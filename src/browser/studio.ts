import { createLogger } from '../logger.js';
import { withContext } from './session.js';

const log = createLogger('browser:studio');

type AnyPage = any;
type AnyLocator = any;

const RELATED_LABELS = ['関連動画', 'Related video', 'Related videos'];
const SAVE_LABELS = ['保存', 'SAVE', 'Save'];

/**
 * Sets a Short's "related video" — the link back to the long-form video it was
 * cut from.
 *
 * There is no API for this; YouTube exposes it only in Studio, so this drives
 * the real UI with the operator's session, the same approach as pinning. It
 * works while the clip is still private, which is the point: the link can be
 * in place before anyone sees the video.
 *
 * Studio is a heavier, more obfuscated app than the watch page, so every step
 * fails with what it was looking for rather than a bare timeout.
 */
export async function setRelatedVideo(clipVideoId: string, sourceVideoId: string): Promise<void> {
  await withContext('youtube', async (page: AnyPage) => {
    await page.goto(`https://studio.youtube.com/video/${clipVideoId}/edit`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);

    if (/accounts\.google\.com|ServiceLogin/.test(page.url())) {
      throw new Error(
        'YouTube Studio がログイン画面に転送されました。ブラウザセッションの Cookie を登録し直してください。',
      );
    }

    await dismissDialogs(page);

    const section = await findRelatedSection(page);
    if (!section) {
      throw new Error(
        '「関連動画」の設定欄が見つかりませんでした。' +
          'Shorts ではない動画か、Studio の画面構成が変わった可能性があります。' +
          `（到達URL: ${page.url()}）`,
      );
    }

    await section.scrollIntoViewIfNeeded().catch(() => {});
    await section.click({ timeout: 10_000 }).catch(async () => {
      await section.evaluate((el: any) => el.click());
    });
    await page.waitForTimeout(2500);

    await pickVideo(page, sourceVideoId);
    await save(page);

    log.info(`related video set: ${clipVideoId} -> ${sourceVideoId}`);
  });
}

async function dismissDialogs(page: AnyPage): Promise<void> {
  for (const label of ['閉じる', 'OK', 'Got it', 'Dismiss', 'あとで', 'Skip']) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
}

/** The control is a labelled row rather than a stable id, so match on its text. */
async function findRelatedSection(page: AnyPage): Promise<AnyLocator | null> {
  for (const label of RELATED_LABELS) {
    for (const candidate of [
      page.locator(`ytcp-form-input-container:has-text("${label}")`).first(),
      page.locator(`[test-id*="related" i]`).first(),
      page.getByText(label, { exact: false }).first(),
    ]) {
      if (await candidate.count().catch(() => 0)) return candidate;
    }
  }
  return null;
}

/**
 * Chooses the source video in the picker.
 *
 * Selection is confirmed by the video id in the row's link where possible;
 * falling back to position would risk attaching the wrong video, which is
 * worse than failing.
 */
async function pickVideo(page: AnyPage, sourceVideoId: string): Promise<void> {
  const search = page
    .locator('input[type="text"]:visible, ytcp-video-picker input:visible, input[aria-label]:visible')
    .last();

  if (await search.count().catch(() => 0)) {
    await search.click({ timeout: 5000 }).catch(() => {});
    await search.fill(sourceVideoId).catch(async () => {
      await search.type(sourceVideoId, { delay: 30 });
    });
    await page.waitForTimeout(3000);
  }

  const byId = page.locator(`[href*="${sourceVideoId}"], [video-id="${sourceVideoId}"]`).first();
  if (await byId.count().catch(() => 0)) {
    await byId.click({ timeout: 8000 }).catch(async () => {
      await byId.evaluate((el: any) => el.click());
    });
    await page.waitForTimeout(1500);
    return;
  }

  // The picker doesn't always expose the id; take the single result only when
  // the search narrowed it to one, so there is nothing to pick wrongly.
  const rows = page.locator('ytcp-video-row:visible, tp-yt-paper-item:visible, [role="option"]:visible');
  const count = await rows.count().catch(() => 0);
  if (count === 1) {
    await rows.first().click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    return;
  }

  throw new Error(
    `元動画（${sourceVideoId}）を候補から特定できませんでした（候補 ${count} 件）。` +
      '元動画が同じチャンネルにあり、削除されていないか確認してください。',
  );
}

async function save(page: AnyPage): Promise<void> {
  for (const label of SAVE_LABELS) {
    const btn = page.getByRole('button', { name: label }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 10_000 }).catch(async () => {
        await btn.evaluate((el: any) => el.click());
      });
      await page.waitForTimeout(4000);
      return;
    }
  }
  const fallback = page.locator('#save, ytcp-button#save-button').first();
  if (await fallback.count().catch(() => 0)) {
    await fallback.click({ timeout: 10_000 });
    await page.waitForTimeout(4000);
    return;
  }
  throw new Error('保存ボタンが見つかりませんでした。変更が保存されていない可能性があります。');
}
