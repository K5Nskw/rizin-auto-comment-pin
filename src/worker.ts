import { browserAvailable, BrowserUnavailable } from './browser/session.js';
import { commentAndPin, pinExistingComment } from './browser/tiktok.js';
import { setRelatedVideo } from './browser/studio.js';
import { pinComment } from './browser/youtube.js';
import { claimDueJobs, deleteJob, isExcluded, updateJob } from './db/repo.js';
import { createLogger, errMessage } from './logger.js';
import { notify, notifyManualAction } from './notify/index.js';
import { getVideoStatus, insertTopLevelComment } from './platforms/youtube/api.js';
import type { JobWithVideo } from './types.js';

const log = createLogger('worker');

const MAX_ATTEMPTS = 5;
/** Backoff per attempt, in minutes. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

let running = false;

function nextRunAfter(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 180;
  return new Date(Date.now() + minutes * 60_000);
}

export async function runDueJobs(): Promise<number> {
  if (running) return 0; // single-flight; the tick interval is shorter than a job can take
  running = true;
  try {
    const jobs = await claimDueJobs(3);
    for (const job of jobs) await processJob(job);
    return jobs.length;
  } finally {
    running = false;
  }
}

async function processJob(job: JobWithVideo): Promise<void> {
  // Re-checked here as well as at ingest: a video can be excluded after its
  // job was queued but before the delay elapses, and that must still stop it.
  const excluded = await isExcluded(job.videoKey);
  if (excluded && !job.commentDone) {
    log.info(`job #${job.id} cancelled: ${job.videoKey} is on the exclusion list`);
    await deleteJob(job.id);
    return;
  }

  log.info(`processing job #${job.id} (${job.platform}, attempt ${job.attempts + 1})`);
  try {
    if (job.platform === 'youtube') await processYouTube(job);
    else await processTikTok(job);
  } catch (e) {
    await handleFailure(job, e);
  }
}

/* -------------------------------------------------------------------------- */

async function processYouTube(job: JobWithVideo): Promise<void> {
  // 1. Link the Short back to the video it was cut from.
  //
  // Done before the comment because it does not need the clip to be public:
  // an unlisted or private clip can carry the link from the moment it is
  // uploaded, and waiting for publication would leave it missing in the window
  // that matters most.
  //
  // 失敗しても先へ進む。Studio の画面操作は、UIの変更や Cookie の失効で
  // 落ちうる。ここで職を止めると、リンクが張れないだけでコメントまで
  // 投稿されなくなる（しかも5回試して諦めるので、その間ずっと出ない）。
  // 理由は related_error に残し、投稿履歴から個別にやり直せるようにする。
  if (job.setRelated && !job.relatedDone && job.video.source?.videoId) {
    try {
      if (!(await browserAvailable())) {
        throw new Error(
          'ブラウザ自動操作が使えません（Chromium が無いか ENABLE_BROWSER_AUTOMATION=false）',
        );
      }
      await setRelatedVideo(job.video.videoId, job.video.source.videoId);
      await updateJob(job.id, { relatedDone: true, relatedError: null });
      job.relatedDone = true;
      log.info(`job #${job.id}: related video set`);
    } catch (e) {
      const message = errMessage(e);
      log.warn(`job #${job.id}: 関連動画を設定できませんでした: ${message}`);
      await updateJob(job.id, { relatedError: message.slice(0, 2000) });
      job.relatedError = message;
    }
  }

  // 2. Comment via the Data API.
  if (!job.commentDone) {
    const status = await getVideoStatus(job.video.videoId);
    if (!status) throw new Error('動画が見つかりません（削除された可能性）');

    if (status.privacyStatus !== 'public') {
      // Scheduled premieres show up in the feed before going public. Wait it
      // out rather than burning an attempt.
      log.info(`job #${job.id}: video is ${status.privacyStatus}, waiting`);
      await updateJob(job.id, { runAfter: new Date(Date.now() + 5 * 60_000) });
      return;
    }

    const commentId = await insertTopLevelComment(job.video.videoId, job.commentText);
    await updateJob(job.id, {
      commentId,
      commentDone: true,
      status: job.shouldPin ? 'pinning' : 'done',
      lastError: null,
    });
    job.commentDone = true;
    job.commentId = commentId;
    log.info(`job #${job.id}: comment posted`);
  }

  // 3. Pin via browser automation (no API exists for this).
  if (!job.shouldPin) {
    await finish(job);
    return;
  }
  if (job.pinDone) {
    await finish(job);
    return;
  }

  if (!(await browserAvailable())) {
    await markManual(job, 'YouTube でコメントを固定（ピン留め）してください。コメント投稿は完了しています。');
    return;
  }

  // Give YouTube a moment to make the fresh comment visible in the UI.
  await new Promise((r) => setTimeout(r, 5000));
  await pinComment(job.video.videoId, job.commentText, job.commentId ?? undefined);
  await updateJob(job.id, { pinDone: true, lastError: null });
  job.pinDone = true;
  await finish(job);
}

async function processTikTok(job: JobWithVideo): Promise<void> {
  if (!(await browserAvailable())) {
    await markManual(
      job,
      job.shouldPin
        ? 'TikTok でコメントを投稿し、ピン留めしてください。'
        : 'TikTok でコメントを投稿してください。',
    );
    return;
  }

  if (!job.commentDone) {
    await commentAndPin(job.video.url, job.commentText, job.shouldPin);
    await updateJob(job.id, {
      commentDone: true,
      pinDone: job.shouldPin,
      lastError: null,
    });
    job.commentDone = true;
    job.pinDone = job.shouldPin;
  } else if (job.shouldPin && !job.pinDone) {
    // Comment already landed on a previous attempt; only the pin is missing.
    await pinExistingComment(job.video.url, job.commentText);
    await updateJob(job.id, { pinDone: true, lastError: null });
    job.pinDone = true;
  }

  await finish(job);
}

/* -------------------------------------------------------------------------- */

async function finish(job: JobWithVideo): Promise<void> {
  await updateJob(job.id, { status: 'done', lastError: null });
  log.info(`job #${job.id} done`);
  await notify(
    '✅ 自動コメント完了',
    [
      `${job.platform}: ${job.video.title}`,
      job.video.url,
      job.shouldPin ? (job.pinDone ? 'ピン留め: 済' : 'ピン留め: 未') : 'ピン留め: なし',
      '',
      job.commentText,
    ].join('\n'),
  );
}

async function markManual(job: JobWithVideo, what: string): Promise<void> {
  await updateJob(job.id, {
    status: 'needs_manual',
    lastError: 'ブラウザ自動操作が利用できないため手動対応が必要です',
  });
  await notifyManualAction({
    platform: job.platform,
    title: job.video.title,
    url: job.video.url,
    comment: job.commentText,
    what,
  });
  log.warn(`job #${job.id} needs manual action`);
}

async function handleFailure(job: JobWithVideo, e: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const message = errMessage(e);

  // A missing browser/session is a configuration problem, not a transient
  // error — retrying it 5 times just delays the human notification.
  if (e instanceof BrowserUnavailable) {
    await updateJob(job.id, { attempts, lastError: message });
    await markManual(
      job,
      job.commentDone
        ? `${job.platform} でコメントをピン留めしてください（コメントは投稿済み）。理由: ${message}`
        : `${job.platform} でコメントを投稿・ピン留めしてください。理由: ${message}`,
    );
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    await updateJob(job.id, { attempts, status: 'failed', lastError: message });
    log.error(`job #${job.id} failed permanently: ${message}`);
    await notify(
      '❌ 自動コメント失敗',
      [
        `${job.platform}: ${job.video.title}`,
        job.video.url,
        `${attempts} 回試行して失敗しました。手動で対応してください。`,
        `エラー: ${message}`,
        '',
        job.commentText,
      ].join('\n'),
    );
    return;
  }

  const runAfter = nextRunAfter(attempts);
  await updateJob(job.id, { attempts, lastError: message, runAfter });
  log.warn(`job #${job.id} attempt ${attempts} failed, retrying at ${runAfter.toISOString()}: ${message}`);
}

/** Used by the "retry" button in the admin UI. */
export async function requeueJob(id: number): Promise<void> {
  await updateJob(id, {
    status: 'pending',
    attempts: 0,
    lastError: null,
    runAfter: new Date(),
  });
}
