import { config } from '../config.js';
import { getBrowserSession, saveBrowserSession, setSetting } from '../db/repo.js';
import { createLogger, errMessage } from '../logger.js';
import type { Platform } from '../types.js';

const log = createLogger('browser');

/** Minimal structural types so we don't need playwright's types at build time. */
type AnyPage = any;
type AnyContext = any;

let chromiumPromise: Promise<any | null> | null = null;

async function getChromium(): Promise<any | null> {
  if (!chromiumPromise) {
    chromiumPromise = import('playwright')
      .then((m) => m.chromium)
      .catch((e) => {
        log.warn(`playwright を読み込めませんでした: ${errMessage(e)}`);
        return null;
      });
  }
  return chromiumPromise;
}

export async function browserAvailable(): Promise<boolean> {
  if (!config.ENABLE_BROWSER_AUTOMATION) return false;
  return (await getChromium()) !== null;
}

export class BrowserUnavailable extends Error {}

/** A real desktop UA — the mobile/bot default gets a different DOM. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Runs `fn` against a logged-in browser context restored from the stored
 * session cookies, then writes the (possibly refreshed) cookies back so the
 * login survives as long as possible.
 */
export async function withContext<T>(
  platform: Platform,
  fn: (page: AnyPage, context: AnyContext) => Promise<T>,
): Promise<T> {
  if (!config.ENABLE_BROWSER_AUTOMATION) {
    throw new BrowserUnavailable('ENABLE_BROWSER_AUTOMATION=false のためブラウザ操作は無効です');
  }

  const chromium = await getChromium();
  if (!chromium) {
    throw new BrowserUnavailable('playwright/Chromium が利用できません（イメージに含まれていない可能性）');
  }

  const storageState = await getBrowserSession(platform);
  if (!storageState) {
    throw new BrowserUnavailable(
      `${platform} のログインセッションが未登録です。管理画面から Cookie を登録してください。`,
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      storageState: storageState as any,
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 1000 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    context.setDefaultTimeout(20_000);

    const page = await context.newPage();
    try {
      const result = await fn(page, context);
      // Persist refreshed cookies so the session doesn't expire prematurely.
      await saveBrowserSession(platform, await context.storageState());
      return result;
    } catch (e) {
      await captureFailure(platform, page).catch(() => {});
      throw e;
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Stores a screenshot of the failure so selector breakage can be diagnosed
 * from the admin UI instead of guessing.
 */
async function captureFailure(platform: Platform, page: AnyPage): Promise<void> {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 40, fullPage: false });
    await setSetting(`last_failure_screenshot:${platform}`, {
      at: new Date().toISOString(),
      url: page.url(),
      dataUri: `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`,
    });
  } catch {
    /* screenshots are best-effort */
  }
}

/** Opens the platform's own page and checks for a logged-in marker. */
export async function checkLogin(platform: Platform): Promise<{ loggedIn: boolean; detail: string }> {
  return withContext(platform, async (page: AnyPage) => {
    if (platform === 'youtube') {
      await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
      const avatar = await page.locator('button#avatar-btn, #avatar-btn').count();
      return {
        loggedIn: avatar > 0,
        detail: avatar > 0 ? 'ログイン済みです' : 'ログインしていません（Cookie が失効した可能性）',
      };
    }
    await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded' });
    const profile = await page.locator('[data-e2e="profile-icon"], [data-e2e="nav-profile"]').count();
    return {
      loggedIn: profile > 0,
      detail: profile > 0 ? 'ログイン済みです' : 'ログインしていません（Cookie が失効した可能性）',
    };
  });
}

/**
 * Accepts either a Playwright storageState JSON or a plain cookie array
 * exported by a browser extension, and normalises it to storageState shape.
 */
export function normaliseStorageState(input: unknown, domainHint: string): unknown {
  if (input && typeof input === 'object' && 'cookies' in (input as any)) return input;

  if (Array.isArray(input)) {
    const cookies = input.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? domainHint,
      path: c.path ?? '/',
      expires: typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : (c.expires ?? -1),
      httpOnly: Boolean(c.httpOnly),
      secure: c.secure ?? true,
      sameSite: normaliseSameSite(c.sameSite),
    }));
    return { cookies, origins: [] };
  }

  throw new Error('Cookie の形式が認識できません。storageState JSON か Cookie 配列を貼り付けてください。');
}

function normaliseSameSite(v: unknown): 'Strict' | 'Lax' | 'None' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}
