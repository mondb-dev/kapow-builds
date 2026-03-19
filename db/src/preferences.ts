import { prisma } from './client.js';

export interface PreferenceSet {
  framework?: string;
  language?: string;
  styling?: string;
  cms?: string;
  hosting?: string;
  database?: string;
  auth?: string;
  state?: string;
  navigation?: string;
  args?: string;
  packageManager?: string;
  linting?: string;
  testing?: string;
  ci?: string;
  notes?: string;
}

export type Preferences = Record<string, PreferenceSet>;

// ── Global Preferences ───────────────────────────────────────────────

export async function getGlobalPreferences(): Promise<Preferences> {
  const rows = await prisma.preference.findMany();
  const prefs: Preferences = {};
  for (const row of rows) {
    prefs[row.category] = row.settings as PreferenceSet;
  }
  return prefs;
}

export async function upsertGlobalPreference(category: string, settings: PreferenceSet): Promise<void> {
  await prisma.preference.upsert({
    where: { id: category },
    create: { id: category, category, settings },
    update: { settings },
  });
}

// ── Per-Project Preferences (layered) ────────────────────────────────

export async function getProjectPreferences(projectId: string): Promise<Preferences> {
  // Start with global defaults
  const global = await getGlobalPreferences();

  // Get project overrides
  const overrides = await prisma.projectPreference.findMany({
    where: { projectId },
  });

  // Merge: project settings override global per-category
  const merged: Preferences = { ...global };
  for (const o of overrides) {
    const globalSettings = merged[o.category] ?? {};
    merged[o.category] = { ...globalSettings, ...(o.settings as PreferenceSet) };
  }

  return merged;
}

export async function upsertProjectPreference(
  projectId: string,
  category: string,
  settings: PreferenceSet,
): Promise<void> {
  // Find global preference ID if it exists
  const globalPref = await prisma.preference.findFirst({ where: { category } });

  await prisma.projectPreference.upsert({
    where: { projectId_category: { projectId, category } },
    create: {
      projectId,
      preferenceId: globalPref?.id,
      category,
      settings,
    },
    update: { settings },
  });
}

export function formatPreferencesForPrompt(prefs: Preferences): string {
  const keys = Object.keys(prefs);
  if (keys.length === 0) return '';

  const lines = ['=== DEFAULT PREFERENCES (use when client does not specify) ===', ''];
  for (const category of keys) {
    const set = prefs[category];
    lines.push(`${category.toUpperCase()}:`);
    for (const [key, value] of Object.entries(set)) {
      if (value) lines.push(`  ${key}: ${value}`);
    }
    lines.push('');
  }
  lines.push('Apply these defaults ONLY when the client brief does not specify a preference.');
  lines.push('If the client requests a specific stack, honor their request over these defaults.');
  lines.push('=== END PREFERENCES ===');
  return lines.join('\n');
}
