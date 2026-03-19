#!/usr/bin/env npx tsx
/**
 * Kapow CLI runner — replaces bootstrap.sh
 * Usage: npx tsx kapow.ts <command>
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(ROOT, '.env');
const LOG_DIR = join(ROOT, 'logs');

// ── Load .env ────────────────────────────────────────────────────────

if (!existsSync(ENV_FILE)) {
  console.error('ERROR: .env not found. Copy .env.example and fill in your keys.');
  process.exit(1);
}
config({ path: ENV_FILE });

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

function run(cmd: string, cwd: string): void {
  console.log(`  → ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
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

function startBackground(name: string, cwd: string, cmd: string, args: string[]): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });

  const out = require('fs').openSync(logFile(name), 'w');
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', out, out],
    detached: true,
    env: { ...process.env },
  });

  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  return child;
}

// ── Commands ─────────────────────────────────────────────────────────

function install() {
  console.log('Installing dependencies...\n');

  // DB package first (others depend on it)
  console.log('[db]');
  run('npm install', join(ROOT, 'db'));
  run('npx prisma generate', join(ROOT, 'db'));

  // Tool client
  console.log('\n[tool-client]');
  run('npm install', join(ROOT, 'tool-client'));

  for (const svc of ALL_SERVICES) {
    console.log(`\n[${svc.name}]`);
    run('npm install', join(ROOT, svc.dir));
  }

  console.log('\nAll dependencies installed.');
}

function dev() {
  mkdirSync(LOG_DIR, { recursive: true });

  console.log('Starting all services...\n');

  for (const svc of ALL_SERVICES) {
    const cwd = join(ROOT, svc.dir);
    startBackground(svc.name, cwd, 'npx', ['tsx', 'src/index.ts']);
    console.log(`  kapow-${svc.name.padEnd(12)} → http://localhost:${svc.port}`);
  }

  console.log(`\nLogs: ${LOG_DIR}/`);
  console.log('Stop: npx tsx kapow.ts stop');
}

function build() {
  console.log('Building all packages...\n');

  // DB first
  console.log('[db]');
  run('npm run build', join(ROOT, 'db'));

  // Tool client
  console.log('\n[tool-client]');
  run('npm run build', join(ROOT, 'tool-client'));

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

const COMMANDS: Record<string, { fn: () => void; desc: string }> = {
  install:      { fn: install,    desc: 'Install all dependencies (db first)' },
  dev:          { fn: dev,        desc: 'Start all services in background' },
  build:        { fn: build,      desc: 'Build all packages' },
  stop:         { fn: stop,       desc: 'Stop all running services' },
  status:       { fn: status,     desc: 'Show running services' },
  'db:migrate': { fn: dbMigrate,  desc: 'Run Prisma migrations' },
  'db:push':    { fn: dbPush,     desc: 'Push schema to DB (no migration)' },
  'db:seed':    { fn: dbSeed,     desc: 'Seed database with initial data' },
  'db:studio':  { fn: dbStudio,   desc: 'Open Prisma Studio' },
};

const cmd = process.argv[2];

if (!cmd || !COMMANDS[cmd]) {
  console.log('Usage: npx tsx kapow.ts <command>\n');
  console.log('Commands:');
  for (const [name, { desc }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(14)} ${desc}`);
  }
  process.exit(1);
}

COMMANDS[cmd].fn();
