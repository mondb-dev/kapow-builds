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
import { listInfra, updateInfraStatus, markInfraDeleted } from 'kapow-db';
import type { InfraWithProject } from 'kapow-db';
import type {
  CommsBus, InboundMessage, PromptRequest, InboundReply,
} from 'kapow-shared';
import {
  teardownCloudRun,
  teardownGitHubRepo,
  teardownNetlifySite,
  teardownFirebaseHosting,
  teardownVercelProject,
  teardownArtifactRegistryImage,
} from './tools/teardown.js';

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
    preferences?: string;
  }): Promise<{ projectId: string; runId: string }>;

  /** List all projects for this user. */
  listProjects(): Promise<string>;

  /** Resume an existing project with new direction. */
  resumeProject(args: {
    projectId: string;
    direction: string;
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
          await this.reply(msg, 'Usage: /new <brief> [--repo=<name>] [--public]\nExample: /new noir storytelling site, react + p5js --repo=noir-site');
          return;
        }
        const repoMatch = arg.match(/--repo(?:-name)?=(\S+)/);
        const isPublic = /--public\b/.test(arg);
        const isAgile = /--agile\b/.test(arg);
        const repoName = repoMatch?.[1];
        const brief = arg
          .replace(/--repo(?:-name)?=\S+/g, '')
          .replace(/--public\b/g, '')
          .replace(/--agile\b/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        const flagPrefs = [
          repoName ? `GitHub repo name: ${repoName}` : '',
          `GitHub repo visibility: ${isPublic ? 'public' : 'private'}`,
          isAgile ? 'Methodology: agile' : '',
        ].filter(Boolean).join('\n');

        await prisma.conversation.update({
          where: { id: conv.id },
          data: { phase: ConversationPhase.Planning, scope: brief },
        });
        await this.reply(msg, '🚀 Starting — planning phase begins.');
        const { projectId, runId } = await this.deps.hooks.startProject({
          brief,
          conversationId: conv.id,
          requestedBy: { userId: msg.userId, userName: msg.userName },
          preferences: flagPrefs,
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

      case '/projects': {
        const list = await this.deps.hooks.listProjects();
        await this.reply(msg, list);
        return;
      }

      case '/resume': {
        const resumeMatch = arg.match(/^(\d+)\s+(.+)$/s);
        if (!resumeMatch) {
          await this.reply(msg, 'Usage: /resume <number> <direction>\nExample: /resume 2 add dark mode and update the hero animation\n\nUse /projects to see the list.');
          return;
        }
        const projectIndex = parseInt(resumeMatch[1], 10) - 1;
        const direction = resumeMatch[2].trim();
        await this.reply(msg, '🔄 Resuming project — planning the update...');
        try {
          const { projectId, runId } = await this.deps.hooks.resumeProject({
            projectId: projectIndex.toString(),
            direction,
            conversationId: conv.id,
            requestedBy: { userId: msg.userId, userName: msg.userName },
          });
          await prisma.conversation.update({
            where: { id: conv.id },
            data: { projectId, runId, phase: ConversationPhase.Planning },
          });
        } catch (err) {
          await this.reply(msg, `❌ Resume failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      case '/decommission': {
        await this.handleDecommission(conv, arg, msg);
        return;
      }

      case '/infra': {
        const resources = await listInfra();
        if (resources.length === 0) {
          await this.reply(msg, '📭 No infrastructure recorded yet. Resources appear here after a successful deploy or repo creation.');
          return;
        }

        // Ping HTTP URLs in parallel to check live status
        await Promise.all(resources.map(async (r) => {
          if (!r.url) return;
          try {
            const res = await fetch(r.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            await updateInfraStatus(r.id, res.ok || res.status < 500 ? 'ACTIVE' : 'INACTIVE').catch(() => undefined);
            r.status = res.ok || res.status < 500 ? 'ACTIVE' : 'INACTIVE';
          } catch {
            await updateInfraStatus(r.id, 'INACTIVE').catch(() => undefined);
            r.status = 'INACTIVE';
          }
        }));

        // Group by project
        const byProject = new Map<string, typeof resources>();
        for (const r of resources) {
          const key = r.projectName ?? '(no project)';
          if (!byProject.has(key)) byProject.set(key, []);
          byProject.get(key)!.push(r);
        }

        const statusIcon = (s: string) => s === 'ACTIVE' ? '🟢' : s === 'INACTIVE' ? '🔴' : '⚪';
        const typeLabel: Record<string, string> = {
          CLOUD_RUN: 'Cloud Run',
          FIREBASE_HOSTING: 'Firebase Hosting',
          FIREBASE_FUNCTIONS: 'Firebase Functions',
          NETLIFY_SITE: 'Netlify',
          GITHUB_REPO: 'GitHub Repo',
          VERCEL_SITE: 'Vercel',
          GCP_VM: 'GCP VM',
          ARTIFACT_REGISTRY: 'Artifact Registry',
        };

        const lines: string[] = ['<b>Infrastructure</b>\n'];
        for (const [project, items] of byProject) {
          lines.push(`<b>${project}</b>`);
          for (const r of items) {
            const label = typeLabel[r.type] ?? r.type;
            const icon = statusIcon(r.status);
            const urlPart = r.url ? `\n  <a href="${r.url}">${r.url}</a>` : '';
            const regionPart = r.region ? ` [${r.region}]` : '';
            lines.push(`${icon} ${label}: <code>${r.name}</code>${regionPart}${urlPart}`);
          }
          lines.push('');
        }
        await this.reply(msg, lines.join('\n'));
        return;
      }

      case '/help':
        await this.reply(msg,
          '<b>Kapow commands</b>\n' +
          '/new &lt;brief&gt; [--repo=name] [--public] [--agile] — start a project\n' +
          '/projects — list all projects\n' +
          '/resume &lt;number&gt; &lt;direction&gt; — update an existing project\n' +
          '/status — current run state\n' +
          '/cancel — stop the current run\n' +
          '/go — start planning after scoping\n' +
          '/infra — list all infra with live health check\n' +
          '/decommission [n] — teardown wizard for a specific resource\n' +
          '/help — show this',
        );
        return;

      default:
        await this.reply(msg, `Unknown command: ${cmd}. /help for the list.`);
    }
  }

  // ── Decommission wizard ─────────────────────────────────────────

  private async handleDecommission(
    conv: { id: string },
    arg: string,
    msg: InboundMessage,
  ): Promise<void> {
    const resources = await listInfra();
    const active = resources.filter((r) => r.status !== 'DELETED');

    if (!arg) {
      // Step 0: show numbered list
      if (active.length === 0) {
        await this.reply(msg, '📭 No active infrastructure to decommission.');
        return;
      }
      const typeLabel = infraTypeLabel();
      const lines = active.map((r, i) => {
        const project = r.projectName ? ` — <i>${escape(r.projectName)}</i>` : '';
        const url = r.url ? `\n   ${escape(r.url)}` : '';
        return `${i + 1}. ${typeLabel[r.type] ?? r.type}: <b>${escape(r.name)}</b>${project}${url}`;
      });
      await this.reply(msg,
        '<b>Active Infrastructure</b>\n\n' +
        lines.join('\n\n') +
        '\n\n📋 Reply <code>/decommission &lt;number&gt;</code> to open the teardown wizard for that resource.',
      );
      return;
    }

    // Step 1: load the chosen resource
    const idx = parseInt(arg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= active.length) {
      await this.reply(msg, `❌ Invalid number. Use /decommission (no number) to see the list.`);
      return;
    }
    const target = active[idx];
    const typeLabel = infraTypeLabel();

    // Find all infra in the same project (siblings)
    const siblings = target.projectId
      ? active.filter((r) => r.projectId === target.projectId && r.id !== target.id)
      : [];

    // Step 2: build dependency card and send wizard prompt
    const targetLine = `${typeLabel[target.type] ?? target.type}: <b>${escape(target.name)}</b>${target.url ? `\n  URL: ${escape(target.url)}` : ''}${target.region ? ` [${escape(target.region)}]` : ''}`;
    const projectLine = target.projectName ? `\n📁 Project: <b>${escape(target.projectName)}</b>` : '';
    const siblingsBlock = siblings.length > 0
      ? '\n\n<b>Other resources in this project:</b>\n' +
        siblings.map((s) => `  • ${typeLabel[s.type] ?? s.type}: ${escape(s.name)}${s.url ? ` — ${escape(s.url)}` : ''}`).join('\n')
      : '';

    const warningBlock = buildWarnings(target, siblings);

    const card =
      `<b>Decommission Wizard</b>\n\n` +
      `🎯 <b>Target</b>\n${targetLine}${projectLine}` +
      siblingsBlock +
      (warningBlock ? `\n\n⚠️ <b>Warnings</b>\n${warningBlock}` : '') +
      `\n\n<i>This action cannot be undone. Choose what to remove:</i>`;

    const buttons: { id: string; label: string; style?: 'primary' | 'danger' }[] = [
      { id: 'target_only', label: `🗑 This only (${typeLabel[target.type] ?? target.type})`, style: 'danger' },
    ];
    if (siblings.length > 0) {
      buttons.push({ id: 'all_project', label: '💣 All project infra', style: 'danger' });
    }
    buttons.push({ id: 'cancel', label: '✗ Cancel' });

    let choice: InboundReply;
    try {
      choice = await this.deps.commsBus.prompt({
        conversationId: conv.id,
        kind: 'plan_approval',
        text: card,
        timeoutMs: 120_000,
        buttons,
      });
    } catch {
      await this.reply(msg, '⏱ Wizard timed out. Run /decommission again when ready.');
      return;
    }

    if (choice.buttonId === 'cancel' || !choice.buttonId) {
      await this.reply(msg, '✅ Decommission cancelled. Nothing was deleted.');
      return;
    }

    const toDelete = choice.buttonId === 'all_project' ? [target, ...siblings] : [target];

    // Step 3: execute teardown, step by step
    await this.reply(msg, `🔧 Starting teardown of ${toDelete.length} resource(s)…`);

    for (const resource of toDelete) {
      try {
        const result = await executeTeardown(resource);
        await markInfraDeleted(resource.type, resource.name);
        await this.reply(msg, `✅ ${result}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.reply(msg, `❌ Failed to remove ${typeLabel[resource.type] ?? resource.type} <b>${escape(resource.name)}</b>:\n<code>${escape(errMsg.slice(0, 300))}</code>\n\nSkipping — fix manually if needed.`);
      }
    }

    await this.reply(msg, `🏁 Decommission complete. Use /infra to verify.`);
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

// ── Decommission helpers ────────────────────────────────────────────

function infraTypeLabel(): Record<string, string> {
  return {
    CLOUD_RUN: 'Cloud Run',
    FIREBASE_HOSTING: 'Firebase Hosting',
    FIREBASE_FUNCTIONS: 'Firebase Functions',
    NETLIFY_SITE: 'Netlify',
    GITHUB_REPO: 'GitHub Repo',
    VERCEL_SITE: 'Vercel',
    GCP_VM: 'GCP VM',
    ARTIFACT_REGISTRY: 'Artifact Registry',
  };
}

function buildWarnings(target: InfraWithProject, siblings: InfraWithProject[]): string {
  const warnings: string[] = [];
  const all = [target, ...siblings];

  if (all.some((r) => r.type === 'GITHUB_REPO')) {
    warnings.push('GitHub repos will be permanently deleted (no recovery without backup).');
  }
  if (all.some((r) => r.type === 'CLOUD_RUN')) {
    warnings.push('Cloud Run services stop serving traffic immediately on deletion.');
  }
  if (all.some((r) => ['NETLIFY_SITE', 'VERCEL_SITE', 'FIREBASE_HOSTING'].includes(r.type))) {
    warnings.push('Hosted sites will go offline — URLs will return 404.');
  }
  if (all.some((r) => r.type === 'FIREBASE_FUNCTIONS')) {
    warnings.push('Firebase Functions will stop executing — dependent services may break.');
  }
  return warnings.map((w) => `• ${w}`).join('\n');
}

async function executeTeardown(resource: InfraWithProject): Promise<string> {
  const region = resource.region ?? (process.env.GOOGLE_CLOUD_REGION ?? 'asia-southeast1');

  switch (resource.type) {
    case 'CLOUD_RUN':
      return teardownCloudRun(resource.name, region);

    case 'GITHUB_REPO':
      // Archive by default (safer); pass archive=false to fully delete
      return teardownGitHubRepo(resource.name, false);

    case 'NETLIFY_SITE':
      if (!resource.resourceId) throw new Error('No Netlify site ID stored — delete manually at netlify.com/sites');
      return teardownNetlifySite(resource.resourceId, resource.name);

    case 'FIREBASE_HOSTING':
      return teardownFirebaseHosting(resource.name);

    case 'FIREBASE_FUNCTIONS':
      // Functions are scoped to GCP project — disabling hosting doesn't remove functions.
      // Individual function deletion requires knowing function names; skip for now.
      throw new Error('Firebase Functions teardown is not automated — delete manually via GCP Console > Cloud Functions.');

    case 'VERCEL_SITE':
      return teardownVercelProject(resource.name);

    case 'ARTIFACT_REGISTRY':
      return teardownArtifactRegistryImage(resource.name, region);

    case 'GCP_VM':
      throw new Error('GCP VM teardown is not automated — delete manually via GCP Console to avoid accidents.');

    default:
      throw new Error(`No teardown procedure for type: ${resource.type}`);
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  kind: 'plan_approval' | 'design_approval' | 'sprint_review';
  text: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  buttons?: { id: string; label: string; style?: 'primary' | 'danger' }[];
}): Promise<InboundReply> {
  const req: PromptRequest = {
    conversationId: args.conversationId,
    kind: args.kind,
    text: args.text,
    payload: args.payload,
    timeoutMs: args.timeoutMs,
    buttons: args.buttons ?? [
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
