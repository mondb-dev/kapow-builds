'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

const SERVICES = [
  { id: 'pipeline', label: 'Pipeline', color: 'text-purple-400' },
  { id: 'technician', label: 'Technician', color: 'text-cyan-400' },
  { id: 'board', label: 'Board', color: 'text-green-400' },
];

export function LogsViewer() {
  const [service, setService] = useState('pipeline');
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [polling, setPolling] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/logs?service=${service}&lines=200`);
        if (res.ok) {
          const data = await res.json();
          if (active) setLines(data.lines);
        }
      } catch {
        // Skip transient fetch failures while polling.
      }
    };

    fetchLogs();
    if (polling) {
      const interval = setInterval(fetchLogs, 3000);
      return () => {
        active = false;
        clearInterval(interval);
      };
    }

    return () => {
      active = false;
    };
  }, [service, polling]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const colorize = (line: string) => {
    if (line.includes('ERROR') || line.includes('error')) return 'text-red-400';
    if (line.includes('WARN') || line.includes('warn')) return 'text-amber-400';
    if (line.includes('Tool:')) return 'text-cyan-300';
    if (line.includes('Result:')) return 'text-gray-500';
    if (line.includes('Pipeline') || line.includes('complete')) return 'text-green-400';
    if (line.includes('Planning') || line.includes('Building') || line.includes('QA')) return 'text-blue-400';
    return 'text-gray-300';
  };

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-white">
      <header className="flex-shrink-0 border-b border-gray-800 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/board" className="text-gray-400 hover:text-white text-sm">← Board</Link>
            <h1 className="text-lg font-semibold">Agent Logs</h1>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={polling}
                onChange={(e) => setPolling(e.target.checked)}
                className="rounded"
              />
              Live
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              Auto-scroll
            </label>
          </div>
        </div>
      </header>

      <div className="flex-shrink-0 border-b border-gray-800 px-6 py-2 flex gap-1 overflow-x-auto">
        {SERVICES.map((svc) => (
          <button
            key={svc.id}
            onClick={() => setService(svc.id)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
              service === svc.id
                ? `bg-gray-800 ${svc.color} font-medium`
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900'
            }`}
          >
            {svc.label}
          </button>
        ))}
      </div>

      <div
        ref={logRef}
        className="flex-1 overflow-auto px-6 py-4 font-mono text-xs leading-5"
      >
        {lines.length === 0 ? (
          <p className="text-gray-600">No logs yet for {service}</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`${colorize(line)} whitespace-pre-wrap break-all`}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
