import axios from 'axios';

const BOARD_URL = process.env.BOARD_URL ?? 'http://localhost:3005';

export interface CardCreatePayload {
  title: string;
  description: string;
  status: 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
  runId: string;
  phaseId: string;
  taskId: string;
}

export interface CardUpdatePayload {
  status?: 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
}

export interface CardEventPayload {
  message: string;
  type: 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS';
}

interface CardResponse {
  id: string;
  title: string;
  status: string;
}

/**
 * Board API client for programmatic card management.
 * Uses the /api/internal/* routes which don't require auth (service-to-service).
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
        { timeout: 10_000 }
      );
      return res.data;
    } catch (err) {
      console.error(`Board: failed to create card for task ${payload.taskId}:`, err instanceof Error ? err.message : err);
      // Non-fatal — pipeline continues even if board is down
      return { id: `offline-${payload.taskId}`, title: payload.title, status: payload.status };
    }
  }

  async updateCardStatus(cardId: string, status: CardUpdatePayload['status']): Promise<void> {
    try {
      await axios.patch(
        `${this.baseUrl}/api/internal/cards/${cardId}`,
        { status },
        { timeout: 10_000 }
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
        { timeout: 10_000 }
      );
    } catch (err) {
      console.error(`Board: failed to add event to card ${cardId}:`, err instanceof Error ? err.message : err);
    }
  }
}
