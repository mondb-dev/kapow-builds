/**
 * Seeds the tool registry with the core tools that were previously
 * hardcoded inside individual agents. These become the foundation
 * that the technician maintains, updates, and documents going forward.
 */
import { upsertTool } from './registry.js';
import type { ToolDefinition } from './types.js';

const now = new Date().toISOString();

const CORE_TOOLS: ToolDefinition[] = [
  // ── Filesystem Tools ────────────────────────────────────────────

  {
    id: 'core-file-write',
    name: 'file_write',
    description: 'Write content to a file in the sandbox. Creates parent directories automatically.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path within the sandbox', required: true },
      { name: 'content', type: 'string', description: 'File content to write', required: true },
    ],
    returnType: 'void',
    implementation: 'sandbox:builder/src/tools/files.ts#fileWrite',
    testCode: '',
    tags: ['filesystem', 'core'],
    doc: {
      summary: 'Write a file to the project sandbox. Parent directories are created if they do not exist.',
      usage: 'file_write({ path: "src/index.ts", content: "console.log(\'hello\');" })',
      parameters: '- path (string, required): Relative path from sandbox root\n- content (string, required): Full file content',
      returns: 'void — throws on I/O error',
      examples: [
        'file_write({ path: "package.json", content: JSON.stringify({ name: "my-app" }, null, 2) })',
        'file_write({ path: "src/utils/helpers.ts", content: "export const add = (a: number, b: number) => a + b;" })',
      ],
      caveats: [
        'Max file size: 10MB',
        'Path must be relative — absolute paths are rejected by the sandbox',
        'Overwrites existing files without warning',
      ],
      relatedTools: ['core-file-read', 'core-file-list'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  {
    id: 'core-file-read',
    name: 'file_read',
    description: 'Read the content of a file from the sandbox.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path within the sandbox', required: true },
    ],
    returnType: 'string',
    implementation: 'sandbox:builder/src/tools/files.ts#fileRead',
    testCode: '',
    tags: ['filesystem', 'core'],
    doc: {
      summary: 'Read a file from the project sandbox and return its contents as a string.',
      usage: 'file_read({ path: "src/index.ts" })',
      parameters: '- path (string, required): Relative path from sandbox root',
      returns: 'string — the full file content in UTF-8',
      examples: [
        'const pkg = JSON.parse(file_read({ path: "package.json" }))',
        'const readme = file_read({ path: "README.md" })',
      ],
      caveats: [
        'Throws if file does not exist',
        'Max readable file size: 10MB',
        'Binary files will be read as UTF-8 (may produce garbage)',
      ],
      relatedTools: ['core-file-write', 'core-file-list'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  {
    id: 'core-file-list',
    name: 'file_list',
    description: 'List files and directories in a sandbox directory.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative directory path (default: ".")', required: false },
    ],
    returnType: 'Array<{ name, path, type, size? }>',
    implementation: 'sandbox:builder/src/tools/files.ts#fileList',
    testCode: '',
    tags: ['filesystem', 'core'],
    doc: {
      summary: 'List the contents of a directory. Returns name, relative path, type (file/directory), and size for files.',
      usage: 'file_list({ path: "src" })',
      parameters: '- path (string, optional): Relative directory path. Defaults to project root.',
      returns: 'Array of { name: string, path: string, type: "file"|"directory", size?: number }',
      examples: [
        'file_list({}) // list project root',
        'file_list({ path: "src/components" })',
      ],
      caveats: [
        'Returns empty array if directory does not exist',
        'Non-recursive — only lists immediate children',
      ],
      relatedTools: ['core-file-read', 'core-file-write'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  // ── Shell Tool ──────────────────────────────────────────────────

  {
    id: 'core-shell-exec',
    name: 'shell_exec',
    description: 'Execute a shell command in the sandbox environment. Supports npm, npx, git, and general bash commands.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in seconds (default: 120)', required: false },
    ],
    returnType: '{ stdout: string, stderr: string, exitCode: number }',
    implementation: 'sandbox:builder/src/tools/shell.ts#shellExec',
    testCode: '',
    tags: ['shell', 'core'],
    doc: {
      summary: 'Execute a bash command in the project sandbox. Working directory is the sandbox root. Environment is sandboxed — only safe vars are forwarded.',
      usage: 'shell_exec({ command: "npm install" })',
      parameters: '- command (string, required): Bash command to run\n- timeout (number, optional): Max execution time in seconds. Default 120.',
      returns: '{ stdout: string, stderr: string, exitCode: number }',
      examples: [
        'shell_exec({ command: "npm install" })',
        'shell_exec({ command: "npx tsc --noEmit" })',
        'shell_exec({ command: "npm test", timeout: 300 })',
        'shell_exec({ command: "curl -s http://localhost:3000/health" })',
      ],
      caveats: [
        'Max buffer: 10MB per stream (stdout/stderr)',
        'Environment is sandboxed — only PATH, HOME, PWD, LANG, TERM, NODE_ENV, TMPDIR are forwarded',
        'HOME and PWD are overridden to the sandbox path',
        'Default timeout: 120 seconds',
      ],
      relatedTools: ['core-file-write', 'core-file-read'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  // ── Git Tools ───────────────────────────────────────────────────

  {
    id: 'core-git-commit',
    name: 'git_commit',
    description: 'Stage all changes and create a git commit in the sandbox repository.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'message', type: 'string', description: 'Commit message', required: true },
    ],
    returnType: 'string',
    implementation: 'sandbox:builder/src/tools/git.ts#gitCommit',
    testCode: '',
    tags: ['git', 'core'],
    doc: {
      summary: 'Stage all changes (git add -A) and commit with the given message. Initializes the repo if needed.',
      usage: 'git_commit({ message: "feat: add user authentication" })',
      parameters: '- message (string, required): Commit message',
      returns: 'string — commit hash or status message',
      examples: [
        'git_commit({ message: "chore: initial project setup" })',
        'git_commit({ message: "fix: resolve null pointer in auth middleware" })',
      ],
      caveats: [
        'Stages ALL changes (git add -A) — be sure files are ready',
        'Tolerates empty commits (no error if nothing changed)',
        'Uses kapow-builder as the committer identity',
      ],
      relatedTools: ['core-github-create-repo', 'core-shell-exec'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  {
    id: 'core-github-create-repo',
    name: 'github_create_repo',
    description: 'Create a new GitHub repository, add it as the remote origin, and push all commits.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'name', type: 'string', description: 'Repository name', required: true },
      { name: 'isPrivate', type: 'boolean', description: 'Whether the repo should be private (default: false)', required: false },
      { name: 'description', type: 'string', description: 'Repository description', required: false },
    ],
    returnType: '{ repoUrl: string, cloneUrl: string }',
    implementation: 'sandbox:builder/src/tools/git.ts#githubCreateRepo',
    testCode: '',
    tags: ['git', 'github', 'core'],
    doc: {
      summary: 'Create a GitHub repo via the API, set it as the remote, and push. Requires GITHUB_TOKEN env var.',
      usage: 'github_create_repo({ name: "my-project" })',
      parameters: '- name (string, required): Repository name\n- isPrivate (boolean, optional): Private repo. Default false.\n- description (string, optional): Repo description.',
      returns: '{ repoUrl: string, cloneUrl: string }',
      examples: [
        'github_create_repo({ name: "landing-page", description: "Marketing landing page" })',
        'github_create_repo({ name: "internal-api", isPrivate: true })',
      ],
      caveats: [
        'Requires GITHUB_TOKEN environment variable',
        'Fails if repo with same name already exists',
        'Uses x-access-token authentication for push',
      ],
      relatedTools: ['core-git-commit'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  // ── Browser Tools ───────────────────────────────────────────────

  {
    id: 'core-browser-navigate',
    name: 'browser_navigate',
    description: 'Navigate a headless browser to a URL and return the page content.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to navigate to', required: true },
      { name: 'waitFor', type: 'string', description: 'CSS selector to wait for before returning', required: false },
    ],
    returnType: '{ title: string, content: string, url: string }',
    implementation: 'sandbox:builder/src/tools/browser.ts#browserNavigate',
    testCode: '',
    tags: ['browser', 'core'],
    doc: {
      summary: 'Open a URL in a headless Chromium browser. Waits for page load, optionally waits for a CSS selector.',
      usage: 'browser_navigate({ url: "http://localhost:3000" })',
      parameters: '- url (string, required): URL to navigate to\n- waitFor (string, optional): CSS selector to wait for',
      returns: '{ title: string, content: string, url: string }',
      examples: [
        'browser_navigate({ url: "http://localhost:3000/health" })',
        'browser_navigate({ url: "http://localhost:3000", waitFor: "#root" })',
      ],
      caveats: [
        'Requires Chrome/Chromium available (CHROME_WS_ENDPOINT or local install)',
        'Viewport: 1280x900',
        'Page content is extracted as text, not raw HTML',
      ],
      relatedTools: ['core-browser-screenshot'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  {
    id: 'core-browser-screenshot',
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current browser page and save it to the sandbox.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'outputPath', type: 'string', description: 'Relative path to save the screenshot', required: true },
      { name: 'fullPage', type: 'boolean', description: 'Capture full page (default: false)', required: false },
    ],
    returnType: '{ path: string, size: number }',
    implementation: 'sandbox:builder/src/tools/browser.ts#browserScreenshot',
    testCode: '',
    tags: ['browser', 'core'],
    doc: {
      summary: 'Take a PNG screenshot of the current browser page. Must call browser_navigate first.',
      usage: 'browser_screenshot({ outputPath: "screenshots/home.png" })',
      parameters: '- outputPath (string, required): Where to save in the sandbox\n- fullPage (boolean, optional): Full page capture. Default false.',
      returns: '{ path: string, size: number }',
      examples: [
        'browser_screenshot({ outputPath: "screenshots/landing.png" })',
        'browser_screenshot({ outputPath: "screenshots/full.png", fullPage: true })',
      ],
      caveats: [
        'Must navigate to a page first — throws if no page is open',
        'Always PNG format',
      ],
      relatedTools: ['core-browser-navigate'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  // ── Deploy Tools ────────────────────────────────────────────────

  {
    id: 'core-vercel-deploy',
    name: 'vercel_deploy',
    description: 'Deploy the sandbox project to Vercel and return the live URL.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'buildCommand', type: 'string', description: 'Custom build command (optional)', required: false },
    ],
    returnType: '{ url: string, deployId: string }',
    implementation: 'sandbox:builder/src/tools/deploy.ts#vercelDeploy',
    testCode: '',
    tags: ['deploy', 'vercel', 'core'],
    doc: {
      summary: 'Deploy to Vercel production using npx vercel CLI. Requires VERCEL_TOKEN env var.',
      usage: 'vercel_deploy({})',
      parameters: '- buildCommand (string, optional): Override the default build command',
      returns: '{ url: string, deployId: string }',
      examples: [
        'vercel_deploy({})',
        'vercel_deploy({ buildCommand: "npm run build:prod" })',
      ],
      caveats: [
        'Requires VERCEL_TOKEN environment variable',
        'Deploys to production (--prod flag)',
        'Project must have a valid framework or vercel.json config',
      ],
      relatedTools: ['core-netlify-deploy', 'core-shell-exec'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },

  {
    id: 'core-netlify-deploy',
    name: 'netlify_deploy',
    description: 'Deploy the sandbox project to Netlify and return the live URL.',
    version: 1,
    status: 'ready',
    parameters: [
      { name: 'siteId', type: 'string', description: 'Netlify site ID (optional, uses auto-detection)', required: false },
    ],
    returnType: '{ url: string }',
    implementation: 'sandbox:builder/src/tools/deploy.ts#netlifyDeploy',
    testCode: '',
    tags: ['deploy', 'netlify', 'core'],
    doc: {
      summary: 'Deploy to Netlify production using netlify-cli. Requires NETLIFY_AUTH_TOKEN env var.',
      usage: 'netlify_deploy({})',
      parameters: '- siteId (string, optional): Target site ID. Auto-detected if omitted.',
      returns: '{ url: string }',
      examples: [
        'netlify_deploy({})',
        'netlify_deploy({ siteId: "my-site-abc123" })',
      ],
      caveats: [
        'Requires NETLIFY_AUTH_TOKEN environment variable',
        'Deploys to production (--prod flag)',
        'Parses URL from "Website URL:" in CLI output',
      ],
      relatedTools: ['core-vercel-deploy', 'core-shell-exec'],
    },
    createdBy: 'seed',
    createdAt: now,
    updatedAt: now,
  },
];

export async function seedCoreTools(): Promise<void> {
  let seeded = 0;
  for (const tool of CORE_TOOLS) {
    await upsertTool(tool);
    seeded++;
  }
  console.log(`[technician] Seeded ${seeded} core tools into the registry.`);
}
