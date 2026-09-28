// scripts/import-tgcloud.mjs — copies the bot's data from Telegram Serverless
// into the local SQLite database (DB_PATH), so links, users, settings and the
// message map survive the move. Run it once, before the first `npm start`.
//
//   npm run import:tgcloud                 # TGCLOUD_TOKEN + TG_BOT_TOKEN from .env
//   npm run import:tgcloud -- --dry-run    # only count rows; changes nothing
//
// It first detaches the serverless deployment from Telegram (deleteWebhook)
// and waits for its last invocations, so nothing changes while exporting;
// Telegram holds new updates until the server starts. If the export fails,
// the deployment is re-attached.
//
// Rows are read through the tgcloud `run` endpoint (what `npx tgcloud run`
// uses): it executes a small read-only module against the cloud database
// without deploying anything.
import { DB_PATH } from '../lib/config.js';
import { openDb, closeDb } from '../lib/db.js';
import { lockInstance, releaseInstanceLock } from '../lib/store.js';
import { tg } from '../lib/telegram.js';
import { sleep } from '../lib/util.js';

const TOKEN = (process.env.TGCLOUD_TOKEN || '').trim();
const CLOUD = (process.env.TG_CLOUD_API_URL || 'https://cloud.telegram.org').replace(/\/+$/, '');
const DRY_RUN = process.argv.includes('--dry-run');

// Imported in this order. `errors` (old serverless logs) is left behind.
const TABLES = ['kv', 'users', 'links', 'codes', 'msgmap', 'claims', 'albums', 'jobs', 'sessions', 'stats', 'broadcasts'];
// kv keys that only meant something to the serverless tick/pump machinery.
const STALE_KV = /^(pump_lock|pump_beat|pump_pause_until|pump_fail_streak|tick_rr|tickers|kick_at|wd_at|gc_at|instance_lock|wslot:.*)$/;

// Runs on tgcloud as handlers/message (a valid module name there); returns one page of a table.
const EXPORTER = `
import { db } from 'sdk';
const TABLES = ${JSON.stringify(TABLES)};
export default async function ({ table, after, limit }) {
  if (!TABLES.includes(table)) throw new Error('unknown table ' + table);
  const pending = table === 'jobs' ? " AND status IN ('new', 'run')" : '';
  return db.all('SELECT rowid AS _rowid, * FROM ' + table + ' WHERE rowid > :after' + pending + ' ORDER BY rowid LIMIT :limit',
    { ':after': after, ':limit': limit });
}
`;

async function cloud(method, path, body) {
  const res = await fetch(`${CLOUD}/${TOKEN.split(':')[0]}/manage${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120e3),
  });
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw Object.assign(new Error(`tgcloud answered HTTP ${res.status} without JSON`), { status: res.status });
  }
  if (!data?.ok) {
    throw Object.assign(new Error(`tgcloud: ${data?.description || data?.error || 'HTTP ' + res.status}`), { status: res.status });
  }
  return data.result;
}

async function page(table, after, limit) {
  const r = await cloud('POST', '/run', {
    module: 'handlers/message',
    sources: { 'handlers/message': EXPORTER },
    args: { table, after, limit },
    ctx: {},
  });
  const rows = r?.result;
  if (!Array.isArray(rows)) throw new Error(`export of ${table} failed: ${rows?.message || JSON.stringify(rows)}`);
  return rows;
}

async function exportTable(table) {
  const out = [];
  let after = 0;
  let limit = 500;
  for (;;) {
    let rows;
    try {
      rows = await page(table, after, limit);
    } catch (e) {
      // Auth problems won't improve; anything else may be a size limit, so shrink the page.
      if (e.status === 401 || e.status === 403 || limit <= 10) throw e;
      limit = Math.ceil(limit / 2);
      continue;
    }
    out.push(...rows);
    process.stdout.write(`\r  ${table}: ${out.length}`);
    if (rows.length < limit) break;
    after = rows[rows.length - 1]._rowid;
  }
  process.stdout.write('\n');
  return out;
}

function importRows(conn, table, rows) {
  const cols = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  let n = 0;
  for (const row of rows) {
    delete row._rowid;
    if (table === 'kv' && STALE_KV.test(row.k)) continue;
    if (table === 'jobs' && row.status === 'run') Object.assign(row, { status: 'new', lease: 0 });
    const keys = Object.keys(row).filter((k) => cols.has(k));
    conn.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => row[k]));
    n++;
  }
  return n;
}

let locked = false;

async function main() {
  if (!/^app\d+:[A-Za-z0-9_-]+$/.test(TOKEN)) {
    throw new Error('Set TGCLOUD_TOKEN in .env (@BotFather → your bot → Serverless → CLI Access → Access token).');
  }
  if (!DRY_RUN && !process.env.TG_BOT_TOKEN?.trim()) throw new Error('Set TG_BOT_TOKEN in .env.');
  const conn = openDb();
  locked = await lockInstance();
  if (!locked) throw new Error(`The bot is running on ${DB_PATH}; stop it before importing.`);
  const used = conn.prepare('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM links) + (SELECT count(*) FROM msgmap) AS n').get().n;
  if (used) throw new Error(`${DB_PATH} already holds bot data; import into a fresh database (set DB_PATH or move the file away).`);

  console.log(`Checking access to tgcloud (${CLOUD})...`);
  await page('kv', 0, 1);

  let detached = false;
  if (!DRY_RUN) {
    console.log('Detaching the serverless deployment from Telegram (deleteWebhook)...');
    await tg('deleteWebhook', {});
    detached = true;
    console.log('Waiting 40s for its last invocations to finish...');
    await sleep(40000);
  }

  const data = {};
  try {
    console.log('Exporting:');
    for (const t of TABLES) data[t] = await exportTable(t);
  } catch (e) {
    if (detached) {
      console.error('Export failed; re-attaching the serverless deployment...');
      await cloud('POST', '/webhook/sync', {}).catch((e2) => console.error('  could not re-attach:', e2.message));
    }
    throw e;
  }
  if (DRY_RUN) {
    console.log('\nDry run: nothing was changed.');
    return;
  }

  const offsetBefore = Number(conn.prepare("SELECT v FROM kv WHERE k = 'bale_offset'").get()?.v || 0);
  conn.exec('BEGIN');
  try {
    console.log(`Importing into ${DB_PATH}:`);
    for (const t of TABLES) console.log(`  ${t}: ${importRows(conn, t, data[t])}`);
    // Never go back to an older Bale offset (that would replay updates).
    conn.prepare("UPDATE kv SET v = ? WHERE k = 'bale_offset' AND CAST(v AS INTEGER) < ?").run(String(offsetBefore), offsetBefore);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }

  console.log('\nDone. The serverless bot no longer receives updates: start this server now');
  console.log('(npm start, or docker compose up -d) and it picks up the updates Telegram queued meanwhile.');
}

try {
  await main();
} catch (e) {
  console.error('\n' + (e.message || e));
  process.exitCode = 1;
} finally {
  if (locked) await releaseInstanceLock().catch(() => {});
  closeDb();
}
