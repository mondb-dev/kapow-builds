import type { IncomingHttpHeaders } from 'http';

export const INTERNAL_AUTH_HEADER = 'x-kapow-internal-key';

export function getInternalApiKey(): string {
  return process.env.INTERNAL_API_KEY ?? process.env.AUTH_SECRET ?? '';
}

export function getInternalAuthHeaders(): Record<string, string> {
  const key = getInternalApiKey();
  return key ? { [INTERNAL_AUTH_HEADER]: key } : {};
}

export function isInternalRequestAuthorized(
  headers: Headers | IncomingHttpHeaders,
  expectedKey = getInternalApiKey(),
): boolean {
  if (!expectedKey) return false;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(INTERNAL_AUTH_HEADER) === expectedKey;
  }

  const httpHeaders = headers as IncomingHttpHeaders;
  const raw = httpHeaders[INTERNAL_AUTH_HEADER];
  if (Array.isArray(raw)) {
    return raw.includes(expectedKey);
  }

  return raw === expectedKey;
}
