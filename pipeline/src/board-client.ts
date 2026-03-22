import axios from 'axios';
import { getInternalAuthHeaders } from 'kapow-shared';

const BOARD_URL = process.env.BOARD_URL ?? 'http://localhost:3005';

export interface CardCreatePayload {
  title: string;
  description: string;
  status: 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
  runId: string;
  phaseId: string;
  taskId: string;
  projectId?: string;
}

export interface CardUpdatePayload {
  status?: 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
  output?: CardOutput;
}

export interface CardOutput {
  type: 'files' | 'url' | 'summary';
  files?: Array<{ name: string; path: string; size?: number }>;
  url?: string;
  summary?: string;
  runId?: string;
}

export interface CardEventPayload {
  message: string;
  type: 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS';
}

interface CardResponse {
  id: string;
  title: string;
  description?: string;
  status: string;
  taskId?: string | null;
  phaseId?: string | null;
}

/**
 * Board API client for programmatic card management.
 * Uses the /api/internal/* routes with an internal service credential.
 */
export class BoardClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BOARD_URL;
  }

  async createCard(payload: CardCreatePayload): Promise<CardResponse> {
    try {
      const res = await axios.post<CardResponse>(
        `${this.baseUrl}/api/internal/cards`,
        payload,
        {
          timeout: 10_000,
          headers: getInternalAuthHeaders(),
        }
      );
      return res.data;
    } catch (err) {
      console.error(`Board: failed to create card for task ${payload.taskId}:`, err instanceof Error ? err.message : err);
      // Non-fatal — pipeline continues even if board is down
      return { id: `offline-${payload.taskId}`, title: payload.title, status: payload.status };
    }
  }

  async listCards(runId: string): Promise<CardResponse[]> {
    try {
      const res = await axios.get<{ cards: CardResponse[] }>(
        `${this.baseUrl}/api/internal/cards`,
        {
          params: { runId },
          timeout: 10_000,
          headers: getInternalAuthHeaders(),
        },
      );
      return Array.isArray(res.data.cards) ? res.data.cards : [];
    } catch (err) {
      console.error(`Board: failed to list cards for run ${runId}:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  async updateCardStatus(cardId: string, status: CardUpdatePayload['status']): Promise<void> {
    try {
      await axios.patch(
        `${this.baseUrl}/api/internal/cards/${cardId}`,
        { status },
        {
          timeout: 10_000,
          headers: getInternalAuthHeaders(),
        }
      );
    } catch (err) {
      console.error(`Board: failed to update card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }

  async updateCard(cardId: string, payload: CardUpdatePayload): Promise<void> {
    try {
      await axios.patch(
        `${this.baseUrl}/api/internal/cards/${cardId}`,
        payload,
        {
          timeout: 10_000,
          headers: getInternalAuthHeaders(),
        }
      );
    } catch (err) {
      console.error(`Board: failed to update card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }

  async addCardEvent(cardId: string, event: CardEventPayload): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/api/internal/cards/${cardId}/events`,
        event,
        {
          timeout: 10_000,
          headers: getInternalAuthHeaders(),
        }
      );
    } catch (err) {
      console.error(`Board: failed to add event to card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }
}
