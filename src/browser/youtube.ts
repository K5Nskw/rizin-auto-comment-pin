import { createLogger } from '../logger.js';
import { withContext } from './session.js';

const log = createLogger('browser:youtube');

type AnyPage = any;
type AnyLocator = any;

/** Label text of the pin menu entry, per UI language. */
const PIN_LABELS = ['固定', 'ピン留め', 'Pin', 'Pin comment'];
const CONFIRM_LABELS = ['固定', 'ピン留め', 'PIN', 'Pin'];

/**
 * A short, distinctive slice of our own comment used to locate it in the DOM.
 * YouTube collapses newlines and may append/trim whitespace, so we compare on a
 * normalised prefix rather than the whole body.
 */
function fingerprint(commentText: string): string {
  const normalised = commentText.replace(/\s+/g, ' ').trim();
  return normalised.slice(0, 30);
}

async function dismissConsent(page: AnyPage): Promise<void> {
  for (const label of ['同意する', 'すべて同意', 'Accept all', 'I agree']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function scrollToComments(page: AnyPage): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const count = await page.locator('ytd-comment-thread-renderer').count();
    if (count > 0) return;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(800);
  }
  throw new Error('コメント欄を読み込めませんでした（コメントが無効、または動画が非公開の可能性）');
}

async function findOwnComment(page: AnyPage, commentText: string): Promise<AnyLocator> {
  const needle = fingerprint(commentText);
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const threads = page.locator('ytd-comment-thread-renderer');
    const total = await threads.count();

    for (let i = 0; i < Math.min(total, 30); i++) {
      const thread = threads.nth(i);
      const body = await thread
        .locator('#content-text')
        .first()
        .innerText()
        .catch(() => '');
      if (body.replace(/\s+/g, ' ').includes(needle)) return thread;
    }

    // The comment can take a moment to appear right after the API posted it.
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await scrollToComments(page).catch(() => {});
  }

  throw new Error('投稿したコメントが画面上に見つかりませんでした（反映待ち、またはログイン中のアカウントが違う可能性）');
}

async function clickByLabel(page: AnyPage, scope: AnyLocator, labels: string[]): Promise<boolean> {
  for (const label of labels) {
    const item = scope.getByText(label, { exact: false }).first();
    if (await item.count().catch(() => 0)) {
      await item.click({ timeout: 5000 });
      await page.waitForTimeout(700);
      return true;
    }
  }
  return false;
}

/**
 * Pins a comment that has already been posted (by the Data API) on a video.
 *
 * There is no YouTube API for pinning, so this drives the real UI with the
 * operator's own logged-in session. Selectors track YouTube's current DOM and
 * may need updating if YouTube changes it — failures are reported with the
 * exact step that broke, plus a screenshot in the admin UI.
 */
export async function pinComment(videoId: string, commentText: string): Promise<void> {
  await withContext('youtube', async (page: AnyPage) => {
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissConsent(page);
    await scrollToComments(page);

    const thread = await findOwnComment(page, commentText);
    await thread.scrollIntoViewIfNeeded();
    await thread.hover();
    await page.waitForTimeout(400);

    const menuButton = thread
      .locator('#action-menu button, ytd-menu-renderer button[aria-label], #action-menu yt-icon-button')
      .first();
    if (!(await menuButton.count())) {
      throw new Error('コメントのメニュー(⋮)ボタンが見つかりませんでした');
    }
    await menuButton.click();
    await page.waitForTimeout(800);

    const dropdown = page.locator('tp-yt-iron-dropdown:visible, ytd-menu-popup-renderer:visible').last();
    const opened = await clickByLabel(page, dropdown.count() ? dropdown : page, PIN_LABELS);
    if (!opened) {
      throw new Error('メニューに「固定」項目が見つかりませんでした（自分のチャンネルでログインしているか確認してください）');
    }

    // YouTube asks for confirmation before pinning.
    const dialog = page.locator('yt-confirm-dialog-renderer, tp-yt-paper-dialog:visible').last();
    if (await dialog.count().catch(() => 0)) {
      const confirmed = await clickByLabel(page, dialog, CONFIRM_LABELS);
      if (!confirmed) {
        const fallback = dialog.locator('#confirm-button button, #confirm-button').first();
        if (await fallback.count()) await fallback.click();
      }
      await page.waitForTimeout(1500);
    }

    log.info(`pinned comment on ${videoId}`);
  });
}
