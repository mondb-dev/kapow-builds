import puppeteer, { Browser, Page } from 'puppeteer-core';
import { resolveSandboxPath } from '../sandbox.js';

let browser: Browser | null = null;
let page: Page | null = null;

async function getPage(): Promise<Page> {
  if (!browser) {
    const wsEndpoint = process.env.CHROME_WS_ENDPOINT;
    if (wsEndpoint) {
      // Connect to existing Chrome via CDP
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    } else {
      // Try to launch Chrome
      const executablePath =
        process.env.CHROME_PATH ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
  }
  return page;
}

export async function browserNavigate(url: string): Promise<string> {
  const p = await getPage();
  const response = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return `Navigated to ${url} — status: ${response?.status() ?? 'unknown'}`;
}

export async function browserScreenshot(sandboxPath: string, filename: string): Promise<string> {
  const p = await getPage();
  const screenshotPath = resolveSandboxPath(sandboxPath, filename.endsWith('.png') ? filename : `${filename}.png`);
  await p.screenshot({ path: screenshotPath, fullPage: true });
  return `Screenshot saved to ${screenshotPath}`;
}

export async function browserGetContent(): Promise<string> {
  const p = await getPage();
  return p.content();
}

export async function browserEval(script: string): Promise<unknown> {
  const p = await getPage();
  return p.evaluate(script);
}

export async function closeBrowser(): Promise<void> {
  if (page && !page.isClosed()) {
    await page.close();
    page = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/** Cleanup function that closes the browser. Callable from outside for resource teardown. */
export async function cleanup(): Promise<void> {
  await closeBrowser();
}
