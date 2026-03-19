// ── Alert Types ──────────────────────────────────────────────────────

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

export interface SecurityAlert {
  id: string;
  runId?: string;
  service: string;
  severity: AlertSeverity;
  category: AlertCategory;
  message: string;
  details: string;
  timestamp: string;
  acknowledged: boolean;
}

// ── Audit Log Types ──────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  runId?: string;
  service: string;
  action: string;
  details: string;
  riskScore: number;           // 0-100, higher = riskier
}

// ── Service Health Types ─────────────────────────────────────────────

export interface ServiceHealth {
  service: string;
  url: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTimeMs: number;
  lastChecked: string;
  exposedPort?: number;
}

// ── Scan Types ───────────────────────────────────────────────────────

export interface ScanRequest {
  runId: string;
  type: 'artifacts' | 'logs' | 'pipeline';
  content: string;
  service?: string;
}

export interface ScanResult {
  runId: string;
  alerts: SecurityAlert[];
  riskScore: number;
  summary: string;
}

// ── Pipeline Event (received from orchestrator) ──────────────────────

export interface PipelineEvent {
  runId: string;
  service: string;
  action: string;
  data: Record<string, unknown>;
}

// ── Dashboard Types ──────────────────────────────────────────────────

export interface SecurityDashboard {
  services: ServiceHealth[];
  recentAlerts: SecurityAlert[];
  auditLog: AuditEntry[];
  overallRisk: 'low' | 'medium' | 'high';
  stats: {
    totalAlerts: number;
    criticalAlerts: number;
    unacknowledged: number;
    servicesHealthy: number;
    servicesTotal: number;
  };
}
