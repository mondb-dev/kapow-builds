import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface Recipe {
  id: string;
  name: string;
  category: string;
  tags: string[];
  content: string;
  source: string; // 'seed' | runId that created/updated it
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RecipeStore {
  recipes: Recipe[];
}

const DATA_DIR = process.env.KAPOW_DATA_DIR ?? join(dirname(dirname(dirname(import.meta.url.replace('file://', '')))), 'data');

function getRecipesPath(): string {
  return join(DATA_DIR, 'recipes.json');
}

export function loadRecipes(): Recipe[] {
  const path = getRecipesPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const store = JSON.parse(raw) as RecipeStore;
    return store.recipes ?? [];
  } catch {
    return [];
  }
}

export function saveRecipes(recipes: Recipe[]): void {
  const path = getRecipesPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ recipes }, null, 2), 'utf-8');
}

export function formatRecipesForPrompt(recipes: Recipe[]): string {
  if (recipes.length === 0) return '';

  const lines = ['=== RECIPES (best practices from previous projects) ===', ''];
  for (const r of recipes) {
    lines.push(`[${r.category}] ${r.name} (v${r.version})`);
    lines.push(r.content);
    lines.push('');
  }
  lines.push('Use these recipes when relevant. Ignore recipes that do not apply to this project.');
  lines.push('=== END RECIPES ===');
  return lines.join('\n');
}

/**
 * After a successful pipeline run, the Gate/orchestrator can call this
 * to propose recipe updates. The LLM extracts lessons learned and either
 * updates existing recipes or creates new ones.
 */
export function upsertRecipe(recipe: Omit<Recipe, 'createdAt' | 'updatedAt' | 'version'>): void {
  const recipes = loadRecipes();
  const now = new Date().toISOString();
  const existing = recipes.findIndex((r) => r.id === recipe.id);

  if (existing >= 0) {
    recipes[existing] = {
      ...recipes[existing],
      ...recipe,
      version: recipes[existing].version + 1,
      updatedAt: now,
    };
  } else {
    recipes.push({
      ...recipe,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveRecipes(recipes);
}
