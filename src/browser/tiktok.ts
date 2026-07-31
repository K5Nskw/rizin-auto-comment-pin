import { createLogger } from '../logger.js';
import { withContext } from './session.js';

const log = createLogger('browser:tiktok');

type AnyPage = any;
type AnyLocator = any;

const PIN_LABELS = ['ピン留め', 'コメントをピン留め', 'Pin comment', 'Pin'];
const CONFIRM_LABELS = ['ピン留め', 'ピン留めする', 'Pin', 'Confirm', 'OK'];

async function closeOverlays(page: AnyPage): Promise<void> {
  const closers = [
    '[data-e2e="modal-close-inner-button"]',
    '[data-e2e="close-btn"]',
    'button[aria-label="Close"]',
    'button[aria-label="閉じる"]',
  ];
  for (const sel of closers) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function openCommentPanel(page: AnyPage): Promise<void> {
  // On the video detail page comments are already visible; on the feed view a
  // click is needed. Try the icon, then fall back to assuming it's open.
  const commentIcon = page.locator('[data-e2e="comment-icon"], [data-e2e="browse-comment"]').first();
  if (await commentIcon.count().catch(() => 0)) {
    await commentIcon.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page
    .locator('[data-e2e="comment-input"], div[contenteditable="true"]')
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {
      throw new Error('コメント入力欄が見つかりませんでした（コメントが無効、または未ログインの可能性）');
    });
}

async function typeComment(page: AnyPage, text: string): Promise<void> {
  const input = page.locator('[data-e2e="comment-input"], div[contenteditable="true"]').first();
  await input.click();
  await page.waitForTimeout(300);
  // TikTok's editor is a contenteditable; fill() doesn't fire its handlers, so
  // type character by character.
  await input.type(text, { delay: 25 });
  await page.waitForTimeout(700);

  const postBtn = page.locator('[data-e2e="comment-post"]').first();
  if (await postBtn.count().catch(() => 0)) {
    await postBtn.click({ timeout: 5000 });
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(3000);
}

function fingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 20);
}

async function findOwnComment(page: AnyPage, text: string): Promise<AnyLocator> {
  const needle = fingerprint(text);
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const items = page.locator('[data-e2e="comment-level-1"], [data-e2e="comment-item"]');
    const total = await items.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 20); i++) {
      const item = items.nth(i);
      const body = await item.innerText().catch(() => '');
      if (body.replace(/\s+/g, ' ').includes(needle)) {
        // Walk up to the row container that carries the hover menu.
        return item.locator('xpath=ancestor-or-self::div[3]').first();
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('投稿したコメントが見つかりませんでした（反映待ち、またはコメントが弾かれた可能性）');
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

async function pinLocatedComment(page: AnyPage, row: AnyLocator): Promise<void> {
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.hover();
  await page.waitForTimeout(600);

  const moreBtn = row
    .locator('[data-e2e="comment-more-btn"], svg[data-e2e="more-icon"], button[aria-label*="more" i]')
    .first();
  if (!(await moreBtn.count().catch(() => 0))) {
    throw new Error('コメントの「…」メニューが見つかりませんでした');
  }
  await moreBtn.click({ force: true });
  await page.waitForTimeout(900);

  if (!(await clickByLabel(page, page, PIN_LABELS))) {
    throw new Error(
      'メニューに「ピン留め」が見つかりませんでした（動画の投稿者アカウントでログインしているか確認してください）',
    );
  }

  const dialog = page.locator('[role="dialog"], [data-e2e="modal"]').last();
  if (await dialog.count().catch(() => 0)) {
    await clickByLabel(page, dialog, CONFIRM_LABELS);
    await page.waitForTimeout(1500);
  }
}

/**
 * Posts a comment on a TikTok video and pins it.
 *
 * TikTok exposes no public API for either action on an organic post, so both
 * halves run through the UI with the operator's own logged-in session.
 */
export async function commentAndPin(videoUrl: string, text: string, shouldPin: boolean): Promise<void> {
  await withContext('tiktok', async (page: AnyPage) => {
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await closeOverlays(page);
    await openCommentPanel(page);
    await typeComment(page, text);

    const row = await findOwnComment(page, text);
    log.info('comment posted');

    if (shouldPin) {
      await pinLocatedComment(page, row);
      log.info('comment pinned');
    }
  });
}

/** Pin only — used when retrying a job whose comment already went through. */
export async function pinExistingComment(videoUrl: string, text: string): Promise<void> {
  await withContext('tiktok', async (page: AnyPage) => {
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await closeOverlays(page);
    await openCommentPanel(page);
    const row = await findOwnComment(page, text);
    await pinLocatedComment(page, row);
  });
}
