import { config } from '../../config.js';
import { getSetting, setSetting } from '../../db/repo.js';
import { createLogger, errMessage } from '../../logger.js';
import { RSS_URL, resolveChannelId } from './watcher.js';

const log = createLogger('youtube:websub');

const HUB = 'https://pubsubhubbub.appspot.com/subscribe';
/** The hub caps leases at ~10 days; we renew well inside that. */
const LEASE_SECONDS = 432_000; // 5 days
const RENEW_BEFORE_MS = 86_400_000; // renew when under 1 day remains

export const callbackUrl = () => `${config.PUBLIC_URL}/webhooks/youtube`;

interface SubState {
  channelId: string;
  subscribedAt: number;
  leaseSeconds: number;
}

export async function subscribe(mode: 'subscribe' | 'unsubscribe' = 'subscribe'): Promise<void> {
  const channelId = await resolveChannelId();
  if (!channelId) throw new Error('チャンネルIDが未設定のため購読できません');
  if (!config.PUBLIC_URL.startsWith('https://')) {
    throw new Error('PUBLIC_URL が https でないため YouTube の push 通知を購読できません');
  }

  const body = new URLSearchParams({
    'hub.callback': callbackUrl(),
    'hub.topic': RSS_URL(channelId),
    'hub.verify': 'async',
    'hub.mode': mode,
    'hub.lease_seconds': String(LEASE_SECONDS),
  });
  if (config.WEBSUB_SECRET) body.set('hub.secret', config.WEBSUB_SECRET);

  const res = await fetch(HUB, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`WebSub ${mode} failed: ${res.status} ${await res.text()}`);
  }

  if (mode === 'subscribe') {
    await setSetting('websub', {
      channelId,
      subscribedAt: Date.now(),
      leaseSeconds: LEASE_SECONDS,
    } satisfies SubState);
  }
  log.info(`${mode} request accepted for ${channelId}`);
}

export async function subscriptionState(): Promise<{
  subscribed: boolean;
  channelId?: string;
  expiresAt?: string;
}> {
  const state = await getSetting<SubState>('websub');
  if (!state) return { subscribed: false };
  const expiresAt = state.subscribedAt + state.leaseSeconds * 1000;
  return {
    subscribed: expiresAt > Date.now(),
    channelId: state.channelId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Called on boot and on a timer. Re-subscribes when the lease is close to
 * expiring or when the configured channel changed.
 */
export async function ensureSubscription(): Promise<void> {
  if (!config.PUBLIC_URL.startsWith('https://')) {
    log.warn('PUBLIC_URL が https ではないため push 購読をスキップします（ポーリングのみで動作します）');
    return;
  }
  const channelId = await resolveChannelId();
  if (!channelId) return;

  const state = await getSetting<SubState>('websub');
  const expiresAt = state ? state.subscribedAt + state.leaseSeconds * 1000 : 0;
  const needsRenewal = !state || state.channelId !== channelId || expiresAt - Date.now() < RENEW_BEFORE_MS;

  if (!needsRenewal) return;

  try {
    await subscribe('subscribe');
  } catch (e) {
    log.warn(`subscription renewal failed: ${errMessage(e)}`);
  }
}
