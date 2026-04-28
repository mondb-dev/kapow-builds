/**
 * QA Tool Dispatch
 *
 * Same pattern as builder, but only registers read-safe tools.
 * The QA_ALLOWED_ROLES config determines which tool categories
 * are permitted — not a hardcoded name list.
 */
import { shellExec } from '../tools/shell.js';
import { fileRead, fileList } from '../tools/files.js';
import { browserNavigate, browserScreenshot, browserSetViewport } from '../tools/browser.js';
import { redactSecrets } from '../tools/redact.js';

export type ToolExecutor = (
  input: Record<string, unknown>,
  sandboxPath: string,
) => Promise<string>;

const registry = new Map<string, ToolExecutor>();

/**
 * Tool permission levels.
 *
 * QA is hardcoded to 'read' only. We do NOT honor an env var override here
 * because a misconfigured deployment ("QA_TOOL_PERMISSIONS=read,write,execute")
 * would silently let the QA agent mutate the sandbox, push commits, or run
 * deploys — the opposite of what QA is for. If you genuinely need a
 * write-capable QA, register additional tools explicitly in code.
 */
type ToolPermission = 'read' | 'write' | 'execute' | 'deploy';

const toolPermissions = new Map<string, ToolPermission>();
const allowedPermissions: Set<ToolPermission> = new Set<ToolPermission>(['read']);

if (process.env.QA_TOOL_PERMISSIONS && process.env.QA_TOOL_PERMISSIONS !== 'read') {
  console.warn(
    `[qa] Ignoring QA_TOOL_PERMISSIONS="${process.env.QA_TOOL_PERMISSIONS}" — QA is locked to read-only.`
  );
}

export function registerTool(name: string, executor: ToolExecutor, permission: ToolPermission): void {
  registry.set(name, executor);
  toolPermissions.set(name, permission);
}

export function isToolAllowed(name: string): boolean {
  const perm = toolPermissions.get(name);
  return perm !== undefined && allowedPermissions.has(perm);
}

export function allowedTools(): string[] {
  return Array.from(registry.keys()).filter(isToolAllowed);
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandboxPath: string,
): Promise<string> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return `Tool error (${name}): input must be a JSON object, got ${Array.isArray(input) ? 'array' : typeof input}`;
  }
  if (!isToolAllowed(name)) {
    return `Tool "${name}" is not permitted in QA (allowed permissions: ${[...allowedPermissions].join(', ')})`;
  }

  const executor = registry.get(name);
  if (!executor) {
    return `Unknown tool: ${name}. Available: ${allowedTools().join(', ')}`;
  }

  try {
    const result = await executor(input, sandboxPath);
    return redactSecrets(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${name}): ${redactSecrets(msg)}`;
  }
}

// ── QA shell read-only enforcement ──────────────────────────────────
//
// Whitelist approach: extract every executable token from the command
// (including ones inside `$(...)`, backticks, pipes, &&, ||, ;, redirects)
// and require each to be in QA_SHELL_ALLOWED. A blocklist is unsafe because
// shell offers many ways to obscure a command name (env vars, quoting,
// command substitution, escapes). Returning a denial string short-circuits.

const QA_SHELL_ALLOWED = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg',
  'find', 'wc', 'sort', 'uniq', 'awk', 'sed', 'cut', 'tr',
  'tee', 'echo', 'printf', 'true', 'false', 'test', '[',
  'pwd', 'env', 'which', 'type', 'file', 'stat', 'realpath', 'basename', 'dirname',
  'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'xxd', 'od',
  'jq', 'yq', 'curl', 'wget',
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3',
  'git', 'tsc',
]);

// Subcommands that turn an otherwise-allowed binary into a mutator.
const QA_SUBCOMMAND_DENY: Record<string, RegExp> = {
  npm: /^(install|i|uninstall|remove|rm|update|publish|link|unlink|ci|exec)$/i,
  npx: /.*/,                       // npx runs arbitrary code — block entirely
  pip: /^(install|uninstall)$/i,
  pip3: /^(install|uninstall)$/i,
  git: /^(push|commit|reset|rebase|merge|pull|fetch|clone|init|add|rm|mv|tag|checkout|switch|restore|stash|clean|cherry-pick|revert|am|apply|format-patch|gc|prune|repack|filter-branch|update-ref|symbolic-ref|update-index|write-tree|commit-tree|hash-object)$/i,
  curl: /^-[^-]*o|^--output|^-[^-]*O|^--remote-name/i,  // disallow curl writing files
  wget: /.*/,                      // wget defaults to writing files; block
  node: /.*/,                      // node -e arbitrary code; block
};

function denyIfNotReadOnly(command: string): string | null {
  // Pull out every token that *could* be an executable: anything that
  // appears at the start of the command, or after a shell separator.
  // Separators: ; & | && || $( ) ` { } newline
  const parts = command.split(/(?:\$\(|`|[;|&\n]|\|\||&&)/);
  for (const part of parts) {
    const trimmed = part.replace(/^[\s()]+/, '').trim();
    if (!trimmed) continue;

    // Strip leading "VAR=value " env assignments and "command "/"exec " prefixes
    let rest = trimmed;
    while (true) {
      const stripped = rest
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
        .replace(/^(?:command|exec|builtin|time|nohup|sudo)\s+/i, '');
      if (stripped === rest) break;
      rest = stripped;
    }

    // First token = candidate executable
    const tokenMatch = rest.match(/^([^\s]+)/);
    if (!tokenMatch) continue;
    let exe = tokenMatch[1];

    // Strip backslash-escapes (\rm -> rm) and surrounding quotes
    exe = exe.replace(/\\(.)/g, '$1').replace(/^['"]|['"]$/g, '');

    // Skip flags, redirects, variable expansions, and subshell artifacts
    if (!exe || exe.startsWith('-') || exe.startsWith('>') || exe.startsWith('<') || exe.startsWith('$')) continue;

    // Take basename so /bin/rm and ./rm both check as "rm"
    const base = exe.split('/').pop() ?? exe;
    if (!base) continue;

    // Reject anything containing shell metacharacters that survived splitting
    if (/[`$]/.test(base)) {
      return `Command substitution not permitted near token "${base.slice(0, 40)}".`;
    }

    if (!QA_SHELL_ALLOWED.has(base)) {
      return `Disallowed command "${base}". Allowed: ${[...QA_SHELL_ALLOWED].sort().join(', ')}.`;
    }

    // Subcommand check (e.g. `git push`, `npm install`)
    const denyPattern = QA_SUBCOMMAND_DENY[base];
    if (denyPattern) {
      const subMatch = rest.slice(tokenMatch[0].length).trim().match(/^([^\s]+)/);
      const sub = subMatch?.[1] ?? '';
      if (denyPattern.test(sub) || denyPattern.source === '.*') {
        return `"${base}${sub ? ' ' + sub : ''}" is not permitted in QA (mutates state or runs arbitrary code).`;
      }
    }

    // Disallow any output redirection that writes files
    if (/(?:^|\s)(?:>|>>|&>|tee\b)/.test(rest)) {
      // `tee` is allowed only in piped read-only chains we can't fully verify here; block writes.
      if (/(?:^|\s)(?:>|>>|&>)/.test(rest)) {
        return `Output redirection (>, >>, &>) not permitted.`;
      }
    }
  }
  return null;
}

// ── Register core QA tools ───────────────────────────────────────────

export function registerCoreQATools(): void {
  registerTool('shell_exec', async (input, sandboxPath) => {
    const { command, timeout_ms } = input as { command: string; timeout_ms?: number };

    const denial = denyIfNotReadOnly(command);
    if (denial) {
      return JSON.stringify({
        stdout: '',
        stderr: `QA shell is read-only. ${denial}`,
        exitCode: 1,
      });
    }

    const result = await shellExec(command, sandboxPath, timeout_ms);
    return JSON.stringify({
      stdout: result.stdout.slice(0, 8000),
      stderr: result.stderr.slice(0, 2000),
      exitCode: result.exitCode,
    });
  }, 'read');

  registerTool('file_read', async (input, sandboxPath) => {
    const { path } = input as { path: string };
    return fileRead(sandboxPath, path).slice(0, 10000);
  }, 'read');

  registerTool('file_list', async (input, sandboxPath) => {
    const { path = '.' } = input as { path?: string };
    return JSON.stringify(fileList(sandboxPath, path));
  }, 'read');

  registerTool('browser_navigate', async (input, sandboxPath) => {
    const { url } = input as { url: string };
    return browserNavigate(sandboxPath, url);
  }, 'read');

  registerTool('browser_screenshot', async (input, sandboxPath) => {
    const { filename } = input as { filename: string };
    return browserScreenshot(sandboxPath, filename);
  }, 'read');

  registerTool('browser_set_viewport', async (input, sandboxPath) => {
    const { width, height } = input as { width: number; height: number };
    return browserSetViewport(sandboxPath, width, height);
  }, 'read');

  console.log(`[qa] Registered ${6} tool executors (allowed: ${[...allowedPermissions].join(', ')})`);
}
