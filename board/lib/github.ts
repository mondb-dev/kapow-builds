/**
 * GitHub integration for Kapow board.
 * Creates repos using the GITHUB_TOKEN env var.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export function isGitHubConfigured(): boolean {
  return !!GITHUB_TOKEN;
}

export async function createGitHubRepo(
  name: string,
  description?: string,
  isPrivate = false,
): Promise<{ repoUrl: string; cloneUrl: string } | null> {
  if (!GITHUB_TOKEN) return null;

  // Slugify the name
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);

  try {
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        name: slug,
        description: description ?? `Kapow project: ${name}`,
        private: isPrivate,
        auto_init: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
      // If repo already exists, look it up
      if (res.status === 422 && err.errors?.some((e) => e.message?.includes('already exists'))) {
        return await lookupRepo(slug);
      }
      console.error(`GitHub repo creation failed: ${res.status}`, err);
      return null;
    }

    const repo = await res.json() as { html_url: string; clone_url: string };
    return {
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
    };
  } catch (err) {
    console.error('GitHub repo creation error:', err);
    return null;
  }
}

async function lookupRepo(name: string): Promise<{ repoUrl: string; cloneUrl: string } | null> {
  if (!GITHUB_TOKEN) return null;
  try {
    // Get authenticated user first
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!userRes.ok) return null;
    const user = await userRes.json() as { login: string };

    const repoRes = await fetch(`https://api.github.com/repos/${user.login}/${name}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!repoRes.ok) return null;
    const repo = await repoRes.json() as { html_url: string; clone_url: string };
    return { repoUrl: repo.html_url, cloneUrl: repo.clone_url };
  } catch {
    return null;
  }
}
