// lib/schema — SQLite schema as ordered migrations. lib/db applies the ones
// newer than the database's `PRAGMA user_version`; append, never edit, entries.
//
// Timestamps are unix seconds unless the column name says otherwise.

export const MIGRATIONS = [
  // 1 — initial schema (same tables, columns and indexes as the Telegram Serverless version)
  `
  -- Small key/value store: Bale offset, forced-join config, forwarded posts, etc.
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT
  );

  -- Everyone who talked to the bot, on either platform.
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL, -- 'tg' | 'bale'
    uid INTEGER NOT NULL,
    first_name TEXT,
    username TEXT,
    joined_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    blocked INTEGER DEFAULT 0, -- user blocked the bot
    banned INTEGER DEFAULT 0, -- banned by an admin
    fj_at INTEGER DEFAULT 0 -- last successful forced-join check
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_users_pu ON users (platform, uid);
  CREATE INDEX IF NOT EXISTS idx_users_joined ON users (joined_at);

  -- A Telegram channel <-> Bale channel pair.
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_chat INTEGER NOT NULL,
    bale_chat INTEGER NOT NULL,
    tg_title TEXT,
    tg_user TEXT,
    bale_title TEXT,
    bale_user TEXT,
    owner_tg INTEGER,
    owner_bale INTEGER,
    settings TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    t2b INTEGER DEFAULT 0, -- posts synced Telegram -> Bale
    b2t INTEGER DEFAULT 0, -- posts synced Bale -> Telegram
    last_at INTEGER DEFAULT 0,
    err_count INTEGER DEFAULT 0,
    last_err TEXT,
    err_notified_at INTEGER DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_links_tg ON links (tg_chat);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_links_bale ON links (bale_chat);

  -- One-time codes that pair a channel on one platform with a channel on the other.
  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    title TEXT,
    username TEXT,
    owner_uid INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Source message -> copied message, used for edits, deletes, replies and pins.
  CREATE TABLE IF NOT EXISTS msgmap (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    sp TEXT NOT NULL,
    sc INTEGER NOT NULL,
    sm INTEGER NOT NULL,
    dp TEXT NOT NULL,
    dc INTEGER NOT NULL,
    dm INTEGER NOT NULL,
    role TEXT DEFAULT 'main', -- 'main' | 'extra' (overflow text parts)
    created_at INTEGER NOT NULL,
    -- Bale copies only: content fingerprint + whether Bale's echo of it was seen.
    -- Bale reports our own channel posts back as updates, sometimes with a
    -- different message_id than sendX returned, so echoes are matched by content.
    fp TEXT,
    echo INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msgmap_src ON msgmap (sp, sc, sm);
  CREATE INDEX IF NOT EXISTS idx_msgmap_dst ON msgmap (dp, dc, dm);
  CREATE INDEX IF NOT EXISTS idx_msgmap_link ON msgmap (link_id);

  -- Dedupe for redelivered updates.
  CREATE TABLE IF NOT EXISTS claims (
    k TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );

  -- Album items waiting until the whole media group has arrived.
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    gid TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_albums_grp ON albums (platform, chat_id, gid);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_albums_msg ON albums (platform, chat_id, msg_id);

  -- Work queue. Jobs sharing lk run strictly in id order.
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    lk TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'new', -- new | run | done | fail
    tries INTEGER DEFAULT 0,
    lease INTEGER DEFAULT 0,
    run_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    err TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_lk ON jobs (lk, status);

  -- Multi-step conversations (waiting for a channel, a rule, a broadcast...).
  CREATE TABLE IF NOT EXISTS sessions (
    k TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL
  );

  -- Daily counters (Tehran day).
  CREATE TABLE IF NOT EXISTS stats (
    day TEXT NOT NULL,
    k TEXT NOT NULL,
    n INTEGER DEFAULT 0,
    PRIMARY KEY (day, k)
  );

  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    src TEXT,
    msg TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_errors_at ON errors (at);

  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL, -- tg | bale | all
    sp TEXT NOT NULL,
    sc INTEGER NOT NULL,
    sm INTEGER NOT NULL,
    text TEXT,
    status TEXT DEFAULT 'draft', -- draft | run | done | cancel
    cursor INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    by_uid INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
];
