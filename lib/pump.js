// lib/pump — the long-running background loops, all stopped by one AbortSignal.
//
// Pump: long-polls Bale getUpdates, turns channel posts into jobs and answers
// private chats directly. Workers: claim and run jobs. Maintenance: flushes
// finished albums and cleans up old rows.
import { db, sql } from './db.js';
import { POLL } from './config.js';
import { bale } from './bale.js';
import { kvGet, kvSet, logError } from './store.js';
import { now, sleep, backoff, serialByKey, updateKey } from './util.js';
import { claim, done, retry, enqueue } from './queue.js';
import { jobsWake, pumpWake, workerJobs } from './runtime.js';
import { runJob, jobFailed } from './sync.js';
import { onChannelPost, onChannelEdit } from './channel.js';
import { onDM } from './dm.js';
import { onCallback } from './callbacks.js';
import { linkByChat } from './links.js';

async function onBaleUpdate(u) {
  const m = u.message || u.channel_post;
  if (m) {
    if (m.chat?.type === 'channel') return onChannelPost('bale', m);
    if (m.chat?.type === 'private') return onDM('bale', m);
    return;
  }
  const e = u.edited_message || u.edited_channel_post;
  if (e) {
    if (e.chat?.type === 'channel') return onChannelEdit('bale', e);
    return;
  }
  if (u.callback_query) return onCallback('bale', u.callback_query);
}

async function handleBaleUpdate(u) {
  try {
    await onBaleUpdate(u);
  } catch (e) {
    await logError('bale:update', e);
  }
}

// Albums arrive one item per update; a group is complete once it's been quiet for 2.5s.
export async function flushAlbums() {
  const cutoff = Date.now() - 2500;
  const groups = await db.all(sql`SELECT platform, chat_id, gid, MAX(at_ms) AS last FROM albums
    GROUP BY platform, chat_id, gid HAVING MAX(at_ms) < ${cutoff}`);
  for (const g of groups) {
    const { rows } = await db.run(sql`DELETE FROM albums WHERE platform = ${g.platform} AND chat_id = ${g.chat_id} AND gid = ${g.gid} RETURNING payload, msg_id`);
    if (!rows.length) continue; // another flusher took it
    const link = await linkByChat(g.platform, g.chat_id);
    if (!link) continue;
    const items = rows.sort((a, b) => a.msg_id - b.msg_id).map((r) => JSON.parse(r.payload));
    await enqueue('album', 'L' + link.id, { link_id: link.id, sp: g.platform, sc: g.chat_id, items });
  }
}

async function housekeeping() {
  const t = now();
  await db.run(sql`DELETE FROM jobs WHERE status IN ('done', 'fail') AND created_at < ${t - 3 * 86400}`);
  await db.run(sql`DELETE FROM claims WHERE at < ${t - 7 * 86400}`);
  await db.run(sql`DELETE FROM codes WHERE created_at < ${t - 86400}`);
  await db.run(sql`DELETE FROM sessions WHERE at < ${t - 86400}`);
  await db.run(sql`DELETE FROM errors WHERE at < ${t - 14 * 86400}`);
  await db.run(sql`DELETE FROM albums WHERE at_ms < ${Date.now() - 3600e3}`);
  await db.run(sql`DELETE FROM msgmap WHERE created_at < ${t - 180 * 86400}`);
  await db.run(sql`DELETE FROM kv WHERE (k LIKE 'fw:%' OR k LIKE 'fwa:%') AND CAST(json_extract(v, '$.at') AS INTEGER) < ${t - 86400}`);
}

// Bale updates of a batch are handled per chat in order (different chats in
// parallel); the offset is saved once the whole batch is done.
export async function runPump(signal) {
  const serial = serialByKey();
  let offset = Number(await kvGet('bale_offset', '0')) || 0;
  let failures = 0;
  while (!signal.aborted) {
    const t0 = Date.now();
    let ups;
    try {
      ups = await bale('getUpdates', { offset, timeout: POLL.bale, limit: 50 }, { signal });
    } catch (e) {
      if (signal.aborted) break;
      failures++;
      if (failures === 1 || failures % 10 === 0) await logError('pump:getUpdates', e);
      await pumpWake.wait(backoff(failures), signal);
      continue;
    }
    failures = 0;
    try {
      await kvSet('pump_beat', Date.now());
      if (!Array.isArray(ups) || !ups.length) {
        // Don't spin if the server answers at once instead of long-polling.
        if (Date.now() - t0 < 1000) await sleep(1000, signal);
        continue;
      }
      await Promise.all(ups.map((u) => serial(updateKey(u), () => handleBaleUpdate(u))));
      offset = ups[ups.length - 1].update_id + 1;
      await kvSet('bale_offset', offset);
    } catch (e) {
      await logError('pump', e);
      await sleep(5000, signal);
    }
  }
}

// One queue worker. On shutdown it finishes the job in hand, then returns.
export async function runWorker(slot, signal) {
  workerJobs[slot] = 0;
  while (!signal.aborted) {
    let job;
    try {
      job = await claim();
    } catch (e) {
      await logError('worker:claim', e);
      await sleep(5000, signal);
      continue;
    }
    if (!job) {
      // Woken by new work; the timeout picks up delayed retries.
      await jobsWake.wait(1000, signal);
      continue;
    }
    workerJobs[slot] = job.id;
    try {
      await runJob(job);
      await done(job.id);
    } catch (e) {
      await logError('job:' + job.kind + '#' + job.id, e);
      try {
        if (await retry(job, e)) await jobFailed(job, e);
      } catch (e2) {
        await logError('job:retry#' + job.id, e2);
      }
    } finally {
      workerJobs[slot] = 0;
    }
  }
}

export async function runMaintenance(signal) {
  let gcAt = 0;
  while (!signal.aborted) {
    try {
      await flushAlbums();
      if (Date.now() - gcAt > 10 * 60e3) {
        gcAt = Date.now();
        await housekeeping();
      }
    } catch (e) {
      await logError('maintenance', e);
    }
    await sleep(1000, signal);
  }
}
