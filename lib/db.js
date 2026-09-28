// lib/db — SQLite through Node's built-in node:sqlite, with the surface the
// bot was written against: db.get / db.all / db.run over sql`...` templates,
// where every interpolated value becomes a bound parameter.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';
import { MIGRATIONS } from './schema.js';

export function sql(strings, ...values) {
  return { text: strings.join('?'), values };
}

let conn = null;
const stmts = new Map();

// Opens and migrates the database on first use; later calls reuse the connection.
export function openDb(file = DB_PATH) {
  if (conn) return conn;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  migrate(conn);
  return conn;
}

export function closeDb() {
  if (!conn) return;
  stmts.clear();
  conn.close();
  conn = null;
}

function migrate(c) {
  const from = c.prepare('PRAGMA user_version').get().user_version;
  for (let v = from; v < MIGRATIONS.length; v++) {
    c.exec('BEGIN');
    try {
      c.exec(MIGRATIONS[v]);
      c.exec(`PRAGMA user_version = ${v + 1}`);
      c.exec('COMMIT');
    } catch (e) {
      c.exec('ROLLBACK');
      throw e;
    }
  }
}

function prepare(q) {
  let s = stmts.get(q.text);
  if (!s) {
    s = openDb().prepare(q.text);
    stmts.set(q.text, s);
  }
  return s;
}

// node:sqlite binds only null, numbers, bigints, strings and bytes.
const bind = (values) => values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

const RETURNING = /\bRETURNING\b/i;

export const db = {
  // First row, or null.
  async get(q) {
    return prepare(q).get(...bind(q.values)) ?? null;
  },
  async all(q) {
    return prepare(q).all(...bind(q.values));
  },
  // Writes -> { rowsAffected, rows }; rows come from a RETURNING clause.
  async run(q) {
    const s = prepare(q);
    if (RETURNING.test(q.text)) {
      const rows = s.all(...bind(q.values));
      return { rowsAffected: rows.length, rows };
    }
    const r = s.run(...bind(q.values));
    return { rowsAffected: Number(r.changes), rows: [] };
  },
};
