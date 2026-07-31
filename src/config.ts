import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v === undefined || v === '' || Number.isNaN(n) ? def : n;
    });

const schema = z.object({
  PORT: int(3000),
  PUBLIC_URL: z.string().optional().default(''),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Railway の Postgres を追加してください)'),

  ADMIN_USER: z.string().optional().default('admin'),
  ADMIN_PASSWORD: z.string().optional().default(''),
  ENCRYPTION_KEY: z.string().optional().default(''),

  YOUTUBE_CLIENT_ID: z.string().optional().default(''),
  YOUTUBE_CLIENT_SECRET: z.string().optional().default(''),
  YOUTUBE_CHANNEL_ID: z.string().optional().default(''),
  WEBSUB_SECRET: z.string().optional().default(''),

  TIKTOK_CLIENT_KEY: z.string().optional().default(''),
  TIKTOK_CLIENT_SECRET: z.string().optional().default(''),

  ENABLE_BROWSER_AUTOMATION: bool(true),
  POLL_INTERVAL_MINUTES: int(5),
  NOTIFY_WEBHOOK_URL: z.string().optional().default(''),
  MAX_VIDEO_AGE_HOURS: int(48),
  DRY_RUN: bool(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`[config] 環境変数が不正です:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

/** Railway injects RAILWAY_PUBLIC_DOMAIN automatically once a domain is generated. */
function resolvePublicUrl(): string {
  if (raw.PUBLIC_URL) return raw.PUBLIC_URL.replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return `http://localhost:${raw.PORT}`;
}

export const config = {
  ...raw,
  PUBLIC_URL: resolvePublicUrl(),
  isProd: process.env.NODE_ENV === 'production',
} as const;

export const oauthRedirect = (platform: 'youtube' | 'tiktok') =>
  `${config.PUBLIC_URL}/oauth/${platform}/callback`;

/** Warnings surfaced on the dashboard so misconfiguration is visible, not silent. */
export function configWarnings(): string[] {
  const w: string[] = [];
  if (!config.ADMIN_PASSWORD) w.push('ADMIN_PASSWORD が未設定です。管理画面が誰でも開ける状態です。');
  if (!config.ENCRYPTION_KEY) w.push('ENCRYPTION_KEY が未設定です。トークンが平文で保存されます。');
  else if (Buffer.from(config.ENCRYPTION_KEY, 'hex').length !== 32)
    w.push('ENCRYPTION_KEY は 32 バイトの hex (64文字) にしてください。');
  if (!config.PUBLIC_URL.startsWith('https://') && config.isProd)
    w.push('PUBLIC_URL が https ではありません。OAuth と YouTube の push 通知が失敗します。');
  if (!config.YOUTUBE_CLIENT_ID) w.push('YOUTUBE_CLIENT_ID が未設定です。YouTube 連携ができません。');
  if (!config.WEBSUB_SECRET) w.push('WEBSUB_SECRET が未設定です。YouTube の即時通知が無効になります（ポーリングのみ）。');
  if (!config.TIKTOK_CLIENT_KEY) w.push('TIKTOK_CLIENT_KEY が未設定です。TikTok の新着検知ができません。');
  return w;
}
