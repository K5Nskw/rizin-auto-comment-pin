import { Router } from 'express';
import express from 'express';
import { config } from '../../config.js';
import { verifyWebSubSignature } from '../../crypto.js';
import { createLogger, errMessage } from '../../logger.js';
import { handlePushNotification } from '../../platforms/youtube/watcher.js';

const log = createLogger('webhook');

export const webhooksRouter: Router = Router();

/**
 * WebSub verification handshake. The hub calls this with hub.challenge after we
 * request a subscription; echoing the challenge confirms the callback is ours.
 */
webhooksRouter.get('/youtube', (req, res) => {
  const challenge = req.query['hub.challenge'];
  const mode = req.query['hub.mode'];
  const topic = req.query['hub.topic'];

  if (typeof challenge === 'string') {
    log.info(`websub ${mode} verified`, { topic });
    res.status(200).send(challenge);
    return;
  }
  res.status(400).send('missing hub.challenge');
});

/**
 * New-upload push. Raw body is required so the HMAC signature can be verified
 * against the exact bytes the hub signed.
 */
webhooksRouter.post('/youtube', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
  const signature = req.headers['x-hub-signature'] as string | undefined;

  if (!verifyWebSubSignature(signature, body, config.WEBSUB_SECRET)) {
    log.warn('rejected push with bad signature');
    res.status(403).send('bad signature');
    return;
  }

  // Acknowledge immediately — the hub retries on slow responses, and the
  // ingest path is idempotent anyway.
  res.status(204).end();

  try {
    const queued = await handlePushNotification(body.toString('utf8'));
    if (queued) log.info(`push queued ${queued} job(s)`);
  } catch (e) {
    log.error(`push handling failed: ${errMessage(e)}`);
  }
});
