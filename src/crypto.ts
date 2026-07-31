import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const ALGO = 'aes-256-gcm';

function key(): Buffer | null {
  if (!config.ENCRYPTION_KEY) return null;
  const k = Buffer.from(config.ENCRYPTION_KEY, 'hex');
  return k.length === 32 ? k : null;
}

/**
 * Encrypts a JSON-serialisable value. Falls back to a marked plaintext form
 * when ENCRYPTION_KEY is absent so the app still runs locally, and
 * configWarnings() tells the operator about it.
 */
export function sealJson(value: unknown): string {
  const plain = JSON.stringify(value);
  const k = key();
  if (!k) return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function openJson<T>(blob: string | null | undefined): T | null {
  if (!blob) return null;
  try {
    if (blob.startsWith('plain:')) {
      return JSON.parse(Buffer.from(blob.slice(6), 'base64').toString('utf8')) as T;
    }
    const [version, ivB64, tagB64, dataB64] = blob.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const k = key();
    if (!k) return null;
    const decipher = createDecipheriv(ALGO, k, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Constant-time string compare for admin auth. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Verifies the X-Hub-Signature header YouTube's WebSub hub sends. */
export function verifyWebSubSignature(header: string | undefined, body: Buffer, secret: string): boolean {
  if (!secret) return true; // no secret configured -> nothing to verify
  if (!header) return false;
  const [algo, sig] = header.split('=');
  if (!algo || !sig) return false;
  try {
    const expected = createHmac(algo, secret).update(body).digest('hex');
    return safeEqual(expected, sig);
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
