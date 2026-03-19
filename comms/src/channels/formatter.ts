/**
 * Message Formatter
 *
 * Converts structured plan data into platform-specific markup.
 * Each platform gets its own formatter — the handler calls
 * formatPlan(plan, platform) and gets the right output.
 */

export interface PlanData {
  architecture?: {
    overview?: string;
    techStack?: string;
    fileStructure?: string;
    conventions?: string;
  };
  phases?: Array<{
    name: string;
    description: string;
    tasks: Array<{
      description: string;
      acceptanceCriteria: string[];
    }>;
  }>;
  constraints?: string[];
}

type Platform = 'slack' | 'discord' | 'plain';

export function formatPlan(plan: PlanData, platform: Platform): string {
  switch (platform) {
    case 'slack':
      return formatSlack(plan);
    case 'discord':
      return formatDiscord(plan);
    case 'plain':
    default:
      return formatPlain(plan);
  }
}

export function formatPrompt(platform: Platform): string {
  const bold = platform === 'slack' ? '*' : platform === 'discord' ? '**' : '';
  return [
    `${bold}What do you think?${bold} Reply with:`,
    `• ${bold}"go"${bold} or ${bold}"approved"${bold} to start building`,
    `• Describe changes you want`,
    `• ${bold}"cancel"${bold} to scrap it`,
  ].join('\n');
}

// ── Slack (mrkdwn) ───────────────────────────────────────────────────

function formatSlack(plan: PlanData): string {
  const lines: string[] = [];

  if (plan.architecture) {
    const a = plan.architecture;
    lines.push('*Architecture*');
    if (a.overview) lines.push(`> ${a.overview}`);
    if (a.techStack) lines.push(`\n*Tech Stack:* ${a.techStack}`);
    if (a.fileStructure) lines.push(`*File Structure:* ${a.fileStructure}`);
    lines.push('');
  }

  if (plan.phases && plan.phases.length > 0) {
    lines.push(`*Phases (${plan.phases.length}):*`);
    for (const phase of plan.phases) {
      lines.push(`\n*${phase.name}* — ${phase.description}`);
      for (const task of phase.tasks) {
        lines.push(`  • ${task.description}`);
        for (const ac of task.acceptanceCriteria.slice(0, 3)) {
          lines.push(`    ✓ ${ac}`);
        }
        if (task.acceptanceCriteria.length > 3) {
          lines.push(`    _...and ${task.acceptanceCriteria.length - 3} more criteria_`);
        }
      }
    }
    lines.push('');
  }

  if (plan.constraints && plan.constraints.length > 0) {
    lines.push('*Constraints:*');
    for (const c of plan.constraints) lines.push(`  ⚠ ${c}`);
  }

  return lines.join('\n');
}

// ── Discord (markdown) ───────────────────────────────────────────────

function formatDiscord(plan: PlanData): string {
  const lines: string[] = [];

  if (plan.architecture) {
    const a = plan.architecture;
    lines.push('## Architecture');
    if (a.overview) lines.push(`> ${a.overview}`);
    if (a.techStack) lines.push(`\n**Tech Stack:** ${a.techStack}`);
    if (a.fileStructure) lines.push(`**File Structure:** ${a.fileStructure}`);
    lines.push('');
  }

  if (plan.phases && plan.phases.length > 0) {
    lines.push(`## Phases (${plan.phases.length})`);
    for (const phase of plan.phases) {
      lines.push(`\n### ${phase.name}`);
      lines.push(phase.description);
      for (const task of phase.tasks) {
        lines.push(`- ${task.description}`);
        for (const ac of task.acceptanceCriteria.slice(0, 3)) {
          lines.push(`  - ✓ ${ac}`);
        }
      }
    }
    lines.push('');
  }

  if (plan.constraints && plan.constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of plan.constraints) lines.push(`- ⚠ ${c}`);
  }

  return lines.join('\n');
}

// ── Plain text ───────────────────────────────────────────────────────

function formatPlain(plan: PlanData): string {
  const lines: string[] = [];

  if (plan.architecture) {
    const a = plan.architecture;
    lines.push('ARCHITECTURE');
    if (a.overview) lines.push(`  ${a.overview}`);
    if (a.techStack) lines.push(`  Tech Stack: ${a.techStack}`);
    if (a.fileStructure) lines.push(`  File Structure: ${a.fileStructure}`);
    lines.push('');
  }

  if (plan.phases && plan.phases.length > 0) {
    lines.push(`PHASES (${plan.phases.length}):`);
    for (const phase of plan.phases) {
      lines.push(`\n  ${phase.name} — ${phase.description}`);
      for (const task of phase.tasks) {
        lines.push(`    - ${task.description}`);
        for (const ac of task.acceptanceCriteria.slice(0, 3)) {
          lines.push(`      ✓ ${ac}`);
        }
      }
    }
    lines.push('');
  }

  if (plan.constraints && plan.constraints.length > 0) {
    lines.push('CONSTRAINTS:');
    for (const c of plan.constraints) lines.push(`  ! ${c}`);
  }

  return lines.join('\n');
}
