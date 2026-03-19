/**
 * Security auditor — now backed by Postgres via kapow-db.
 * Replaces the old JSON file-based alerts and audit log.
 */
import {
  createAlert as dbCreateAlert,
  acknowledgeAlert as dbAcknowledgeAlert,
  getRecentAlerts as dbGetRecentAlerts,
  getAlertStats as dbGetAlertStats,
  logAudit as dbLogAudit,
  getRecentAudit as dbGetRecentAudit,
  type AlertRecord,
  type AuditRecord,
  type AlertSeverity,
  type AlertCategory,
} from 'kapow-db/security';
import type { PipelineEvent } from './types.js';

export type { AlertRecord, AuditRecord, AlertSeverity, AlertCategory };

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
  return dbCreateAlert(service, severity, category, message, details, runId, projectId);
}

export async function acknowledgeAlert(id: string): Promise<boolean> {
  return dbAcknowledgeAlert(id);
}

export async function getRecentAlerts(limit = 50, projectId?: string): Promise<AlertRecord[]> {
  return dbGetRecentAlerts(limit, projectId);
}

export async function getAlertStats(projectId?: string) {
  return dbGetAlertStats(projectId);
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
  return dbLogAudit(service, action, details, riskScore, runId, projectId);
}

export async function getRecentAudit(limit = 100, projectId?: string): Promise<AuditRecord[]> {
  return dbGetRecentAudit(limit, projectId);
}

// ── Pipeline Event Analysis ──────────────────────────────────────────

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|password|token|credential|auth)[\s]*[=:]\s*['"][^'"]{8,}/i,
  /(?:sk-|pk-|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9]{20,}/,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
];

const DANGEROUS_COMMANDS = [
  /rm\s+-rf\s+\//,
  /chmod\s+777/,
  /curl\s+.*\|\s*(?:bash|sh|zsh)/,
  /wget\s+.*\|\s*(?:bash|sh|zsh)/,
  /eval\s*\(/,
  /exec\s*\(/,
  /child_process/,
  /process\.env\.\w+.*(?:console|log|print|write)/i,
];

export async function analyzePipelineEvent(event: PipelineEvent): Promise<AlertRecord[]> {
  const alerts: AlertRecord[] = [];
  const content = JSON.stringify(event.data);

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      const alert = await createAlert(
        event.service,
        'critical',
        'secret_exposure',
        'Potential secret detected in pipeline output',
        `Pattern matched in ${event.action}: ${pattern.source.slice(0, 50)}`,
        event.runId,
      );
      alerts.push(alert);
      break;
    }
  }

  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(content)) {
      const alert = await createAlert(
        event.service,
        'warning',
        'suspicious_command',
        'Potentially dangerous command detected',
        `Pattern: ${pattern.source.slice(0, 50)} in ${event.action}`,
        event.runId,
      );
      alerts.push(alert);
      break;
    }
  }

  const riskScore = alerts.length > 0
    ? alerts.some((a) => a.severity === 'critical') ? 80 : 40
    : 5;

  await logAudit(event.service, event.action, content.slice(0, 500), riskScore, event.runId);

  return alerts;
}
