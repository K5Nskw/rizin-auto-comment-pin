import { XMLParser } from 'fast-xml-parser';
import { config } from '../../config.js';
import { getAccount } from '../../db/repo.js';
import { createLogger, errMessage } from '../../logger.js';
import { ingestVideo } from '../../pipeline.js';
import type { DetectedVideo } from '../../types.js';

const log = createLogger('youtube:watcher');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export const RSS_URL = (channelId: string) =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

export async function resolveChannelId(): Promise<string | null> {
  if (config.YOUTUBE_CHANNEL_ID) return config.YOUTUBE_CHANNEL_ID;
  const account = await getAccount('youtube');
  return account?.externalId ?? null;
}

/** Parses the Atom feed YouTube publishes for a channel — free, no API quota. */
export function parseFeed(xml: string): DetectedVideo[] {
  const doc = parser.parse(xml) as any;
  const feed = doc?.feed;
  if (!feed) return [];

  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  const out: DetectedVideo[] = [];

  for (const entry of entries) {
    const videoId: string | undefined = entry['yt:videoId'] ?? entry.videoId;
    if (!videoId) continue;
    const published = entry.published ?? entry.updated;
    out.push({
      platform: 'youtube',
      videoId: String(videoId),
      title: String(entry.title ?? ''),
      description: String(entry['media:group']?.['media:description'] ?? ''),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: published ? new Date(published) : null,
    });
  }
  return out;
}

async function fetchFeed(channelId: string): Promise<DetectedVideo[]> {
  const res = await fetch(RSS_URL(channelId), { headers: { 'user-agent': 'rizin-auto-comment-pin/1.0' } });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  return parseFeed(await res.text());
}

/**
 * Polling fallback. WebSub usually gets there first; whichever wins, the unique
 * index on jobs.video_key means only one comment is ever posted.
 */
export async function pollYouTube(): Promise<{ checked: number; queued: number; error?: string }> {
  const channelId = await resolveChannelId();
  if (!channelId) return { checked: 0, queued: 0, error: 'チャンネルIDが未設定です' };

  try {
    const videos = await fetchFeed(channelId);
    let queued = 0;
    for (const v of videos) {
      const result = await ingestVideo(v);
      if (result.created) queued++;
    }
    log.debug(`polled ${videos.length} entries, queued ${queued}`);
    return { checked: videos.length, queued };
  } catch (e) {
    const error = errMessage(e);
    log.warn(`poll failed: ${error}`);
    return { checked: 0, queued: 0, error };
  }
}

/** Handles the Atom payload the WebSub hub POSTs on a new upload. */
export async function handlePushNotification(xml: string): Promise<number> {
  const videos = parseFeed(xml);
  let queued = 0;
  for (const v of videos) {
    const result = await ingestVideo(v);
    log.info(`push: ${v.videoId} -> ${result.reason}`);
    if (result.created) queued++;
  }
  return queued;
}
