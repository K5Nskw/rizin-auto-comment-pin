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
  await snapshot(platform, page, 'error');
}

async function snapshot(platform: Platform, page: AnyPage, label: string): Promise<void> {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 40, fullPage: false });
    await setSetting(`last_failure_screenshot:${platform}`, {
      at: new Date().toISOString(),
      label,
      url: page.url(),
      dataUri: `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`,
    });
  } catch {
    /* screenshots are best-effort */
  }
}

/**
 * Cookie names that carry the actual login. Checked without any network
 * access, so a bad export (wrong site, wrong browser profile, partial copy)
 * is identified immediately instead of looking like an expired session.
 */
const REQUIRED_COOKIES: Record<Platform, { any: string[]; label: string }> = {
  youtube: {
    any: ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'],
    label: 'youtube.com にログインした状態',
  },
  tiktok: {
    any: ['sessionid', 'sessionid_ss', 'sid_tt'],
    label: 'tiktok.com にログインした状態',
  },
};

export interface CookieDiagnosis {
  ok: boolean;
  total: number;
  found: string[];
  domains: string[];
  expiringSoon: string[];
  message: string;
}

/** Offline sanity check on the stored cookies — no browser or network needed. */
export async function diagnoseCookies(platform: Platform): Promise<CookieDiagnosis> {
  const state = await getBrowserSession<{ cookies?: Array<Record<string, any>> }>(platform);
  const cookies = state?.cookies ?? [];
  const names = new Set(cookies.map((c) => c.name));
  const spec = REQUIRED_COOKIES[platform];

  const found = spec.any.filter((n) => names.has(n));
  const domains = [...new Set(cookies.map((c) => String(c.domain ?? '')))].filter(Boolean);

  const soon = Date.now() / 1000 + 7 * 86_400;
  const expiringSoon = cookies
    .filter((c) => typeof c.expires === 'number' && c.expires > 0 && c.expires < soon)
    .map((c) => String(c.name));

  let message: string;
  if (!cookies.length) {
    message = 'Cookie が登録されていません。';
  } else if (!found.length) {
    message =
      `ログイン用の Cookie（${spec.any.join(' / ')}）が1つも含まれていません。` +
      `${spec.label}で、そのサイトを開いたままエクスポートし直してください。` +
      `（登録されているドメイン: ${domains.join(', ') || 'なし'}）`;
  } else {
    message = `Cookie ${cookies.length} 件。ログイン用 Cookie（${found.join(', ')}）を確認しました。`;
  }

  return { ok: found.length > 0, total: cookies.length, found, domains, expiringSoon, message };
}

/**
 * Opens the platform's own page and checks for a logged-in marker.
 *
 * The primary signal is the server-rendered config blob rather than a DOM
 * element: the page ships `"LOGGED_IN":true` in its HTML, so the check doesn't
 * depend on the SPA having finished rendering or on a class name that changes
 * with the next redesign. DOM selectors stay as a secondary signal.
 *
 * A screenshot is captured on every run, including a negative result — "not
 * logged in" is exactly when seeing the real page matters, and the previous
 * version returned normally so nothing was ever saved.
 */
export async function checkLogin(
  platform: Platform,
): Promise<{ loggedIn: boolean; detail: string; cookies: CookieDiagnosis; signals: string[] }> {
  const cookies = await diagnoseCookies(platform);

  const live = await withContext(platform, async (page: AnyPage) => {
    const url = platform === 'youtube' ? 'https://www.youtube.com/' : 'https://www.tiktok.com/';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Give the app time to hydrate. The previous check ran immediately and
    // could report a perfectly good session as logged out.
    await page.waitForTimeout(5000);

    const html: string = await page.content();
    const signals: string[] = [];
    let loggedIn = false;

    if (platform === 'youtube') {
      if (/"LOGGED_IN":\s*true/.test(html)) {
        loggedIn = true;
        signals.push('ytcfg: LOGGED_IN=true');
      } else if (/"LOGGED_IN":\s*false/.test(html)) {
        signals.push('ytcfg: LOGGED_IN=false（YouTube 側でログアウト扱い）');
      }
      const avatar = await page
        .locator('#avatar-btn, button#avatar-btn, ytd-topbar-menu-button-renderer')
        .count();
      if (avatar > 0) {
        loggedIn = true;
        signals.push(`アバターボタン: ${avatar}件`);
      }
    } else {
      if (/"isLogin":\s*true/.test(html)) {
        loggedIn = true;
        signals.push('app-context: isLogin=true');
      } else if (/"isLogin":\s*false/.test(html)) {
        signals.push('app-context: isLogin=false（TikTok 側でログアウト扱い）');
      }
      const profile = await page.locator('[data-e2e="profile-icon"], [data-e2e="nav-profile"]').count();
      if (profile > 0) {
        loggedIn = true;
        signals.push(`プロフィールアイコン: ${profile}件`);
      }
    }

    signals.push(`到達URL: ${page.url()}`);
    await snapshot(platform, page, loggedIn ? 'login-ok' : 'login-ng');
    return { loggedIn, signals };
  });

  const detail = live.loggedIn
    ? `ログイン済みです。${cookies.message}`
    : cookies.ok
      ? 'ログインが確認できませんでした。Cookie の形式は正しいので、失効しているか別アカウントのものの可能性があります。「失敗時の画面を見る」で実際の画面を確認してください。'
      : cookies.message;

  return { loggedIn: live.loggedIn, detail, cookies, signals: live.signals };
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
