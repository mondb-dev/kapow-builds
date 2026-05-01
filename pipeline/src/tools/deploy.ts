import { shellExec } from './shell.js';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Pull the actionable error out of a multi-megabyte gcloud builds log.
 * The real error is usually buried near the end after "ERROR" or in a
 * "returned a non-zero code" line. Returning the whole log overwhelms
 * the LLM and it just says "build failed" without identifying root cause.
 */
function extractBuildError(stdout: string, stderr: string): string {
  const all = (stdout + '\n' + stderr).split('\n');
  // Look for known error signatures, prefer the most specific
  const patterns = [
    /Node\.js version[^\n]+/i,
    /required engine[^\n]+/i,
    /Cannot find module[^\n]+/i,
    /Module not found[^\n]+/i,
    /returned a non-zero code:[^\n]*\n?[^\n]+/i,
    /(?:^|\n)ERROR:?\s*([^\n]+)/i,
    /failed: step exited[^\n]+/i,
    /(?:gcloud|gsutil)\.[a-z.]+\)\s+([^\n]+)/i,
  ];
  for (const pat of patterns) {
    for (const line of all) {
      const m = line.match(pat);
      if (m) return line.trim().slice(0, 500);
    }
  }
  // Fallback: last 500 chars of stderr or stdout
  const fallback = (stderr || stdout).trim();
  return fallback.slice(-500);
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

type FirebaseTarget = 'hosting' | 'functions' | 'firestore' | 'storage' | 'all';

async function firebaseDeployCore(
  sandboxPath: string,
  projectId: string,
  targets: FirebaseTarget[] = ['hosting'],
  publicDir: string = 'dist',
  functionsRuntime: string = 'nodejs20',
): Promise<string> {
  const gcpProject = projectId || process.env.GOOGLE_CLOUD_PROJECT;
  if (!gcpProject) throw new Error('GOOGLE_CLOUD_PROJECT is required for Firebase deploy');

  const onlyFlag = targets.includes('all') ? '' : `--only ${targets.join(',')}`;

  // Write firebase.json if missing, including all requested targets
  const firebaseJson = join(sandboxPath, 'firebase.json');
  if (!existsSync(firebaseJson)) {
    const config: Record<string, unknown> = {};
    if (targets.includes('hosting') || targets.includes('all')) {
      config.hosting = {
        public: publicDir,
        ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
        rewrites: [{ source: '**', destination: '/index.html' }],
      };
    }
    if (targets.includes('functions') || targets.includes('all')) {
      config.functions = [{ source: 'functions', codebase: 'default', runtime: functionsRuntime }];
    }
    if (targets.includes('firestore') || targets.includes('all')) {
      config.firestore = { rules: 'firestore.rules', indexes: 'firestore.indexes.json' };
    }
    if (targets.includes('storage') || targets.includes('all')) {
      config.storage = [{ rules: 'storage.rules' }];
    }
    writeFileSync(firebaseJson, JSON.stringify(config, null, 2));
  }

  const firebaserc = join(sandboxPath, '.firebaserc');
  if (!existsSync(firebaserc)) {
    writeFileSync(firebaserc, JSON.stringify({ projects: { default: gcpProject } }, null, 2));
  }

  const extraEnv: Record<string, string> = {};
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    extraEnv.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  await shellExec('npm install --save-dev firebase-tools', sandboxPath, 60_000, extraEnv);

  // Install functions dependencies if needed
  if ((targets.includes('functions') || targets.includes('all')) && existsSync(join(sandboxPath, 'functions'))) {
    await shellExec('cd functions && npm install', sandboxPath, 60_000, extraEnv);
  }

  const result = await shellExec(
    `npx firebase deploy ${onlyFlag} --project ${gcpProject} --non-interactive`,
    sandboxPath,
    300_000,
    extraEnv,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Firebase deploy failed:\n${result.stderr || result.stdout}`);
  }

  const hostingMatch = result.stdout.match(/Hosting URL:\s+(https:\/\/[^\s]+)/);
  const functionsMatch = result.stdout.match(/Function URL[^:]*:\s+(https:\/\/[^\s]+)/g);
  const lines: string[] = [];
  if (hostingMatch) lines.push(`Hosting: ${hostingMatch[1]}`);
  if (functionsMatch) lines.push(...functionsMatch.map(l => `Function: ${l.split(/\s+/).pop()}`));
  if (lines.length === 0) lines.push(`Deployed to Firebase (project: ${gcpProject})`);
  return lines.join('\n');
}

export async function firebaseDeploy(
  sandboxPath: string,
  projectId: string,
  publicDir: string = 'dist',
): Promise<string> {
  return firebaseDeployCore(sandboxPath, projectId, ['hosting'], publicDir);
}

export async function firebaseFunctionsDeploy(
  sandboxPath: string,
  projectId: string,
  runtime: string = 'nodejs20',
): Promise<string> {
  return firebaseDeployCore(sandboxPath, projectId, ['functions'], '.', runtime);
}

export async function firebaseFullDeploy(
  sandboxPath: string,
  projectId: string,
  targets: FirebaseTarget[],
  publicDir: string = 'dist',
  functionsRuntime: string = 'nodejs20',
): Promise<string> {
  return firebaseDeployCore(sandboxPath, projectId, targets, publicDir, functionsRuntime);
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
    throw new Error(`Cloud Build failed: ${extractBuildError(buildResult.stdout, buildResult.stderr)}`);
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
