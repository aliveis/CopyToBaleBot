// lib/util — small helpers with no platform dependencies.

export const now = () => Math.floor(Date.now() / 1000);

// Tehran calendar day as YYYY-MM-DD (Iran has no DST).
export function day(daysAgo = 0) {
  return new Date(Date.now() + 3.5 * 3600e3 - daysAgo * 86400e3).toISOString().slice(0, 10);
}

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randCode(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export const fa = (n) => Number(n || 0).toLocaleString('fa-IR');

export function ago(ms) {
  if (!ms) return 'هرگز';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${fa(s)} ثانیه پیش`;
  if (s < 3600) return `${fa(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${fa(Math.floor(s / 3600))} ساعت پیش`;
  return `${fa(Math.floor(s / 86400))} روز پیش`;
}

export function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function parseJSON(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function errText(e) {
  if (!e) return 'unknown';
  return String(e.description || e.message || e).slice(0, 500);
}

export function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- long-running loops ------------------------------------------------------

// Resolves after `ms`, or as soon as `signal` aborts.
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Retry delay after `failures` consecutive errors: 1s, 2s, 4s ... capped at a minute.
export const backoff = (failures) => Math.min(60e3, 1000 * 2 ** Math.min(failures - 1, 6));

// A wake-up call: wait() sleeps until notify(), a timeout or an abort. A notify
// with nobody waiting is remembered, so the next wait() returns at once.
export function wakeable() {
  const waiters = new Set();
  let pending = false;
  return {
    wait(ms, signal) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        const woken = new AbortController();
        const done = () => { waiters.delete(done); woken.abort(); resolve(); };
        waiters.add(done);
        sleep(ms, signal ? AbortSignal.any([signal, woken.signal]) : woken.signal).then(done);
      });
    },
    notify() {
      if (!waiters.size) { pending = true; return; }
      for (const w of [...waiters]) w();
    },
  };
}

// Runs tasks one at a time per key and concurrently across keys, so updates
// from one chat keep their order without blocking other chats.
export function serialByKey() {
  const tails = new Map();
  return (key, fn) => {
    const run = (tails.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}

// The chat an update belongs to (the key for serialByKey).
export function updateKey(u) {
  const m = u.message || u.channel_post || u.edited_message || u.edited_channel_post || u.my_chat_member;
  return String(m?.chat?.id ?? u.callback_query?.from?.id ?? 'u' + u.update_id);
}
