import { openJson, sealJson } from '../crypto.js';
import type { PlaylistConfig } from '../platforms/youtube/playlists.js';
import type {
  Account,
  DetectedVideo,
  Job,
  JobStatus,
  JobWithVideo,
  OAuthCredentials,
  Platform,
  Template,
  TemplateInput,
  VideoRecord,
} from '../types.js';
import { query, queryOne } from './index.js';

/* -------------------------------------------------------------------------- */
/* accounts                                                                    */
/* -------------------------------------------------------------------------- */

export async function getAccount(platform: Platform): Promise<Account | null> {
  const row = await queryOne('SELECT * FROM accounts WHERE platform = $1', [platform]);
  if (!row) return null;
  return {
    platform,
    displayName: row.display_name,
    externalId: row.external_id,
    connectedAt: row.connected_at,
    credentials: openJson<OAuthCredentials>(row.credentials_enc),
  };
}

export async function saveAccount(
  platform: Platform,
  data: { displayName?: string | null; externalId?: string | null; credentials: OAuthCredentials },
): Promise<void> {
  await query(
    `INSERT INTO accounts (platform, display_name, external_id, credentials_enc, connected_at, updated_at)
     VALUES ($1,$2,$3,$4, now(), now())
     ON CONFLICT (platform) DO UPDATE SET
       display_name    = COALESCE(EXCLUDED.display_name, accounts.display_name),
       external_id     = COALESCE(EXCLUDED.external_id, accounts.external_id),
       credentials_enc = EXCLUDED.credentials_enc,
       connected_at    = COALESCE(accounts.connected_at, EXCLUDED.connected_at),
       updated_at      = now()`,
    [platform, data.displayName ?? null, data.externalId ?? null, sealJson(data.credentials)],
  );
}

export async function updateCredentials(platform: Platform, credentials: OAuthCredentials): Promise<void> {
  await query('UPDATE accounts SET credentials_enc = $2, updated_at = now() WHERE platform = $1', [
    platform,
    sealJson(credentials),
  ]);
}

export async function deleteAccount(platform: Platform): Promise<void> {
  await query('DELETE FROM accounts WHERE platform = $1', [platform]);
}

/* -------------------------------------------------------------------------- */
/* templates                                                                   */
/* -------------------------------------------------------------------------- */

function toTemplate(row: Record<string, any>): Template {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    enabled: row.enabled,
    priority: row.priority,
    matchType: row.match_type,
    matchValue: row.match_value,
    bodies: Array.isArray(row.bodies) ? row.bodies : [],
    pin: row.pin,
    delaySeconds: row.delay_seconds,
  };
}

export async function listTemplates(): Promise<Template[]> {
  const rows = await query('SELECT * FROM templates ORDER BY priority ASC, id ASC');
  return rows.map(toTemplate);
}

export async function getTemplate(id: number): Promise<Template | null> {
  const row = await queryOne('SELECT * FROM templates WHERE id = $1', [id]);
  return row ? toTemplate(row) : null;
}

export async function createTemplate(input: TemplateInput): Promise<Template> {
  const row = await queryOne(
    `INSERT INTO templates (name, platform, enabled, priority, match_type, match_value, bodies, pin, delay_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [
      input.name,
      input.platform,
      input.enabled,
      input.priority,
      input.matchType,
      input.matchValue,
      JSON.stringify(input.bodies),
      input.pin,
      input.delaySeconds,
    ],
  );
  return toTemplate(row!);
}

export async function updateTemplate(id: number, input: TemplateInput): Promise<Template | null> {
  const row = await queryOne(
    `UPDATE templates SET name=$2, platform=$3, enabled=$4, priority=$5, match_type=$6,
        match_value=$7, bodies=$8::jsonb, pin=$9, delay_seconds=$10, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      id,
      input.name,
      input.platform,
      input.enabled,
      input.priority,
      input.matchType,
      input.matchValue,
      JSON.stringify(input.bodies),
      input.pin,
      input.delaySeconds,
    ],
  );
  return row ? toTemplate(row) : null;
}

export async function deleteTemplate(id: number): Promise<void> {
  await query('DELETE FROM templates WHERE id = $1', [id]);
}

export async function countTemplates(): Promise<number> {
  const row = await queryOne<{ count: string }>('SELECT count(*)::text AS count FROM templates');
  return Number(row?.count ?? 0);
}

/* -------------------------------------------------------------------------- */
/* videos                                                                      */
/* -------------------------------------------------------------------------- */

function toVideo(row: Record<string, any>): VideoRecord {
  return {
    key: row.key,
    platform: row.platform,
    videoId: row.video_id,
    title: row.title,
    description: row.description,
    url: row.url,
    publishedAt: row.published_at,
    detectedAt: row.detected_at,
    isShort: row.is_short ?? null,
    source: row.source_video_id
      ? {
          videoId: row.source_video_id,
          url: row.source_url ?? '',
          title: row.source_title ?? '',
          startSec: row.source_start_sec ?? null,
        }
      : null,
  };
}

export const videoKey = (platform: Platform, videoId: string) => `${platform}:${videoId}`;

/** Returns true when this upload had never been seen before. */
export async function recordVideo(v: DetectedVideo): Promise<{ isNew: boolean; video: VideoRecord }> {
  const key = videoKey(v.platform, v.videoId);
  const inserted = await queryOne(
    `INSERT INTO videos (key, platform, video_id, title, description, url, published_at, raw,
                         source_video_id, source_url, source_title, source_start_sec, is_short)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
     ON CONFLICT (key) DO NOTHING
     RETURNING *`,
    [
      key,
      v.platform,
      v.videoId,
      v.title ?? '',
      v.description ?? '',
      v.url,
      v.publishedAt,
      JSON.stringify(v.raw ?? null),
      v.source?.videoId ?? null,
      v.source?.url ?? null,
      v.source?.title ?? null,
      v.source?.startSec ?? null,
      v.isShort ?? null,
    ],
  );
  if (inserted) return { isNew: true, video: toVideo(inserted) };

  // A clip can be detected by the watcher before its hook arrives, or the hook
  // may be re-sent. Fill in the source rather than discarding it.
  if (v.source) {
    await query(
      `UPDATE videos SET source_video_id = $2, source_url = $3, source_title = $4, source_start_sec = $5
       WHERE key = $1 AND source_video_id IS NULL`,
      [key, v.source.videoId, v.source.url, v.source.title, v.source.startSec],
    );
  }

  const existing = await queryOne('SELECT * FROM videos WHERE key = $1', [key]);
  return { isNew: false, video: toVideo(existing!) };
}

export async function getVideo(key: string): Promise<VideoRecord | null> {
  const row = await queryOne('SELECT * FROM videos WHERE key = $1', [key]);
  return row ? toVideo(row) : null;
}

/* -------------------------------------------------------------------------- */
/* jobs                                                                        */
/* -------------------------------------------------------------------------- */

function toJob(row: Record<string, any>): Job {
  return {
    id: row.id,
    videoKey: row.video_key,
    platform: row.platform,
    templateId: row.template_id,
    templateName: row.template_name,
    commentText: row.comment_text,
    shouldPin: row.should_pin,
    status: row.status,
    commentId: row.comment_id,
    commentDone: row.comment_done,
    pinDone: row.pin_done,
    setRelated: row.set_related,
    relatedDone: row.related_done,
    relatedError: row.related_error ?? null,
    attempts: row.attempts,
    lastError: row.last_error,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Returns null when a job for this video already exists (de-dup). */
export async function createJob(input: {
  videoKey: string;
  platform: Platform;
  templateId: number | null;
  templateName: string;
  commentText: string;
  shouldPin: boolean;
  runAfter: Date;
  setRelated?: boolean;
}): Promise<Job | null> {
  const row = await queryOne(
    `INSERT INTO jobs (video_key, platform, template_id, template_name, comment_text, should_pin,
                       run_after, set_related)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (video_key) DO NOTHING
     RETURNING *`,
    [
      input.videoKey,
      input.platform,
      input.templateId,
      input.templateName,
      input.commentText,
      input.shouldPin,
      input.runAfter,
      input.setRelated ?? false,
    ],
  );
  return row ? toJob(row) : null;
}

/**
 * Atomically leases due jobs by pushing run_after forward, so a crash mid-run
 * simply retries a few minutes later instead of losing the job.
 */
/**
 * 既にあるジョブに、関連動画の設定を後付けで有効にする。
 *
 * ジョブは動画1本につき1件しか作らない。そのため、切り抜きだと分かる前に
 * ジョブができていると（RSSが先に拾った、連携を入れる前に投稿した、など）、
 * set_related が FALSE のまま二度と設定されない。あとから元動画が分かった
 * ときに、その1件を拾い直せるようにする。
 *
 * 終わったジョブは「待機」に戻す。コメントとピン留めはそれぞれ済みフラグで
 * 守られているので、もう一度通しても投稿し直しにはならない。
 */
export async function enableRelatedStep(videoKey: string): Promise<boolean> {
  const row = await queryOne(
    `UPDATE jobs
        SET set_related = TRUE,
            status = CASE WHEN status IN ('done', 'needs_manual') THEN 'pending' ELSE status END,
            run_after = now(),
            updated_at = now()
      WHERE video_key = $1
        AND related_done = FALSE
        AND status <> 'failed'
      RETURNING id`,
    [videoKey],
  );
  return Boolean(row);
}

export async function claimDueJobs(limit = 5): Promise<JobWithVideo[]> {
  const rows = await query(
    `UPDATE jobs SET run_after = now() + interval '5 minutes', updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status IN ('pending','commenting','pinning') AND run_after <= now()
       ORDER BY run_after ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit],
  );
  const jobs: JobWithVideo[] = [];
  for (const row of rows) {
    const video = await getVideo(row.video_key);
    if (video) jobs.push({ ...toJob(row), video });
  }
  return jobs;
}

export async function updateJob(
  id: number,
  patch: Partial<{
    status: JobStatus;
    commentId: string | null;
    commentDone: boolean;
    pinDone: boolean;
    relatedDone: boolean;
    relatedError: string | null;
    setRelated: boolean;
    attempts: number;
    lastError: string | null;
    runAfter: Date;
    commentText: string;
    shouldPin: boolean;
  }>,
): Promise<void> {
  const map: Record<string, string> = {
    status: 'status',
    commentId: 'comment_id',
    commentDone: 'comment_done',
    pinDone: 'pin_done',
    relatedDone: 'related_done',
    relatedError: 'related_error',
    setRelated: 'set_related',
    attempts: 'attempts',
    lastError: 'last_error',
    runAfter: 'run_after',
    commentText: 'comment_text',
    shouldPin: 'should_pin',
  };
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k];
    if (!col) continue;
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  }
  if (!sets.length) return;
  await query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
}

/**
 * Cancels queued work. The `videos` row is deliberately kept: it is what
 * stops the watchers from detecting the same upload again and re-queueing
 * the job we were just asked to remove.
 */
export async function deleteJob(id: number): Promise<boolean> {
  const rows = await query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

export async function deleteJobsByStatus(statuses: JobStatus[]): Promise<number> {
  if (!statuses.length) return 0;
  const rows = await query('DELETE FROM jobs WHERE status = ANY($1::text[]) RETURNING id', [statuses]);
  return rows.length;
}

export async function listJobs(limit = 50): Promise<JobWithVideo[]> {
  const rows = await query(
    `SELECT j.*, row_to_json(v) AS video_json
     FROM jobs j JOIN videos v ON v.key = j.video_key
     ORDER BY j.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({ ...toJob(row), video: toVideo(row.video_json) }));
}

export async function getJob(id: number): Promise<JobWithVideo | null> {
  const row = await queryOne(
    `SELECT j.*, row_to_json(v) AS video_json
     FROM jobs j JOIN videos v ON v.key = j.video_key WHERE j.id = $1`,
    [id],
  );
  return row ? { ...toJob(row), video: toVideo(row.video_json) } : null;
}

export async function jobStats(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM jobs GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

/* -------------------------------------------------------------------------- */
/* settings / browser sessions / logs                                          */
/* -------------------------------------------------------------------------- */

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await queryOne<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : null;
}

/**
 * The cutoff that decides what counts as "new".
 *
 * An age-based window is not enough on its own: anything published inside that
 * window at the moment of first deploy looks new and gets commented on, which
 * is exactly the accident this now prevents. Only videos published *after* the
 * platform was first activated are eligible.
 *
 * Returns `justCreated` on the first call, so that pass can be skipped
 * entirely — a first run primes the cutoff, it never posts.
 */
export async function ensureWatermark(platform: Platform): Promise<{ value: number; justCreated: boolean }> {
  const key = `watermark:${platform}`;
  const existing = await getSetting<number>(key);
  if (typeof existing === 'number') return { value: existing, justCreated: false };

  const now = Date.now();
  await setSetting(key, now);
  return { value: now, justCreated: true };
}

export interface Exclusion {
  /** `<platform>:<videoId>` — same shape as videos.key */
  key: string;
  platform: Platform;
  videoId: string;
  url: string;
  note: string;
  addedAt: string;
}

export async function getExclusions(): Promise<Exclusion[]> {
  return (await getSetting<Exclusion[]>('exclusions')) ?? [];
}

export async function setExclusions(list: Exclusion[]): Promise<void> {
  await setSetting('exclusions', list);
}

export async function isExcluded(key: string): Promise<Exclusion | null> {
  const list = await getExclusions();
  return list.find((e) => e.key === key) ?? null;
}

export async function getPlaylists(): Promise<PlaylistConfig[]> {
  return (await getSetting<PlaylistConfig[]>('playlists')) ?? [];
}

export async function setPlaylists(playlists: PlaylistConfig[]): Promise<void> {
  await setSetting('playlists', playlists);
}

export async function getWatermark(platform: Platform): Promise<number | null> {
  return getSetting<number>(`watermark:${platform}`);
}

/** Used by the admin UI to re-arm the cutoff at the current moment. */
export async function resetWatermark(platform: Platform, at: number = Date.now()): Promise<void> {
  await setSetting(`watermark:${platform}`, at);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function saveBrowserSession(platform: Platform, storageState: unknown): Promise<void> {
  await query(
    `INSERT INTO browser_sessions (platform, state_enc, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (platform) DO UPDATE SET state_enc = EXCLUDED.state_enc, updated_at = now()`,
    [platform, sealJson(storageState)],
  );
}

export async function getBrowserSession<T = unknown>(platform: Platform): Promise<T | null> {
  const row = await queryOne('SELECT state_enc FROM browser_sessions WHERE platform = $1', [platform]);
  return row ? openJson<T>(row.state_enc) : null;
}

export async function browserSessionInfo(): Promise<Record<string, string>> {
  const rows = await query<{ platform: string; updated_at: Date }>(
    'SELECT platform, updated_at FROM browser_sessions',
  );
  return Object.fromEntries(rows.map((r) => [r.platform, new Date(r.updated_at).toISOString()]));
}

export async function deleteBrowserSession(platform: Platform): Promise<void> {
  await query('DELETE FROM browser_sessions WHERE platform = $1', [platform]);
}

export async function recentLogs(limit = 100) {
  return query('SELECT * FROM logs ORDER BY id DESC LIMIT $1', [limit]);
}
