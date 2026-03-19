import { randomUUID } from 'crypto';
import { prisma } from './client.js';
import type { AlertSeverity as PrismaAlertSeverity } from '@prisma/client';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertCategory =
  | 'secret_exposure'
  | 'unauthorized_network'
  | 'permission_escalation'
  | 'suspicious_command'
  | 'policy_violation'
  | 'service_anomaly'
  | 'rate_limit'
  | 'general';

const SEV_TO_PRISMA: Record<AlertSeverity, PrismaAlertSeverity> = {
  info: 'INFO',
  warning: 'WARNING',
  critical: 'CRITICAL',
};

const PRISMA_TO_SEV: Record<PrismaAlertSeverity, AlertSeverity> = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

export interface AlertRecord {
  id: string;
  runId: string | null;
  projectId: string | null;
  service: string;
  severity: AlertSeverity;
  category: string;
  message: string;
  details: string;
  acknowledged: boolean;
  createdAt: Date;
}

export interface AuditRecord {
  id: string;
  runId: string | null;
  projectId: string | null;
  service: string;
  action: string;
  details: string;
  riskScore: number;
  createdAt: Date;
}

// ── Alerts ───────────────────────────────────────────────────────────

export async function createAlert(
  service: string,
  severity: AlertSeverity,
  category: AlertCategory,
  message: string,
  details: string,
  runId?: string,
  projectId?: string,
): Promise<AlertRecord> {
  const row = await prisma.securityAlert.create({
    data: {
      id: `alert-${randomUUID().slice(0, 8)}`,
      service,
      severity: SEV_TO_PRISMA[severity],
      category,
      message,
      details,
      runId: runId ?? null,
      projectId: projectId ?? null,
    },
  });

  if (severity === 'critical') {
    console.error(`[SECURITY CRITICAL] ${service}: ${message}`);
  } else if (severity === 'warning') {
    console.warn(`[SECURITY WARNING] ${service}: ${message}`);
  }

  return { ...row, severity: PRISMA_TO_SEV[row.severity] };
}

export async function acknowledgeAlert(id: string): Promise<boolean> {
  try {
    await prisma.securityAlert.update({
      where: { id },
      data: { acknowledged: true },
    });
    return true;
  } catch {
    return false;
  }
}

export async function getRecentAlerts(limit = 50, projectId?: string): Promise<AlertRecord[]> {
  const where = projectId ? { projectId } : {};
  const rows = await prisma.securityAlert.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({ ...r, severity: PRISMA_TO_SEV[r.severity] }));
}

export async function getAlertStats(projectId?: string) {
  const where = projectId ? { projectId } : {};
  const [total, critical, unacknowledged] = await Promise.all([
    prisma.securityAlert.count({ where }),
    prisma.securityAlert.count({ where: { ...where, severity: 'CRITICAL' } }),
    prisma.securityAlert.count({ where: { ...where, acknowledged: false } }),
  ]);
  return { total, critical, unacknowledged };
}

// ── Audit Log ────────────────────────────────────────────────────────

export async function logAudit(
  service: string,
  action: string,
  details: string,
  riskScore: number,
  runId?: string,
  projectId?: string,
): Promise<AuditRecord> {
  return prisma.auditEntry.create({
    data: {
      id: `audit-${randomUUID().slice(0, 8)}`,
      service,
      action,
      details: details.slice(0, 10_000),
      riskScore: Math.min(100, Math.max(0, riskScore)),
      runId: runId ?? null,
      projectId: projectId ?? null,
    },
  });
}

export async function getRecentAudit(limit = 100, projectId?: string): Promise<AuditRecord[]> {
  const where = projectId ? { projectId } : {};
  return prisma.auditEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
