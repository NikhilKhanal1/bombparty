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
  // Batch 42: careers, public profiles, write-time identity, rejection log,
  // provider avatars. daily_runs gains user_id (stamped at write, backfilled on
  // claim); word_rejections is the new meter; supporting indexes for career reads.
  `ALTER TABLE daily_runs ADD COLUMN IF NOT EXISTS user_id BIGINT`,
  `CREATE TABLE IF NOT EXISTS word_rejections (
    id BIGSERIAL PRIMARY KEY,
    mode TEXT NOT NULL,
    device_id TEXT,
    user_id BIGINT,
    game_id TEXT,
    word TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_we_word ON word_events (word)`,
  `CREATE INDEX IF NOT EXISTS idx_dr_device ON daily_runs (device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dr_user ON daily_runs (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wr_device ON word_rejections (device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wr_user ON word_rejections (user_id)`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
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
    // Batch 42: present only when the SELECT projects user_id; null for guests.
    accountId: (row.user_id != null) ? Number(row.user_id) : null,
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
        [evt.mode, evt.deviceId || null, evt.userId ?? null, evt.gameId, evt.round ?? null,
         evt.word, evt.tier, evt.points, evt.ms ?? null]
      );
    },
    async saveDailyRun(run) {
      // Batch 42: user_id stamped at write for signed-in runs. On a re-finish
      // never clobber an existing user_id with null (a claimed run stays owned).
      await pool.query(
        `INSERT INTO daily_runs (date_int, session_id, device_id, user_id, name, score, round_reached, words)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id) DO UPDATE
           SET score = EXCLUDED.score,
               round_reached = EXCLUDED.round_reached,
               words = EXCLUDED.words,
               user_id = COALESCE(EXCLUDED.user_id, daily_runs.user_id)`,
        [run.dateInt, run.sessionId, run.deviceId || null, run.userId ?? null, run.name,
         run.score, run.round, JSON.stringify(run.words || [])]
      );
    },
    async getDailyBoard(dateInt) {
      const res = await pool.query(
        `SELECT session_id, name, score, round_reached, words, user_id
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
        `SELECT id, provider, display_name, avatar_url FROM accounts WHERE id = $1`,
        [id]
      );
      if (!res.rows.length) return null;
      const r = res.rows[0];
      return { id: Number(r.id), provider: r.provider, displayName: r.display_name, avatarUrl: r.avatar_url || null };
    },
    async setDisplayName(id, name) {
      await pool.query(`UPDATE accounts SET display_name = $2 WHERE id = $1`, [id, name]);
    },
    // Batch 42: avatars sync on every login (people change avatars); names never
    // update on conflict. A null url clears a previously-set avatar.
    async setAvatarUrl(id, url) {
      await pool.query(`UPDATE accounts SET avatar_url = $2 WHERE id = $1`, [id, url || null]);
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
      // Batch 42: claim BOTH word_events and daily_runs; the returned count is
      // word_events only (the client copy says words). Idempotent by construction.
      const res = await pool.query(
        `UPDATE word_events SET user_id = $2 WHERE device_id = $1 AND user_id IS NULL`,
        [deviceId, accountId]
      );
      await pool.query(
        `UPDATE daily_runs SET user_id = $2 WHERE device_id = $1 AND user_id IS NULL`,
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
    // ── Career (batch 42) ──
    // Fire-and-forget rejection meter, same discipline as recordWordEvent.
    async recordWordRejection(evt) {
      await pool.query(
        `INSERT INTO word_rejections (mode, device_id, user_id, game_id, word, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [evt.mode, evt.deviceId || null, evt.userId ?? null, evt.gameId || null,
         String(evt.word || '').slice(0, 64), evt.reason]
      );
    },
    // Assemble the whole career payload from the verified queries. identity is
    // { userId } (account) or { deviceId } (unclaimed guest rows). IDENT and its
    // negation expand per identity kind; all values flow through as $1.
    async careerStats(identity) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      // IDENT: account reads its own rows; guest reads only unclaimed device rows.
      const IDENT = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;
      // NOT-IDENT: the negation used by unique-to-me (Q8).
      const NOTID = isAccount ? `user_id IS DISTINCT FROM $1` : `NOT (device_id = $1 AND user_id IS NULL)`;
      // IDENT-ON-r: the identity predicate against alias r (Q16).
      const IDENTR = isAccount ? `r.user_id = $1` : `r.device_id = $1 AND r.user_id IS NULL`;
      const q = (sql) => pool.query(sql, [v]);
      const one = async (sql) => (await q(sql)).rows[0] || {};
      const rows = async (sql) => (await q(sql)).rows;

      const core = await one(`SELECT COUNT(*)::int words, COALESCE(SUM(points),0)::int pts, COUNT(DISTINCT game_id)::int games, COUNT(DISTINCT word)::int dw FROM word_events WHERE ${IDENT}`);
      if (!core.words) {
        // Fresh identity: 200 with the shape intact, everything zeroed/null.
        return emptyCareer();
      }
      const tierRows = await rows(`SELECT tier, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY tier`);
      const tiers = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
      for (const r of tierRows) if (r.tier in tiers) tiers[r.tier] = r.n;

      const speed = await one(`SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int med, COUNT(*) FILTER (WHERE ms < 1000)::int subsec FROM word_events WHERE ${IDENT} AND ms IS NOT NULL`);
      const fastest = (await rows(`SELECT word, ms FROM word_events WHERE ${IDENT} AND ms IS NOT NULL ORDER BY ms ASC LIMIT 1`))[0] || null;
      const slowest = (await rows(`SELECT word, ms FROM word_events WHERE ${IDENT} AND ms IS NOT NULL ORDER BY ms DESC LIMIT 1`))[0] || null;

      const best = await rows(`SELECT * FROM (
          SELECT DISTINCT ON (word) word, tier, points, mode, played_at::date AS d
          FROM word_events WHERE ${IDENT}
          ORDER BY word, points DESC, played_at DESC) t
        ORDER BY points DESC, d DESC LIMIT 5`);

      const scale = await one(`SELECT COALESCE(SUM(ms),0)::bigint tub, COALESCE(SUM(LENGTH(word)),0)::int letters FROM word_events WHERE ${IDENT}`);
      const first = (await rows(`SELECT word, played_at FROM word_events WHERE ${IDENT} ORDER BY played_at ASC, id ASC LIMIT 1`))[0] || null;
      const fav = (await rows(`SELECT word, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY word ORDER BY n DESC, MAX(played_at) DESC LIMIT 1`))[0] || null;
      const unique = await one(`SELECT COUNT(*)::int c FROM (
          SELECT word FROM word_events GROUP BY word
          HAVING COUNT(*) FILTER (WHERE ${NOTID}) = 0
             AND COUNT(*) FILTER (WHERE ${IDENT}) > 0) t`);
      const longest = (await rows(`SELECT word, LENGTH(word) len FROM word_events WHERE ${IDENT} ORDER BY LENGTH(word) DESC, points DESC LIMIT 1`))[0] || null;
      const firstLetter = (await rows(`SELECT LEFT(word,1) l, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY l ORDER BY n DESC, l ASC LIMIT 1`))[0] || null;
      const usedLetters = (await one(`SELECT array_agg(DISTINCT LEFT(word,1)) a FROM word_events WHERE ${IDENT}`)).a || [];
      const legendaries = await rows(`SELECT word, points, mode, played_at::date AS d FROM word_events WHERE ${IDENT} AND tier='LEGENDARY' ORDER BY played_at ASC`);
      const busiest = (await rows(`SELECT ((played_at AT TIME ZONE 'UTC')::date) d, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY d ORDER BY n DESC, d DESC LIMIT 1`))[0] || null;
      const daysPlayed = (await one(`SELECT COUNT(DISTINCT (played_at AT TIME ZONE 'UTC')::date)::int c FROM word_events WHERE ${IDENT}`)).c || 0;
      const streak = (await one(`WITH d AS (SELECT DISTINCT (played_at AT TIME ZONE 'UTC')::date AS day FROM word_events WHERE ${IDENT}),
          g AS (SELECT day, day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp FROM d)
          SELECT COALESCE(MAX(n),0)::int c FROM (SELECT COUNT(*)::int n FROM g GROUP BY grp) s`)).c || 0;
      const hourRows = await rows(`SELECT EXTRACT(HOUR FROM played_at AT TIME ZONE 'UTC')::int h, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY h ORDER BY h`);
      const hourHistogram = new Array(24).fill(0);
      for (const r of hourRows) if (r.h >= 0 && r.h < 24) hourHistogram[r.h] = r.n;

      const dailyAgg = await one(`SELECT COUNT(*)::int runs, MAX(score)::int best, MAX(round_reached)::int bestround, COUNT(*) FILTER (WHERE round_reached >= 30)::int perfect, ROUND(AVG(round_reached),1)::float avgr FROM daily_runs WHERE ${IDENT}`);
      const top10 = (await one(`SELECT COUNT(*)::int c FROM daily_runs r WHERE ${IDENTR} AND
          (SELECT COUNT(*) FROM daily_runs b WHERE b.date_int=r.date_int AND b.score > r.score)::float
          / NULLIF((SELECT COUNT(*) FROM daily_runs b WHERE b.date_int=r.date_int),0) < 0.10`)).c || 0;
      const modeRows = await rows(`SELECT mode, COUNT(*)::int n FROM word_events WHERE ${IDENT} GROUP BY mode ORDER BY n DESC`);
      const modes = { multiplayer: 0, scramble: 0, sabotage: 0, daily: 0 };
      for (const r of modeRows) if (r.mode in modes) modes[r.mode] = r.n;
      const rejections = (await one(`SELECT COUNT(*)::int c FROM word_rejections WHERE ${IDENT}`)).c || 0;

      const toDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : null;
      return {
        since: first ? new Date(first.played_at).toISOString().slice(0, 10) : null,
        overview: {
          words: core.words, points: core.pts, games: core.games, distinctWords: core.dw,
          tiers,
          best: best.map(b => ({ word: b.word, tier: b.tier, points: b.points, mode: b.mode, date: toDate(b.d) })),
          medianMs: speed.med ?? null,
          fastest: fastest ? { word: fastest.word, ms: fastest.ms } : null,
          slowest: slowest ? { word: slowest.word, ms: slowest.ms } : null,
          modes,
          daily: { runs: dailyAgg.runs || 0, best: dailyAgg.best ?? 0, bestRound: dailyAgg.bestround ?? 0, perfect: dailyAgg.perfect || 0, avgRound: dailyAgg.avgr ?? 0 },
        },
        vault: {
          timeUnderBombMs: Number(scale.tub) || 0,
          lettersTyped: scale.letters || 0,
          firstWord: first ? { word: first.word, date: toDate(first.played_at) } : null,
          favoriteWord: fav ? { word: fav.word, n: fav.n } : null,
          uniqueWords: unique.c || 0,
          longestWord: longest ? { word: longest.word, len: longest.len } : null,
          modalFirstLetter: firstLetter ? firstLetter.l : null,
          usedFirstLetters: usedLetters,
          legendaries: legendaries.map(l => ({ word: l.word, points: l.points, mode: l.mode, date: toDate(l.d) })),
          subSecond: speed.subsec || 0,
          slowestSave: slowest ? { word: slowest.word, ms: slowest.ms } : null,
          busiestDay: busiest ? { date: toDate(busiest.d), n: busiest.n } : null,
          daysPlayed,
          longestDayStreak: streak,
          hourHistogram,
          top10Dailies: top10,
          rejections,
        },
      };
    },
  };
}

// The all-zero career shape (fresh identity). The endpoint still returns 200.
function emptyCareer() {
  return {
    since: null,
    overview: {
      words: 0, points: 0, games: 0, distinctWords: 0,
      tiers: { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 },
      best: [], medianMs: null, fastest: null, slowest: null,
      modes: { multiplayer: 0, scramble: 0, sabotage: 0, daily: 0 },
      daily: { runs: 0, best: 0, bestRound: 0, perfect: 0, avgRound: 0 },
    },
    vault: {
      timeUnderBombMs: 0, lettersTyped: 0, firstWord: null, favoriteWord: null,
      uniqueWords: 0, longestWord: null, modalFirstLetter: null, usedFirstLetters: [],
      legendaries: [], subSecond: 0, slowestSave: null, busiestDay: null,
      daysPlayed: 0, longestDayStreak: 0, hourHistogram: new Array(24).fill(0),
      top10Dailies: 0, rejections: 0,
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
    // ── Career (batch 42) ── postgres-only, same posture as accounts.
    async setAvatarUrl() { /* no database: avatars are postgres-only */ },
    async recordWordRejection() { /* no database: rejections are skipped */ },
    async careerStats() { return null; },
  };
}

module.exports = process.env.DATABASE_URL
  ? createPgBackend(process.env.DATABASE_URL)
  : createMemoryBackend();
