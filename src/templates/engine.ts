import type { ClipSource, DetectedVideo, Platform, Template } from '../types.js';

export interface RenderContext {
  title: string;
  url: string;
  videoId: string;
  platform: Platform;
  channel: string;
  publishedAt: Date;
  /** Resolved playlist variables, keyed by their full token name. */
  extra?: Record<string, string>;
  /** Only set for clips sent in from AutoClipMaker. */
  source?: ClipSource;
}

/** Shown in the admin UI so the operator doesn't have to read the docs. */
export const TEMPLATE_VARIABLES: Array<{ token: string; description: string }> = [
  { token: '{{title}}', description: '動画タイトル' },
  { token: '{{url}}', description: '動画URL' },
  { token: '{{videoId}}', description: '動画ID' },
  { token: '{{platform}}', description: 'youtube / tiktok' },
  { token: '{{channel}}', description: 'チャンネル名・アカウント名' },
  { token: '{{date}}', description: '公開日 (2026/07/31)' },
  { token: '{{time}}', description: '公開時刻 (21:00)' },
  { token: '{{datetime}}', description: '公開日時 (2026/07/31 21:00)' },
  { token: '{{weekday}}', description: '公開曜日 (金)' },
  { token: '[[A|B|C]]', description: 'A・B・C からランダムで1つ選ぶ' },
];

/**
 * 切り抜き（AutoClipMaker から届いた動画）でだけ使える変数。
 *
 * 元動画が分からない動画に使うと、リンクの無い「元動画→」だけが残る。
 * それを避けるため、これらを含む本文は「使う条件＝切り抜き」でしか投稿しない。
 */
export const SOURCE_VARIABLES: Array<{ token: string; description: string }> = [
  { token: '{{sourceUrl}}', description: '元動画のURL（切り抜き限定）' },
  { token: '{{sourceUrlAt}}', description: '元動画のURL＋切り抜いた位置（切り抜き限定）' },
  { token: '{{sourceTitle}}', description: '元動画のタイトル（切り抜き限定）' },
  { token: '{{sourceStart}}', description: '切り抜いた位置 (12:34)（切り抜き限定）' },
];

const SOURCE_NAMES = SOURCE_VARIABLES.map((v) => v.token.slice(2, -2));

/** 本文が切り抜き専用の変数を使っているか。 */
export function usesSourceVariables(body: string): boolean {
  return [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].some((m) => SOURCE_NAMES.includes(m[1] as string));
}

/** 秒を 12:34 / 1:02:03 に直す。元動画のどこかを指すための表記。 */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** 元動画のURLに、切り抜いた位置を足したもの。頭出しになる。 */
function sourceUrlAt(source: ClipSource): string {
  if (!source.startSec || !Number.isFinite(source.startSec)) return source.url;
  const at = Math.max(0, Math.floor(source.startSec));
  return `${source.url}${source.url.includes('?') ? '&' : '?'}t=${at}s`;
}

const JP_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function fmt(d: Date, tz = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}/${get('month')}/${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const weekday =
    JP_WEEKDAYS[new Date(d.toLocaleString('en-US', { timeZone: tz })).getDay()] ?? '';
  return { date, time, datetime: `${date} ${time}`, weekday };
}

const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];

/**
 * Substitutes {{variables}} and resolves [[a|b|c]] random choices.
 * Unknown variables are left untouched so a typo is visible in the preview
 * rather than silently producing an empty string.
 */
export function renderTemplate(body: string, ctx: RenderContext): string {
  const { date, time, datetime, weekday } = fmt(ctx.publishedAt);
  const vars: Record<string, string> = {
    title: ctx.title,
    url: ctx.url,
    videoId: ctx.videoId,
    platform: ctx.platform,
    channel: ctx.channel,
    date,
    time,
    datetime,
    weekday,
  };

  if (ctx.source) {
    vars.sourceUrl = ctx.source.url;
    vars.sourceUrlAt = sourceUrlAt(ctx.source);
    vars.sourceTitle = ctx.source.title ?? '';
    vars.sourceStart = ctx.source.startSec === undefined ? '' : clock(ctx.source.startSec);
  }

  const all: Record<string, string> = { ...vars, ...(ctx.extra ?? {}) };

  let out = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in all ? (all[name] as string) : whole,
  );

  out = out.replace(/\[\[([^\]]+)\]\]/g, (_whole, group: string) => {
    const options = group.split('|').map((s) => s.trim());
    return pick(options) ?? '';
  });

  return out.trim();
}

function matches(template: Template, video: Pick<DetectedVideo, 'title' | 'description' | 'source'>): boolean {
  const haystack = `${video.title}\n${video.description ?? ''}`;
  switch (template.matchType) {
    case 'always':
      return true;
    case 'keyword': {
      const keywords = template.matchValue
        .split(/[,、\n]/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (!keywords.length) return false;
      const lower = haystack.toLowerCase();
      return keywords.some((k) => lower.includes(k.toLowerCase()));
    }
    case 'regex':
      try {
        return new RegExp(template.matchValue, 'i').test(haystack);
      } catch {
        return false; // invalid regex never matches; the UI validates on save
      }
    case 'clip':
      // AutoClipMaker から届いたものだけ。通常の新着検知では当たらない。
      return Boolean(video.source);
    default:
      return false;
  }
}

/** Lowest `priority` number wins; ties break on id order from the query. */
export function selectTemplate(
  templates: Template[],
  video: Pick<DetectedVideo, 'title' | 'description' | 'platform' | 'source'>,
): Template | null {
  const candidates = templates
    .filter((t) => t.enabled)
    .filter((t) => t.platform === 'all' || t.platform === video.platform)
    .filter((t) => t.bodies.some((b) => b.trim().length > 0))
    .filter((t) => matches(t, video))
    // 元動画が分からない動画に、元動画のリンクを載せる本文は使わない
    .filter((t) => Boolean(video.source) || !t.bodies.some((b) => usesSourceVariables(b)))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  return candidates[0] ?? null;
}

export function pickBody(template: Template): string {
  const usable = template.bodies.filter((b) => b.trim().length > 0);
  return pick(usable) ?? '';
}

/** Platform hard limits, applied after rendering. */
export const COMMENT_MAX_LENGTH: Record<Platform, number> = {
  youtube: 9000,
  tiktok: 150,
};

export function clampComment(text: string, platform: Platform): { text: string; truncated: boolean } {
  const max = COMMENT_MAX_LENGTH[platform];
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

/**
 * `extraNames` carries the playlist variables, which are defined at runtime by
 * the operator rather than built in.
 */
export function validateTemplateBody(body: string, extraNames: string[] = []): string[] {
  const errors: string[] = [];
  const known = new Set([
    ...TEMPLATE_VARIABLES.filter((v) => v.token.startsWith('{{')).map((v) => v.token.slice(2, -2)),
    ...SOURCE_NAMES,
    ...extraNames,
  ]);
  for (const m of body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    const name = m[1];
    if (name && !known.has(name)) errors.push(`未知の変数 {{${name}}} が含まれています`);
  }
  const open = (body.match(/\[\[/g) ?? []).length;
  const close = (body.match(/\]\]/g) ?? []).length;
  if (open !== close) errors.push('[[ ]] の対応が取れていません');
  return errors;
}
