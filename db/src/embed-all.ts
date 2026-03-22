import { prisma } from './client.js';
import { embed, toPgVector } from 'kapow-shared';

async function main() {
  const tools = await prisma.tool.findMany();
  console.log(`Embedding ${tools.length} tools...`);
  for (const t of tools) {
    const text = `${t.name}. ${t.description}. Tags: ${t.tags.join(', ')}`;
    const vec = await embed(text);
    await prisma.$executeRawUnsafe('UPDATE "Tool" SET embedding = $1::vector WHERE id = $2', toPgVector(vec), t.id);
    console.log(`  + ${t.name}`);
  }

  const recipes = await prisma.recipe.findMany();
  console.log(`Embedding ${recipes.length} recipes...`);
  for (const r of recipes) {
    const text = `${r.name}. ${r.category}. Tags: ${r.tags.join(', ')}. ${r.content}`;
    const vec = await embed(text);
    await prisma.$executeRawUnsafe('UPDATE "Recipe" SET embedding = $1::vector WHERE id = $2', toPgVector(vec), r.id);
    console.log(`  + ${r.name}`);
  }

  console.log('Done!');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
