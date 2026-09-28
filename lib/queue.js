// lib/queue — durable job queue in SQLite. Jobs with the same `lk` (one per
// link) run strictly in order, so posts never overtake each other. Anything
// that makes a job runnable wakes the workers (lib/pump).
import { db, sql } from './db.js';
import { now, errText } from './util.js';
import { WORKER } from './config.js';
import { jobsWake } from './runtime.js';

export const kickWorkers = () => jobsWake.notify();

export async function enqueue(kind, lk, payload, delaySec = 0) {
  const t = now();
  await db.run(sql`INSERT INTO jobs (kind, lk, payload, status, tries, lease, run_at, created_at)
    VALUES (${kind}, ${lk}, ${JSON.stringify(payload)}, 'new', 0, 0, ${t + delaySec}, ${t})`);
  kickWorkers();
}

export async function claim() {
  const t = now();
  const r = await db.run(sql`UPDATE jobs SET status = 'run', lease = ${t + WORKER.leaseSec}, tries = tries + 1
    WHERE id = (
      SELECT j.id FROM jobs j
      WHERE (j.status = 'new' OR (j.status = 'run' AND j.lease < ${t})) AND j.run_at <= ${t}
        AND NOT EXISTS (SELECT 1 FROM jobs e WHERE e.lk = j.lk AND e.id < j.id AND e.status IN ('new', 'run'))
      ORDER BY j.id LIMIT 1
    ) RETURNING *`);
  return r.rows[0] || null;
}

// Finishing a job can unblock the next one of its link.
export async function done(id) {
  await db.run(sql`UPDATE jobs SET status = 'done', lease = 0 WHERE id = ${id}`);
  kickWorkers();
}

// Returns true when the job has now failed permanently.
export async function retry(job, e) {
  const final = job.tries >= WORKER.maxTries || e?.code === 403;
  if (final) {
    await db.run(sql`UPDATE jobs SET status = 'fail', lease = 0, err = ${errText(e)} WHERE id = ${job.id}`);
    kickWorkers();
    return true;
  }
  const wait = e?.parameters?.retry_after ? Number(e.parameters.retry_after) + 1 : 5 * job.tries;
  await db.run(sql`UPDATE jobs SET status = 'new', lease = 0, run_at = ${now() + wait}, err = ${errText(e)} WHERE id = ${job.id}`);
  return false;
}

// Jobs left running by a previous process (crash, kill) go back to the queue.
// Only safe while this process holds the instance lock.
export async function requeueRunning() {
  const r = await db.run(sql`UPDATE jobs SET status = 'new', lease = 0 WHERE status = 'run'`);
  return r.rowsAffected;
}
