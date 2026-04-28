import { writeFileSync } from 'fs';
import { isIP } from 'net';
import puppeteer, { Browser, BrowserContext, Page } from 'puppeteer-core';
import { resolveSandboxPath } from '../agents/sandbox.js';

let browser: Browser | null = null;

// Per-sandbox isolated browser contexts. Each run gets its own context with
// separate cookies / localStorage / cache so navigation in run A cannot leak
// authenticated session state into run B.
const sessions = new Map<string, { context: BrowserContext; page: Page }>();

// URL validation: block SSRF vectors. Schemes are restricted to http(s);
// hosts pointing at loopback, link-local, cloud metadata, or RFC1918
// ranges are refused unless explicitly allowed via BROWSER_URL_ALLOWLIST
// (comma-separated hostnames, exact match).
const BROWSER_URL_ALLOWLIST = new Set(
  (process.env.BROWSER_URL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;                          // loopback
  if (a === 169 && b === 254) return true;             // link-local incl. 169.254.169.254 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower === '::ffff:127.0.0.1' || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.')) return true;
  return false;
}

function assertSafeUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) URL scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BROWSER_URL_ALLOWLIST.has(host)) return;

  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) {
    throw new Error(`Refusing loopback host: ${host}`);
  }
  if (host === 'metadata.google.internal' || host === 'metadata') {
    throw new Error(`Refusing cloud metadata host: ${host}`);
  }
  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateIPv4(host)) {
    throw new Error(`Refusing private/loopback IPv4: ${host}`);
  }
  if (ipKind === 6 && isPrivateIPv6(host)) {
    throw new Error(`Refusing private/loopback IPv6: ${host}`);
  }
}

const HELMSTACK_BASE_URL = normalizeHelmStackUrl(process.env.HELMSTACK_AGENT_URL ?? process.env.HELMSTACK_URL ?? '');

function normalizeHelmStackUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed.replace(/\/$/, '');
  return `http://${trimmed.replace(/\/$/, '')}`;
}

function isHelmStackEnabled(): boolean {
  return !!HELMSTACK_BASE_URL;
}

async function fetchHelmStackTabId(): Promise<string> {
  if (!HELMSTACK_BASE_URL) {
    throw new Error('HELMSTACK_AGENT_URL is not configured');
  }

  const res = await fetch(`${HELMSTACK_BASE_URL}/api/tabs`, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`HelmStack /api/tabs returned ${res.status}`);
  }

  const payload = await res.json() as unknown;
  const tabs = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as { tabs?: unknown[] }).tabs)
      ? (payload as { tabs: unknown[] }).tabs
      : []);

  const validTabs = tabs.filter((t): t is { id: string; isActive?: boolean } =>
    !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string'
  );

  const active = validTabs.find((t) => t.isActive);
  if (active?.id) return active.id;
  if (validTabs[0]?.id) return validTabs[0].id;

  throw new Error('HelmStack has no open tabs. Open a tab in HelmStack first.');
}

async function helmstackNavigate(url: string): Promise<string> {
  if (!HELMSTACK_BASE_URL) {
    throw new Error('HELMSTACK_AGENT_URL is not configured');
  }

  const tabId = await fetchHelmStackTabId();
  const endpoints = [
    `${HELMSTACK_BASE_URL}/api/tabs/${encodeURIComponent(tabId)}/navigate`,
    `${HELMSTACK_BASE_URL}/api/tabs/navigate`,
  ];

  const payloads = [
    { url },
    { tabId, url },
  ];

  const errors: string[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const res = await fetch(endpoints[i], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloads[i]),
    });

    if (res.ok) {
      return `HelmStack navigated tab ${tabId} to ${url}`;
    }

    const text = await res.text().catch(() => '');
    errors.push(`${endpoints[i]} -> ${res.status} ${text.slice(0, 180)}`);
  }

  throw new Error(`HelmStack navigation failed. Tried: ${errors.join(' | ')}`);
}

async function helmstackSetViewport(width: number, height: number): Promise<string> {
  if (!HELMSTACK_BASE_URL) {
    throw new Error('HELMSTACK_AGENT_URL is not configured');
  }

  const tabId = await fetchHelmStackTabId();
  const endpoints = [
    `${HELMSTACK_BASE_URL}/api/tabs/${encodeURIComponent(tabId)}/viewport`,
    `${HELMSTACK_BASE_URL}/api/tabs/viewport`,
  ];

  const payloads = [
    { width, height },
    { tabId, width, height },
  ];

  const errors: string[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const res = await fetch(endpoints[i], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloads[i]),
    });

    if (res.ok) {
      return `HelmStack viewport set to ${width}x${height} for tab ${tabId}`;
    }

    const text = await res.text().catch(() => '');
    errors.push(`${endpoints[i]} -> ${res.status} ${text.slice(0, 180)}`);
  }

  throw new Error(`HelmStack set viewport failed. Tried: ${errors.join(' | ')}`);
}

async function helmstackScreenshot(sandboxPath: string, filename: string): Promise<string> {
  if (!HELMSTACK_BASE_URL) {
    throw new Error('HELMSTACK_AGENT_URL is not configured');
  }

  const tabId = await fetchHelmStackTabId();
  const screenshotPath = resolveSandboxPath(sandboxPath, filename.endsWith('.png') ? filename : `${filename}.png`);

  const endpoints = [
    `${HELMSTACK_BASE_URL}/api/tabs/${encodeURIComponent(tabId)}/screenshot`,
    `${HELMSTACK_BASE_URL}/api/perception/screenshot?tabId=${encodeURIComponent(tabId)}`,
  ];

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'image/png,application/json' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push(`${endpoint} -> ${res.status} ${text.slice(0, 180)}`);
      continue;
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      const body = await res.json() as { imageBase64?: string; screenshotBase64?: string };
      const b64 = body.imageBase64 ?? body.screenshotBase64;
      if (!b64) {
        errors.push(`${endpoint} -> JSON response missing imageBase64`);
        continue;
      }
      writeFileSync(screenshotPath, Buffer.from(b64, 'base64'));
      return `HelmStack screenshot saved to ${screenshotPath}`;
    }

    const bytes = await res.arrayBuffer();
    writeFileSync(screenshotPath, Buffer.from(bytes));
    return `HelmStack screenshot saved to ${screenshotPath}`;
  }

  throw new Error(`HelmStack screenshot failed. Tried: ${errors.join(' | ')}`);
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  const wsEndpoint = process.env.CHROME_WS_ENDPOINT;
  if (wsEndpoint) {
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  } else {
    const executablePath =
      process.env.CHROME_PATH ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browser;
}

async function getPage(sandboxPath: string): Promise<Page> {
  const existing = sessions.get(sandboxPath);
  if (existing && !existing.page.isClosed()) return existing.page;

  const b = await getBrowser();
  const context = await b.createBrowserContext();
  const p = await context.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  sessions.set(sandboxPath, { context, page: p });
  return p;
}

export async function browserNavigate(sandboxPath: string, url: string): Promise<string> {
  assertSafeUrl(url);
  if (isHelmStackEnabled()) {
    return helmstackNavigate(url);
  }

  const p = await getPage(sandboxPath);
  const response = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return `Navigated to ${url} — status: ${response?.status() ?? 'unknown'}`;
}

export async function browserScreenshot(sandboxPath: string, filename: string): Promise<string> {
  if (isHelmStackEnabled()) {
    return helmstackScreenshot(sandboxPath, filename);
  }

  const p = await getPage(sandboxPath);
  const screenshotPath = resolveSandboxPath(sandboxPath, filename.endsWith('.png') ? filename : `${filename}.png`);
  await p.screenshot({ path: screenshotPath, fullPage: true });
  return `Screenshot saved to ${screenshotPath}`;
}

export async function browserSetViewport(sandboxPath: string, width: number, height: number): Promise<string> {
  if (isHelmStackEnabled()) {
    return helmstackSetViewport(width, height);
  }

  const p = await getPage(sandboxPath);
  await p.setViewport({ width, height });
  return `Viewport set to ${width}x${height}`;
}

export async function browserGetContent(sandboxPath: string): Promise<string> {
  const p = await getPage(sandboxPath);
  return p.content();
}

export async function browserEval(sandboxPath: string, script: string): Promise<unknown> {
  const p = await getPage(sandboxPath);
  return p.evaluate(script);
}

/**
 * Close every browser context whose sandbox path includes `runId`.
 * Sandbox paths follow `/tmp/kapow/<runId>` and `/tmp/kapow/<runId>-<taskId>`,
 * so a substring match cleans up all contexts created for that run.
 */
export async function closeBrowsersForRun(runId: string): Promise<void> {
  const matching = [...sessions.keys()].filter((k) => k.includes(runId));
  for (const key of matching) {
    await closeBrowserForSandbox(key);
  }
}

/** Close the browser context for one run — call after the run completes. */
export async function closeBrowserForSandbox(sandboxPath: string): Promise<void> {
  const session = sessions.get(sandboxPath);
  if (!session) return;
  sessions.delete(sandboxPath);
  try {
    if (!session.page.isClosed()) await session.page.close();
  } catch { /* ignore */ }
  try {
    await session.context.close();
  } catch { /* ignore */ }
}

export async function closeBrowser(): Promise<void> {
  for (const key of [...sessions.keys()]) {
    await closeBrowserForSandbox(key);
  }
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
}

/** Cleanup function that closes the browser. Callable from outside for resource teardown. */
export async function cleanup(): Promise<void> {
  await closeBrowser();
}
