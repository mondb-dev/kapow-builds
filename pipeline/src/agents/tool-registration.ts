/**
 * Core Tool Registration
 *
 * Registers all built-in tool executors on startup.
 * This replaces the switch statement in builder.ts.
 */
import { registerTool } from './tool-dispatch.js';
import { shellExec } from '../tools/shell.js';
import { fileWrite, fileRead, fileList } from '../tools/files.js';
import { gitInit, gitCommit, gitBranch, gitPush, gitStatus, githubCreateRepo } from '../tools/git.js';
import { browserNavigate, browserScreenshot, browserSetViewport } from '../tools/browser.js';
import { vercelDeploy, netlifyDeploy, firebaseDeploy } from '../tools/deploy.js';

export function registerCoreTools(): void {
  registerTool('shell_exec', async (input, sandboxPath) => {
    const { command, timeout_ms } = input as { command: string; timeout_ms?: number };
    const result = await shellExec(command, sandboxPath, timeout_ms);
    return JSON.stringify({
      stdout: result.stdout.slice(0, 8000),
      stderr: result.stderr.slice(0, 2000),
      exitCode: result.exitCode,
    });
  });

  registerTool('file_write', async (input, sandboxPath) => {
    const { path, content } = input as { path: string; content: string };
    fileWrite(sandboxPath, path, content);
    return `File written: ${path}`;
  });

  registerTool('file_read', async (input, sandboxPath) => {
    const { path } = input as { path: string };
    return fileRead(sandboxPath, path).slice(0, 10000);
  });

  registerTool('file_list', async (input, sandboxPath) => {
    const { path = '.' } = input as { path?: string };
    return JSON.stringify(fileList(sandboxPath, path));
  });

  registerTool('git_init', async (_input, sandboxPath) => {
    return await gitInit(sandboxPath);
  });

  registerTool('git_commit', async (input, sandboxPath) => {
    const { message } = input as { message: string };
    return await gitCommit(sandboxPath, message);
  });

  registerTool('git_branch', async (input, sandboxPath) => {
    const { branch_name } = input as { branch_name: string };
    return await gitBranch(sandboxPath, branch_name);
  });

  registerTool('git_push', async (input, sandboxPath) => {
    const { remote = 'origin', branch = 'main' } = input as { remote?: string; branch?: string };
    return await gitPush(sandboxPath, remote, branch);
  });

  registerTool('git_status', async (_input, sandboxPath) => {
    return await gitStatus(sandboxPath);
  });

  registerTool('github_create_repo', async (input, sandboxPath) => {
    const { repo_name, description, private: isPrivate = false } = input as {
      repo_name: string; description: string; private?: boolean;
    };
    return githubCreateRepo(sandboxPath, repo_name, description, isPrivate);
  });

  registerTool('vercel_deploy', async (input, sandboxPath) => {
    const { project_name, build_command, output_dir } = input as {
      project_name: string; build_command?: string; output_dir?: string;
    };
    return vercelDeploy(sandboxPath, project_name, build_command, output_dir);
  });

  registerTool('netlify_deploy', async (input, sandboxPath) => {
    const { site_id, publish_dir = '.' } = input as {
      site_id?: string; publish_dir?: string;
    };
    return netlifyDeploy(sandboxPath, site_id, publish_dir);
  });

  registerTool('browser_navigate', async (input, sandboxPath) => {
    const { url } = input as { url: string };
    return browserNavigate(sandboxPath, url);
  });

  registerTool('browser_screenshot', async (input, sandboxPath) => {
    const { filename } = input as { filename: string };
    return browserScreenshot(sandboxPath, filename);
  });

  registerTool('browser_set_viewport', async (input, sandboxPath) => {
    const { width, height } = input as { width: number; height: number };
    return browserSetViewport(sandboxPath, width, height);
  });

  registerTool('firebase_deploy', async (input, sandboxPath) => {
    const { project_id, public_dir } = input as { project_id?: string; public_dir?: string };
    return firebaseDeploy(sandboxPath, project_id ?? '', public_dir);
  });

  console.log(`[builder] Registered 16 core tool executors`);
}
