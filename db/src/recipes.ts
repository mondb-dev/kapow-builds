import { prisma } from './client.js';

export interface RecipeData {
  id: string;
  name: string;
  category: string;
  tags: string[];
  content: string;
  source: string;
}

// ── Global Recipes ───────────────────────────────────────────────────

export async function getGlobalRecipes(): Promise<RecipeData[]> {
  return prisma.recipe.findMany({ orderBy: { category: 'asc' } });
}

export async function getRecipesByCategory(category: string): Promise<RecipeData[]> {
  return prisma.recipe.findMany({ where: { category } });
}

export async function upsertGlobalRecipe(recipe: RecipeData): Promise<void> {
  await prisma.recipe.upsert({
    where: { id: recipe.id },
    create: {
      ...recipe,
      version: 1,
    },
    update: {
      name: recipe.name,
      category: recipe.category,
      tags: recipe.tags,
      content: recipe.content,
      source: recipe.source,
      version: { increment: 1 },
    },
  });
}

// ── Per-Project Recipes (layered on top of global) ───────────────────

export async function getProjectRecipes(projectId: string): Promise<RecipeData[]> {
  // Get global recipes
  const global = await prisma.recipe.findMany();

  // Get project overrides
  const overrides = await prisma.projectRecipe.findMany({
    where: { projectId },
  });

  // Build map: global recipes, then overlay project-specific ones
  const recipeMap = new Map<string, RecipeData>();

  for (const r of global) {
    recipeMap.set(r.id, r);
  }

  for (const o of overrides) {
    const key = o.recipeId ?? `project-${o.id}`;
    recipeMap.set(key, {
      id: key,
      name: o.name,
      category: o.category,
      tags: o.tags,
      content: o.content,
      source: o.source,
    });
  }

  return Array.from(recipeMap.values());
}

export async function upsertProjectRecipe(
  projectId: string,
  recipe: RecipeData,
  globalRecipeId?: string,
): Promise<void> {
  if (globalRecipeId) {
    await prisma.projectRecipe.upsert({
      where: { projectId_recipeId: { projectId, recipeId: globalRecipeId } },
      create: {
        projectId,
        recipeId: globalRecipeId,
        name: recipe.name,
        category: recipe.category,
        tags: recipe.tags,
        content: recipe.content,
        source: recipe.source,
      },
      update: {
        content: recipe.content,
        tags: recipe.tags,
        source: recipe.source,
        version: { increment: 1 },
      },
    });
  } else {
    await prisma.projectRecipe.create({
      data: {
        projectId,
        name: recipe.name,
        category: recipe.category,
        tags: recipe.tags,
        content: recipe.content,
        source: recipe.source,
      },
    });
  }
}

export function formatRecipesForPrompt(recipes: RecipeData[]): string {
  if (recipes.length === 0) return '';

  const lines = ['=== RECIPES (best practices from previous projects) ===', ''];
  for (const r of recipes) {
    lines.push(`[${r.category}] ${r.name}`);
    lines.push(r.content);
    lines.push('');
  }
  lines.push('Use these recipes when relevant. Ignore recipes that do not apply to this project.');
  lines.push('=== END RECIPES ===');
  return lines.join('\n');
}
