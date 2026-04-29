import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';

export async function githubCreateRepo(
  sandboxPath: string,
  repoName: string,
  description: string,
  isPrivate: boolean = true
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is not set');

  const octokit = new Octokit({ auth: token });
  const { data: user } = await octokit.users.getAuthenticated();

  // Try the requested name, then append a short timestamp suffix on conflict
  const candidates = [
    repoName,
    `${repoName}-${Date.now().toString(36)}`,
  ];

  let repo: Awaited<ReturnType<typeof octokit.repos.createForAuthenticatedUser>>['data'] | null = null;
  let usedName = repoName;

  for (const name of candidates) {
    try {
      const { data } = await octokit.repos.createForAuthenticatedUser({
        name,
        description,
        private: isPrivate,
        auto_init: false,
      });
      repo = data;
      usedName = name;
      break;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 422) continue; // name taken — try next candidate
      throw err;
    }
  }

  if (!repo) throw new Error(`Could not create GitHub repo — all candidate names taken: ${candidates.join(', ')}`);

  const git = getGit(sandboxPath);

  // Remove existing origin if present (fix attempts may have added it already)
  try { await git.removeRemote('origin'); } catch { /* not set */ }
  await git.addRemote('origin', repo.clone_url);

  const authHeader =
    'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  await git.addConfig('http.https://github.com/.extraheader', authHeader);

  git.env('GIT_TERMINAL_PROMPT', '0');
  await git.push('origin', 'main', ['--set-upstream']);

  return `Created repo ${user.login}/${usedName} → ${repo.html_url}`;
}

let gitInstances: Map<string, SimpleGit> = new Map();

function getGit(sandboxPath: string): SimpleGit {
  if (!gitInstances.has(sandboxPath)) {
    gitInstances.set(sandboxPath, simpleGit(sandboxPath));
  }
  return gitInstances.get(sandboxPath)!;
}

export function clearGitInstance(sandboxPath: string): void {
  gitInstances.delete(sandboxPath);
}

export async function gitInit(sandboxPath: string): Promise<string> {
  const git = getGit(sandboxPath);
  await git.init();
  await git.addConfig('user.email', 'kapow-builder@kapow.dev');
  await git.addConfig('user.name', 'Kapow Builder');
  return 'Initialized empty git repository';
}

export async function gitCommit(sandboxPath: string, message: string): Promise<string> {
  const git = getGit(sandboxPath);
  await git.add('.');
  try {
    const result = await git.commit(message);
    return `Committed: ${result.commit} — ${result.summary.changes} changes`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Nothing to commit is not a fatal error
    if (msg.includes('nothing to commit')) {
      return 'Nothing to commit (working tree clean)';
    }
    throw err;
  }
}

export async function gitBranch(sandboxPath: string, branchName: string): Promise<string> {
  const git = getGit(sandboxPath);
  await git.checkoutLocalBranch(branchName);
  return `Switched to new branch: ${branchName}`;
}

export async function gitPush(
  sandboxPath: string,
  remote: string,
  branch: string
): Promise<string> {
  const git = getGit(sandboxPath);
  await git.push(remote, branch);
  return `Pushed to ${remote}/${branch}`;
}

export async function gitStatus(sandboxPath: string): Promise<string> {
  const git = getGit(sandboxPath);
  const status = await git.status();
  const lines = [
    `Branch: ${status.current}`,
    `Modified: ${status.modified.length}`,
    `Created: ${status.created.length}`,
    `Deleted: ${status.deleted.length}`,
    `Untracked: ${status.not_added.length}`,
  ];
  return lines.join(', ');
}
