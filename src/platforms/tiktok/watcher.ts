import { getAccount } from '../../db/repo.js';
import { createLogger, errMessage } from '../../logger.js';
import { ingestVideo } from '../../pipeline.js';
import { listVideos } from './api.js';

const log = createLogger('tiktok:watcher');

/**
 * TikTok has no push notification for new uploads, so this is polled on the
 * same timer as the YouTube fallback.
 */
export async function pollTikTok(): Promise<{ checked: number; queued: number; error?: string }> {
  const account = await getAccount('tiktok');
  if (!account?.credentials) return { checked: 0, queued: 0, error: 'TikTok が未連携です' };

  try {
    const videos = await listVideos(20);
    let queued = 0;
    for (const v of videos) {
      const result = await ingestVideo({
        platform: 'tiktok',
        videoId: v.id,
        title: v.title,
        description: v.description,
        url: v.shareUrl,
        publishedAt: v.createTime ? new Date(v.createTime * 1000) : null,
      });
      if (result.created) queued++;
    }
    log.debug(`polled ${videos.length} videos, queued ${queued}`);
    return { checked: videos.length, queued };
  } catch (e) {
    const error = errMessage(e);
    log.warn(`poll failed: ${error}`);
    return { checked: 0, queued: 0, error };
  }
}
