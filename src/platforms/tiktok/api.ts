import { createLogger } from '../../logger.js';
import { getAccessToken } from './oauth.js';

const log = createLogger('tiktok:api');
const API = 'https://open.tiktokapis.com/v2';

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

async function call<T>(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const json = (await res.json()) as TikTokEnvelope<T>;
  // TikTok returns error.code === 'ok' on success, so only non-ok is a failure.
  if (!res.ok || (json.error?.code && json.error.code !== 'ok')) {
    throw new Error(`TikTok API ${res.status}: ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  }
  return json.data as T;
}

export interface TikTokUser {
  openId: string;
  displayName: string;
}

export async function getMyUser(): Promise<TikTokUser> {
  const data = await call<{ user?: { open_id: string; display_name: string } }>('/user/info/', {
    query: { fields: 'open_id,display_name' },
  });
  if (!data?.user) throw new Error('TikTok ユーザー情報が取得できませんでした');
  return { openId: data.user.open_id, displayName: data.user.display_name };
}

export interface TikTokVideo {
  id: string;
  title: string;
  description: string;
  shareUrl: string;
  createTime: number; // unix seconds
}

const VIDEO_FIELDS = 'id,title,video_description,create_time,share_url';

export async function listVideos(maxCount = 20): Promise<TikTokVideo[]> {
  const data = await call<{
    videos?: Array<{
      id: string;
      title?: string;
      video_description?: string;
      share_url?: string;
      create_time?: number;
    }>;
  }>('/video/list/', {
    method: 'POST',
    query: { fields: VIDEO_FIELDS },
    body: JSON.stringify({ max_count: maxCount }),
  });

  const videos = data?.videos ?? [];
  log.debug(`fetched ${videos.length} videos`);
  return videos.map((v) => ({
    id: v.id,
    title: v.title || v.video_description || '',
    description: v.video_description ?? '',
    shareUrl: v.share_url ?? `https://www.tiktok.com/video/${v.id}`,
    createTime: v.create_time ?? 0,
  }));
}
