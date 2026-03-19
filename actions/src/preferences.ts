import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

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

export interface Preferences {
  [category: string]: PreferenceSet;
}

interface PreferenceStore {
  preferences: Preferences;
}

const DATA_DIR = process.env.KAPOW_DATA_DIR ?? join(dirname(dirname(dirname(import.meta.url.replace('file://', '')))), 'data');

function getPreferencesPath(): string {
  return join(DATA_DIR, 'preferences.json');
}

export function loadPreferences(): Preferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const store = JSON.parse(raw) as PreferenceStore;
    return store.preferences ?? {};
  } catch {
    return {};
  }
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
