'use strict';

/* --------------------------------- helpers -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (v) => (v ? new Date(v).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—');

function message(el, text, kind = 'ok') {
  el.textContent = text;
  el.className = `form-message ${kind}`;
  if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
}

/* ---------------------------------- tabs ---------------------------------- */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'jobs') {
      loadJobs();
      loadExclusions();
    }
    if (tab.dataset.tab === 'logs') loadLogs();
  });
});

/* -------------------------------- dashboard ------------------------------- */

const STATUS_LABELS = {
  pending: '待機中',
  commenting: 'コメント中',
  pinning: 'ピン留め中',
  done: '完了',
  needs_manual: '手動対応が必要',
  failed: '失敗',
};

function renderConsoleUrls(s) {
  const copyRow = ([k, v]) =>
    `<div>${esc(k)}</div><div><code>${esc(v)}</code>
     <button class="btn btn-ghost btn-copy" data-copy="${esc(v)}">コピー</button></div>`;

  // Duplicated next to the connect buttons: this is the value a redirect_uri
  // error is about, and it needs to be where the error happens.
  const redirectEl = $('#redirect-uris');
  if (redirectEl) {
    redirectEl.innerHTML = [
      ['YouTube', s.redirectUris.youtube],
      ['TikTok', s.redirectUris.tiktok],
      ['TikTok Web/Desktop URL', s.publicUrl],
    ]
      .map(copyRow)
      .join('');
  }

  $('#console-urls').innerHTML = [
    ['プライバシーポリシー URL', s.legal.privacy],
    ['利用規約 URL', s.legal.terms],
    ['YouTube リダイレクトURI', s.redirectUris.youtube],
    ['TikTok リダイレクトURI', s.redirectUris.tiktok],
    ['TikTok Web/Desktop URL', s.publicUrl],
    ['AutoClipMaker の COMMENT_HOOK_URL', s.ingestUrl || ''],
  ]
    .map(copyRow)
    .join('');

  const ingestEl = $('#ingest-status');
  if (ingestEl) {
    ingestEl.innerHTML = `
      <div class="line"><span>受け口</span><span class="badge ${
        s.ingestConfigured ? 'badge-ok' : 'badge-err'
      }">${s.ingestConfigured ? '有効' : 'INGEST_TOKEN が未設定'}</span></div>
      <div class="line"><span>関連動画の設定</span><span class="badge ${
        s.browser && s.browser.available ? 'badge-ok' : 'badge-err'
      }">${s.browser && s.browser.available ? '実行可能' : 'ブラウザ自動操作が利用不可'}</span></div>`;
    $('#ingest-urls').innerHTML = [
      ['AutoClipMaker の COMMENT_HOOK_URL', s.ingestUrl || ''],
    ]
      .map(copyRow)
      .join('');
  }

  $$('.btn-copy').forEach((b) =>
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      const original = b.textContent;
      b.textContent = 'コピーしました';
      setTimeout(() => { b.textContent = original; }, 1500);
    }),
  );
}

async function loadStatus() {
  let s;
  try {
    s = await api('/status');
  } catch (e) {
    $('#warnings').innerHTML = `<div class="warning-box">状態を取得できませんでした: ${esc(e.message)}</div>`;
    return false;
  }

  // Database down: this is the screen shown after a failed deploy, so lead
  // with the reason and stop before rendering panels that have no data.
  if (s.dbReady === false) {
    $('#warnings').innerHTML = `
      <div class="warning-box" style="border-color:var(--err)">
        <strong style="color:var(--err)">データベースに接続できていません</strong>
        <p style="margin:8px 0">${esc(s.dbError || '')}</p>
        <p style="margin:8px 0 0">
          接続を${s.dbAttempts}回試行しました。自動で再試行を続けます。<br>
          Railway で <strong>New → Database → Add PostgreSQL</strong> を実行すると
          <code>DATABASE_URL</code> が自動で設定されます。
        </p>
      </div>
      ${
        s.warnings.length
          ? `<div class="warning-box"><strong>他の設定</strong><ul>${s.warnings
              .map((w) => `<li>${esc(w)}</li>`)
              .join('')}</ul></div>`
          : ''
      }`;
    renderConsoleUrls(s);
    for (const id of ['#yt-status', '#tt-status', '#browser-status', '#job-stats']) {
      $(id).innerHTML = '<p class="hint">データベース接続の復旧を待っています。</p>';
    }
    return false;
  }

  $('#dry-run-badge').hidden = !s.dryRun;

  $('#warnings').innerHTML = s.warnings.length
    ? `<div class="warning-box"><strong>設定を確認してください</strong><ul>${s.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join('')}</ul></div>`
    : '';

  const watermarkLine = (p) => {
    const wm = s.watermarks && s.watermarks[p];
    return `<div class="line"><span>この時刻より後の動画が対象</span><span>${
      wm ? fmtDate(wm) : '未設定（次回検知時に設定されます）'
    }</span></div>
    <div class="line"><span></span><span>
      <button class="btn btn-ghost btn-copy" data-reset-watermark="${p}">今にリセット</button>
    </span></div>`;
  };

  const account = (a, extra = '') =>
    a
      ? `<div class="line"><span>状態</span><span class="badge badge-ok">連携済み</span></div>
         <div class="line"><span>アカウント</span><span>${esc(a.displayName || '—')}</span></div>
         <div class="line"><span>ID</span><span>${esc(a.externalId || '—')}</span></div>
         <div class="line"><span>連携日</span><span>${fmtDate(a.connectedAt)}</span></div>${extra}`
      : `<div class="line"><span>状態</span><span class="badge badge-err">未連携</span></div>
         <p class="hint">「アカウント連携」タブから連携してください。</p>`;

  const websub = s.websub.subscribed
    ? `<div class="line"><span>即時通知</span><span class="badge badge-ok">有効</span></div>
       <div class="line"><span>有効期限</span><span>${fmtDate(s.websub.expiresAt)}</span></div>`
    : `<div class="line"><span>即時通知</span><span class="badge badge-warn">無効（ポーリングのみ）</span></div>`;

  $('#yt-status').innerHTML = account(
    s.accounts.youtube,
    s.accounts.youtube ? websub + watermarkLine('youtube') : '',
  );
  $('#tt-status').innerHTML = account(
    s.accounts.tiktok,
    s.accounts.tiktok ? watermarkLine('tiktok') : '',
  );

  $$('[data-reset-watermark]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = b.dataset.resetWatermark;
      if (!confirm(`基準時刻を「今」にリセットします。\n\nこれ以降に公開された ${p} の動画だけが対象になります。`)) return;
      try {
        await api(`/watermark/${p}/reset`, { method: 'POST' });
        loadStatus();
      } catch (e) {
        alert(e.message);
      }
    }),
  );

  const b = s.browser;
  // 最終更新も出す。Cookie は使われるたびに更新されるので、ここが古いままなら
  // 「登録済みだが実際には通っていない」を疑える
  const sessionLine = (p, label) =>
    `<div class="line"><span>${label} Cookie</span><span>${
      b.sessions[p]
        ? `<span class="badge badge-ok">登録済み</span> <span class="hint">最終更新 ${esc(fmtDate(b.sessions[p]))}</span>`
        : `<span class="badge badge-err">未登録</span>`
    }</span></div>`;

  $('#browser-status').innerHTML = `
    <div class="line"><span>機能</span><span class="badge ${b.enabled ? 'badge-ok' : 'badge-muted'}">${
      b.enabled ? '有効' : '無効'
    }</span></div>
    <div class="line"><span>Chromium</span><span class="badge ${b.available ? 'badge-ok' : 'badge-err'}">${
      b.available ? '利用可能' : '利用不可'
    }</span></div>
    ${sessionLine('youtube', 'YouTube')}
    ${sessionLine('tiktok', 'TikTok')}
    ${
      b.available
        ? ''
        : '<p class="hint">ピン留めができません。手動対応の通知だけが飛びます。</p>'
    }`;

  const stats = s.stats || {};
  const keys = Object.keys(STATUS_LABELS).filter((k) => stats[k]);
  $('#job-stats').innerHTML = keys.length
    ? keys.map((k) => `<div class="line"><span>${STATUS_LABELS[k]}</span><span>${stats[k]} 件</span></div>`).join('')
    : '<p class="hint">まだジョブはありません。</p>';

  renderConsoleUrls(s);

  $('#runtime-config').innerHTML = [
    ['公開URL', s.publicUrl],
    ['新着チェック間隔', `${s.pollIntervalMinutes} 分`],
    ['対象にする動画の新しさ', `公開から ${s.maxVideoAgeHours} 時間以内`],
    ['DRY_RUN（実際には投稿しない）', s.dryRun ? 'ON' : 'OFF'],
  ]
    .map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`)
    .join('');

  return true;
}

$('#btn-poll').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'チェック中…';
  try {
    const r = await api('/poll', { method: 'POST' });
    alert(
      `新着チェック完了\n\nYouTube: ${r.youtube.checked}件確認 / ${r.youtube.queued}件キュー${
        r.youtube.error ? `\n  エラー: ${r.youtube.error}` : ''
      }\nTikTok: ${r.tiktok.checked}件確認 / ${r.tiktok.queued}件キュー${
        r.tiktok.error ? `\n  エラー: ${r.tiktok.error}` : ''
      }`,
    );
    loadStatus();
  } catch (err) {
    alert(`失敗しました: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '今すぐ新着チェック';
  }
});

/* -------------------------------- templates ------------------------------- */

const MATCH_TYPES = ['always', 'keyword', 'regex'];

const TARGET_LABELS = {
  all: '両方',
  youtube: 'YouTube（Shorts含む）',
  youtube_shorts: 'YouTube Shorts のみ',
  tiktok: 'TikTok',
};

function matchLabel(t) {
  if (t.matchType === 'always') return 'すべての動画';
  if (t.matchType === 'keyword') return `キーワード: ${esc(t.matchValue)}`;
  if (t.matchType === 'regex') return '正規表現';
  return `<span style="color:var(--err)">未対応の条件: ${esc(t.matchType)}</span>`;
}

let templates = [];
let editingId = null;
let lastFocusedBody = null;

const form = $('#template-form');

async function loadTemplates() {
  templates = await api('/templates');
  const list = $('#template-list');
  list.innerHTML = templates
    .map(
      (t) => `<li data-id="${t.id}" class="${t.enabled ? '' : 'disabled'} ${
        editingId === t.id ? 'selected' : ''
      }">
        <div class="t-head">
          <span class="t-name">${esc(t.name)}</span>
          <span class="badge badge-muted">優先度 ${t.priority}</span>
        </div>
        <div class="t-meta">
          ${TARGET_LABELS[t.platform] || t.platform} ・
          ${matchLabel(t)} ・
          ${t.pin ? 'ピン留めあり' : 'ピン留めなし'} ・ ${t.bodies.length} パターン
          ${t.enabled ? '' : '・<span class="badge badge-warn">無効</span>'}
        </div>
        <div class="t-preview">${esc((t.bodies[0] || '').replace(/\n/g, ' '))}</div>
      </li>`,
    )
    .join('');

  $$('#template-list li').forEach((li) =>
    li.addEventListener('click', () => openTemplate(Number(li.dataset.id))),
  );
}

async function loadVariables() {
  const vars = await api('/variables');
  $('#variable-chips').innerHTML =
    '<span class="hint" style="margin:0 6px 0 0">クリックで挿入:</span>' +
    vars.map((v) => `<span class="chip" data-token="${esc(v.token)}" title="${esc(v.description)}">${esc(v.token)}</span>`).join('');

  $$('#variable-chips .chip').forEach((chip) =>
    chip.addEventListener('click', () => insertToken(chip.dataset.token)),
  );
}

function insertToken(token) {
  const ta = lastFocusedBody || $('#bodies textarea');
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + token.length;
  updateBodyCounts();
}

function addBody(value = '') {
  const wrap = document.createElement('div');
  wrap.className = 'body-item';
  wrap.innerHTML = `
    <textarea rows="5" placeholder="コメント本文">${esc(value)}</textarea>
    <button type="button" class="body-remove" title="この文面を削除">×</button>
    <div class="body-count"></div>`;

  const ta = $('textarea', wrap);
  ta.addEventListener('focus', () => { lastFocusedBody = ta; });
  ta.addEventListener('input', updateBodyCounts);
  $('.body-remove', wrap).addEventListener('click', () => {
    if ($$('#bodies .body-item').length <= 1) {
      ta.value = '';
    } else {
      wrap.remove();
    }
    updateBodyCounts();
  });

  $('#bodies').appendChild(wrap);
  updateBodyCounts();
}

function updateBodyCounts() {
  const limit = form.platform.value === 'tiktok' ? 150 : 9000;
  $$('#bodies .body-item').forEach((item) => {
    const len = $('textarea', item).value.length;
    const over = len > limit;
    $('.body-count', item).innerHTML = `${len} 文字${
      over ? ` <span style="color:var(--err)">（${limit}文字を超えると自動で切り詰められます）</span>` : ''
    }`;
  });
}

function showForm(show) {
  form.hidden = !show;
}

function openTemplate(id) {
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  $('#form-title').textContent = 'テンプレートを編集';
  form.name.value = t.name;
  form.platform.value = t.platform;
  form.priority.value = t.priority;
  // A template saved by an older build can carry a condition this form has no
  // option for. Assigning it leaves the select empty, which then fails
  // validation on save with a message that says nothing useful — so fall back
  // and say what happened instead.
  if (MATCH_TYPES.includes(t.matchType)) {
    form.matchType.value = t.matchType;
  } else {
    form.matchType.value = 'always';
    message(
      $('#form-message'),
      `このテンプレートの条件「${t.matchType}」は現在サポートされていません。` +
        `「すべての動画」に切り替えました。条件を選び直して保存するか、不要なら削除してください。`,
      'err',
    );
  }
  form.matchValue.value = t.matchValue;
  form.enabled.checked = t.enabled;
  form.pin.checked = t.pin;
  form.delaySeconds.value = t.delaySeconds;
  $('#bodies').innerHTML = '';
  (t.bodies.length ? t.bodies : ['']).forEach((b) => addBody(b));
  $('#btn-delete-template').hidden = false;
  syncMatchValueVisibility();
  showForm(true);
  loadTemplates();
  runPreview();
}

function newTemplate() {
  editingId = null;
  $('#form-title').textContent = '新しいテンプレート';
  form.reset();
  form.platform.value = 'all';
  form.priority.value = 100;
  form.matchType.value = 'always';
  form.enabled.checked = true;
  form.pin.checked = true;
  form.delaySeconds.value = 30;
  $('#bodies').innerHTML = '';
  addBody('');
  $('#btn-delete-template').hidden = true;
  syncMatchValueVisibility();
  showForm(true);
  loadTemplates();
}

function syncMatchValueVisibility() {
  const type = form.matchType.value;
  $('#match-value-wrap').style.display = type === 'always' ? 'none' : '';
  form.matchValue.placeholder =
    type === 'keyword' ? 'ハイライト, 記者会見（カンマ区切り／どれか1つ含まれば一致）' : '例: (ハイライト|HIGHLIGHT)';
}

form.matchType.addEventListener('change', syncMatchValueVisibility);
form.platform.addEventListener('change', updateBodyCounts);
$('#btn-new-template').addEventListener('click', newTemplate);
$('#btn-add-body').addEventListener('click', () => addBody(''));
$('#btn-close-form').addEventListener('click', () => { showForm(false); editingId = null; loadTemplates(); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: form.name.value.trim(),
    platform: form.platform.value,
    enabled: form.enabled.checked,
    priority: Number(form.priority.value),
    matchType: form.matchType.value,
    matchValue: form.matchValue.value,
    bodies: $$('#bodies textarea').map((t) => t.value),
    pin: form.pin.checked,
    delaySeconds: Number(form.delaySeconds.value),
  };
  try {
    const saved = editingId
      ? await api(`/templates/${editingId}`, { method: 'PUT', body: payload })
      : await api('/templates', { method: 'POST', body: payload });
    editingId = saved.id;
    message($('#form-message'), '保存しました', 'ok');
    await loadTemplates();
    runPreview();
  } catch (err) {
    message($('#form-message'), err.message, 'err');
  }
});

$('#btn-delete-template').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('このテンプレートを削除しますか？')) return;
  try {
    await api(`/templates/${editingId}`, { method: 'DELETE' });
    editingId = null;
    showForm(false);
    await loadTemplates();
  } catch (err) {
    message($('#form-message'), err.message, 'err');
  }
});

/* -------------------------------- playlists ------------------------------- */

function playlistRow(p = { key: '', playlistId: '', label: '', order: 'newest' }) {
  const wrap = document.createElement('div');
  wrap.className = 'body-item playlist-row';
  wrap.innerHTML = `
    <div class="row">
      <label>キー（変数名に使われます）
        <input class="pl-key" type="text" value="${esc(p.key)}" placeholder="highlight">
      </label>
      <label>表示名
        <input class="pl-label" type="text" value="${esc(p.label)}" placeholder="ハイライト再生リスト">
      </label>
    </div>
    <div class="row">
      <label>再生リストID
        <input class="pl-id" type="text" value="${esc(p.playlistId)}" placeholder="PLxxxxxxxxxxxx">
      </label>
      <label>どれを「最新」とするか
        <select class="pl-order">
          <option value="newest">公開日が最も新しい動画</option>
          <option value="first">再生リストの先頭</option>
          <option value="last">再生リストの末尾</option>
        </select>
      </label>
    </div>
    <div class="row">
      <button type="button" class="btn btn-ghost pl-test">この再生リストをテスト</button>
      <button type="button" class="btn btn-danger pl-remove">削除</button>
      <span class="form-message pl-msg"></span>
    </div>
    <div class="hint pl-vars"></div>`;

  $('.pl-order', wrap).value = p.order || 'newest';

  const updateVars = () => {
    const k = $('.pl-key', wrap).value.trim();
    $('.pl-vars', wrap).innerHTML = k
      ? `使える変数: <code>{{playlist_${esc(k)}_url}}</code> <code>{{playlist_${esc(k)}_title}}</code>`
      : 'キーを入力すると、使える変数名が表示されます。';
  };
  $('.pl-key', wrap).addEventListener('input', updateVars);
  updateVars();

  $('.pl-remove', wrap).addEventListener('click', () => wrap.remove());

  $('.pl-test', wrap).addEventListener('click', async () => {
    const msg = $('.pl-msg', wrap);
    message(msg, '取得中…', 'ok');
    try {
      const r = await api('/playlists/test', {
        method: 'POST',
        body: {
          key: $('.pl-key', wrap).value.trim() || 'test',
          playlistId: $('.pl-id', wrap).value.trim(),
          label: $('.pl-label', wrap).value.trim(),
          order: $('.pl-order', wrap).value,
        },
      });
      // Reflect the normalised ID back into the field so a pasted URL is
      // visibly converted rather than silently reinterpreted each time.
      if (r.playlistId) $('.pl-id', wrap).value = r.playlistId;
      msg.innerHTML = `<span class="ok">最新動画: ${esc(r.title)}</span><br>
        <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>`;
      msg.className = 'form-message pl-msg';
    } catch (err) {
      message(msg, err.message, 'err');
    }
  });

  return wrap;
}

async function loadPlaylists() {
  const list = await api('/playlists');
  const el = $('#playlist-list');
  el.innerHTML = '';
  if (!list.length) el.appendChild(playlistRow());
  else list.forEach((p) => el.appendChild(playlistRow(p)));
}

$('#btn-add-playlist').addEventListener('click', () => {
  $('#playlist-list').appendChild(playlistRow());
});

$('#btn-save-playlists').addEventListener('click', async () => {
  const msg = $('#playlist-message');
  const playlists = $$('#playlist-list .playlist-row')
    .map((w) => ({
      key: $('.pl-key', w).value.trim(),
      playlistId: $('.pl-id', w).value.trim(),
      label: $('.pl-label', w).value.trim(),
      order: $('.pl-order', w).value,
    }))
    // A blank row is the empty starting state, not something to save.
    .filter((p) => p.key || p.playlistId);

  try {
    await api('/playlists', { method: 'PUT', body: { playlists } });
    message(msg, '保存しました', 'ok');
    await loadVariables();
    runPreview();
  } catch (err) {
    message(msg, err.message, 'err');
  }
});

/* --------------------------------- preview -------------------------------- */

async function runPreview() {
  // The picker offers Shorts as its own entry; the API takes platform plus a
  // flag, since a Short is still posted to YouTube.
  const picked = $('#preview-platform').value;
  const body = {
    title: $('#preview-title').value,
    platform: picked === 'youtube_short' ? 'youtube' : picked,
    isShort: picked === 'youtube_short',
  };
  // When the editor is open, preview exactly what's on screen (including
  // unsaved edits) instead of the stored template.
  if (!form.hidden) {
    const bodies = $$('#bodies textarea').map((t) => t.value).filter((v) => v.trim());
    if (bodies.length) body.body = bodies[Math.floor(Math.random() * bodies.length)];
  }

  try {
    const r = await api('/templates/preview', { method: 'POST', body });
    const matched = r.matched
      ? `使われるテンプレート: <strong>${esc(r.matched.name)}</strong>（${
          r.matched.pin ? 'ピン留めあり' : 'ピン留めなし'
        } / ${r.matched.delaySeconds}秒後に投稿）`
      : '<span class="badge badge-warn">一致するテンプレートがありません</span>';

    $('#preview-result').innerHTML = `
      <p class="hint" style="margin-bottom:8px">${matched}</p>
      ${r.rendered ? `<div class="preview-box">${esc(r.rendered)}</div>` : ''}
      <p class="hint">${r.length ?? 0} 文字${r.truncated ? '（文字数上限で切り詰められました）' : ''}${
        r.warnings && r.warnings.length ? ` ・ <span style="color:var(--warn)">${esc(r.warnings.join(' / '))}</span>` : ''
      }</p>`;
  } catch (err) {
    $('#preview-result').innerHTML = `<p class="form-message err">${esc(err.message)}</p>`;
  }
}

$('#btn-preview').addEventListener('click', runPreview);
$('#preview-title').addEventListener('change', runPreview);
$('#preview-platform').addEventListener('change', runPreview);

/* ---------------------------------- jobs ---------------------------------- */

/* ------------------------------- exclusions ------------------------------- */

async function loadExclusions() {
  const list = await api('/exclusions');
  const el = $('#exclusion-list');

  if (!list.length) {
    el.innerHTML = '<p class="hint">除外中の動画はありません。</p>';
    return;
  }

  el.innerHTML = `<table>
    <thead><tr><th>登録日時</th><th>媒体</th><th>動画</th><th>メモ</th><th></th></tr></thead>
    <tbody>${list
      .map(
        (e) => `<tr>
        <td>${fmtDate(e.addedAt)}</td>
        <td>${e.platform === 'youtube' ? 'YouTube' : 'TikTok'}</td>
        <td><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.videoId)}</a></td>
        <td>${esc(e.note || '—')}</td>
        <td><button class="btn btn-ghost" data-unexclude="${esc(e.platform)}/${esc(e.videoId)}">解除</button></td>
      </tr>`,
      )
      .join('')}</tbody></table>`;

  $$('[data-unexclude]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('除外を解除しますか？\n\n以降、この動画は通常どおりコメント対象になります。')) return;
      b.disabled = true;
      try {
        await api(`/exclusions/${b.dataset.unexclude}`, { method: 'DELETE' });
        await loadExclusions();
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    }),
  );
}

$('#btn-add-exclusion').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msg = $('#exclusion-message');
  const url = $('#exclusion-url').value.trim();
  if (!url) return message(msg, 'URLを入力してください', 'err');

  btn.disabled = true;
  try {
    const r = await api('/exclusions', {
      method: 'POST',
      body: { url, note: $('#exclusion-note').value.trim() },
    });
    $('#exclusion-url').value = '';
    $('#exclusion-note').value = '';
    message(msg, r.note || '除外リストに追加しました。', r.alreadyPosted ? 'err' : 'ok');
    await loadExclusions();
    await loadJobs();
  } catch (err) {
    message(msg, err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------- jobs ---------------------------------- */

/**
 * Only clips have a source to point at, so anything else reads as 対象外
 * rather than as a step that failed.
 */
function relatedCell(j) {
  if (!j.setRelated) return '<span class="hint">対象外</span>';
  const src = j.video.source;
  const link = src
    ? `<div class="hint" style="margin-top:2px"><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(
        src.title || src.videoId,
      )}</a></div>`
    : '';
  return j.relatedDone
    ? `<span class="badge badge-ok">設定済み</span>${link}`
    : `<span class="badge badge-warn">未設定</span>${link}`;
}

let jobs = [];

async function loadJobs() {
  jobs = await api('/jobs');
  if (!jobs.length) {
    $('#jobs-table').innerHTML = '<p class="hint">まだ投稿履歴はありません。</p>';
    return;
  }

  const badge = (s) =>
    ({
      done: 'badge-ok',
      failed: 'badge-err',
      needs_manual: 'badge-warn',
    })[s] || 'badge-muted';

  $('#jobs-table').innerHTML = `<table>
    <thead><tr>
      <th>検知日時</th><th>媒体</th><th>動画</th><th>状態</th>
      <th>コメント / ピン</th><th>関連動画</th><th>コメント本文</th><th></th>
    </tr></thead>
    <tbody>${jobs
      .map(
        (j) => `<tr>
        <td>${fmtDate(j.createdAt)}</td>
        <td>${j.platform === 'youtube' ? 'YouTube' : 'TikTok'}</td>
        <td><a href="${esc(j.video.url)}" target="_blank" rel="noopener">${esc(j.video.title || j.video.videoId)}</a>
            <div class="hint" style="margin:2px 0 0">${esc(j.templateName)}</div></td>
        <td><span class="badge ${badge(j.status)}">${STATUS_LABELS[j.status] || j.status}</span>
            ${j.lastError ? `<div class="hint" style="margin:4px 0 0;color:var(--err)">${esc(j.lastError)}</div>` : ''}</td>
        <td>${j.commentDone ? '✅' : '—'} / ${j.shouldPin ? (j.pinDone ? '✅' : '—') : '対象外'}</td>
        <td>${relatedCell(j)}</td>
        <td class="comment">${esc(j.commentText)}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost" data-retry="${j.id}">再実行</button>
          <button class="btn btn-danger" data-delete-job="${j.id}" style="margin-top:4px">${
            j.commentDone ? 'コメント削除' : '削除'
          }</button>
          <button class="btn btn-ghost" data-exclude-url="${esc(j.video.url)}" style="margin-top:4px">今後も除外</button>
          ${
            j.setRelated
              ? `<button class="btn btn-ghost" data-set-related="${j.id}" style="margin-top:4px">関連動画を再設定</button>`
              : ''
          }
        </td>
      </tr>`,
      )
      .join('')}</tbody></table>`;

  $$('[data-retry]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/jobs/${b.dataset.retry}/retry`, { method: 'POST' });
        await loadJobs();
      } catch (e) {
        alert(e.message);
        b.disabled = false;
      }
    }),
  );

  $$('[data-exclude-url]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('この動画を除外リストに追加しますか？\n\n待機中のジョブがあれば取り消されます。')) return;
      b.disabled = true;
      try {
        const r = await api('/exclusions', { method: 'POST', body: { url: b.dataset.excludeUrl, note: '' } });
        if (r.note) alert(r.note);
        await loadExclusions();
        await loadJobs();
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    }),
  );

  $$('[data-set-related]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const original = b.textContent;
      b.textContent = '設定中…（1分ほど）';
      try {
        const r = await api(`/jobs/${b.dataset.setRelated}/related`, { method: 'POST' });
        alert(r.note || '設定しました');
        await loadJobs();
      } catch (err) {
        alert(err.message);
      } finally {
        b.disabled = false;
        b.textContent = original;
      }
    }),
  );

  $$('[data-delete-job]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.deleteJob;
      const job = jobs.find((j) => String(j.id) === id);
      const posted = job && job.commentDone;

      const message = posted
        ? '実際に投稿済みのコメントです。\n\n' +
          (job.platform === 'youtube'
            ? 'YouTube からこのコメントを削除します。よろしいですか？'
            : 'TikTok はAPIで削除できないため、手動削除が必要です。')
        : 'このジョブを削除しますか？\n\nこの動画へのコメントは行われません。';

      if (!confirm(message)) return;
      b.disabled = true;
      try {
        // Posted comments go through unpost so the real comment is removed,
        // not just our record of it.
        const r = posted
          ? await api(`/jobs/${id}/unpost`, { method: 'POST' })
          : await api(`/jobs/${id}`, { method: 'DELETE' });
        if (r.note) alert(r.note);
        await loadJobs();
        loadStatus();
      } catch (e) {
        alert(e.message);
        b.disabled = false;
      }
    }),
  );
}

$('#btn-refresh-jobs').addEventListener('click', loadJobs);

$('#btn-unpost-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (
    !confirm(
      '⚠️ 投稿済みのコメントを実際に削除します\n\n' +
        'YouTube に書き込まれたコメントを API 経由で削除します。\n' +
        'この操作は取り消せません。\n\n' +
        '実行しますか？',
    )
  ) {
    return;
  }
  btn.disabled = true;
  btn.textContent = '削除中…';
  try {
    const r = await api('/jobs/unpost-all', { method: 'POST' });
    let msg = `YouTube から ${r.deleted} 件のコメントを削除しました。`;
    if (r.failed.length) msg += `\n\n削除に失敗:\n${r.failed.join('\n')}`;
    if (r.manual.length) {
      msg += `\n\n⚠️ TikTok は手動削除が必要です:\n${r.manual.join('\n')}`;
    }
    alert(msg);
    await loadJobs();
    loadStatus();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '投稿済みのコメントを削除（取り消し）';
  }
});

$('#btn-clear-unfinished').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (
    !confirm(
      '未完了のジョブをまとめて削除します。\n\n' +
        '対象: 待機中 / コメント中 / ピン留め中 / 手動対応が必要 / 失敗\n' +
        '完了済みの履歴は残ります。\n\n' +
        '削除した動画にはコメントされません。よろしいですか？',
    )
  ) {
    return;
  }
  btn.disabled = true;
  try {
    const r = await api('/jobs/bulk-delete', {
      method: 'POST',
      body: { statuses: ['pending', 'commenting', 'pinning', 'needs_manual', 'failed'] },
    });
    alert(`${r.deleted} 件のジョブを削除しました。`);
    await loadJobs();
    loadStatus();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------- logs ---------------------------------- */

async function loadLogs() {
  const logs = await api('/logs');
  $('#logs-view').innerHTML = logs.length
    ? logs
        .map(
          (l) => `<div class="log-line">
            <span class="ts">${fmtDate(l.created_at)}</span>
            <span class="lv-${l.level}">[${esc(l.level)}]</span>
            <span class="lv-info">[${esc(l.scope)}]</span>
            ${esc(l.message)}
          </div>`,
        )
        .join('')
    : '<p class="hint">ログはまだありません。</p>';
}

$('#btn-refresh-logs').addEventListener('click', loadLogs);

/* ---------------------------------- setup --------------------------------- */

$$('[data-disconnect]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.disconnect;
    if (!confirm(`${p} の連携を解除しますか？`)) return;
    await api(`/accounts/${p}/disconnect`, { method: 'POST' });
    loadStatus();
  }),
);

$('#btn-websub').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try {
    const r = await api('/websub/subscribe', { method: 'POST' });
    alert(r.note || '購読しました');
  } catch (err) {
    alert(`失敗しました: ${err.message}`);
  } finally {
    e.currentTarget.disabled = false;
    loadStatus();
  }
});

$$('[data-save-session]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.saveSession;
    const msg = $(`#session-msg-${p}`);
    try {
      const merge = $(`[data-merge="${p}"]`)?.checked ?? false;
      const r = await api(`/browser/${p}/session`, {
        method: 'POST',
        body: { cookies: $(`#cookies-${p}`).value, merge },
      });
      $(`#cookies-${p}`).value = '';
      const d = r.diagnosis;
      msg.innerHTML =
        `保存しました（Cookie ${r.cookieCount} 件${merge ? '・追記' : ''}）<br>` +
        `<span class="${d && d.ok ? 'ok' : 'err'}">${esc(d ? d.message : '')}</span>`;
      msg.className = 'form-message';
      loadStatus();
    } catch (err) {
      message(msg, err.message, 'err');
    }
  }),
);

$$('[data-diagnose]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.diagnose;
    const msg = $(`#session-msg-${p}`);
    try {
      const r = await api(`/browser/${p}/diagnose`);
      const extra = r.expiringSoon.length
        ? `<br>7日以内に失効する Cookie: ${esc(r.expiringSoon.slice(0, 5).join(', '))}`
        : '';
      msg.innerHTML = `<span class="${r.ok ? 'ok' : 'err'}">${esc(r.message)}</span>${extra}`;
      msg.className = 'form-message';
    } catch (err) {
      message(msg, err.message, 'err');
    }
  }),
);

$$('[data-check-session]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.checkSession;
    const msg = $(`#session-msg-${p}`);
    message(msg, '確認中…（30秒ほどかかります）', 'ok');
    btn.disabled = true;
    try {
      const r = await api(`/browser/${p}/check`, { method: 'POST' });
      // Show the raw signals: "not logged in" alone gives nothing to act on.
      const signals = (r.signals || []).map((s) => `<li>${esc(s)}</li>`).join('');
      msg.innerHTML =
        `<span class="${r.loggedIn ? 'ok' : 'err'}">${esc(r.detail)}</span>` +
        (signals ? `<ul style="margin:6px 0 0;font-size:12px;color:var(--muted)">${signals}</ul>` : '');
      msg.className = 'form-message';
    } catch (err) {
      message(msg, err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }),
);

$$('[data-refresh-session]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.refreshSession;
    const msg = $(`#session-msg-${p}`);
    message(msg, '更新中…（30秒ほどかかります）', 'ok');
    btn.disabled = true;
    try {
      const r = await api(`/browser/${p}/refresh`, { method: 'POST' });
      message(msg, r.note, r.ok ? 'ok' : 'err');
      loadStatus();
    } catch (err) {
      message(msg, err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }),
);

$$('[data-clear-session]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.clearSession;
    if (!confirm(`${p} のログインセッションを削除しますか？`)) return;
    await api(`/browser/${p}/session`, { method: 'DELETE' });
    message($(`#session-msg-${p}`), '削除しました', 'ok');
    loadStatus();
  }),
);

$$('[data-screenshot]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const p = btn.dataset.screenshot;
    const view = $('#screenshot-view');
    try {
      const r = await api(`/browser/${p}/screenshot`);
      view.innerHTML = r.empty
        ? '<p class="hint">失敗時のスクリーンショットはまだありません。</p>'
        : `<p class="hint">${esc(p)} / ${fmtDate(r.at)} / ${esc(r.url)}</p><img src="${r.dataUri}" alt="">`;
    } catch (err) {
      view.innerHTML = `<p class="form-message err">${esc(err.message)}</p>`;
    }
  }),
);

/* ---------------------------------- init ---------------------------------- */

/**
 * Template and preview loading needs the database. When it is down, loading
 * them anyway just produced unhandled rejections and an empty screen with no
 * explanation — the dashboard's error box is the useful output instead.
 */
async function init() {
  const ready = await loadStatus();
  if (!ready) return;
  await loadTemplates().catch(() => {});
  await loadVariables().catch(() => {});
  await loadPlaylists().catch(() => {});
  runPreview();
}

init();

// Once the database recovers, pick up the data we skipped on the first pass.
let wasReady = false;
setInterval(async () => {
  const ready = await loadStatus();
  if (ready && !wasReady) init();
  wasReady = ready;
}, 30_000);
