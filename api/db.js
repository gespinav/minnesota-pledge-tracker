const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'tracker.db'));

// SQLite holds the ADMIN-EDIT DELTA layer that persists across restarts, applied
// on top of the curated seed (data/officials.js) at startup:
//   - rows in promises/votes  = admin adds + edits (upserts, keyed by id)
//   - rows in deletions        = tombstones for removed seed/admin items
// aligned_with_promise is TEXT (JSON) so it can hold true/false/null OR a promise-ID string.
db.exec(`
  CREATE TABLE IF NOT EXISTS promises (
    id TEXT PRIMARY KEY,
    official_id TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT,
    status TEXT,
    evidence TEXT,
    source_url TEXT,
    date_verified TEXT,
    added_by TEXT,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    official_id TEXT NOT NULL,
    bill_number TEXT NOT NULL,
    bill_title TEXT,
    bill_category TEXT,
    vote_date TEXT,
    vote_value TEXT,
    aligned_with_promise TEXT,
    source_url TEXT,
    added_by TEXT,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deletions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_promises_official ON promises(official_id);
  CREATE INDEX IF NOT EXISTS idx_votes_official ON votes(official_id);
`);

module.exports = db;
