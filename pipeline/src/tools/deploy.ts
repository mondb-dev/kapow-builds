import { shellExec } from './shell.js';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

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

  // Resolve scope: explicit env var > derive from token via API
  let scope = process.env.VERCEL_SCOPE ?? '';
  if (!scope) {
    try {
      const r = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json() as { user?: { defaultTeamId?: string } };
      scope = data.user?.defaultTeamId ?? '';
    } catch { /* skip — CLI will error with a clear message */ }
  }

  const args = [
    `npx vercel --prod --yes`,
    `--name ${shellQuote(projectName)}`,
    scope ? `--scope ${shellQuote(scope)}` : '',
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

export async function firebaseDeploy(
  sandboxPath: string,
  projectId: string,
  publicDir: string = 'dist',
): Promise<string> {
  const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const gcpProject = projectId || process.env.GOOGLE_CLOUD_PROJECT;
  if (!gcpProject) throw new Error('GOOGLE_CLOUD_PROJECT is required for Firebase deploy');

  // Write a minimal firebase.json if one doesn't exist
  const firebaseJson = join(sandboxPath, 'firebase.json');
  if (!existsSync(firebaseJson)) {
    writeFileSync(firebaseJson, JSON.stringify({
      hosting: {
        public: publicDir,
        ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
        rewrites: [{ source: '**', destination: '/index.html' }],
      },
    }, null, 2));
  }

  // Write .firebaserc if not present
  const firebaserc = join(sandboxPath, '.firebaserc');
  if (!existsSync(firebaserc)) {
    writeFileSync(firebaserc, JSON.stringify({ projects: { default: gcpProject } }, null, 2));
  }

  const extraEnv: Record<string, string> = {};
  if (serviceAccount) extraEnv.GOOGLE_APPLICATION_CREDENTIALS = serviceAccount;

  // Install firebase-tools locally if needed
  await shellExec('npm install --save-dev firebase-tools', sandboxPath, 60_000, extraEnv);

  const result = await shellExec(
    `npx firebase deploy --only hosting --project ${gcpProject} --non-interactive`,
    sandboxPath,
    180_000,
    extraEnv,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Firebase deploy failed:\n${result.stderr || result.stdout}`);
  }

  const match = result.stdout.match(/Hosting URL:\s+(https:\/\/[^\s]+)/);
  const url = match?.[1] ?? `https://${gcpProject}.web.app`;
  return `Deployed to Firebase Hosting: ${url}`;
}
