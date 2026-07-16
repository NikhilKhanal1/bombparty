// Persistence spine. One interface, two backends, chosen exactly once at
// boot from DATABASE_URL:
//
//   - postgres: word events + durable daily runs (Railway PostgreSQL)
//   - memory:   word events are a no-op; the daily board is the same
//               in-memory per-day structure the game has always used
//
// Contract with the game (see server.js):
//   - recordWordEvent is fire-and-forget: callers never await it in a
//     gameplay path and always attach .catch
//   - saveDailyRun is idempotent per session (ON CONFLICT updates), matching
//     the old Map.set overwrite behavior
//   - getDailyBoard returns the day's runs sorted score desc then round
//     desc, each normalized to the shape the daily routes render:
//     { id, name, score, round, completed, bestWord, words, tiles }
//
// Practice writes NOTHING here, ever (standing rule).

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS word_events (
    id BIGSERIAL PRIMARY KEY,
    mode TEXT NOT NULL,
    device_id TEXT,
    user_id BIGINT,
    game_id TEXT NOT NULL,
    round INTEGER,
    word TEXT NOT NULL,
    tier TEXT NOT NULL,
    points INTEGER NOT NULL,
    ms INTEGER,
    played_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_we_device ON word_events (device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_we_mode_time ON word_events (mode, played_at)`,
  `CREATE INDEX IF NOT EXISTS idx_we_legendary ON word_events (device_id) WHERE tier = 'LEGENDARY'`,
  `CREATE TABLE IF NOT EXISTS daily_runs (
    id BIGSERIAL PRIMARY KEY,
    date_int INTEGER NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    device_id TEXT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    round_reached INTEGER NOT NULL,
    words JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dr_date ON daily_runs (date_int, score DESC)`,
  // Batch 41: optional accounts (Discord/Google OAuth). One row per provider
  // identity; display_name is app-owned after seeding (no email, no merging).
  `CREATE TABLE IF NOT EXISTS accounts (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Claiming a device's history filters on user_id IS NULL by device_id.
  `CREATE INDEX IF NOT EXISTS idx_we_user ON word_events (user_id)`,
];

// Display ranking only (mirrors the daily's DAILY_TIER_RANK); no scoring here.
const TIER_RANK = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 };

// Rebuild the board-entry shape from a daily_runs row. tiles, bestWord, and
// completed are pure functions of the stored words array:
//   - bestWord: highest tier, ties to the longer word, first seen wins -
//     the same comparison the live session applies incrementally
//   - completed: every faced round was answered, so round == words.length
//     (a timeout always leaves one more round faced than words answered)
function runFromRow(row) {
  const words = row.words || [];
  let best = null;
  for (const w of words) {
    if (!best ||
        TIER_RANK[w.tier] > TIER_RANK[best.tier] ||
        (TIER_RANK[w.tier] === TIER_RANK[best.tier] && w.word.length > best.word.length)) {
      best = { word: w.word, tier: w.tier, points: w.points };
    }
  }
  return {
    id: row.session_id,
    name: row.name,
    score: row.score,
    round: row.round_reached,
    completed: words.length > 0 && row.round_reached === words.length,
    bestWord: best,
    words,
    tiles: words.map(w => w.tier),
  };
}

function createPgBackend(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5 });
  // Mandatory: idle clients emit 'error' when the server drops connections;
  // unhandled, that crashes the whole process. Log and keep playing.
  pool.on('error', (err) => {
    console.error('pg pool error (continuing):', err.message);
  });

  return {
    name: 'postgres',
    async init() {
      for (const sql of MIGRATIONS) await pool.query(sql);
      return 'postgres';
    },
    async recordWordEvent(evt) {
      await pool.query(
        `INSERT INTO word_events (mode, device_id, user_id, game_id, round, word, tier, points, ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [evt.mode, evt.deviceId || null, null, evt.gameId, evt.round ?? null,
         evt.word, evt.tier, evt.points, evt.ms ?? null]
      );
    },
    async saveDailyRun(run) {
      await pool.query(
        `INSERT INTO daily_runs (date_int, session_id, device_id, name, score, round_reached, words)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id) DO UPDATE
           SET score = EXCLUDED.score,
               round_reached = EXCLUDED.round_reached,
               words = EXCLUDED.words`,
        [run.dateInt, run.sessionId, run.deviceId || null, run.name,
         run.score, run.round, JSON.stringify(run.words || [])]
      );
    },
    async getDailyBoard(dateInt) {
      const res = await pool.query(
        `SELECT session_id, name, score, round_reached, words
         FROM daily_runs WHERE date_int = $1
         ORDER BY score DESC, round_reached DESC`,
        [dateInt]
      );
      return res.rows.map(runFromRow);
    },
    async getDailyRun(sessionId) {
      const res = await pool.query(
        `SELECT session_id, name, score, round_reached, words
         FROM daily_runs WHERE session_id = $1`,
        [sessionId]
      );
      return res.rows.length ? runFromRow(res.rows[0]) : null;
    },
    async getDailyPlayCount(dateInt) {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS n FROM daily_runs WHERE date_int = $1`,
        [dateInt]
      );
      return res.rows[0].n;
    },
    async counts() {
      const we = await pool.query(`SELECT COUNT(*)::int AS n FROM word_events`);
      const dr = await pool.query(`SELECT COUNT(*)::int AS n FROM daily_runs`);
      return { wordEvents: we.rows[0].n, dailyRuns: dr.rows[0].n };
    },
    // ── Accounts (batch 41) ──
    // One account per (provider, provider_id). ON CONFLICT DO NOTHING keeps the
    // seeded display_name untouched on re-login; created is true only when this
    // call actually inserted the row (RETURNING yields a row only on insert).
    async findOrCreateAccount({ provider, providerId, displayName }) {
      const ins = await pool.query(
        `INSERT INTO accounts (provider, provider_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_id) DO NOTHING
         RETURNING id, provider, display_name`,
        [provider, providerId, displayName]
      );
      if (ins.rows.length) {
        const r = ins.rows[0];
        return { id: Number(r.id), provider: r.provider, displayName: r.display_name, created: true };
      }
      const sel = await pool.query(
        `SELECT id, provider, display_name FROM accounts WHERE provider = $1 AND provider_id = $2`,
        [provider, providerId]
      );
      const r = sel.rows[0];
      return { id: Number(r.id), provider: r.provider, displayName: r.display_name, created: false };
    },
    async getAccount(id) {
      const res = await pool.query(
        `SELECT id, provider, display_name FROM accounts WHERE id = $1`,
        [id]
      );
      if (!res.rows.length) return null;
      const r = res.rows[0];
      return { id: Number(r.id), provider: r.provider, displayName: r.display_name };
    },
    async setDisplayName(id, name) {
      await pool.query(`UPDATE accounts SET display_name = $2 WHERE id = $1`, [id, name]);
    },
    async claimPreview(deviceId) {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS words, COUNT(DISTINCT game_id)::int AS games
         FROM word_events WHERE device_id = $1 AND user_id IS NULL`,
        [deviceId]
      );
      return { words: res.rows[0].words, games: res.rows[0].games };
    },
    async claimDevice(deviceId, accountId) {
      const res = await pool.query(
        `UPDATE word_events SET user_id = $2 WHERE device_id = $1 AND user_id IS NULL`,
        [deviceId, accountId]
      );
      return { words: res.rowCount };
    },
    async saveFeedback({ deviceId, text }) {
      await pool.query(
        `INSERT INTO feedback (device_id, text) VALUES ($1, $2)`,
        [deviceId || null, text]
      );
    },
  };
}

function createMemoryBackend() {
  // The pre-database daily board, verbatim in behavior: one day's entries
  // keyed by sessionId, wiped when the UTC day rolls over.
  let board = { dateInt: 0, entries: new Map() };
  const forDay = (dateInt) => {
    if (board.dateInt !== dateInt) board = { dateInt, entries: new Map() };
    return board;
  };
  return {
    name: 'memory',
    async init() { return 'memory'; },
    async recordWordEvent() { /* no database: word events are skipped */ },
    async saveDailyRun(run) {
      forDay(run.dateInt).entries.set(run.sessionId, run);
    },
    async getDailyBoard(dateInt) {
      return [...forDay(dateInt).entries.values()]
        .sort((a, b) => b.score - a.score || b.round - a.round);
    },
    async getDailyRun(sessionId) {
      return board.entries.get(sessionId) || null;
    },
    async getDailyPlayCount(dateInt) {
      return forDay(dateInt).entries.size;
    },
    async counts() {
      return { wordEvents: 0, dailyRuns: board.entries.size };
    },
    // ── Accounts (batch 41) ──
    // Auth requires postgres, so these are never reached in the memory backend.
    // They still return safe values (null / zeroes) so an accidental call can
    // never crash the process. saveFeedback is the standing memory-fallback no-op.
    async findOrCreateAccount() { return null; },
    async getAccount() { return null; },
    async setDisplayName() { /* no database: accounts are postgres-only */ },
    async claimPreview() { return { words: 0, games: 0 }; },
    async claimDevice() { return { words: 0 }; },
    async saveFeedback() { /* no database: feedback is dropped */ },
  };
}

module.exports = process.env.DATABASE_URL
  ? createPgBackend(process.env.DATABASE_URL)
  : createMemoryBackend();
