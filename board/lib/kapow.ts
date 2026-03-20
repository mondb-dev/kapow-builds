import { getInternalAuthHeaders } from './internal';

const KAPOW_URL = process.env.KAPOW_ACTIONS_URL ?? 'http://localhost:3000';

export interface PipelineStatus {
  status: string;
  messages: string[];
}

export async function triggerPipeline(runId: string, plan: string, projectId?: string): Promise<void> {
  const res = await fetch(`${KAPOW_URL}/pipeline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getInternalAuthHeaders(),
    },
    body: JSON.stringify({ runId, plan, projectId }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`kapow-actions /pipeline returned ${res.status}: ${text}`);
  }
}

export async function getPipelineStatus(runId: string): Promise<PipelineStatus> {
  const res = await fetch(`${KAPOW_URL}/runs/${runId}/status`, {
    headers: getInternalAuthHeaders(),
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`kapow-actions /runs/${runId}/status returned ${res.status}`);
  }

  return res.json() as Promise<PipelineStatus>;
}

export async function stopPipeline(runId: string, reason = 'Stopped by user.'): Promise<void> {
  const res = await fetch(`${KAPOW_URL}/runs/${runId}/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getInternalAuthHeaders(),
    },
    body: JSON.stringify({ reason }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`kapow-actions /runs/${runId}/stop returned ${res.status}: ${text}`);
  }
}
