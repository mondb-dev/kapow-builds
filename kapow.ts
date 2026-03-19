#!/usr/bin/env npx tsx
/**
 * Kapow CLI runner
 * Usage: npx tsx kapow.ts <command>
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, copyFileSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import { config } from 'dotenv';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const LOG_DIR = join(ROOT, 'logs');

// ── Interactive prompt helper ────────────────────────────────────────

function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Load .env (skip if running setup) ────────────────────────────────

const cmd = process.argv[2];
if (cmd !== 'setup' && existsSync(ENV_FILE)) {
  config({ path: ENV_FILE });
}

// ── Service definitions ──────────────────────────────────────────────

interface Service {
  name: string;
  dir: string;
  port: number;
}

const AGENTS: Service[] = [
  { name: 'planner',    dir: 'planner',    port: 3001 },
  { name: 'builder',    dir: 'builder',    port: 3002 },
  { name: 'qa',         dir: 'qa',         port: 3003 },
  { name: 'gate',       dir: 'gate',       port: 3004 },
  { name: 'technician', dir: 'technician', port: 3006 },
  { name: 'security',   dir: 'security',   port: 3007 },
  { name: 'comms',      dir: 'comms',      port: 3008 },
  { name: 'actions',    dir: 'actions',    port: 3000 },
];

const BOARD: Service = { name: 'board', dir: 'board', port: 3005 };
const ALL_SERVICES = [...AGENTS, BOARD];

// ── Helpers ──────────────────────────────────────────────────────────

function run(cmd: string, cwd: string, silent = false): void {
  if (!silent) console.log(`  → ${cmd}`);
  execSync(cmd, { cwd, stdio: silent ? 'pipe' : 'inherit' });
}

function runSafe(cmd: string, cwd: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function pidFile(name: string): string {
  return join(LOG_DIR, `${name}.pid`);
}

function logFile(name: string): string {
  return join(LOG_DIR, `${name}.log`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startBackground(name: string, cwd: string, cmd: string, args: string[], extraEnv?: Record<string, string>): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });

  const out = openSync(logFile(name), 'w');
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', out, out],
    detached: true,
    env: { ...process.env, ...extraEnv },
  });

  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  return child;
}

// ═══════════════════════════════════════════════════════════════════════
// SETUP WIZARD
// ═══════════════════════════════════════════════════════════════════════

async function setup() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║         Kapow Setup Wizard           ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  const envVars: Record<string, string> = {};

  // ── Step 1: AI Provider ──────────────────────────────────────────

  console.log('  ── Step 1: AI Provider ──\n');
  const aiProvider = await ask('AI provider (anthropic / gemini)', 'anthropic');
  envVars['AI_PROVIDER'] = aiProvider;

  if (aiProvider === 'gemini' || aiProvider === 'google') {
    const geminiKey = await askSecret('Gemini API key (https://aistudio.google.com/apikey)');
    if (geminiKey) envVars['GEMINI_API_KEY'] = geminiKey;
    // Anthropic key optional when using Gemini
    const anthropicKey = await askSecret('Anthropic API key (optional, press Enter to skip)');
    if (anthropicKey) envVars['ANTHROPIC_API_KEY'] = anthropicKey;
  } else {
    const anthropicKey = await askSecret('Anthropic API key (https://console.anthropic.com/settings/keys)');
    if (anthropicKey) envVars['ANTHROPIC_API_KEY'] = anthropicKey;
    const geminiKey = await askSecret('Gemini API key (optional, press Enter to skip)');
    if (geminiKey) envVars['GEMINI_API_KEY'] = geminiKey;
  }

  // ── Step 2: Database ─────────────────────────────────────────────

  console.log('\n  ── Step 2: Database ──\n');
  const dbChoice = await ask('Postgres setup (docker / local / url)', 'docker');

  let dbUrl: string;

  if (dbChoice === 'docker') {
    const pgPassword = randomBytes(12).toString('hex');
    envVars['POSTGRES_PASSWORD'] = pgPassword;

    console.log('\n  Starting Postgres via Docker...');

    // Stop existing container if any
    runSafe('docker rm -f kapow-pg', ROOT);

    try {
      run(
        `docker run -d --name kapow-pg -p 5432:5432 -e POSTGRES_DB=kapow -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=${pgPassword} postgres:16-alpine`,
        ROOT,
      );
      dbUrl = `postgresql://postgres:${pgPassword}@localhost:5432/kapow`;
      console.log('  Postgres started on localhost:5432\n');

      // Wait for Postgres to be ready
      console.log('  Waiting for Postgres to accept connections...');
      let ready = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (runSafe(`docker exec kapow-pg pg_isready -U postgres`, ROOT)) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        console.warn('  Warning: Postgres may not be ready yet. Continuing anyway...');
      } else {
        console.log('  Postgres is ready.\n');
      }
    } catch {
      console.error('  Docker failed. Do you have Docker installed and running?');
      console.log('  Falling back to manual URL...');
      dbUrl = await ask('Paste your DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/kapow');
    }
  } else if (dbChoice === 'local') {
    console.log('\n  Using local Postgres...');
    const pgExists = runSafe('psql --version', ROOT);
    if (!pgExists) {
      console.warn('  psql not found. Install Postgres: brew install postgresql@16');
    }
    runSafe('createdb kapow 2>/dev/null', ROOT);
    dbUrl = await ask('DATABASE_URL', 'postgresql://localhost:5432/kapow');
  } else {
    dbUrl = await ask('Paste your DATABASE_URL');
  }

  envVars['DATABASE_URL'] = dbUrl;

  // ── Step 3: Board Auth ───────────────────────────────────────────

  console.log('\n  ── Step 3: Board Authentication ──\n');
  envVars['AUTH_SECRET'] = randomBytes(32).toString('base64');
  console.log('  AUTH_SECRET auto-generated.\n');

  const hasGithubOAuth = await ask('Set up GitHub OAuth for board login? (y/n)', 'n');
  if (hasGithubOAuth === 'y') {
    console.log('  Create an OAuth App at: https://github.com/settings/developers');
    console.log('  Callback URL: http://localhost:3005/api/auth/callback/github\n');
    envVars['AUTH_GITHUB_ID'] = await askSecret('GitHub OAuth Client ID');
    envVars['AUTH_GITHUB_SECRET'] = await askSecret('GitHub OAuth Client Secret');
  }

  // ── Step 4: Optional Integrations ────────────────────────────────

  console.log('\n  ── Step 4: Optional Integrations (press Enter to skip) ──\n');

  const githubToken = await askSecret('GitHub Token for repo creation (https://github.com/settings/tokens)');
  if (githubToken) envVars['GITHUB_TOKEN'] = githubToken;

  const vercelToken = await askSecret('Vercel Token (https://vercel.com/account/tokens)');
  if (vercelToken) envVars['VERCEL_TOKEN'] = vercelToken;

  const netlifyToken = await askSecret('Netlify Token (https://app.netlify.com/user/applications)');
  if (netlifyToken) envVars['NETLIFY_TOKEN'] = netlifyToken;

  // ── Step 5: Slack ────────────────────────────────────────────────

  console.log('\n  ── Step 5: Slack Bot (press Enter to skip all) ──\n');
  const slackToken = await askSecret('Slack Bot Token (xoxb-...)');
  if (slackToken) {
    envVars['SLACK_BOT_TOKEN'] = slackToken;
    const slackSecret = await askSecret('Slack Signing Secret');
    if (slackSecret) envVars['SLACK_SIGNING_SECRET'] = slackSecret;
    const slackApp = await askSecret('Slack App Token for Socket Mode (xapp-..., optional)');
    if (slackApp) envVars['SLACK_APP_TOKEN'] = slackApp;
  }

  // ── Write .env ───────────────────────────────────────────────────

  console.log('\n  ── Writing .env ──\n');

  // Start from .env.example as template
  let envContent = existsSync(ENV_EXAMPLE) ? readFileSync(ENV_EXAMPLE, 'utf-8') : '';

  // Replace or append each value
  for (const [key, value] of Object.entries(envVars)) {
    if (!value) continue;
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  writeFileSync(ENV_FILE, envContent, 'utf-8');
  console.log('  .env written.\n');

  // Reload env
  config({ path: ENV_FILE, override: true });

  // ── Step 6: Install Dependencies ─────────────────────────────────

  console.log('  ── Step 6: Installing Dependencies ──\n');
  install();

  // ── Step 7: Database Setup ───────────────────────────────────────

  console.log('\n  ── Step 7: Setting Up Database ──\n');
  try {
    console.log('  Pushing schema...');
    run('npx prisma db push', join(ROOT, 'db'));
    console.log('\n  Seeding initial data...');
    run('npx tsx src/seed.ts', join(ROOT, 'db'));
    console.log('\n  Database ready.\n');
  } catch (err) {
    console.error(`  Database setup failed. You can retry with:`);
    console.log('    npx tsx kapow.ts db:push');
    console.log('    npx tsx kapow.ts db:seed\n');
  }

  // ── Done ─────────────────────────────────────────────────────────

  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║          Setup Complete!              ║');
  console.log('  ╚══════════════════════════════════════╝\n');
  console.log('  Start Kapow:');
  console.log('    npx tsx kapow.ts dev\n');
  console.log('  Then open:');
  console.log('    http://localhost:3005\n');
}

// ═══════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════

function install() {
  console.log('Installing dependencies...\n');

  // Foundation packages first (others depend on these)
  for (const pkg of ['shared', 'db', 'tool-client']) {
    console.log(`[${pkg}]`);
    run('npm install', join(ROOT, pkg));
    if (pkg === 'db') run('npx prisma generate', join(ROOT, pkg));
    console.log('');
  }

  for (const svc of ALL_SERVICES) {
    console.log(`\n[${svc.name}]`);
    run('npm install', join(ROOT, svc.dir));
  }

  console.log('\nAll dependencies installed.');
}

function dev() {
  if (!existsSync(ENV_FILE)) {
    console.log('No .env found. Running setup first...\n');
    setup().then(() => startDev());
    return;
  }
  startDev();
}

function startDev() {
  mkdirSync(LOG_DIR, { recursive: true });

  console.log('Starting all services...\n');

  for (const svc of ALL_SERVICES) {
    const cwd = join(ROOT, svc.dir);
    if (svc.name === 'board') {
      // Board is a Next.js app — use next dev
      startBackground(svc.name, cwd, 'npx', ['next', 'dev', '-p', String(svc.port)], {
        PORT: String(svc.port),
      });
    } else {
      startBackground(svc.name, cwd, 'npx', ['tsx', 'src/index.ts'], {
        PORT: String(svc.port),
      });
    }
    console.log(`  kapow-${svc.name.padEnd(12)} → http://localhost:${svc.port}`);
  }

  console.log(`\nLogs: ${LOG_DIR}/`);
  console.log('Stop: npx tsx kapow.ts stop');
}

function build() {
  console.log('Building all packages...\n');

  // Foundation packages first
  for (const pkg of ['shared', 'db', 'tool-client']) {
    console.log(`[${pkg}]`);
    run('npm run build', join(ROOT, pkg));
    console.log('');
  }

  for (const svc of ALL_SERVICES) {
    console.log(`\n[${svc.name}]`);
    run('npm run build', join(ROOT, svc.dir));
  }

  console.log('\nAll builds complete.');
}

function stop() {
  let stopped = 0;

  for (const svc of ALL_SERVICES) {
    const pf = pidFile(svc.name);
    if (!existsSync(pf)) continue;

    const pid = parseInt(readFileSync(pf, 'utf-8').trim(), 10);
    if (isRunning(pid)) {
      try {
        process.kill(pid);
        console.log(`Stopped ${svc.name} (pid ${pid})`);
        stopped++;
      } catch {
        console.log(`Failed to stop ${svc.name} (pid ${pid})`);
      }
    }
    unlinkSync(pf);
  }

  if (stopped === 0) {
    console.log('No running kapow processes found.');
  }
}

function status() {
  for (const svc of ALL_SERVICES) {
    const pf = pidFile(svc.name);
    if (!existsSync(pf)) {
      console.log(`  ${svc.name.padEnd(12)} not started`);
      continue;
    }

    const pid = parseInt(readFileSync(pf, 'utf-8').trim(), 10);
    if (isRunning(pid)) {
      console.log(`  ${svc.name.padEnd(12)} running (pid ${pid}) → http://localhost:${svc.port}`);
    } else {
      console.log(`  ${svc.name.padEnd(12)} dead (stale pid ${pid})`);
      unlinkSync(pf);
    }
  }
}

function dbMigrate() {
  console.log('Running Prisma migrations...');
  run('npx prisma migrate dev', join(ROOT, 'db'));
}

function dbPush() {
  console.log('Pushing schema to database...');
  run('npx prisma db push', join(ROOT, 'db'));
}

function dbSeed() {
  console.log('Seeding database...');
  run('npx tsx src/seed.ts', join(ROOT, 'db'));
}

function dbStudio() {
  console.log('Opening Prisma Studio...');
  run('npx prisma studio', join(ROOT, 'db'));
}

// ── CLI ──────────────────────────────────────────────────────────────

const COMMANDS: Record<string, { fn: () => void | Promise<void>; desc: string }> = {
  setup:        { fn: setup,      desc: 'Interactive setup wizard (first-time install)' },
  install:      { fn: install,    desc: 'Install all dependencies' },
  dev:          { fn: dev,        desc: 'Start all services (runs setup if no .env)' },
  build:        { fn: build,      desc: 'Build all packages' },
  stop:         { fn: stop,       desc: 'Stop all running services' },
  status:       { fn: status,     desc: 'Show running services' },
  'db:migrate': { fn: dbMigrate,  desc: 'Run Prisma migrations' },
  'db:push':    { fn: dbPush,     desc: 'Push schema to DB (no migration)' },
  'db:seed':    { fn: dbSeed,     desc: 'Seed database with initial data' },
  'db:studio':  { fn: dbStudio,   desc: 'Open Prisma Studio GUI' },
};

if (!cmd || !COMMANDS[cmd]) {
  console.log('\n  Usage: npx tsx kapow.ts <command>\n');
  console.log('  Commands:');
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.log(`    ${name.padEnd(14)} ${desc}`);
  }
  console.log('');
  process.exit(1);
}

const result = COMMANDS[cmd].fn();
if (result instanceof Promise) result.catch((err) => { console.error(err); process.exit(1); });
