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

  const args = [
    `vercel --prod --yes`,
    `--name ${shellQuote(projectName)}`,
    buildCommand ? `--build-env BUILD_COMMAND=${shellQuote(buildCommand)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Pass VERCEL_TOKEN via env — CLI reads it automatically, never via --token flag
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
  const token = process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN env var is not set');

  const cmd = [
    `netlify deploy --prod`,
    `--dir ${shellQuote(publishDir)}`,
    siteId ? `--site ${shellQuote(siteId)}` : '',
  ].filter(Boolean).join(' ');

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

export async function cloudRunDeploy(
  sandboxPath: string,
  serviceName: string,
  projectDir: string = '.',
  region: string = process.env.GOOGLE_CLOUD_REGION ?? 'asia-southeast1',
  port: number = 8080,
  memory: string = '512Mi',
  envVars?: Record<string, string>,
): Promise<string> {
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
  if (!gcpProject) throw new Error('GOOGLE_CLOUD_PROJECT is required for Cloud Run deploy');

  // Sanitize service name: lowercase, alphanumeric + hyphens, max 63 chars
  const sanitizedName = serviceName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  const imageTag = `${region}-docker.pkg.dev/${gcpProject}/kapow/${sanitizedName}:latest`;

  // Cloud Build submits source remotely — no local Docker required.
  // On GCP VMs, gcloud auto-authenticates via the instance service account.
  const buildCmd = [
    `gcloud builds submit ${shellQuote(projectDir)}`,
    `--tag ${shellQuote(imageTag)}`,
    `--project ${shellQuote(gcpProject)}`,
    `--quiet`,
  ].join(' ');

  const buildResult = await shellExec(buildCmd, sandboxPath, 600_000);
  if (buildResult.exitCode !== 0) {
    throw new Error(`Cloud Build failed:\n${buildResult.stderr || buildResult.stdout}`);
  }

  // Build env-vars flag
  const envFlag = envVars && Object.keys(envVars).length > 0
    ? `--set-env-vars ${shellQuote(Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join(','))}`
    : '';

  const deployCmd = [
    `gcloud run deploy ${shellQuote(sanitizedName)}`,
    `--image ${shellQuote(imageTag)}`,
    `--platform managed`,
    `--region ${shellQuote(region)}`,
    `--allow-unauthenticated`,
    `--port ${port}`,
    `--memory ${shellQuote(memory)}`,
    `--project ${shellQuote(gcpProject)}`,
    `--quiet`,
    envFlag,
  ].filter(Boolean).join(' ');

  const deployResult = await shellExec(deployCmd, sandboxPath, 300_000);
  if (deployResult.exitCode !== 0) {
    throw new Error(`Cloud Run deploy failed:\n${deployResult.stderr || deployResult.stdout}`);
  }

  const urlMatch = deployResult.stdout.match(/Service URL:\s+(https:\/\/[^\s]+)/);
  const url = urlMatch?.[1] ?? '';
  return url ? `Deployed to Cloud Run: ${url}` : deployResult.stdout.slice(0, 500);
}
