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

/**
 * Opens a comment's "⋮" menu.
 *
 * YouTube keeps that button behind a `hidden` attribute and only drops it when
 * the comment is hovered. A synthetic hover doesn't reliably trigger that in a
 * headless browser, and Playwright then refuses to click an invisible element
 * — the click times out against a button that is right there in the DOM.
 *
 * So: hover first (the normal path), and if the button is still hidden, strip
 * the attribute ourselves before clicking, with a direct DOM click as the last
 * resort.
 */
async function openCommentMenu(page: AnyPage, thread: AnyLocator): Promise<void> {
  // Centre it rather than scrollIntoViewIfNeeded(): that only guarantees the
  // element is inside the viewport, which frequently parks it at the top edge
  // underneath YouTube's sticky masthead. Pointer events at those coordinates
  // land on the header, so hovering and clicking silently do nothing.
  await thread
    .evaluate((el: any) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    .catch(async () => {
      await thread.scrollIntoViewIfNeeded().catch(() => {});
    });
  await page.waitForTimeout(500);

  // A real pointer move, not just locator.hover(): YouTube reveals the button
  // from mouseover on the comment, and moving the actual mouse is the closest
  // thing to a user doing it.
  const box = await thread.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(30, box.height / 2));
    await page.waitForTimeout(300);
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
  }
  await thread.hover().catch(() => {});
  await page.waitForTimeout(700);

  const menuButton = thread
    .locator(
      '#action-menu #button, #action-menu button, ytd-menu-renderer #button, ' +
        'ytd-menu-renderer button[aria-label], #action-menu yt-icon-button',
    )
    .first();

  if (!(await menuButton.count())) {
    throw new Error('コメントのメニュー(⋮)ボタンが見つかりませんでした');
  }

  const visible = await menuButton.isVisible().catch(() => false);
  if (!visible) {
    log.info('menu button still hidden after hover; revealing it directly');
    await thread
      .evaluate((root: any) => {
        const menu = root.querySelector('#action-menu') ?? root;
        menu.removeAttribute?.('hidden');
        for (const el of menu.querySelectorAll('[hidden]')) el.removeAttribute('hidden');
        for (const el of [menu, ...menu.querySelectorAll('*')] as any[]) {
          if (el?.style) {
            el.style.visibility = 'visible';
            el.style.opacity = '1';
          }
        }
      })
      .catch(() => {});
    await page.waitForTimeout(200);
  }

  // Click at real coordinates where possible — a synthetic click on a Polymer
  // component does not always run the same handler as a genuine pointer press.
  const buttonBox = await menuButton.boundingBox().catch(() => null);
  let clicked = false;

  if (buttonBox) {
    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.up();
    clicked = await menuIsOpen(page, 3000);
  }

  if (!clicked) {
    try {
      await menuButton.click({ timeout: 5000, force: true });
      clicked = await menuIsOpen(page, 3000);
    } catch {
      /* fall through to the DOM click */
    }
  }

  if (!clicked) {
    log.info('pointer clicks did not open the menu; dispatching a direct DOM click');
    await menuButton.evaluate((el: any) => el.click()).catch(() => {});
    clicked = await menuIsOpen(page, 4000);
  }

  if (!clicked) {
    throw new Error(`コメントのメニューを開けませんでした。${await describeMenuState(page, thread)}`);
  }
}

/**
 * Collects the facts that distinguish the ways this step can fail: a signed-out
 * session, a comment scrolled under the sticky masthead, a zero-sized button,
 * or a menu that opened somewhere this code isn't looking.
 */
async function describeMenuState(page: AnyPage, thread: AnyLocator): Promise<string> {
  const facts: string[] = [];

  try {
    const html: string = await page.content();
    const m = html.match(/"LOGGED_IN":\s*(\w+)/);
    facts.push(`ログイン状態=${m?.[1] ?? '不明'}`);
  } catch {
    facts.push('ログイン状態=取得失敗');
  }

  const box = await thread.boundingBox().catch(() => null);
  facts.push(box ? `コメント位置 y=${Math.round(box.y)} 高さ=${Math.round(box.height)}` : 'コメント位置=取得不可');
  if (box && box.y < 60) facts.push('※ヘッダーの裏に隠れている可能性');

  const detail = await thread
    .locator('#action-menu #button, #action-menu button, ytd-menu-renderer #button')
    .first()
    .evaluate((el: any) => {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return `hidden=${el.hasAttribute('hidden')} display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity} size=${Math.round(r.width)}x${Math.round(r.height)}`;
    })
    .catch(() => '取得失敗');
  facts.push(`⋮ボタン: ${detail}`);

  const dropdowns = await page.locator('tp-yt-iron-dropdown').count().catch(() => 0);
  const visibleDropdowns = await page.locator('tp-yt-iron-dropdown:visible').count().catch(() => 0);
  facts.push(`ドロップダウン: 全${dropdowns}件 / 表示中${visibleDropdowns}件`);

  const isUploader = await thread
    .locator('[author-is-uploader], ytd-comment-view-model[author-is-uploader]')
    .count()
    .catch(() => 0);
  facts.push(`投稿者バッジ=${isUploader > 0 ? 'あり' : 'なし'}`);

  return facts.join(' / ');
}

/**
 * The open menu renders at the document root inside a tp-yt-iron-dropdown.
 *
 * Scoping to that visible dropdown matters: YouTube keeps many hidden
 * ytd-menu-*-item-renderer elements elsewhere in the page, and a page-wide
 * query picks one of those instead — which is what made an open menu look
 * closed, so the code clicked again and toggled it shut.
 */
const OPEN_MENU_ITEMS = [
  'tp-yt-iron-dropdown:visible ytd-menu-navigation-item-renderer',
  'tp-yt-iron-dropdown:visible ytd-menu-service-item-renderer',
  'ytd-menu-popup-renderer:visible ytd-menu-navigation-item-renderer',
  'ytd-menu-popup-renderer:visible ytd-menu-service-item-renderer',
].join(', ');

async function menuIsOpen(page: AnyPage, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await page.locator(OPEN_MENU_ITEMS).count().catch(() => 0)) > 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Clicks the entry of the open menu whose text contains one of `labels`. */
async function clickMenuItem(page: AnyPage, labels: string[]): Promise<{ ok: boolean; items: string[] }> {
  const all = page.locator(OPEN_MENU_ITEMS);
  const count = await all.count().catch(() => 0);
  const items: string[] = [];

  for (let i = 0; i < count; i++) {
    const item = all.nth(i);
    const text = (await item.innerText().catch(() => '')).trim();
    if (!text) continue;
    items.push(text);
    if (labels.some((l) => text.includes(l))) {
      await item.click({ timeout: 5000 }).catch(async () => {
        await item.evaluate((el: any) => el.click());
      });
      await page.waitForTimeout(1000);
      return { ok: true, items };
    }
  }
  return { ok: false, items };
}

/**
 * Confirms the "pin this comment?" dialog when YouTube shows one.
 *
 * Absence of the dialog is not an error — YouTube doesn't always ask — so this
 * only reports a problem when a dialog is present and cannot be confirmed.
 */
async function confirmPinDialog(page: AnyPage): Promise<void> {
  const dialog = page
    .locator('yt-confirm-dialog-renderer:visible, tp-yt-paper-dialog:visible, ytd-popup-container tp-yt-paper-dialog:visible')
    .last();

  // Give it a moment to appear; no dialog at all is a valid outcome.
  const appeared = await dialog
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    log.info('no confirmation dialog appeared');
    return;
  }

  const confirmButton = dialog.locator('#confirm-button, #confirm-button button, yt-button-renderer#confirm-button').first();
  if (await confirmButton.count().catch(() => 0)) {
    await confirmButton.click({ timeout: 5000 }).catch(async () => {
      await confirmButton.evaluate((el: any) => el.click());
    });
    await page.waitForTimeout(1500);
    return;
  }

  if (await clickByLabel(page, dialog, CONFIRM_LABELS)) {
    await page.waitForTimeout(1500);
    return;
  }

  const text = (await dialog.innerText().catch(() => '')).trim().slice(0, 200);
  throw new Error(`確認ダイアログの実行ボタンが見つかりませんでした。ダイアログの内容: ${text || '（取得できず）'}`);
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

    // Checked before touching the menu: pin/edit/delete only exist for the
    // comment's author, so a signed-out session leaves the "⋮" permanently
    // hidden and every click on it does nothing. Without this the failure
    // reads as a selector problem instead of an expired login.
    const html: string = await page.content();
    if (/"LOGGED_IN":\s*false/.test(html)) {
      throw new Error(
        'ブラウザセッションがログインしていません（YouTube 側で LOGGED_IN=false）。' +
          '「アカウント連携」タブで Cookie を登録し直してください。',
      );
    }
    if (!/"LOGGED_IN":\s*true/.test(html)) {
      log.warn('LOGGED_IN フラグを判定できませんでした。ログイン状態が不明なまま続行します');
    }

    await scrollToComments(page);

    const thread = await findOwnComment(page, commentText);
    await openCommentMenu(page, thread);

    const pin = await clickMenuItem(page, PIN_LABELS);
    if (!pin.ok) {
      // The menu contents are the diagnosis: a renamed label and a menu with no
      // pin option (wrong channel signed in) look identical without them.
      throw new Error(
        `メニューに「固定」項目が見つかりませんでした（自分のチャンネルでログインしているか確認してください）。` +
          `実際のメニュー項目: ${pin.items.length ? pin.items.join(' / ') : '（項目なし）'}`,
      );
    }

    log.info(`menu items: ${pin.items.join(' / ')}`);
    await confirmPinDialog(page);
    log.info(`pinned comment on ${videoId}`);
  });
}
