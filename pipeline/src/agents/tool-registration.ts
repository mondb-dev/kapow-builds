/**
 * Core Tool Registration
 *
 * Registers all built-in tool executors on startup.
 * This replaces the switch statement in builder.ts.
 */
import { registerTool, getOnRepoCreated } from './tool-dispatch.js';
import { shellExec } from '../tools/shell.js';
import { fileWrite, fileRead, fileList } from '../tools/files.js';
import { gitInit, gitCommit, gitBranch, gitPush, gitStatus, githubCreateRepo } from '../tools/git.js';
import { browserNavigate, browserScreenshot, browserSetViewport } from '../tools/browser.js';
import { vercelDeploy, netlifyDeploy, firebaseDeploy, cloudRunDeploy } from '../tools/deploy.js';
import {
  gdriveUpload, gdriveRead, gdriveList,
  gdocsCreate, gdocsRead, gdocsAppend,
  gsheetsRead, gsheetsWrite, gsheetsCreate,
  gmailSend,
} from '../tools/google.js';

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
    const { repo_name, description, private: isPrivate = true } = input as {
      repo_name?: string; description?: string; private?: boolean;
    };
    if (!repo_name || repo_name === 'undefined') {
      throw new Error('github_create_repo requires a repo_name. Specify one explicitly in your tool call.');
    }
    const result = await githubCreateRepo(sandboxPath, repo_name, description ?? '', isPrivate);
    const urlMatch = result.match(/https:\/\/github\.com\/\S+/);
    if (urlMatch) getOnRepoCreated()?.(urlMatch[0]);
    return result;
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

  registerTool('cloud_run_deploy', async (input, sandboxPath) => {
    const { service_name, project_dir = '.', region, port, memory, env_vars } = input as {
      service_name: string;
      project_dir?: string;
      region?: string;
      port?: number;
      memory?: string;
      env_vars?: Record<string, string>;
    };
    return cloudRunDeploy(sandboxPath, service_name, project_dir, region, port, memory, env_vars);
  });

  // ── Google Workspace ───────────────────────────────────────────────

  registerTool('gdrive_upload', async (input, sandboxPath) => {
    const { file_path, file_name, folder_id, mime_type } = input as {
      file_path: string; file_name?: string; folder_id?: string; mime_type?: string;
    };
    return gdriveUpload(sandboxPath, file_path, file_name, folder_id, mime_type);
  });

  registerTool('gdrive_read', async (input, sandboxPath) => {
    const { file_id, output_path } = input as { file_id: string; output_path: string };
    return gdriveRead(sandboxPath, file_id, output_path);
  });

  registerTool('gdrive_list', async (input, _sandboxPath) => {
    const { folder_id } = input as { folder_id?: string };
    return gdriveList(folder_id);
  });

  registerTool('gdocs_create', async (input, _sandboxPath) => {
    const { title, content } = input as { title: string; content: string };
    return gdocsCreate(title, content);
  });

  registerTool('gdocs_read', async (input, _sandboxPath) => {
    const { document_id } = input as { document_id: string };
    return gdocsRead(document_id);
  });

  registerTool('gdocs_append', async (input, _sandboxPath) => {
    const { document_id, content } = input as { document_id: string; content: string };
    return gdocsAppend(document_id, content);
  });

  registerTool('gsheets_read', async (input, _sandboxPath) => {
    const { spreadsheet_id, range } = input as { spreadsheet_id: string; range?: string };
    return gsheetsRead(spreadsheet_id, range);
  });

  registerTool('gsheets_write', async (input, _sandboxPath) => {
    const { spreadsheet_id, range, values } = input as {
      spreadsheet_id: string; range: string; values: unknown[][];
    };
    return gsheetsWrite(spreadsheet_id, range, values);
  });

  registerTool('gsheets_create', async (input, _sandboxPath) => {
    const { title, headers } = input as { title: string; headers?: string[] };
    return gsheetsCreate(title, headers);
  });

  registerTool('gmail_send', async (input, _sandboxPath) => {
    const { to, subject, body, is_html } = input as {
      to: string; subject: string; body: string; is_html?: boolean;
    };
    return gmailSend(to, subject, body, is_html);
  });

  console.log(`[builder] Registered 27 core tool executors`);
}
