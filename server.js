// server.js — runs CopyToBaleBot as one long-lived Node.js process: Telegram
// updates (long polling or webhook), the Bale pump, the job workers and
// maintenance. Configuration comes from .env (see .env.example).
import {
  configProblems, ADMINS, BOT_ID, BOT_USERNAME, COMMANDS, DB_PATH, WEBHOOK, WORKER,
} from './lib/config.js';
import { openDb, closeDb } from './lib/db.js';
import { logError, lockInstance, renewInstanceLock, releaseInstanceLock } from './lib/store.js';
import { requeueRunning } from './lib/queue.js';
import { tg } from './lib/telegram.js';
import { bale } from './lib/bale.js';
import { startTelegram } from './lib/intake.js';
import { runPump, runWorker, runMaintenance } from './lib/pump.js';
import { sleep } from './lib/util.js';
import message from './handlers/message.js';
import channel_post from './handlers/channel_post.js';
import edited_channel_post from './handlers/edited_channel_post.js';
import callback_query from './handlers/callback_query.js';
import my_chat_member from './handlers/my_chat_member.js';

// Telegram update type -> handler. Only these update types are requested.
const HANDLERS = { message, channel_post, edited_channel_post, callback_query, my_chat_member };

// Docker and systemd are configured to wait at least this long after SIGTERM.
const SHUTDOWN_GRACE_MS = 25000;

const stop = new AbortController();
const { signal } = stop;

function stopAll(reason) {
  if (signal.aborted) return;
  console.log(`${reason}: finishing work in progress...`);
  stop.abort();
  setTimeout(() => {
    console.error('Shutdown took too long, exiting');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => (signal.aborted ? process.exit(1) : stopAll(sig)));
}
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

async function waitForLock() {
  let warned = false;
  while (!(await lockInstance())) {
    if (!warned) console.warn(`Another instance is using ${DB_PATH} (or one stopped less than 30s ago); waiting...`);
    warned = true;
    await sleep(5000, signal);
    if (signal.aborted) return false;
  }
  return true;
}

// getMe on one platform: waits out network trouble, gives up on a rejected token.
async function whoAmI(name, call) {
  for (let n = 1; ; n++) {
    try {
      return await call('getMe', {}, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      if (e.code === 401 || e.code === 404) throw new Error(`${name} rejected the bot token: ${e.description}`);
      console.warn(`${name} getMe failed (${e.description || e.message}), retrying...`);
      await sleep(Math.min(60e3, 5000 * n), signal);
    }
  }
}

async function setCommands() {
  for (const [name, call] of [['Telegram', tg], ['Bale', bale]]) {
    try {
      await call('setMyCommands', { commands: COMMANDS });
    } catch (e) {
      console.warn(`${name} setMyCommands failed: ${e.description || e.message}`);
    }
  }
}

async function main() {
  const problems = configProblems();
  if (problems.length) {
    console.error(`Configuration error:\n  - ${problems.join('\n  - ')}\nSee .env.example.`);
    return 1;
  }

  openDb();
  console.log(`Database: ${DB_PATH}`);
  if (!(await waitForLock())) {
    closeDb();
    return 0;
  }
  const renew = setInterval(() => renewInstanceLock().catch((e) => logError('instance_lock', e)), 10000);
  let code = 0;
  try {
    const requeued = await requeueRunning();
    if (requeued) console.log(`Re-queued ${requeued} job(s) interrupted by the previous run`);

    const [meTg, meBale] = await Promise.all([whoAmI('Telegram', tg), whoAmI('Bale', bale)]);
    BOT_ID.tg = meTg.id;
    BOT_USERNAME.tg = meTg.username;
    BOT_ID.bale = meBale.id;
    BOT_USERNAME.bale = meBale.username;
    console.log(`Telegram: @${meTg.username} (${meTg.id}) | Bale: @${meBale.username} (${meBale.id})`);
    if (!ADMINS.tg.length && !ADMINS.bale.length) {
      console.warn('TG_ADMINS / BALE_ADMINS are empty: nobody can open the admin panel.');
    }
    await setCommands();

    const loops = {
      telegram: startTelegram(HANDLERS, signal),
      pump: runPump(signal),
      maintenance: runMaintenance(signal),
    };
    for (let i = 0; i < WORKER.slots; i++) loops['worker' + i] = runWorker(i, signal);
    console.log(`Running: Telegram via ${WEBHOOK.url ? 'webhook ' + WEBHOOK.url : 'long polling'}, ${WORKER.slots} workers`);

    // Every loop runs until shutdown; one dying on its own is a bug, so stop the
    // rest and exit non-zero to let the supervisor restart us.
    await Promise.all(Object.entries(loops).map(([name, p]) => p.catch((e) => {
      console.error(`${name} loop crashed:`, e);
      code = 1;
      stopAll('crash');
    })));
  } catch (e) {
    if (!signal.aborted) {
      console.error(e.message || e);
      code = 1;
    }
  } finally {
    clearInterval(renew);
    await releaseInstanceLock().catch(() => {});
    closeDb();
  }
  console.log('Stopped');
  return code;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
