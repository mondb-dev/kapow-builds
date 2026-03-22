import { prisma } from './client.js';
import { embed, toPgVector } from 'kapow-shared';

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

/** Find recipes relevant to a query using vector similarity (RAG) with keyword fallback */
export async function findRelevantRecipes(query: string, maxResults = 5): Promise<RecipeData[]> {
  try {
    const queryEmbedding = await embed(query);
    const pgVec = toPgVector(queryEmbedding);

    // Cosine similarity search via pgvector
    const results = await prisma.$queryRawUnsafe<RecipeData[]>(
      `SELECT id, name, category, tags, content, source
       FROM "Recipe"
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      pgVec,
      maxResults,
    );

    if (results.length > 0) return results;
  } catch (err) {
    // Embedding failed — fall through to keyword search
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[recipes] Vector search failed, using keyword fallback: ${msg}`);
  }

  // Keyword fallback
  return keywordSearch(query, maxResults);
}

function keywordSearch(query: string, maxResults: number): Promise<RecipeData[]> {
  return prisma.recipe.findMany({ orderBy: { category: 'asc' }, take: maxResults }).then((all) => {
    const stopWords = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'will', 'should', 'have', 'create', 'make', 'build', 'simple', 'using']);
    const keywords = [...new Set(
      query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length >= 3 && !stopWords.has(w))
    )];
    if (keywords.length === 0) return all.slice(0, maxResults);

    const scored = all.map((recipe) => {
      const text = `${recipe.name} ${recipe.tags.join(' ')} ${recipe.content}`.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score++;
        if (recipe.tags.some((t) => t.includes(kw))) score += 2;
      }
      return { recipe, score };
    });

    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults).map((s) => s.recipe);
  });
}

export async function getRecipesByCategory(category: string): Promise<RecipeData[]> {
  return prisma.recipe.findMany({ where: { category } });
}

/** Upsert a recipe and compute its embedding */
export async function upsertGlobalRecipe(recipe: RecipeData): Promise<void> {
  await prisma.recipe.upsert({
    where: { id: recipe.id },
    create: { ...recipe, version: 1 },
    update: {
      name: recipe.name,
      category: recipe.category,
      tags: recipe.tags,
      content: recipe.content,
      source: recipe.source,
      version: { increment: 1 },
    },
  });

  // Compute and store embedding (non-blocking)
  embedRecipe(recipe).catch((err) => {
    console.error(`[recipes] Failed to embed recipe ${recipe.id}:`, err instanceof Error ? err.message : err);
  });
}

async function embedRecipe(recipe: RecipeData): Promise<void> {
  const text = `${recipe.name}. ${recipe.category}. Tags: ${recipe.tags.join(', ')}. ${recipe.content}`;
  const embedding = await embed(text);
  const pgVec = toPgVector(embedding);
  await prisma.$executeRawUnsafe(
    `UPDATE "Recipe" SET embedding = $1::vector WHERE id = $2`,
    pgVec,
    recipe.id,
  );
}

/** Embed all recipes that don't have embeddings yet */
export async function embedAllRecipes(): Promise<number> {
  const unembedded = await prisma.$queryRawUnsafe<RecipeData[]>(
    `SELECT id, name, category, tags, content, source FROM "Recipe" WHERE embedding IS NULL`
  );
  for (const recipe of unembedded) {
    await embedRecipe(recipe);
  }
  return unembedded.length;
}

// ── Per-Project Recipes (layered on top of global) ───────────────────

export async function getProjectRecipes(projectId: string): Promise<RecipeData[]> {
  const global = await prisma.recipe.findMany();
  const overrides = await prisma.projectRecipe.findMany({ where: { projectId } });

  const recipeMap = new Map<string, RecipeData>();
  for (const r of global) recipeMap.set(r.id, r);
  for (const o of overrides) {
    const key = o.recipeId ?? `project-${o.id}`;
    recipeMap.set(key, { id: key, name: o.name, category: o.category, tags: o.tags, content: o.content, source: o.source });
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
      create: { projectId, recipeId: globalRecipeId, name: recipe.name, category: recipe.category, tags: recipe.tags, content: recipe.content, source: recipe.source },
      update: { content: recipe.content, tags: recipe.tags, source: recipe.source, version: { increment: 1 } },
    });
  } else {
    await prisma.projectRecipe.create({
      data: { projectId, name: recipe.name, category: recipe.category, tags: recipe.tags, content: recipe.content, source: recipe.source },
    });
  }
}

export function formatRecipesForPrompt(recipes: RecipeData[]): string {
  if (recipes.length === 0) return '';
  const lines = ['=== RECIPES (learned patterns from previous successful builds) ===', ''];
  for (const r of recipes) {
    lines.push(`[${r.category}] ${r.name}`);
    lines.push(r.content);
    lines.push('');
  }
  lines.push('Apply these patterns when they match the current task. Ignore ones that do not apply.');
  lines.push('=== END RECIPES ===');
  return lines.join('\n');
}
