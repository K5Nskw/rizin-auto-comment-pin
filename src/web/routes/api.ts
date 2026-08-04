import { Router } from 'express';
import { z } from 'zod';
import { bootState, describeDbError } from '../../bootState.js';
import {
  browserAvailable,
  checkLogin,
  diagnoseCookies,
  mergeStorageState,
  normaliseStorageState,
} from '../../browser/session.js';
import { config, configWarnings, legalUrls } from '../../config.js';
import {
  browserSessionInfo,
  createTemplate,
  deleteAccount,
  deleteBrowserSession,
  deleteJob,
  deleteJobsByStatus,
  deleteTemplate,
  type Exclusion,
  getAccount,
  getBrowserSession,
  getExclusions,
  getJob,
  getPlaylists,
  getSetting,
  getWatermark,
  jobStats,
  listJobs,
  listTemplates,
  recentLogs,
  resetWatermark,
  saveBrowserSession,
  setExclusions,
  setPlaylists,
  updateTemplate,
  videoKey,
} from '../../db/repo.js';
import { PARSE_HINT, parseVideoUrl } from '../../videoUrl.js';
import { errMessage } from '../../logger.js';
import { deleteComment } from '../../platforms/youtube/api.js';
import {
  clearPlaylistCache,
  fetchLatestFromPlaylist,
  normalisePlaylistId,
  playlistVariableNames,
  resolvePlaylistVariables,
} from '../../platforms/youtube/playlists.js';
import { subscribe, subscriptionState } from '../../platforms/youtube/websub.js';
import { pollAll } from '../../scheduler.js';
import {
  clampComment,
  pickBody,
  renderTemplate,
  selectTemplate,
  SOURCE_VARIABLES,
  TEMPLATE_VARIABLES,
  validateTemplateBody,
} from '../../templates/engine.js';
import type { Platform } from '../../types.js';
import { requeueJob } from '../../worker.js';

export const apiRouter: Router = Router();

const platformSchema = z.enum(['youtube', 'tiktok']);

const templateSchema = z.object({
  name: z.string().min(1, '名前を入力してください'),
  platform: z.enum(['all', 'youtube', 'tiktok']),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(9999),
  matchType: z.enum(['always', 'keyword', 'regex']),
  matchValue: z.string(),
  bodies: z.array(z.string()).min(1, 'コメント本文を1つ以上入力してください'),
  pin: z.boolean(),
  delaySeconds: z.number().int().min(0).max(86_400),
});

/**
 * Wraps a handler so any throw becomes a clean JSON error instead of a 500
 * page. Zod errors are flattened to their messages — the raw issue array is
 * unreadable in an alert box.
 */
const handle =
  (fn: (req: any, res: any) => Promise<unknown>) =>
  async (req: any, res: any): Promise<void> => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (e) {
      const error =
        e instanceof z.ZodError
          ? e.issues.map((i) => i.message).join(' / ')
          : errMessage(e);
      if (!res.headersSent) res.status(400).json({ ok: false, error });
    }
  };

/* --------------------------------- status --------------------------------- */

apiRouter.get(
  '/status',
  handle(async () => {
    // Every other field needs the database. When it isn't up yet, return the
    // reason rather than a generic query failure — this is the screen the
    // operator lands on after a failed deploy.
    if (!bootState.dbReady) {
      return {
        dbReady: false,
        dbError: describeDbError(),
        dbAttempts: bootState.dbAttempts,
        warnings: configWarnings(),
        publicUrl: config.PUBLIC_URL,
        legal: legalUrls(),
        redirectUris: {
          youtube: `${config.PUBLIC_URL}/oauth/youtube/callback`,
          tiktok: `${config.PUBLIC_URL}/oauth/tiktok/callback`,
        },
      };
    }

    const [youtube, tiktok, stats, websub, sessions, wmYoutube, wmTiktok] = await Promise.all([
      getAccount('youtube'),
      getAccount('tiktok'),
      jobStats(),
      subscriptionState(),
      browserSessionInfo(),
      getWatermark('youtube'),
      getWatermark('tiktok'),
    ]);
    return {
      dbReady: true,
      warnings: configWarnings(),
      publicUrl: config.PUBLIC_URL,
      // Surfaced so the operator can copy them straight into the Google /
      // TikTok developer consoles instead of assembling them by hand.
      legal: legalUrls(),
      redirectUris: {
        youtube: `${config.PUBLIC_URL}/oauth/youtube/callback`,
        tiktok: `${config.PUBLIC_URL}/oauth/tiktok/callback`,
      },
      dryRun: config.DRY_RUN,
      // AutoClipMaker に貼り付ける値。組み立てさせずにそのまま出す
      ingest: {
        enabled: Boolean(config.INGEST_TOKEN),
        url: `${config.PUBLIC_URL}/ingest/clip`,
      },
      pollIntervalMinutes: config.POLL_INTERVAL_MINUTES,
      maxVideoAgeHours: config.MAX_VIDEO_AGE_HOURS,
      watermarks: {
        youtube: wmYoutube ? new Date(wmYoutube).toISOString() : null,
        tiktok: wmTiktok ? new Date(wmTiktok).toISOString() : null,
      },
      browser: {
        enabled: config.ENABLE_BROWSER_AUTOMATION,
        available: await browserAvailable(),
        sessions,
      },
      websub,
      stats,
      accounts: {
        youtube: youtube && {
          displayName: youtube.displayName,
          externalId: youtube.externalId,
          connectedAt: youtube.connectedAt,
        },
        tiktok: tiktok && {
          displayName: tiktok.displayName,
          externalId: tiktok.externalId,
          connectedAt: tiktok.connectedAt,
        },
      },
    };
  }),
);

apiRouter.get(
  '/variables',
  handle(async () => {
    const playlists = await getPlaylists();
    return [
      ...TEMPLATE_VARIABLES,
      ...SOURCE_VARIABLES,
      ...playlists.flatMap((p) => [
        { token: `{{playlist_${p.key}_url}}`, description: `${p.label || p.key} の最新動画URL` },
        { token: `{{playlist_${p.key}_title}}`, description: `${p.label || p.key} の最新動画タイトル` },
      ]),
    ];
  }),
);

/* -------------------------------- exclusions ------------------------------- */

apiRouter.get(
  '/exclusions',
  handle(async () => getExclusions()),
);

/**
 * Adding an exclusion also cancels any job already queued for that video —
 * excluding a video whose comment is still pending would otherwise post it
 * anyway once the delay elapsed.
 */
apiRouter.post(
  '/exclusions',
  handle(async (req) => {
    const input = z
      .object({ url: z.string().min(1, 'URLを入力してください'), note: z.string().default('') })
      .parse(req.body);

    const parsed = parseVideoUrl(input.url);
    if (!parsed) throw new Error(`URLを認識できませんでした。${PARSE_HINT}`);

    const key = videoKey(parsed.platform, parsed.videoId);
    const list = await getExclusions();
    if (list.some((e) => e.key === key)) {
      throw new Error('この動画はすでに除外リストに登録されています');
    }

    const entry: Exclusion = {
      key,
      platform: parsed.platform,
      videoId: parsed.videoId,
      url: parsed.url,
      note: input.note,
      addedAt: new Date().toISOString(),
    };
    await setExclusions([entry, ...list]);

    // Cancel a queued job, but never touch one whose comment already went out
    // — removing that is a separate, explicit decision.
    const jobs = await listJobs(200);
    const pending = jobs.find((j) => j.videoKey === key && !j.commentDone);
    let cancelledJob = false;
    if (pending) {
      await deleteJob(pending.id);
      cancelledJob = true;
    }

    const posted = jobs.find((j) => j.videoKey === key && j.commentDone);
    return {
      ok: true,
      entry,
      cancelledJob,
      alreadyPosted: Boolean(posted),
      note: posted
        ? 'この動画にはすでにコメントが投稿済みです。今後は対象外になりますが、投稿済みのコメントは「投稿履歴」から削除してください。'
        : cancelledJob
          ? '待機中だったジョブを取り消しました。'
          : undefined,
    };
  }),
);

apiRouter.delete(
  '/exclusions/:platform/:videoId',
  handle(async (req) => {
    const key = videoKey(platformSchema.parse(req.params.platform) as Platform, req.params.videoId);
    const list = await getExclusions();
    await setExclusions(list.filter((e) => e.key !== key));
    return { ok: true };
  }),
);

/* -------------------------------- playlists -------------------------------- */

const playlistSchema = z.object({
  // Becomes part of a {{variable}} name, so it has to match the token pattern.
  key: z
    .string()
    .regex(/^[a-zA-Z0-9_]{1,24}$/, 'キーは半角英数字とアンダースコア（24文字以内）にしてください'),
  // Normalised on the way in, so a pasted URL is stored as a bare ID.
  playlistId: z
    .string()
    .min(2, '再生リストIDを入力してください')
    .transform((v) => normalisePlaylistId(v)),
  label: z.string().default(''),
  order: z.enum(['newest', 'first', 'last']).default('newest'),
});

apiRouter.get(
  '/playlists',
  handle(async () => getPlaylists()),
);

apiRouter.put(
  '/playlists',
  handle(async (req) => {
    const input = z.object({ playlists: z.array(playlistSchema) }).parse(req.body);

    const keys = new Set<string>();
    for (const p of input.playlists) {
      if (keys.has(p.key)) throw new Error(`キー「${p.key}」が重複しています`);
      keys.add(p.key);
    }

    await setPlaylists(input.playlists);
    clearPlaylistCache();
    return { ok: true, playlists: input.playlists };
  }),
);

/** Resolves one playlist now, so the operator can confirm the ID before saving. */
apiRouter.post(
  '/playlists/test',
  handle(async (req) => {
    const config = playlistSchema.parse(req.body);
    clearPlaylistCache();
    const video = await fetchLatestFromPlaylist(config);
    // Echo the normalised ID so a pasted URL visibly resolves to an ID.
    return { ...video, playlistId: config.playlistId };
  }),
);

/* -------------------------------- templates -------------------------------- */

apiRouter.get(
  '/templates',
  handle(async () => listTemplates()),
);

apiRouter.post(
  '/templates',
  handle(async (req) => {
    const input = templateSchema.parse(req.body);
    return createTemplate(await cleanBodies(input));
  }),
);

apiRouter.put(
  '/templates/:id',
  handle(async (req) => {
    const input = templateSchema.parse(req.body);
    const updated = await updateTemplate(Number(req.params.id), await cleanBodies(input));
    if (!updated) throw new Error('テンプレートが見つかりません');
    return updated;
  }),
);

apiRouter.delete(
  '/templates/:id',
  handle(async (req) => {
    await deleteTemplate(Number(req.params.id));
    return { ok: true };
  }),
);

async function cleanBodies<T extends { bodies: string[]; matchType: string; matchValue: string }>(
  input: T,
): Promise<T> {
  const bodies = input.bodies.map((b) => b.trim()).filter(Boolean);
  if (!bodies.length) throw new Error('コメント本文が空です');

  const playlistNames = (await getPlaylists()).flatMap((p) => playlistVariableNames(p.key));
  for (const b of bodies) {
    const errors = validateTemplateBody(b, playlistNames);
    if (errors.length) throw new Error(errors.join(' / '));
  }
  if (input.matchType === 'regex') {
    try {
      new RegExp(input.matchValue);
    } catch {
      throw new Error('正規表現が不正です');
    }
  }
  if (input.matchType !== 'always' && !input.matchValue.trim()) {
    throw new Error('条件（キーワード / 正規表現）を入力してください');
  }
  return { ...input, bodies };
}

/**
 * Answers "if a video with this title were posted right now, what exactly
 * would the bot say?" — the main way to check template changes before they run.
 */
apiRouter.post(
  '/templates/preview',
  handle(async (req) => {
    const schema = z.object({
      title: z.string().default('【RIZIN】試合ハイライト｜〇〇 vs 〇〇'),
      description: z.string().default(''),
      platform: platformSchema.default('youtube'),
      body: z.string().optional(),
      /** 切り抜き（AutoClipMaker 経由）として試す。 */
      asClip: z.boolean().default(false),
    });
    const input = schema.parse(req.body ?? {});

    // 切り抜きの見本。実際に届くのと同じ形で入れないと、
    // 切り抜き用テンプレートのプレビューが変数のまま出てしまう
    const clipSource = input.asClip
      ? {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: '【RIZIN】記者会見ノーカット',
          videoId: 'dQw4w9WgXcQ',
          startSec: 754,
        }
      : undefined;

    const templates = await listTemplates();
    const matched = selectTemplate(templates, {
      title: input.title,
      description: input.description,
      platform: input.platform,
      source: clipSource,
    });

    const account = await getAccount(input.platform);
    const ctx = {
      title: input.title,
      url:
        input.platform === 'youtube'
          ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
          : 'https://www.tiktok.com/@rizin/video/1234567890',
      videoId: input.platform === 'youtube' ? 'dQw4w9WgXcQ' : '1234567890',
      platform: input.platform,
      channel: account?.displayName ?? 'RIZIN',
      publishedAt: new Date(),
      source: clipSource,
    };

    // An explicit body previews unsaved edits; otherwise preview the template
    // that would actually be selected.
    const source = input.body ?? (matched ? pickBody(matched) : '');
    if (!source) {
      return { matched: null, rendered: '', note: '一致するテンプレートがありません' };
    }

    // Resolve playlist links for real, so the preview shows the actual URL
    // that would be posted rather than a placeholder.
    const playlists = await getPlaylists();
    const resolved = await resolvePlaylistVariables(source, playlists);

    const rendered = renderTemplate(source, { ...ctx, extra: resolved.values });
    const { text, truncated } = clampComment(rendered, input.platform);
    return {
      matched: matched ? { id: matched.id, name: matched.name, pin: matched.pin, delaySeconds: matched.delaySeconds } : null,
      rendered: text,
      length: text.length,
      truncated,
      warnings: [
        ...validateTemplateBody(source, playlists.flatMap((p) => playlistVariableNames(p.key))),
        ...resolved.errors,
      ],
    };
  }),
);

/* ----------------------------------- jobs ---------------------------------- */

apiRouter.get(
  '/jobs',
  handle(async () => listJobs(50)),
);

apiRouter.post(
  '/jobs/:id/retry',
  handle(async (req) => {
    await requeueJob(Number(req.params.id));
    return { ok: true };
  }),
);

apiRouter.delete(
  '/jobs/:id',
  handle(async (req) => {
    const deleted = await deleteJob(Number(req.params.id));
    if (!deleted) throw new Error('ジョブが見つかりません');
    return { ok: true };
  }),
);

/**
 * Undo: deletes the comment from YouTube itself, not just our record of it.
 * TikTok has no comment-delete API, so those have to be removed by hand and
 * we say so rather than pretending it worked.
 */
apiRouter.post(
  '/jobs/:id/unpost',
  handle(async (req) => {
    const job = await getJob(Number(req.params.id));
    if (!job) throw new Error('ジョブが見つかりません');

    if (!job.commentDone) {
      await deleteJob(job.id);
      return { ok: true, note: 'まだ投稿されていないジョブだったため、削除しました。' };
    }

    if (job.platform !== 'youtube' || !job.commentId) {
      throw new Error(
        'TikTok のコメントはAPIで削除できません。TikTokアプリ/サイトから手動で削除してください。',
      );
    }

    await deleteComment(job.commentId);
    await deleteJob(job.id);
    return { ok: true, note: 'YouTube からコメントを削除しました。' };
  }),
);

/** Bulk version of the above, for cleaning up a run that shouldn't have happened. */
apiRouter.post(
  '/jobs/unpost-all',
  handle(async () => {
    const jobs = await listJobs(200);
    const targets = jobs.filter((j) => j.commentDone && j.platform === 'youtube' && j.commentId);

    const result = { deleted: 0, failed: [] as string[], manual: [] as string[] };

    for (const job of targets) {
      try {
        await deleteComment(job.commentId!);
        await deleteJob(job.id);
        result.deleted++;
      } catch (e) {
        result.failed.push(`${job.video.title}: ${errMessage(e)}`);
      }
    }

    // Anything posted on TikTok went through the browser, and there is no API
    // to take it back down.
    for (const job of jobs.filter((j) => j.commentDone && j.platform === 'tiktok')) {
      result.manual.push(job.video.url);
    }

    return result;
  }),
);

/**
 * Bulk cancel. Restricted to statuses that represent unfinished work —
 * clearing 'done' would lose the record of what was actually posted.
 */
apiRouter.post(
  '/jobs/bulk-delete',
  handle(async (req) => {
    const input = z
      .object({ statuses: z.array(z.enum(['pending', 'commenting', 'pinning', 'needs_manual', 'failed'])).min(1) })
      .parse(req.body);
    const deleted = await deleteJobsByStatus(input.statuses);
    return { ok: true, deleted };
  }),
);

apiRouter.post(
  '/poll',
  handle(async () => pollAll()),
);

apiRouter.get(
  '/logs',
  handle(async () => recentLogs(150)),
);

/* --------------------------------- accounts -------------------------------- */

apiRouter.post(
  '/accounts/:platform/disconnect',
  handle(async (req) => {
    await deleteAccount(platformSchema.parse(req.params.platform));
    return { ok: true };
  }),
);

/** Re-arms the cutoff at "now", so nothing already published becomes eligible. */
apiRouter.post(
  '/watermark/:platform/reset',
  handle(async (req) => {
    const platform = platformSchema.parse(req.params.platform) as Platform;
    await resetWatermark(platform);
    return { ok: true, at: new Date().toISOString() };
  }),
);

apiRouter.post(
  '/websub/subscribe',
  handle(async () => {
    await subscribe('subscribe');
    return { ok: true, note: '購読リクエストを送信しました（数秒後に反映されます）' };
  }),
);

/* ----------------------------- browser sessions ---------------------------- */

apiRouter.post(
  '/browser/:platform/session',
  handle(async (req) => {
    const platform = platformSchema.parse(req.params.platform) as Platform;
    const raw = z
      .object({ cookies: z.string().min(2), merge: z.boolean().default(false) })
      .parse(req.body);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.cookies);
    } catch {
      throw new Error('JSON として読み取れませんでした');
    }

    const domain = platform === 'youtube' ? '.youtube.com' : '.tiktok.com';
    let state = normaliseStorageState(parsed, domain);

    // Merging lets youtube.com and google.com exports coexist; a browser
    // extension only ever exports one site at a time.
    if (raw.merge) {
      state = mergeStorageState(await getBrowserSession(platform), state);
    }

    await saveBrowserSession(platform, state);

    const cookieCount = (state as { cookies?: unknown[] }).cookies?.length ?? 0;
    return { ok: true, cookieCount, diagnosis: await diagnoseCookies(platform) };
  }),
);

apiRouter.post(
  '/browser/:platform/check',
  handle(async (req) => checkLogin(platformSchema.parse(req.params.platform) as Platform)),
);

/**
 * Inspects the stored cookies without launching a browser. Instant, and it
 * catches the common case — an export taken from the wrong site or profile —
 * which otherwise looks identical to an expired session.
 */
apiRouter.get(
  '/browser/:platform/diagnose',
  handle(async (req) => diagnoseCookies(platformSchema.parse(req.params.platform) as Platform)),
);

apiRouter.delete(
  '/browser/:platform/session',
  handle(async (req) => {
    await deleteBrowserSession(platformSchema.parse(req.params.platform) as Platform);
    return { ok: true };
  }),
);

apiRouter.get(
  '/browser/:platform/screenshot',
  handle(async (req) => {
    const platform = platformSchema.parse(req.params.platform);
    return (await getSetting(`last_failure_screenshot:${platform}`)) ?? { empty: true };
  }),
);
