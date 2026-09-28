// lib/config — configuration. Secrets and deployment settings come from the
// environment, or from a .env file in the project root (see .env.example);
// variables already set in the environment win over the file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const env = (k, fallback = '') => (process.env[k] ?? '').trim() || fallback;
const ids = (k) => env(k).split(/[\s,]+/).filter(Boolean).map(Number);
const baseUrl = (k, fallback) => env(k, fallback).replace(/\/+$/, '');

const TG_TOKEN = env('TG_BOT_TOKEN');
const BALE_TOKEN = env('BALE_BOT_TOKEN');

export const ADMINS = { tg: ids('TG_ADMINS'), bale: ids('BALE_ADMINS') };
// Filled in from getMe when the server starts.
export const BOT_ID = { tg: 0, bale: 0 };
export const BOT_USERNAME = { tg: '', bale: '' };

export const PNAME = { tg: 'تلگرام', bale: 'بله' };
export const PICON = { tg: '✈️', bale: '🟢' };
export const OTHER = { tg: 'bale', bale: 'tg' };

// Base URLs can point at a relay or a local Bot API server.
const TG_BASE = baseUrl('TG_API_URL', 'https://api.telegram.org');
const BALE_BASE = baseUrl('BALE_API_URL', 'https://tapi.bale.ai');
export const TG_API = `${TG_BASE}/bot${TG_TOKEN}/`;
export const TG_FILE = `${TG_BASE}/file/bot${TG_TOKEN}/`;
export const BALE_API = `${BALE_BASE}/bot${BALE_TOKEN}/`;
export const BALE_FILE = `${BALE_BASE}/file/bot${BALE_TOKEN}/`;

export const channelUrl = (p, username) =>
  p === 'tg' ? `https://t.me/${username}` : `https://ble.ir/${username}`;

// Telegram updates arrive by long polling, or by webhook when TG_WEBHOOK_URL is set.
export const WEBHOOK = {
  url: env('TG_WEBHOOK_URL'),
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '8080')),
  // Telegram sends it back with every update; derived from the token unless set.
  secret: env('TG_WEBHOOK_SECRET') || createHash('sha256').update('webhook:' + TG_TOKEN).digest('hex').slice(0, 48),
};

export const DB_PATH = path.resolve(ROOT, env('DB_PATH', 'data/bot.db'));

export const LIMITS = {
  text: { tg: 4096, bale: 3900 },
  caption: { tg: 1024, bale: 3900 },
  download: 20 * 1024 * 1024, // getFile cap on both platforms
  photo: 10 * 1024 * 1024,
};

// Long-poll timeouts in seconds. The admin panel reports the Bale pump as
// stopped when it hasn't finished a round for staleMs.
export const POLL = { tg: 25, bale: 10 };
export const PUMP = { staleMs: 45000 };
// A job still marked running after leaseSec is treated as abandoned.
export const WORKER = { slots: 3, leaseSec: 3600, maxTries: 3 };

export const CODE_RE = /^CTB-[A-Z0-9]{6}$/;
export const CODE_TTL = 3600;

// Command menu registered on both bots at startup.
export const COMMANDS = [
  { command: 'start', description: 'منوی اصلی' },
  { command: 'new', description: 'اتصال کانال جدید' },
  { command: 'links', description: 'اتصال‌های من' },
  { command: 'stats', description: 'آمار' },
  { command: 'help', description: 'راهنما' },
  { command: 'cancel', description: 'لغو عملیات' },
];

export const isAdmin = (p, uid) => ADMINS[p].includes(Number(uid));

// Settings the bot can't run without. Scripts that only touch the database skip this.
export function configProblems() {
  const out = [];
  if (!TG_TOKEN) out.push('TG_BOT_TOKEN is not set');
  if (!BALE_TOKEN) out.push('BALE_BOT_TOKEN is not set');
  for (const p of ['tg', 'bale']) {
    if (ADMINS[p].some((id) => !Number.isSafeInteger(id))) out.push(`${p.toUpperCase()}_ADMINS must be numeric user ids`);
  }
  if (WEBHOOK.url && !/^https:\/\/[^/]+/i.test(WEBHOOK.url)) out.push('TG_WEBHOOK_URL must be an https:// URL');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK.secret)) out.push('TG_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and -');
  if (!Number.isInteger(WEBHOOK.port) || WEBHOOK.port <= 0) out.push('PORT must be a port number');
  return out;
}
