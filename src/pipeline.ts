import { config } from './config.js';
import { createJob, getAccount, listTemplates, recordVideo, videoKey } from './db/repo.js';
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

/**
 * The single funnel every detection path (WebSub push, RSS poll, TikTok poll,
 * manual trigger) goes through. All de-duplication and safety checks live here
 * so no watcher can bypass them.
 */
export async function ingestVideo(v: DetectedVideo): Promise<IngestResult> {
  const key = videoKey(v.platform, v.videoId);
  const { isNew } = await recordVideo(v);

  if (!isNew) {
    return { created: false, reason: 'すでに検知済みの動画です' };
  }

  // Safety net: on first deploy the feed is full of old uploads. Without this
  // the bot would comment on the entire back catalogue at once.
  if (v.publishedAt) {
    const ageHours = (Date.now() - v.publishedAt.getTime()) / 3_600_000;
    if (ageHours > config.MAX_VIDEO_AGE_HOURS) {
      log.info(`skipping old video ${key} (${Math.round(ageHours)}h old)`);
      return { created: false, reason: `公開から${Math.round(ageHours)}時間経過しているためスキップ` };
    }
  }

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

  const rendered = renderTemplate(pickBody(template), {
    title: v.title,
    url: v.url,
    videoId: v.videoId,
    platform: v.platform,
    channel: (await getAccount(v.platform))?.displayName ?? '',
    publishedAt: v.publishedAt ?? new Date(),
  });

  const { text, truncated } = clampComment(rendered, v.platform);
  if (truncated) log.warn(`comment truncated to platform limit for ${key}`);

  if (!text) {
    return { created: false, reason: 'テンプレートの本文が空です' };
  }

  if (config.DRY_RUN) {
    log.info(`DRY_RUN: would comment on ${key}`, { text });
    await notify('🧪 DRY_RUN', `${v.title}\n${v.url}\n\n--- 投稿予定のコメント ---\n${text}`);
    return { created: false, reason: 'DRY_RUN のため投稿しません', commentText: text };
  }

  const job = await createJob({
    videoKey: key,
    platform: v.platform,
    templateId: template.id,
    templateName: template.name,
    commentText: text,
    shouldPin: template.pin,
    runAfter: new Date(Date.now() + template.delaySeconds * 1000),
  });

  if (!job) return { created: false, reason: 'この動画のジョブは既に存在します' };

  log.info(`job #${job.id} queued for ${key}`, { template: template.name, delay: template.delaySeconds });
  return {
    created: true,
    reason: `テンプレート「${template.name}」でジョブを作成しました`,
    commentText: text,
    jobId: job.id,
  };
}
