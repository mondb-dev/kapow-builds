import axios from 'axios';
import type { ServiceHealth } from './types.js';

export interface ServiceEndpoint {
  name: string;
  url: string;
  port: number;
}

const DEFAULT_SERVICES: ServiceEndpoint[] = [
  { name: 'actions', url: process.env.ACTIONS_URL ?? 'http://localhost:3000', port: 3000 },
  { name: 'planner', url: process.env.PLANNER_URL ?? 'http://localhost:3001', port: 3001 },
  { name: 'builder', url: process.env.BUILDER_URL ?? 'http://localhost:3002', port: 3002 },
  { name: 'qa', url: process.env.QA_URL ?? 'http://localhost:3003', port: 3003 },
  { name: 'gate', url: process.env.GATE_URL ?? 'http://localhost:3004', port: 3004 },
  { name: 'board', url: process.env.BOARD_URL ?? 'http://localhost:3005', port: 3005 },
  { name: 'technician', url: process.env.TECHNICIAN_URL ?? 'http://localhost:3006', port: 3006 },
];

export async function checkServiceHealth(endpoint: ServiceEndpoint): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    await axios.get(`${endpoint.url}/health`, { timeout: 5000 });
    return {
      service: endpoint.name,
      url: endpoint.url,
      status: 'healthy',
      responseTimeMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
      exposedPort: endpoint.port,
    };
  } catch {
    return {
      service: endpoint.name,
      url: endpoint.url,
      status: 'unhealthy',
      responseTimeMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
      exposedPort: endpoint.port,
    };
  }
}

export async function checkAllServices(): Promise<ServiceHealth[]> {
  return Promise.all(DEFAULT_SERVICES.map(checkServiceHealth));
}

// Periodic health monitor
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let latestHealthSnapshot: ServiceHealth[] = [];

export function startHealthMonitor(intervalMs: number = 30_000): void {
  if (monitorInterval) return;

  const tick = async () => {
    latestHealthSnapshot = await checkAllServices();
    const unhealthy = latestHealthSnapshot.filter((s) => s.status === 'unhealthy');
    if (unhealthy.length > 0) {
      console.warn(`[security] Unhealthy services: ${unhealthy.map((s) => s.service).join(', ')}`);
    }
  };

  // Run immediately, then on interval
  tick();
  monitorInterval = setInterval(tick, intervalMs);
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function getLatestHealth(): ServiceHealth[] {
  return latestHealthSnapshot;
}
