import { NextRequest, NextResponse } from 'next/server';

const INTERNAL_AUTH_HEADER = 'x-kapow-internal-key';

export function getInternalApiKey(): string {
  return process.env.INTERNAL_API_KEY ?? process.env.AUTH_SECRET ?? '';
}

export function getInternalAuthHeaders(): Record<string, string> {
  const key = getInternalApiKey();
  return key ? { [INTERNAL_AUTH_HEADER]: key } : {};
}

export function requireInternalApiKey(req: NextRequest): NextResponse | null {
  const expected = getInternalApiKey();
  if (!expected) {
    return NextResponse.json({ error: 'Internal API key is not configured' }, { status: 500 });
  }

  if (req.headers.get(INTERNAL_AUTH_HEADER) === expected) {
    return null;
  }

  return NextResponse.json({ error: 'Internal authorization required' }, { status: 401 });
}
