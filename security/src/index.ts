import express, { Request, Response, NextFunction } from 'express';
import { isInternalRequestAuthorized } from 'kapow-shared';
import {
  getRecentAlerts, getRecentAudit, acknowledgeAlert,
  analyzePipelineEvent, getAlertStats,
} from './auditor.js';
import { checkAllServices, startHealthMonitor, getLatestHealth } from './observer.js';
import { scanContent } from './scanner.js';
import type { PipelineEvent, ScanRequest, SecurityDashboard } from './types.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT ?? '3007', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') {
    next();
    return;
  }

  if (isInternalRequestAuthorized(req.headers)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Internal authorization required' });
});

// ── Health ───────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-security' });
});

// ── Dashboard (full picture for the board UI) ────────────────────────

app.get('/dashboard', async (_req: Request, res: Response) => {
  const services = getLatestHealth().length > 0 ? getLatestHealth() : await checkAllServices();
  const recentAlerts = await getRecentAlerts(20);
  const auditLog = await getRecentAudit(50);
  const stats = await getAlertStats();
  const healthyCount = services.filter((s) => s.status === 'healthy').length;

  let overallRisk: SecurityDashboard['overallRisk'] = 'low';
  if (stats.critical > 0 || stats.unacknowledged > 10) overallRisk = 'high';
  else if (stats.unacknowledged > 3 || services.some((s) => s.status === 'unhealthy')) overallRisk = 'medium';

  const dashboard: SecurityDashboard = {
    services,
    recentAlerts,
    auditLog,
    overallRisk,
    stats: {
      totalAlerts: stats.total,
      criticalAlerts: stats.critical,
      unacknowledged: stats.unacknowledged,
      servicesHealthy: healthyCount,
      servicesTotal: services.length,
    },
  };

  res.json(dashboard);
});

// ── Alerts ───────────────────────────────────────────────────────────

app.get('/alerts', async (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit ?? '50'), 10);
  res.json(await getRecentAlerts(limit));
});

app.post('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  const ok = await acknowledgeAlert(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  res.json({ acknowledged: true });
});

// ── Audit Log ────────────────────────────────────────────────────────

app.get('/audit', async (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit ?? '100'), 10);
  res.json(await getRecentAudit(limit));
});

// ── Service Health ───────────────────────────────────────────────────

app.get('/services', async (_req: Request, res: Response) => {
  const health = await checkAllServices();
  res.json(health);
});

// ── Pipeline Event Ingestion (called by orchestrator) ────────────────

app.post('/event', async (req: Request, res: Response) => {
  const event = req.body as PipelineEvent;

  if (!event.service || !event.action) {
    res.status(400).json({ error: 'service and action are required' });
    return;
  }

  const alerts = await analyzePipelineEvent(event);
  res.json({
    processed: true,
    alertsGenerated: alerts.length,
    alerts: alerts.map((a) => ({ id: a.id, severity: a.severity, message: a.message })),
  });
});

// ── Deep Scan (AI-powered analysis) ──────────────────────────────────

app.post('/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as ScanRequest;

    if (!body.runId || !body.content || !body.type) {
      res.status(400).json({ error: 'runId, type, and content are required' });
      return;
    }

    console.log(`[${body.runId}] Security scan (${body.type})...`);
    const result = await scanContent(body);
    console.log(`[${body.runId}] Scan complete: risk=${result.riskScore}, alerts=${result.alerts.length}`);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Security error:', err);
  res.status(500).json({ error: err.message });
});

// Start health monitor on boot
startHealthMonitor(30_000);

// Start bus monitoring if BUS_URL is configured
if (process.env.BUS_URL) {
  import('./bus-integration.js').then((m) => m.startBusMonitoring()).catch((err) => {
    console.warn(`[security] Bus monitoring disabled: ${err}`);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`kapow-security listening on ${HOST}:${PORT}`);
});
