import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getInternalAuthHeaders } from '@/lib/internal';

export const dynamic = 'force-dynamic';

const SECURITY_URL = process.env.SECURITY_URL ?? 'http://localhost:3007';

interface ServiceHealth {
  service: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTimeMs: number;
  exposedPort?: number;
}

interface Alert {
  id: string;
  service: string;
  severity: string;
  category: string;
  message: string;
  acknowledged: boolean;
  createdAt: string;
}

interface Dashboard {
  services: ServiceHealth[];
  recentAlerts: Alert[];
  overallRisk: 'low' | 'medium' | 'high';
  stats: {
    totalAlerts: number;
    criticalAlerts: number;
    unacknowledged: number;
    servicesHealthy: number;
    servicesTotal: number;
  };
}

async function fetchDashboard(): Promise<Dashboard | null> {
  try {
    const res = await fetch(`${SECURITY_URL}/dashboard`, {
      headers: getInternalAuthHeaders(),
      next: { revalidate: 10 },
    });
    return res.json();
  } catch {
    return null;
  }
}

const riskColors = {
  low: 'text-green-400 bg-green-400/10 border-green-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  high: 'text-red-400 bg-red-400/10 border-red-400/20',
};

const sevColors: Record<string, string> = {
  CRITICAL: 'text-red-400',
  WARNING: 'text-amber-400',
  INFO: 'text-gray-400',
};

export default async function SecurityPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!session.user.isAdmin) redirect('/board');

  const dashboard = await fetchDashboard();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/board" className="text-gray-400 hover:text-white text-sm">
            ← Board
          </Link>
          <h1 className="text-lg font-semibold">Security Dashboard</h1>
        </div>
      </header>

      {!dashboard ? (
        <main className="max-w-4xl mx-auto p-6 text-center text-gray-500">
          <p>Security service unavailable</p>
        </main>
      ) : (
        <main className="max-w-5xl mx-auto p-6 space-y-6">
          {/* Risk + Stats */}
          <div className="grid grid-cols-4 gap-4">
            <div className={`rounded-lg border p-4 ${riskColors[dashboard.overallRisk]}`}>
              <div className="text-xs uppercase tracking-wide opacity-70">Overall Risk</div>
              <div className="text-2xl font-bold mt-1 capitalize">{dashboard.overallRisk}</div>
            </div>
            <Stat label="Services" value={`${dashboard.stats.servicesHealthy}/${dashboard.stats.servicesTotal}`} />
            <Stat label="Alerts" value={dashboard.stats.totalAlerts} sub={`${dashboard.stats.criticalAlerts} critical`} />
            <Stat label="Unacknowledged" value={dashboard.stats.unacknowledged} />
          </div>

          {/* Services */}
          <section>
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">Services</h2>
            <div className="grid grid-cols-3 gap-3">
              {dashboard.services.map((svc) => (
                <div
                  key={svc.service}
                  className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium text-sm">{svc.service}</div>
                    <div className="text-xs text-gray-500">:{svc.exposedPort}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">{svc.responseTimeMs}ms</span>
                    <span className={`w-2.5 h-2.5 rounded-full ${svc.status === 'healthy' ? 'bg-green-400' : 'bg-red-400'}`} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Recent Alerts */}
          <section>
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">Recent Alerts</h2>
            {dashboard.recentAlerts.length === 0 ? (
              <p className="text-gray-500 text-sm">No alerts</p>
            ) : (
              <div className="space-y-2">
                {dashboard.recentAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-start justify-between ${alert.acknowledged ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`text-xs font-medium uppercase mt-0.5 ${sevColors[alert.severity] ?? 'text-gray-400'}`}>
                        {alert.severity}
                      </span>
                      <div>
                        <div className="text-sm">{alert.message}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {alert.service} · {alert.category} · {new Date(alert.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    {!alert.acknowledged && (
                      <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">new</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
