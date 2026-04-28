/**
 * Comms Router
 *
 * Phase-aware router for inbound messages from any IO channel.
 * Maintains a Conversation per (channelId, threadId), routes commands and
 * freeform text based on conversation phase, and exposes high-level helpers
 * the orchestrator uses to request approvals.
 *
 * Lifecycle:
 *
 *   inbound msg
 *      │
 *      ▼
 *   resolveConversation()    ── load or create row in Conversation table
 *      │
 *      ▼
 *   routeMessage()           ── command? phase-action? freeform?
 *      │
 *      ▼
 *   handler invokes orchestrator hooks (start, cancel, status reply)
 *
 *
 * The router does NOT block on prompts — orchestrator code awaits
 * commsBus.prompt() directly. The router only handles inbound traffic
 * that ISN'T a button reply (those resolve in CommsBus.dispatchInbound).
 */
import { prisma } from 'kapow-db';
import type {
  CommsBus, InboundMessage, PromptRequest, InboundReply,
} from 'kapow-shared';

// ── Phase taxonomy ──────────────────────────────────────────────────

export const ConversationPhase = {
  Idle: 'idle',
  Scoping: 'scoping',
  Planning: 'planning',
  AwaitingPlanApproval: 'awaiting_plan_approval',
  Building: 'building',
  AwaitingDesignApproval: 'awaiting_design_approval',
  Done: 'done',
  Failed: 'failed',
} as const;
export type ConversationPhase = typeof ConversationPhase[keyof typeof ConversationPhase];

// ── Orchestrator hooks ──────────────────────────────────────────────

export interface OrchestratorHooks {
  /** User asked Kapow to start a new project. */
  startProject(args: {
    brief: string;
    conversationId: string;
    requestedBy: { userId: string; userName: string };
  }): Promise<{ projectId: string; runId: string }>;

  /** User asked to cancel an in-flight run. */
  cancelRun(runId: string): Promise<void>;

  /** Build a short status string for the current run/conversation. */
  describeStatus(args: { conversationId: string }): Promise<string>;
}

// ── Router ──────────────────────────────────────────────────────────

export interface CommsRouterDeps {
  commsBus: CommsBus;
  hooks: OrchestratorHooks;
}

export class CommsRouter {
  constructor(private deps: CommsRouterDeps) {}

  /** Wire as the inbound handler on the CommsBus. */
  async start(): Promise<void> {
    await this.deps.commsBus.startInbound((msg) => this.handle(msg));
    console.log('[comms-router] Listening for inbound messages');
  }

  async handle(msg: InboundMessage): Promise<void> {
    const conv = await resolveConversation(msg);
    const text = msg.text.trim();

    // Slash commands take priority regardless of phase
    if (text.startsWith('/')) {
      await this.handleCommand(conv, text, msg);
      return;
    }

    // Freeform routing by phase
    switch (conv.phase as ConversationPhase) {
      case ConversationPhase.Idle:
      case ConversationPhase.Done:
      case ConversationPhase.Failed:
        await this.reply(msg, '👋 Send /new <brief> to start a project, or /status to see current state.');
        return;

      case ConversationPhase.Scoping: {
        // Treat freeform as a brief refinement
        const refinedScope = appendScope(conv.scope ?? '', text);
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { scope: refinedScope },
        });
        await this.reply(msg, '📝 Got it — added to the brief. Reply /go to start planning, or keep refining.');
        return;
      }

      case ConversationPhase.Planning:
      case ConversationPhase.Building:
        await this.reply(msg, `⏳ Currently ${humanPhase(conv.phase)}. Use /status for details, /cancel to stop.`);
        return;

      case ConversationPhase.AwaitingPlanApproval:
      case ConversationPhase.AwaitingDesignApproval:
        // User typed instead of clicking. Interpret common words.
        await this.handleApprovalText(conv, text, msg);
        return;
    }
  }

  // ── Commands ────────────────────────────────────────────────────

  private async handleCommand(
    conv: { id: string; phase: string; runId: string | null },
    text: string,
    msg: InboundMessage,
  ): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/new': {
        if (!arg) {
          await this.reply(msg, 'Usage: /new <brief>\nExample: /new noir storytelling site, react + p5js');
          return;
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { phase: ConversationPhase.Planning, scope: arg },
        });
        await this.reply(msg, '🚀 Starting — planning phase begins.');
        const { projectId, runId } = await this.deps.hooks.startProject({
          brief: arg,
          conversationId: conv.id,
          requestedBy: { userId: msg.userId, userName: msg.userName },
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { projectId, runId },
        });
        return;
      }

      case '/status': {
        const desc = await this.deps.hooks.describeStatus({ conversationId: conv.id });
        await this.reply(msg, desc);
        return;
      }

      case '/cancel': {
        if (!conv.runId) {
          await this.reply(msg, 'Nothing to cancel.');
          return;
        }
        await this.deps.hooks.cancelRun(conv.runId);
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { phase: ConversationPhase.Failed },
        });
        await this.reply(msg, '🛑 Cancelled.');
        return;
      }

      case '/go': {
        if (conv.phase !== ConversationPhase.Scoping) {
          await this.reply(msg, '/go only works during scoping. Use /new to start.');
          return;
        }
        // Same as /new but with already-collected scope
        const scope = (await prisma.conversation.findUnique({ where: { id: conv.id } }))?.scope ?? '';
        if (!scope) {
          await this.reply(msg, 'No brief collected yet.');
          return;
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { phase: ConversationPhase.Planning },
        });
        await this.reply(msg, '🚀 Planning…');
        const { projectId, runId } = await this.deps.hooks.startProject({
          brief: scope,
          conversationId: conv.id,
          requestedBy: { userId: msg.userId, userName: msg.userName },
        });
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { projectId, runId },
        });
        return;
      }

      case '/help':
        await this.reply(msg,
          '<b>Kapow commands</b>\n' +
          '/new &lt;brief&gt; — start a project\n' +
          '/status — current run state\n' +
          '/cancel — stop the current run\n' +
          '/go — start planning after scoping\n' +
          '/help — show this',
        );
        return;

      default:
        await this.reply(msg, `Unknown command: ${cmd}. /help for the list.`);
    }
  }

  // ── Approval text fallback ──────────────────────────────────────

  private async handleApprovalText(
    conv: { id: string },
    text: string,
    msg: InboundMessage,
  ): Promise<void> {
    const lower = text.toLowerCase();
    if (/^(yes|y|approve|ok|go|ship)/.test(lower)) {
      await this.reply(msg, '👍 Use the Approve button on the prompt above so I can record it cleanly.');
    } else if (/^(no|n|stop|reject|cancel)/.test(lower)) {
      await this.reply(msg, '👎 Use the Reject button on the prompt above.');
    } else {
      // Captured as a revision note — orchestrator can read it from the convo
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          // append to messages JSON
          messages: { push: { role: 'user', text, at: new Date().toISOString() } as never },
        },
      }).catch(() => undefined);
      await this.reply(msg, '✏️ Noted as a revision request. Tap Revise on the prompt to apply.');
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async reply(_msg: InboundMessage, text: string): Promise<void> {
    await this.deps.commsBus.notify(text);
  }
}

// ── Orchestrator-side helpers (approvals) ───────────────────────────

/**
 * Helper used inside the pipeline: present an approval prompt and persist the
 * decision. Caller passes the existing conversation id; this writes an Approval
 * row when one is added to the schema.
 */
export async function requestApproval(args: {
  commsBus: CommsBus;
  conversationId: string;
  kind: 'plan_approval' | 'design_approval';
  text: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<InboundReply> {
  const req: PromptRequest = {
    conversationId: args.conversationId,
    kind: args.kind,
    text: args.text,
    payload: args.payload,
    timeoutMs: args.timeoutMs,
    buttons: [
      { id: 'approve', label: '✅ Approve', style: 'primary' },
      { id: 'revise', label: '✏️ Revise' },
      { id: 'cancel', label: '🛑 Cancel', style: 'danger' },
    ],
  };
  return args.commsBus.prompt(req);
}

// ── Internals ───────────────────────────────────────────────────────

async function resolveConversation(msg: InboundMessage) {
  const existing = await prisma.conversation.findUnique({
    where: { channelId_threadTs: { channelId: msg.channelId, threadTs: msg.threadId } },
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: {
      channelId: msg.channelId,
      threadTs: msg.threadId,
      userId: msg.userId,
      userName: msg.userName,
      phase: ConversationPhase.Idle,
    },
  });
}

function appendScope(existing: string, addition: string): string {
  return existing ? `${existing}\n${addition}` : addition;
}

function humanPhase(phase: string): string {
  return phase.replace(/_/g, ' ');
}
