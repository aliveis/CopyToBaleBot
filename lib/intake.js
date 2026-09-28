// lib/intake — receives Telegram updates and hands each to its handler
// (handlers/<update type>.js): long polling by default, a webhook when
// TG_WEBHOOK_URL is set. Updates are handled in order per chat and in
// parallel across chats.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { POLL, WEBHOOK } from './config.js';
import { tg } from './telegram.js';
import { logError } from './store.js';
import { sleep, backoff, serialByKey, updateKey } from './util.js';

// handlers: { [update type]: (payload, ctx) => Promise }. Resolves after `signal`
// aborts and the updates in hand are handled.
export function startTelegram(handlers, signal) {
  const serial = serialByKey();
  const allowed = Object.keys(handlers);
  const handle = (u) => {
    const type = allowed.find((t) => u[t]);
    if (!type) return Promise.resolve();
    return serial(updateKey(u), () => handlers[type](u[type], { update: u }))
      .catch((e) => logError('tg:' + type, e));
  };
  return WEBHOOK.url ? serveWebhook(handle, allowed, signal) : poll(handle, allowed, signal);
}

async function dropWebhook() {
  try {
    await tg('deleteWebhook', {});
  } catch (e) {
    await logError('tg:deleteWebhook', e);
  }
}

async function poll(handle, allowed, signal) {
  // A webhook (e.g. the old Telegram Serverless deployment) blocks getUpdates.
  await dropWebhook();
  let offset = 0;
  let failures = 0;
  while (!signal.aborted) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: POLL.tg, allowed_updates: allowed }, { signal });
    } catch (e) {
      if (signal.aborted) break;
      failures++;
      if (failures === 1 || failures % 10 === 0) await logError('tg:getUpdates', e);
      // 409: a webhook was set again, or another process polls with this token.
      if (e.code === 409 && /webhook/i.test(e.description || '')) await dropWebhook();
      await sleep(backoff(failures), signal);
      continue;
    }
    failures = 0;
    if (!updates.length) continue;
    await Promise.all(updates.map(handle));
    offset = updates[updates.length - 1].update_id + 1;
  }
  // Confirm what was handled, so the next start doesn't get it again.
  if (offset) await tg('getUpdates', { offset, limit: 1, timeout: 0 }).catch(() => {});
}

function secretOk(header) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(WEBHOOK.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function serveWebhook(handle, allowed, signal) {
  const url = new URL(WEBHOOK.url);
  const inflight = new Set();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST' || path !== url.pathname) return res.writeHead(404).end();
    if (!secretOk(req.headers['x-telegram-bot-api-secret-token'])) return res.writeHead(403).end();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let u;
      try {
        u = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return res.writeHead(400).end();
      }
      // Answer at once; Telegram waits for the response before sending more.
      res.writeHead(200).end();
      const p = handle(u);
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(WEBHOOK.port, WEBHOOK.host, resolve);
  });
  console.log(`Webhook server listening on ${WEBHOOK.host}:${WEBHOOK.port}${url.pathname}`);

  for (let n = 1; !signal.aborted; n++) {
    try {
      await tg('setWebhook', { url: url.href, secret_token: WEBHOOK.secret, allowed_updates: allowed }, { signal });
      break;
    } catch (e) {
      if (signal.aborted) break;
      await logError('tg:setWebhook', e);
      await sleep(backoff(n), signal);
    }
  }

  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  // Keep the webhook registered: Telegram queues updates until we're back.
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections();
  });
  await Promise.allSettled([...inflight]);
}
