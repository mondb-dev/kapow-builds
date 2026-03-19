/**
 * Seeds the database with initial recipes, preferences, and core tools.
 * Run: npx tsx src/seed.ts
 */
import { prisma } from './client.js';

async function seed() {
  console.log('Seeding database...');

  // ── Recipes ──────────────────────────────────────────────────────

  const recipes = [
    {
      id: 'next-app-foundation',
      name: 'Next.js App Foundation',
      category: 'web',
      tags: ['nextjs', 'react', 'typescript'],
      content: 'For Next.js apps: use App Router (not Pages), TypeScript strict mode, Tailwind CSS for styling. Structure: src/app/ for routes, src/components/ for shared UI, src/lib/ for utilities. Always add a health endpoint at /api/health. Use next/font for font optimization. Include .env.example with all required vars documented.',
      source: 'seed',
    },
    {
      id: 'express-api-foundation',
      name: 'Express API Foundation',
      category: 'api',
      tags: ['express', 'nodejs', 'typescript'],
      content: 'For Express APIs: TypeScript with strict mode, structured error handling middleware, /health endpoint returning {status:\'ok\'}. Use express.json() with size limits. Validate env vars at startup (exit 1 if missing). Structure: src/routes/ for endpoints, src/middleware/ for shared middleware, src/types.ts for interfaces.',
      source: 'seed',
    },
    {
      id: 'sanity-cms-setup',
      name: 'Sanity CMS Integration',
      category: 'cms',
      tags: ['sanity', 'cms', 'headless'],
      content: 'When a website needs CMS capabilities: use Sanity.io with the Next.js toolkit (@sanity/client, next-sanity). Define schemas in sanity/schemas/. Use GROQ for queries. Set up a studio at /studio route. Always configure preview mode for draft content. Use CDN for published content, direct API for drafts.',
      source: 'seed',
    },
  ];

  for (const recipe of recipes) {
    await prisma.recipe.upsert({
      where: { id: recipe.id },
      create: { ...recipe, version: 1 },
      update: {},
    });
  }
  console.log(`  Recipes: ${recipes.length} seeded`);

  // ── Preferences ──────────────────────────────────────────────────

  const preferences = [
    { id: 'website', category: 'website', settings: { framework: 'Next.js 14+ (App Router)', language: 'TypeScript (strict)', styling: 'Tailwind CSS', cms: 'Sanity.io', hosting: 'Vercel', notes: 'Use App Router over Pages Router. Server components by default, client components only when needed.' } },
    { id: 'api', category: 'api', settings: { framework: 'Express.js', language: 'TypeScript (strict)', database: 'PostgreSQL with Prisma ORM', auth: 'JWT with refresh tokens', hosting: 'Docker on Oracle Cloud free tier', notes: 'Always include /health endpoint. Validate env vars at startup.' } },
    { id: 'mobile', category: 'mobile', settings: { framework: 'React Native with Expo', language: 'TypeScript', state: 'Zustand', navigation: 'Expo Router', notes: 'Prefer Expo managed workflow unless native modules are required.' } },
    { id: 'cli', category: 'cli', settings: { language: 'TypeScript with tsx', args: 'commander.js', notes: 'Compile to single file with tsup for distribution.' } },
    { id: 'general', category: 'general', settings: { packageManager: 'npm', linting: 'ESLint + Prettier', testing: 'Vitest for unit tests, Playwright for E2E', ci: 'GitHub Actions', notes: 'Prefer established libraries over custom implementations. Fewer dependencies is better.' } },
  ];

  for (const pref of preferences) {
    await prisma.preference.upsert({
      where: { id: pref.id },
      create: pref,
      update: {},
    });
  }
  console.log(`  Preferences: ${preferences.length} seeded`);

  // ── Core Tools ───────────────────────────────────────────────────

  const coreTools = [
    { id: 'core-file-write', name: 'file_write', description: 'Write content to a file in the sandbox. Creates parent directories automatically.', tags: ['filesystem', 'core'], returnType: 'void', parameters: [{ name: 'path', type: 'string', description: 'Relative path within the sandbox', required: true }, { name: 'content', type: 'string', description: 'File content to write', required: true }] },
    { id: 'core-file-read', name: 'file_read', description: 'Read the content of a file from the sandbox.', tags: ['filesystem', 'core'], returnType: 'string', parameters: [{ name: 'path', type: 'string', description: 'Relative path within the sandbox', required: true }] },
    { id: 'core-file-list', name: 'file_list', description: 'List files and directories in a sandbox directory.', tags: ['filesystem', 'core'], returnType: 'Array<{ name, path, type, size? }>', parameters: [{ name: 'path', type: 'string', description: 'Relative directory path (default: ".")', required: false }] },
    { id: 'core-shell-exec', name: 'shell_exec', description: 'Execute a shell command in the sandbox environment.', tags: ['shell', 'core'], returnType: '{ stdout, stderr, exitCode }', parameters: [{ name: 'command', type: 'string', description: 'Shell command to execute', required: true }, { name: 'timeout', type: 'number', description: 'Timeout in seconds (default: 120)', required: false }] },
    { id: 'core-git-commit', name: 'git_commit', description: 'Stage all changes and create a git commit.', tags: ['git', 'core'], returnType: 'string', parameters: [{ name: 'message', type: 'string', description: 'Commit message', required: true }] },
    { id: 'core-github-create-repo', name: 'github_create_repo', description: 'Create a new GitHub repository, add remote, and push.', tags: ['git', 'github', 'core'], returnType: '{ repoUrl, cloneUrl }', parameters: [{ name: 'name', type: 'string', description: 'Repository name', required: true }, { name: 'isPrivate', type: 'boolean', description: 'Private repo (default: false)', required: false }, { name: 'description', type: 'string', description: 'Repository description', required: false }] },
    { id: 'core-browser-navigate', name: 'browser_navigate', description: 'Navigate a headless browser to a URL.', tags: ['browser', 'core'], returnType: '{ title, content, url }', parameters: [{ name: 'url', type: 'string', description: 'URL to navigate to', required: true }, { name: 'waitFor', type: 'string', description: 'CSS selector to wait for', required: false }] },
    { id: 'core-browser-screenshot', name: 'browser_screenshot', description: 'Capture a screenshot of the current browser page.', tags: ['browser', 'core'], returnType: '{ path, size }', parameters: [{ name: 'outputPath', type: 'string', description: 'Relative path to save screenshot', required: true }, { name: 'fullPage', type: 'boolean', description: 'Full page capture (default: false)', required: false }] },
    { id: 'core-vercel-deploy', name: 'vercel_deploy', description: 'Deploy the project to Vercel.', tags: ['deploy', 'vercel', 'core'], returnType: '{ url, deployId }', parameters: [{ name: 'buildCommand', type: 'string', description: 'Custom build command', required: false }] },
    { id: 'core-netlify-deploy', name: 'netlify_deploy', description: 'Deploy the project to Netlify.', tags: ['deploy', 'netlify', 'core'], returnType: '{ url }', parameters: [{ name: 'siteId', type: 'string', description: 'Netlify site ID', required: false }] },
  ];

  for (const tool of coreTools) {
    await prisma.tool.upsert({
      where: { id: tool.id },
      create: {
        ...tool,
        version: 1,
        status: 'READY',
        implementation: `sandbox:${tool.id}`,
        testCode: '',
        createdBy: 'seed',
      },
      update: {},
    });
  }
  console.log(`  Tools: ${coreTools.length} seeded`);

  console.log('Seed complete.');
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
