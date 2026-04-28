/**
 * Board Channel
 *
 * OutputChannel adapter that wraps the existing kanban board API.
 * This is the primary tracker channel — it supports createTask/listTasks
 * for pipeline state management, plus all notification methods.
 *
 * Delegates to the board's /api/internal/* routes via HTTP,
 * authenticated with the internal API key.
 */
import axios from 'axios';
import { getInternalAuthHeaders } from '../../internal-auth.js';
import type {
  OutputChannel, TaskCreatePayload, TaskRecord,
  TaskStatus, TaskOutput, EventSeverity,
} from '../types.js';

const DEFAULT_BOARD_URL = 'http://localhost:3005';
const TIMEOUT_MS = 10_000;

export class BoardChannel implements OutputChannel {
  readonly name = 'board';
  readonly supportsTracking = true;
  readonly critical = true;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.BOARD_URL ?? DEFAULT_BOARD_URL;
  }

  // ── Tracking ──────────────────────────────────────────────────────

  async createTask(payload: TaskCreatePayload): Promise<TaskRecord> {
    try {
      const res = await axios.post<TaskRecord>(
        `${this.baseUrl}/api/internal/cards`,
        payload,
        { timeout: TIMEOUT_MS, headers: getInternalAuthHeaders() },
      );
      return res.data;
    } catch (err) {
      console.error(`[board] Failed to create card for task ${payload.taskId}:`, err instanceof Error ? err.message : err);
      return { id: `offline-${payload.taskId}`, title: payload.title, status: payload.status };
    }
  }

  async listTasks(runId: string): Promise<TaskRecord[]> {
    try {
      const res = await axios.get<{ cards: TaskRecord[] }>(
        `${this.baseUrl}/api/internal/cards`,
        { params: { runId }, timeout: TIMEOUT_MS, headers: getInternalAuthHeaders() },
      );
      return Array.isArray(res.data.cards) ? res.data.cards : [];
    } catch (err) {
      console.error(`[board] Failed to list cards for run ${runId}:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  // ── Notifications ─────────────────────────────────────────────────

  async onStatusChanged(
    _taskId: string,
    cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void> {
    try {
      const body: Record<string, unknown> = { status };
      if (output) body.output = output;
      await axios.patch(
        `${this.baseUrl}/api/internal/cards/${cardId}`,
        body,
        { timeout: TIMEOUT_MS, headers: getInternalAuthHeaders() },
      );
    } catch (err) {
      console.error(`[board] Failed to update card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }

  async onEvent(
    _taskId: string,
    cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/api/internal/cards/${cardId}/events`,
        { message, type: severity },
        { timeout: TIMEOUT_MS, headers: getInternalAuthHeaders() },
      );
    } catch (err) {
      console.error(`[board] Failed to add event to card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }
}
