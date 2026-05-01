/**
 * Infrastructure teardown functions.
 *
 * Each function deletes the named resource and returns a human-readable
 * result string. Errors are NOT swallowed — callers handle them and report
 * to the user.
 */
import { Octokit } from '@octokit/rest';
import { shellExec } from './shell.js';

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function teardownCloudRun(
  serviceName: string,
  region: string,
): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set');

  const cmd = [
    `gcloud run services delete ${shellQuote(serviceName)}`,
    `--region ${shellQuote(region)}`,
    `--project ${shellQuote(project)}`,
    `--quiet`,
  ].join(' ');

  const result = await shellExec(cmd, '/tmp', 120_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'gcloud delete failed');
  }
  return `Deleted Cloud Run service: ${serviceName} (${region})`;
}

export async function teardownGitHubRepo(
  ownerRepo: string,
  archive: boolean = false,
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo format: ${ownerRepo} (expected owner/repo)`);

  const octokit = new Octokit({ auth: token });

  if (archive) {
    await octokit.repos.update({ owner, repo, archived: true });
    return `Archived GitHub repo: ${ownerRepo}`;
  } else {
    await octokit.repos.delete({ owner, repo });
    return `Deleted GitHub repo: ${ownerRepo}`;
  }
}

export async function teardownNetlifySite(
  siteId: string,
  siteName: string,
): Promise<string> {
  const token = process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN not set');

  // Use Netlify API directly — more reliable than CLI for deletion
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Netlify API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return `Deleted Netlify site: ${siteName} (${siteId})`;
}

export async function teardownFirebaseHosting(
  gcpProjectId: string,
): Promise<string> {
  // firebase hosting:disable removes the live site but keeps the project
  const cmd = `npx firebase hosting:disable --project ${shellQuote(gcpProjectId)} --non-interactive`;
  const result = await shellExec(cmd, '/tmp', 60_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'firebase hosting:disable failed');
  }
  return `Disabled Firebase Hosting for project: ${gcpProjectId}`;
}

export async function teardownVercelProject(
  projectName: string,
): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN not set');

  // First resolve project ID from name
  const listRes = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    throw new Error(`Vercel project not found: ${projectName}`);
  }
  const proj = await listRes.json() as { id: string };

  const delRes = await fetch(`https://api.vercel.com/v9/projects/${proj.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!delRes.ok && delRes.status !== 404) {
    const body = await delRes.text();
    throw new Error(`Vercel API error ${delRes.status}: ${body.slice(0, 200)}`);
  }
  return `Deleted Vercel project: ${projectName}`;
}

export async function teardownArtifactRegistryImage(
  imageName: string,
  region: string,
): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set');

  const imageRef = `${region}-docker.pkg.dev/${project}/kapow/${imageName}`;
  const cmd = `gcloud artifacts docker images delete ${shellQuote(imageRef)} --quiet --delete-tags`;
  const result = await shellExec(cmd, '/tmp', 120_000);
  if (result.exitCode !== 0) {
    const errLower = (result.stderr + result.stdout).toLowerCase();
    // Not found is fine — already gone
    if (errLower.includes('not found') || errLower.includes('does not exist')) {
      return `Artifact image already gone: ${imageRef}`;
    }
    throw new Error(result.stderr || result.stdout);
  }
  return `Deleted Artifact Registry image: ${imageRef}`;
}
