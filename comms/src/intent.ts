import Anthropic from '@anthropic-ai/sdk';
import type { UserIntent, ConversationPhase } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an intent classifier for Kapow, an AI development pipeline.

Given a user's Slack message and the current conversation phase, classify their intent.

Respond with ONLY a JSON object. One of:

- { "type": "new_project", "scope": "<extracted project description>" }
  When user wants to create/build something new.

- { "type": "modify_scope", "changes": "<what they want changed>" }
  When user is in negotiation and wants to adjust the plan.

- { "type": "approve" }
  When user approves/confirms a plan. Look for: "yes", "go", "approved", "lgtm", "ship it", "build it", "looks good", "confirmed", "let's do it", thumbs up, etc.

- { "type": "reject", "reason": "<why>" }
  When user rejects a plan entirely. Look for: "no", "cancel", "nevermind", "scrap it", etc.

- { "type": "check_status" }
  When user asks about progress of a running build.

- { "type": "list_projects" }
  When user asks to see existing projects.

- { "type": "help" }
  When user asks what Kapow can do or how to use it.

- { "type": "unknown", "text": "<original message>" }
  When you genuinely can't classify the intent.

Context matters. If the phase is "negotiating", a short "yes" means approve. If the phase is "idle", a description of what to build means new_project.`;

export async function detectIntent(
  message: string,
  phase: ConversationPhase,
): Promise<UserIntent> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Phase: ${phase}\nMessage: ${message}`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/) ?? [null];
    return JSON.parse(jsonMatch[0]!) as UserIntent;
  } catch {
    return { type: 'unknown', text: message };
  }
}
