import { shellExec } from './shell.js';

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function vercelDeploy(
  sandboxPath: string,
  projectName: string,
  buildCommand?: string,
  outputDir?: string
): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error('VERCEL_TOKEN env var is not set');

  const args = [
    `npx vercel --prod --yes`,
    `--name ${shellQuote(projectName)}`,
    buildCommand ? `--build-env BUILD_COMMAND=${shellQuote(buildCommand)}` : '',
    outputDir ? `--local-config-file vercel.json` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Pass VERCEL_TOKEN via env — Vercel CLI reads it from environment automatically
  const result = await shellExec(args, sandboxPath, 180000, { VERCEL_TOKEN: token });

  if (result.exitCode !== 0) {
    throw new Error(`Vercel deploy failed:\n${result.stderr || result.stdout}`);
  }

  // Vercel CLI prints the deployment URL on the last line
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const url = lines.find((l) => l.startsWith('https://'));
  return url ? `Deployed to Vercel: ${url}` : result.stdout.slice(0, 500);
}

export async function netlifyDeploy(
  sandboxPath: string,
  siteId?: string,
  publishDir: string = '.'
): Promise<string> {
  const token = process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_TOKEN env var is not set');

  const siteFlag = siteId ? `--site ${shellQuote(siteId)}` : '--open';

  const cmd = [
    `npx netlify-cli deploy --prod`,
    `--dir ${shellQuote(publishDir)}`,
    siteFlag,
  ].join(' ');

  // Pass NETLIFY_AUTH_TOKEN via env — Netlify CLI reads it from environment automatically
  const result = await shellExec(cmd, sandboxPath, 180000, { NETLIFY_AUTH_TOKEN: token });

  if (result.exitCode !== 0) {
    throw new Error(`Netlify deploy failed:\n${result.stderr || result.stdout}`);
  }

  // Parse the live URL from Netlify CLI output
  const match = result.stdout.match(/Website URL:\s+(https:\/\/[^\s]+)/);
  return match ? `Deployed to Netlify: ${match[1]}` : result.stdout.slice(0, 500);
}
