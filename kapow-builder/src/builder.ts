import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createSandbox } from './sandbox.js';
import { shellExec } from './tools/shell.js';
import { fileWrite, fileRead, fileList } from './tools/files.js';
import { gitInit, gitCommit, githubCreateRepo } from './tools/git.js';
import { browserNavigate, browserScreenshot } from './tools/browser.js';
import { vercelDeploy, netlifyDeploy } from './tools/deploy.js';
import type { TaskGraph, BuildResult, Artifact } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ITERATIONS = 50;

const SYSTEM_PROMPT = `You are a senior full-stack engineer with access to a sandboxed workspace.

Implement the given tasks completely and correctly. Use shell commands to install dependencies, run builds, run tests.
Write production-quality code. Handle errors. Follow the constraints and acceptance criteria exactly.

Available tools:
- shell_exec: run shell commands (npm install, npx, mkdir, etc.)
- file_write: write a file to the sandbox
- file_read: read a file from the sandbox
- file_list: list directory contents
- git_commit: commit all changes with a message
- browser_navigate: open a URL in a headless browser
- browser_screenshot: capture a screenshot to a file
- github_create_repo: create a GitHub repo, set remote, and push (requires GITHUB_TOKEN)
- vercel_deploy: deploy the project to Vercel and return the live URL (requires VERCEL_TOKEN)
- netlify_deploy: deploy the project to Netlify and return the live URL (requires NETLIFY_TOKEN)

Work through tasks one by one in dependency order. After completing all tasks, call git_commit to save the work.
Always verify your work by running tests or checking outputs with shell_exec.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'shell_exec',
    description: 'Execute a shell command in the sandbox working directory',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default: 120000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file in the sandbox',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path within sandbox' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a file from the sandbox',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path within sandbox' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_list',
    description: 'List directory contents in the sandbox',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path (default: ".")',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit with a message',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['message'],
    },
  },
  {
    name: 'github_create_repo',
    description: 'Create a new GitHub repository, add it as remote origin, and push the current sandbox commits',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo_name: { type: 'string', description: 'Repository name (slug, no spaces)' },
        description: { type: 'string', description: 'Short description of the repo' },
        private: { type: 'boolean', description: 'Create as private repo (default: false)' },
      },
      required: ['repo_name', 'description'],
    },
  },
  {
    name: 'vercel_deploy',
    description: 'Deploy the current sandbox project to Vercel and return the live URL',
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Vercel project name (slug)' },
        build_command: { type: 'string', description: 'Optional build command (e.g. npm run build)' },
        output_dir: { type: 'string', description: 'Optional output directory (e.g. dist, .next)' },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'netlify_deploy',
    description: 'Deploy the current sandbox project to Netlify and return the live URL',
    input_schema: {
      type: 'object' as const,
      properties: {
        site_id: { type: 'string', description: 'Existing Netlify site ID (omit to create new site)' },
        publish_dir: { type: 'string', description: 'Directory to publish (default: ".")' },
      },
      required: [],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the headless browser',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string',
          description: 'Output filename (relative to sandbox, .png extension)',
        },
      },
      required: ['filename'],
    },
  },
];

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  sandboxPath: string
): Promise<string> {
  try {
    switch (toolName) {
      case 'shell_exec': {
        const { command, timeout_ms } = toolInput as { command: string; timeout_ms?: number };
        const result = await shellExec(command, sandboxPath, timeout_ms);
        return JSON.stringify({
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 2000),
          exitCode: result.exitCode,
        });
      }

      case 'file_write': {
        const { path, content } = toolInput as { path: string; content: string };
        fileWrite(sandboxPath, path, content);
        return `File written: ${path}`;
      }

      case 'file_read': {
        const { path } = toolInput as { path: string };
        const content = fileRead(sandboxPath, path);
        return content.slice(0, 10000);
      }

      case 'file_list': {
        const { path = '.' } = toolInput as { path?: string };
        const entries = fileList(sandboxPath, path);
        return JSON.stringify(entries);
      }

      case 'git_commit': {
        const { message } = toolInput as { message: string };
        const result = await gitCommit(sandboxPath, message);
        return result;
      }

      case 'github_create_repo': {
        const { repo_name, description, private: isPrivate = false } = toolInput as {
          repo_name: string;
          description: string;
          private?: boolean;
        };
        return githubCreateRepo(sandboxPath, repo_name, description, isPrivate);
      }

      case 'vercel_deploy': {
        const { project_name, build_command, output_dir } = toolInput as {
          project_name: string;
          build_command?: string;
          output_dir?: string;
        };
        return vercelDeploy(sandboxPath, project_name, build_command, output_dir);
      }

      case 'netlify_deploy': {
        const { site_id, publish_dir = '.' } = toolInput as {
          site_id?: string;
          publish_dir?: string;
        };
        return netlifyDeploy(sandboxPath, site_id, publish_dir);
      }

      case 'browser_navigate': {
        const { url } = toolInput as { url: string };
        return browserNavigate(url);
      }

      case 'browser_screenshot': {
        const { filename } = toolInput as { filename: string };
        return browserScreenshot(sandboxPath, filename);
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${toolName}): ${msg}`;
  }
}

const MAX_WALK_DEPTH = 10;
const MAX_ARTIFACTS = 5000;

function collectArtifacts(sandboxPath: string): Artifact[] {
  const artifacts: Artifact[] = [];

  function walk(dir: string, depth: number) {
    if (depth > MAX_WALK_DEPTH) return;
    if (artifacts.length >= MAX_ARTIFACTS) return;
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (artifacts.length >= MAX_ARTIFACTS) return;
      // Skip node_modules, .git, dist
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      const rel = relative(sandboxPath, full);
      const stat = lstatSync(full);
      // Skip symlinks
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        artifacts.push({ path: rel, type: 'directory' });
        walk(full, depth + 1);
      } else {
        artifacts.push({ path: rel, type: 'file' });
      }
    }
  }

  walk(sandboxPath, 0);
  return artifacts;
}

export async function build(runId: string, taskGraph: TaskGraph): Promise<BuildResult> {
  const sandboxPath = createSandbox(runId);
  const logs: string[] = [];

  // Initialize git in sandbox
  await gitInit(sandboxPath);
  logs.push(`Sandbox created at ${sandboxPath}`);

  const userContent = [
    `Run ID: ${runId}`,
    `Task Graph ID: ${taskGraph.id}`,
    '',
    'Original Plan:',
    taskGraph.originalPlan,
    '',
    'Constraints:',
    ...taskGraph.constraints.map((c) => `- ${c}`),
    '',
    'Context:',
    JSON.stringify(taskGraph.context, null, 2),
    '',
    'Tasks (implement all of them):',
    ...taskGraph.tasks.map(
      (t) =>
        `\n[${t.id}] (${t.type}) ${t.description}\n` +
        `  Dependencies: ${t.dependencies.join(', ') || 'none'}\n` +
        `  Acceptance Criteria:\n` +
        t.acceptanceCriteria.map((c) => `    - ${c}`).join('\n')
    ),
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

  let success = false;
  let continueLoop = true;
  let iterations = 0;

  while (continueLoop) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      success = false;
      logs.push(`WARNING: Max tool iterations (${MAX_TOOL_ITERATIONS}) reached, stopping build loop.`);
      break;
    }
    iterations++;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Collect text logs from this response
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logs.push(block.text.trim().slice(0, 500));
      }
    }

    if (response.stop_reason === 'tool_use') {
      // Process all tool calls in this response
      const assistantMessage: Anthropic.MessageParam = {
        role: 'assistant',
        content: response.content,
      };
      messages.push(assistantMessage);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          logs.push(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          const result = await handleToolCall(
            block.name,
            block.input as Record<string, unknown>,
            sandboxPath
          );
          logs.push(`  Result: ${result.slice(0, 200)}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      // end_turn or other stop reason — done
      continueLoop = false;
      success = true;
      logs.push('Builder completed successfully.');
    }
  }

  const artifacts = collectArtifacts(sandboxPath);

  return {
    runId,
    taskGraphId: taskGraph.id,
    sandboxPath,
    artifacts,
    logs,
    success,
  };
}

export async function fix(
  runId: string,
  taskGraph: TaskGraph,
  previousBuildResult: BuildResult,
  delta: string,
  iteration: number
): Promise<BuildResult> {
  // Reuse the same sandbox for targeted fixes
  const sandboxPath = previousBuildResult.sandboxPath;
  const logs: string[] = [`Fix iteration ${iteration} started`];

  const userContent = [
    `Run ID: ${runId} (fix iteration ${iteration})`,
    `Task Graph ID: ${taskGraph.id}`,
    '',
    'The previous build did not pass QA. Here is what needs to be fixed:',
    '',
    delta,
    '',
    'The sandbox at the following path still exists with your previous work:',
    sandboxPath,
    '',
    'Make targeted fixes only. Do not rewrite everything from scratch unless necessary.',
    'After fixing, commit the changes.',
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

  let success = false;
  let continueLoop = true;
  let iterations = 0;

  while (continueLoop) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      success = false;
      logs.push(`WARNING: Max tool iterations (${MAX_TOOL_ITERATIONS}) reached, stopping fix loop.`);
      break;
    }
    iterations++;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logs.push(block.text.trim().slice(0, 500));
      }
    }

    if (response.stop_reason === 'tool_use') {
      const assistantMessage: Anthropic.MessageParam = {
        role: 'assistant',
        content: response.content,
      };
      messages.push(assistantMessage);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          logs.push(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          const result = await handleToolCall(
            block.name,
            block.input as Record<string, unknown>,
            sandboxPath
          );
          logs.push(`  Result: ${result.slice(0, 200)}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      continueLoop = false;
      success = true;
      logs.push('Builder fix completed.');
    }
  }

  const artifacts = collectArtifacts(sandboxPath);

  return {
    runId,
    taskGraphId: taskGraph.id,
    sandboxPath,
    artifacts,
    logs: [...previousBuildResult.logs, ...logs],
    success,
  };
}
