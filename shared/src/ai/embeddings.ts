/**
 * Embedding service using Gemini text-embedding-004.
 * Used for RAG-based recipe and tool matching.
 */

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 3072;

let apiKey: string | null = null;

function getApiKey(): string {
  if (apiKey) return apiKey;
  apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY required for embeddings');
  return apiKey;
}

export interface EmbeddingResult {
  embedding: number[];
  dimension: number;
}

/** Embed a single text string */
export async function embed(text: string): Promise<number[]> {
  const key = getApiKey();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: text.slice(0, 8000) }] },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown');
    throw new Error(`Embedding API error (${res.status}): ${err}`);
  }

  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

/** Embed multiple texts in a batch */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const key = getApiKey();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: text.slice(0, 8000) }] },
        })),
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown');
    throw new Error(`Batch embedding API error (${res.status}): ${err}`);
  }

  const data = await res.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map((e) => e.values);
}

/** Format a vector as a Postgres pgvector literal */
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export { EMBEDDING_DIM };
