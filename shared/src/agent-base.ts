/**
 * Agent Base
 *
 * Standardized Express service factory for all Kapow agents.
 * Handles: health checks, error handling, startup validation,
 * structured logging, graceful shutdown.
 *
 * Usage:
 *   const agent = createAgent('planner', { requiresAI: true });
 *   agent.app.post('/plan', async (req, res, next) => { ... });
 *   agent.start();
 */
import express, { Request, Response, NextFunction, type Express } from 'express';

export interface AgentConfig {
  /** Whether this agent needs ANTHROPIC_API_KEY */
  requiresAI?: boolean;

  /** Whether this agent needs DATABASE_URL */
  requiresDB?: boolean;

  /** Custom required env vars (beyond the standard ones) */
  requiredEnv?: string[];

  /** JSON body size limit (default: '10mb') */
  bodyLimit?: string;

  /** Custom health check data (merged into health response) */
  healthData?: () => Record<string, unknown> | Promise<Record<string, unknown>>;

  /** Called before the server starts listening */
  onBoot?: () => void | Promise<void>;

  /** Called on SIGTERM/SIGINT for cleanup */
  onShutdown?: () => void | Promise<void>;
}

export interface Agent {
  app: Express;
  start: () => void;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export function createAgent(name: string, config: AgentConfig = {}): Agent {
  const app = express();
  app.use(express.json({ limit: config.bodyLimit ?? '10mb' }));

  const PORT = parseInt(process.env.PORT ?? '3000', 10);

  // ── Structured logging ─────────────────────────────────────────

  function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${name}]`;
    switch (level) {
      case 'error': console.error(`${prefix} ERROR: ${msg}`); break;
      case 'warn':  console.warn(`${prefix} WARN: ${msg}`); break;
      default:      console.log(`${prefix} ${msg}`); break;
    }
  }

  // ── Startup validation ─────────────────────────────────────────

  function validateEnv(): void {
    const missing: string[] = [];

    if (config.requiresAI && !process.env.ANTHROPIC_API_KEY) {
      missing.push('ANTHROPIC_API_KEY');
    }
    if (config.requiresDB && !process.env.DATABASE_URL) {
      missing.push('DATABASE_URL');
    }
    for (const key of config.requiredEnv ?? []) {
      if (!process.env[key]) missing.push(key);
    }

    if (missing.length > 0) {
      log(`Missing required env vars: ${missing.join(', ')}`, 'error');
      process.exit(1);
    }
  }

  // ── Health check ───────────────────────────────────────────────

  app.get('/health', async (_req: Request, res: Response) => {
    const base = { status: 'ok', service: `kapow-${name}`, uptime: process.uptime() };
    if (config.healthData) {
      const extra = await config.healthData();
      res.json({ ...base, ...extra });
    } else {
      res.json(base);
    }
  });

  // ── Error handler (registered last, before start) ──────────────

  function attachErrorHandler() {
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      log(`${err.message}\n${err.stack ?? ''}`, 'error');
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  // ── Graceful shutdown ──────────────────────────────────────────

  function attachShutdown() {
    const handler = async () => {
      log('Shutting down...');
      if (config.onShutdown) await config.onShutdown();
      process.exit(0);
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  // ── Start ──────────────────────────────────────────────────────

  function start() {
    validateEnv();
    attachErrorHandler();
    attachShutdown();

    const boot = async () => {
      if (config.onBoot) await config.onBoot();
      app.listen(PORT, () => {
        log(`listening on port ${PORT}`);
      });
    };

    boot().catch((err) => {
      log(`Boot failed: ${err}`, 'error');
      process.exit(1);
    });
  }

  return { app, start, log };
}
