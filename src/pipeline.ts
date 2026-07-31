import { config } from './config.js';
import {
  createJob,
  ensureWatermark,
  getAccount,
  getPlaylists,
  isExcluded,
  listTemplates,
  recordVideo,
  videoKey,
} from './db/repo.js';
import { resolvePlaylistVariables } from './platforms/youtube/playlists.js';
import { createLogger } from './logger.js';
import { notify } from './notify/index.js';
import { clampComment, pickBody, renderTemplate, selectTemplate } from './templates/engine.js';
import type { DetectedVideo } from './types.js';

const log = createLogger('pipeline');

export interface IngestResult {
  created: boolean;
  reason: string;
  commentText?: string;
  jobId?: number;
}

export interface IngestOptions {
  /**
   * Skips the watermark and age cutoffs. Only set for an explicit manual
   * request, where the operator has named the video themselves — automatic
   * watchers must never bypass it.
   */
  ignoreAge?: boolean;
  /** Posts this exact text instead of selecting a template. */
  overrideText?: string;
  /** Overrides the template's pin setting. Used with overrideText. */
  forcePin?: boolean;
  /** Ignores DRY_RUN, for a manual "post this one now". */
  force?: boolean;
}

/**
 * The single funnel every detection path (WebSub push, RSS poll, TikTok poll,
 * profile scrape, manual trigger) goes through. All de-duplication and safety
 * checks live here so no watcher can bypass them.
 */
export async function ingestVideo(v: DetectedVideo, options: IngestOptions = {}): Promise<IngestResult> {
  const key = videoKey(v.platform, v.videoId);

  // Checked first and with no override: an explicitly excluded video must not
  // be commented on by any path, including a manual trigger.
  const excluded = await isExcluded(key);
  if (excluded) {
    log.info(`skipping ${key}: on the exclusion list`);
    return {
      created: false,
      reason: `除外リストに登録されているためコメントしません${excluded.note ? `（${excluded.note}）` : ''}`,
    };
  }

  const { isNew } = await recordVideo(v);

  // A manual request re-runs on a known video on purpose; the unique index on
  // jobs.video_key is what actually prevents a duplicate comment.
  if (!isNew && !options.ignoreAge) {
    return { created: false, reason: 'すでに検知済みの動画です' };
  }

  if (!options.ignoreAge) {
    // Primary guard: only videos published after this platform was activated.
    // An age window alone let anything posted in the preceding 48 hours look
    // new on first deploy, which meant commenting on already-published videos.
    const watermark = await ensureWatermark(v.platform);

    if (watermark.justCreated) {
      log.info(`watermark set for ${v.platform}; existing uploads will not be commented on`);
      return {
        created: false,
        reason: '初回検知のため基準時刻を設定しました。これ以降に公開された動画から対象になります。',
      };
    }

    if (!v.publishedAt) {
      // Without a publication time there is no way to tell a new upload from
      // an old one, and guessing wrong means commenting on the back catalogue.
      log.warn(`skipping ${key}: no publish time`);
      return { created: false, reason: '公開日時が取得できなかったためスキップしました' };
    }

    if (v.publishedAt.getTime() <= watermark.value) {
      log.info(`skipping ${key}: published before watermark`);
      return {
        created: false,
        reason: `基準時刻（${new Date(watermark.value).toLocaleString('ja-JP')}）より前に公開された動画のためスキップ`,
      };
    }

    // Secondary guard, unchanged: catches a stale queue after downtime.
    const ageHours = (Date.now() - v.publishedAt.getTime()) / 3_600_000;
    if (ageHours > config.MAX_VIDEO_AGE_HOURS) {
      log.info(`skipping old video ${key} (${Math.round(ageHours)}h old)`);
      return { created: false, reason: `公開から${Math.round(ageHours)}時間経過しているためスキップ` };
    }
  }

  let text: string;
  let templateId: number | null = null;
  let templateName = '手動指定';
  let shouldPin = options.forcePin ?? true;
  let delaySeconds = 0;

  const playlists = await getPlaylists();

  /**
   * Playlist links are resolved before anything is queued. A failure here
   * stops the job: substituting nothing would publish a comment with a
   * dangling "→" and no link, which is worse than not commenting.
   */
  const resolvePlaylists = async (body: string) => {
    const { values, errors } = await resolvePlaylistVariables(body, playlists);
    if (errors.length) {
      log.error(`playlist resolution failed for ${key}: ${errors.join(' / ')}`);
      await notify(
        '⚠️ 再生リストのリンクを取得できませんでした',
        `${v.title}\n${v.url}\n\n${errors.join('\n')}\n\nリンクが空のまま投稿すると不自然なため、コメントしませんでした。`,
      );
    }
    return { values, failed: errors.length > 0, errors };
  };

  if (options.overrideText) {
    const resolved = await resolvePlaylists(options.overrideText);
    if (resolved.failed) {
      return { created: false, reason: resolved.errors.join(' / ') };
    }
    const rendered = renderTemplate(options.overrideText, {
      title: v.title,
      url: v.url,
      videoId: v.videoId,
      platform: v.platform,
      channel: (await getAccount(v.platform))?.displayName ?? '',
      publishedAt: v.publishedAt ?? new Date(),
      extra: resolved.values,
    });
    const clamped = clampComment(rendered, v.platform);
    if (clamped.truncated) log.warn(`manual comment truncated to platform limit for ${key}`);
    text = clamped.text;
  } else {
    const templates = await listTemplates();
    const template = selectTemplate(templates, v);
    if (!template) {
      log.warn(`no template matched for ${key}`, { title: v.title });
      await notify(
        '⚠️ テンプレートが見つかりません',
        `${v.title}\n${v.url}\n\n条件に一致する有効なテンプレートがないため、コメントしませんでした。`,
      );
      return { created: false, reason: '一致するテンプレートがありません' };
    }

    const body = pickBody(template);
    const resolved = await resolvePlaylists(body);
    if (resolved.failed) {
      return { created: false, reason: resolved.errors.join(' / ') };
    }

    const rendered = renderTemplate(body, {
      extra: resolved.values,
      title: v.title,
      url: v.url,
      videoId: v.videoId,
      platform: v.platform,
      channel: (await getAccount(v.platform))?.displayName ?? '',
      publishedAt: v.publishedAt ?? new Date(),
    });

    const clamped = clampComment(rendered, v.platform);
    if (clamped.truncated) log.warn(`comment truncated to platform limit for ${key}`);

    text = clamped.text;
    templateId = template.id;
    templateName = template.name;
    shouldPin = options.forcePin ?? template.pin;
    delaySeconds = template.delaySeconds;
  }

  if (!text) {
    return { created: false, reason: 'コメント本文が空です' };
  }

  if (config.DRY_RUN && !options.force) {
    log.info(`DRY_RUN: would comment on ${key}`, { text });
    await notify('🧪 DRY_RUN', `${v.title}\n${v.url}\n\n--- 投稿予定のコメント ---\n${text}`);
    return { created: false, reason: 'DRY_RUN のため投稿しません', commentText: text };
  }

  const job = await createJob({
    videoKey: key,
    platform: v.platform,
    templateId,
    templateName,
    commentText: text,
    shouldPin,
    runAfter: new Date(Date.now() + delaySeconds * 1000),
  });

  if (!job) return { created: false, reason: 'この動画のジョブは既に存在します（重複投稿は行いません）' };

  log.info(`job #${job.id} queued for ${key}`, { template: templateName, delay: delaySeconds });
  return {
    created: true,
    reason: options.overrideText
      ? '手動指定の本文でジョブを作成しました'
      : `テンプレート「${templateName}」でジョブを作成しました`,
    commentText: text,
    jobId: job.id,
  };
}
