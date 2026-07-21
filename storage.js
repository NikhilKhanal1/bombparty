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
  // Batch 43: the safety meter. A turn/round a living player failed to convert
  // (bomb explosion / scramble no-submit / daily run-ending timeout). Starts
  // empty at this deploy; the skill score cold-start path handles the ramp.
  `CREATE TABLE IF NOT EXISTS turn_misses (
    id BIGSERIAL PRIMARY KEY,
    mode TEXT NOT NULL,
    device_id TEXT,
    user_id BIGINT,
    game_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tm_device ON turn_misses (device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tm_user ON turn_misses (user_id)`,
  // Batch 43: nightly global percentile snapshots. identity_key is 'u:<id>' for
  // accounts, 'd:<deviceId>' for guest devices (device keys never leave the DB).
  `CREATE TABLE IF NOT EXISTS rank_snapshots (
    identity_key TEXT PRIMARY KEY,
    stats JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS snapshot_meta (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  )`,
  // Batch 44: the prompt each accepted word answered (forward-only; older rows
  // keep NULL). Powers the legendary wall's "answering PROMPT" line.
  `ALTER TABLE word_events ADD COLUMN IF NOT EXISTS prompt TEXT`,
  // Batch 44: earned trophies per identity, one row per (identity, trophy).
  `CREATE TABLE IF NOT EXISTS trophies (
    identity_key TEXT NOT NULL,
    trophy_id TEXT NOT NULL,
    earned_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (identity_key, trophy_id)
  )`,
  // Batch 46: identity personalization (all optional, null when unset).
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar_animal TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS flair_title TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bio TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signature_word TEXT`,
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
    // Batch 47: joined account avatar (present only when the SELECT joins accounts).
    avatarUrl: row.avatar_url || null,
    avatarAnimal: row.avatar_animal || null,
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
        `INSERT INTO word_events (mode, device_id, user_id, game_id, round, word, tier, points, ms, prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [evt.mode, evt.deviceId || null, evt.userId ?? null, evt.gameId, evt.round ?? null,
         evt.word, evt.tier, evt.points, evt.ms ?? null, evt.prompt ?? null]
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
      // Batch 47: LEFT JOIN accounts so leaderboard rows can show provider pics
      // and chosen animals. Keeps every existing column.
      const res = await pool.query(
        `SELECT r.session_id, r.name, r.score, r.round_reached, r.words, r.user_id,
                a.avatar_url, a.avatar_animal
         FROM daily_runs r LEFT JOIN accounts a ON r.user_id = a.id
         WHERE r.date_int = $1
         ORDER BY r.score DESC, r.round_reached DESC`,
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
        `SELECT id, provider, display_name, avatar_url, avatar_animal, flair_title, bio, signature_word FROM accounts WHERE id = $1`,
        [id]
      );
      if (!res.rows.length) return null;
      const r = res.rows[0];
      return {
        id: Number(r.id), provider: r.provider, displayName: r.display_name, avatarUrl: r.avatar_url || null,
        avatarAnimal: r.avatar_animal || null, flairTitle: r.flair_title || null,
        bio: r.bio || null, signatureWord: r.signature_word || null,
      };
    },
    async setDisplayName(id, name) {
      await pool.query(`UPDATE accounts SET display_name = $2 WHERE id = $1`, [id, name]);
    },
    // Batch 46: personalization setters. Each accepts null to clear the field.
    async setAvatarAnimal(id, animal) {
      await pool.query(`UPDATE accounts SET avatar_animal = $2 WHERE id = $1`, [id, animal || null]);
    },
    async setFlairTitle(id, trophyId) {
      await pool.query(`UPDATE accounts SET flair_title = $2 WHERE id = $1`, [id, trophyId || null]);
    },
    async setBio(id, bio) {
      await pool.query(`UPDATE accounts SET bio = $2 WHERE id = $1`, [id, bio || null]);
    },
    async setSignatureWord(id, word) {
      await pool.query(`UPDATE accounts SET signature_word = $2 WHERE id = $1`, [id, word || null]);
    },
    // Batch 46: has this identity ever played this exact word? (signature guard)
    async hasPlayedWord(identity, word) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      const SCOPE = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;
      const res = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM word_events WHERE ${SCOPE} AND word = $2) AS valid_pick`,
        [v, word]
      );
      return !!res.rows[0].valid_pick;
    },
    // Batch 46: distinct played words, alphabetical (signature picker source).
    async distinctWords(identity) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      const SCOPE = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;
      const res = await pool.query(
        `SELECT DISTINCT word FROM word_events WHERE ${SCOPE} ORDER BY word ASC`,
        [v]
      );
      return res.rows.map(r => r.word);
    },
    // Is a trophy earned by this account? (flair-title validation)
    async hasTrophy(accountId, trophyId) {
      const res = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM trophies WHERE identity_key = $1 AND trophy_id = $2) AS earned`,
        ['u:' + accountId, trophyId]
      );
      return !!res.rows[0].earned;
    },
    // Batch 49: cheap words + legendaries counts for the landing career card.
    async careerSummary(identity) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      const SCOPE = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;
      const res = await pool.query(
        `SELECT COUNT(*)::int words, COUNT(*) FILTER (WHERE tier = 'LEGENDARY')::int legendaries FROM word_events WHERE ${SCOPE}`,
        [v]
      );
      return { words: res.rows[0].words, legendaries: res.rows[0].legendaries };
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
    // Batch 43: fire-and-forget miss meter, same discipline as recordWordEvent.
    async recordTurnMiss(evt) {
      await pool.query(
        `INSERT INTO turn_misses (mode, device_id, user_id, game_id)
         VALUES ($1, $2, $3, $4)`,
        [evt.mode, evt.deviceId || null, evt.userId ?? null, evt.gameId || null]
      );
    },
    async getRankSnapshot(identityKey) {
      const res = await pool.query(`SELECT stats FROM rank_snapshots WHERE identity_key = $1`, [identityKey]);
      return res.rows.length ? res.rows[0].stats : null;
    },
    async getSnapshotMeta(key) {
      const res = await pool.query(`SELECT value FROM snapshot_meta WHERE key = $1`, [key]);
      return res.rows.length ? res.rows[0].value : null;
    },
    // Batch 43: nightly global percentile rebuild. One qualification pass, then
    // per-stat ranking (RANK desc) and the skill composite (PERCENT_RANK), all
    // among qualified identities, assembled into one JSONB per identity. Written
    // in a single transaction. Ranking math is done in JS for clarity; the
    // VERIFIED SQL (qualification + unique-owner) is copied verbatim.
    async rebuildRankSnapshots() {
      // Batch 48 (3d): per game, count turns until the alphabet is covered, then
      // reset. VERIFIED: ['jackdaws','lovemy','bigsphinx','ofquartz'] -> [4].
      function extraLifeCompletions(wordsInOrder) {
        let covered = new Set(); let turns = 0; const completions = [];
        for (const w of wordsInOrder) {
          turns += 1;
          for (const ch of w) covered.add(ch);
          if (covered.size === 26) { completions.push(turns); covered = new Set(); turns = 0; }
        }
        return completions;
      }
      // Qualification floor: words >= 5 AND distinct UTC play-days >= 2.
      const qual = (await pool.query(`
        WITH ident AS (
          SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) AS ik,
                 COUNT(*)::int words,
                 COUNT(DISTINCT (played_at AT TIME ZONE 'UTC')::date)::int days,
                 COALESCE(SUM(points),0)::int pts,
                 COUNT(DISTINCT game_id)::int games,
                 COUNT(*) FILTER (WHERE tier = 'LEGENDARY')::int legendaries,
                 COALESCE(SUM(LENGTH(word)),0)::int letters,
                 COUNT(*) FILTER (WHERE ms IS NOT NULL AND ms < 1000)::int subsec
          FROM word_events
          GROUP BY ik
        ), qual AS (
          SELECT * FROM ident WHERE words >= 5 AND days >= 2
        )
        SELECT ik, pts, words, days, games, legendaries, letters, subsec FROM qual
      `)).rows.filter(r => r.ik != null);

      const P = qual.length;
      const M = new Map();
      for (const r of qual) {
        M.set(r.ik, { ik: r.ik, pts: r.pts, words: r.words, games: r.games, legendaries: r.legendaries,
          letters: r.letters, subSecond: r.subsec, daysPlayed: r.days,
          uniqueWords: 0, streak: 0, top10Dailies: 0, misses: 0, med: null,
          roundsAppeared: 0, elCompletions: [] }); // batch 48: rounds/life + letters/life
      }

      if (P > 0) {
        // Unique words: globally single-owner words (VERIFIED).
        const uniq = (await pool.query(`
          WITH ev AS (SELECT word, COALESCE('u:' || user_id::text, 'd:' || device_id) ik FROM word_events),
          owners AS (SELECT word, MIN(ik) ik FROM ev GROUP BY word HAVING COUNT(DISTINCT ik) = 1)
          SELECT ik, COUNT(*)::int uniq FROM owners GROUP BY ik
        `)).rows;
        for (const r of uniq) if (M.has(r.ik)) M.get(r.ik).uniqueWords = r.uniq;

        // Longest daily-play streak per identity (one grouped gaps-and-islands
        // pass partitioned by ik; same grp arithmetic as batch 42 Q13).
        const streak = (await pool.query(`
          WITH d AS (SELECT DISTINCT COALESCE('u:' || user_id::text, 'd:' || device_id) ik, (played_at AT TIME ZONE 'UTC')::date AS day FROM word_events),
          g AS (SELECT ik, day - (ROW_NUMBER() OVER (PARTITION BY ik ORDER BY day))::int AS grp FROM d)
          SELECT ik, MAX(n)::int streak FROM (SELECT ik, grp, COUNT(*)::int n FROM g GROUP BY ik, grp) s GROUP BY ik
        `)).rows;
        for (const r of streak) if (M.has(r.ik)) M.get(r.ik).streak = r.streak;

        // Top 10% daily finishes per identity (batch 42 Q16 shape, keyed).
        const top10 = (await pool.query(`
          WITH r AS (SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) ik, date_int, score FROM daily_runs)
          SELECT ik, COUNT(*)::int top10 FROM r
          WHERE (SELECT COUNT(*) FROM daily_runs b WHERE b.date_int = r.date_int AND b.score > r.score)::float
                / NULLIF((SELECT COUNT(*) FROM daily_runs b WHERE b.date_int = r.date_int),0) < 0.10
          GROUP BY ik
        `)).rows;
        for (const r of top10) if (M.has(r.ik)) M.get(r.ik).top10Dailies = r.top10;

        // Median answer ms per identity (skill speed component).
        const meds = (await pool.query(`
          SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) ik,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) med
          FROM word_events WHERE ms IS NOT NULL GROUP BY ik
        `)).rows;
        for (const r of meds) if (M.has(r.ik)) M.get(r.ik).med = r.med != null ? Number(r.med) : null;

        // Misses per identity (skill safety component).
        const misses = (await pool.query(`
          SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) ik, COUNT(*)::int misses FROM turn_misses GROUP BY ik
        `)).rows;
        for (const r of misses) if (M.has(r.ik)) M.get(r.ik).misses = r.misses;

        // Batch 48 (3c): distinct rounds appeared in (game_id, round pairs).
        const roundsRows = (await pool.query(`
          SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) ik, COUNT(DISTINCT (game_id, round))::int rounds FROM word_events GROUP BY ik
        `)).rows;
        for (const r of roundsRows) if (M.has(r.ik)) M.get(r.ik).roundsAppeared = r.rounds;

        // Batch 48 (3d): letters-per-life (26-letter completion simulation). One
        // query streams every accepted word in per-identity, per-game, played
        // order; the completion count is simulated in JS. Trivial at current
        // scale; REVISIT with a windowed/materialized approach past ~100k rows.
        const wordRows = (await pool.query(`
          SELECT COALESCE('u:' || user_id::text, 'd:' || device_id) ik, game_id, word
          FROM word_events
          ORDER BY COALESCE('u:' || user_id::text, 'd:' || device_id), game_id, played_at, id
        `)).rows;
        let curKey = null, curGame = null, gameWords = [];
        const flushGame = () => {
          if (curKey != null && M.has(curKey) && gameWords.length) {
            for (const t of extraLifeCompletions(gameWords)) M.get(curKey).elCompletions.push(t);
          }
          gameWords = [];
        };
        for (const r of wordRows) {
          if (r.ik !== curKey || r.game_id !== curGame) { flushGame(); curKey = r.ik; curGame = r.game_id; }
          gameWords.push(r.word);
        }
        flushGame();
      }

      const items = [...M.values()];
      const pctOf = (rank, pop) => Math.max(1, Math.ceil((rank - 1) * 100 / pop));
      // RANK() OVER (ORDER BY value DESC): ties share the lowest rank, next skips.
      function rankStat(valueFn) {
        const arr = items.slice().sort((a, b) => valueFn(b) - valueFn(a));
        const out = new Map();
        let i = 0;
        while (i < arr.length) {
          const v = valueFn(arr[i]);
          let j = i; while (j < arr.length && valueFn(arr[j]) === v) j++;
          const rank = i + 1;
          for (let k = i; k < j; k++) out.set(arr[k].ik, { rank, pct: pctOf(rank, P) });
          i = j;
        }
        return out;
      }
      // Batch 48: rank only the items that pass includeFn (exclusion stats), with
      // the pct computed against the INCLUDED population. Excluded items are absent
      // from the returned map (client shows '-'). dir 'desc' (default) or 'asc'.
      function rankStatFiltered(valueFn, includeFn, dir) {
        const incl = items.filter(includeFn);
        const pop = incl.length;
        const arr = incl.slice().sort((a, b) => dir === 'asc' ? valueFn(a) - valueFn(b) : valueFn(b) - valueFn(a));
        const out = new Map();
        let i = 0;
        while (i < arr.length) {
          const v = valueFn(arr[i]);
          let j = i; while (j < arr.length && valueFn(arr[j]) === v) j++;
          const rank = i + 1;
          for (let k = i; k < j; k++) out.set(arr[k].ik, { rank, pct: Math.max(1, Math.ceil((rank - 1) * 100 / pop)) });
          i = j;
        }
        return out;
      }
      // PERCENT_RANK() OVER (ORDER BY value <dir>): (rank - 1) / (n - 1); single
      // row is 0. Ties share the value.
      function percentRank(valueFn, dir) {
        const n = items.length;
        const out = new Map();
        if (n === 1) { out.set(items[0].ik, 0); return out; }
        const arr = items.slice().sort((a, b) => dir === 'asc' ? valueFn(a) - valueFn(b) : valueFn(b) - valueFn(a));
        let i = 0;
        while (i < n) {
          const v = valueFn(arr[i]);
          let j = i; while (j < n && valueFn(arr[j]) === v) j++;
          const pr = i / (n - 1); // i = rank - 1
          for (let k = i; k < j; k++) out.set(arr[k].ik, pr);
          i = j;
        }
        return out;
      }

      // Skill components. Speed is no longer a skill term (design ruling:
      // slowness is already priced in via misses); median ms is still stored
      // as a raw component for display.
      const compute = (it) => {
        const turns = it.words + it.misses;
        const ppt = turns ? it.pts / turns : 0;
        const missRate = turns ? it.misses / turns : 0;
        return { turns, ppt, missRate };
      };
      const comp = new Map();
      for (const it of items) comp.set(it.ik, compute(it));
      const pPpt = percentRank(it => comp.get(it.ik).ppt, 'asc');
      const pSafety = percentRank(it => comp.get(it.ik).missRate, 'desc');
      const skillMap = new Map();
      for (const it of items) {
        const c = comp.get(it.ik);
        const pp = pPpt.get(it.ik), ps = pSafety.get(it.ik);
        // Weights 0.7 ppt / 0.3 safety; cold start (turns < 20) renormalizes to
        // pure ppt (the miss rate is not yet meaningful).
        const cold = (it.misses + it.words) < 20;
        const skill = cold ? pp : (0.7 * pp + 0.3 * ps);
        skillMap.set(it.ik, { skill, turns: c.turns, ppt: c.ppt, missRate: c.missRate, medianMs: it.med });
      }
      const skillRank = rankStat(it => skillMap.get(it.ik).skill);

      const rPoints = rankStat(it => it.pts);
      const rWords = rankStat(it => it.words);
      const rGames = rankStat(it => it.games);
      const rLeg = rankStat(it => it.legendaries);
      const rLetters = rankStat(it => it.letters);
      const rUniq = rankStat(it => it.uniqueWords);
      const rSub = rankStat(it => it.subSecond);
      const rDays = rankStat(it => it.daysPlayed);
      const rStreak = rankStat(it => it.streak);
      const rTop10 = rankStat(it => it.top10Dailies);
      const r2 = (x) => Number(x.toFixed(2));

      // ── Batch 48 competitive stats ──
      // Raw values per identity (null where excluded), computed from skill comps.
      const derived = new Map();
      for (const it of items) {
        const sk = skillMap.get(it.ik);
        const turns = sk.turns; // words + misses
        const survivalRate = turns >= 20 ? (1 - sk.missRate) : null;                 // 3b: >=20 turns only
        const roundsPerLife = it.misses > 0 ? (it.roundsAppeared / it.misses) : null; // 3c: 0 misses excluded
        const meanEl = it.elCompletions.length
          ? it.elCompletions.reduce((a, b) => a + b, 0) / it.elCompletions.length : null; // 3d: 0 completions excluded
        const legendaryRate = it.words ? (it.legendaries * 100 / it.words) : 0;       // 3e
        derived.set(it.ik, { ppt: sk.ppt, survivalRate, roundsPerLife, meanEl, legendaryRate });
      }
      const rPpt = rankStat(it => derived.get(it.ik).ppt);                                              // 3a desc
      const rSurvival = rankStatFiltered(it => derived.get(it.ik).survivalRate, it => derived.get(it.ik).survivalRate != null); // 3b desc
      const rRoundsLife = rankStatFiltered(it => derived.get(it.ik).roundsPerLife, it => derived.get(it.ik).roundsPerLife != null); // 3c desc
      const rLettersLife = rankStatFiltered(it => derived.get(it.ik).meanEl, it => derived.get(it.ik).meanEl != null, 'asc');   // 3d asc
      const rLegRate = rankStat(it => derived.get(it.ik).legendaryRate);                                // 3e desc
      const withVal = (rankMap, ik, value) => { const r = rankMap.get(ik); return r ? { rank: r.rank, pct: r.pct, value } : null; };

      const toInsert = items.map(it => {
        const sk = skillMap.get(it.ik);
        return {
          ik: it.ik,
          stats: {
            population: P,
            points: rPoints.get(it.ik),
            words: rWords.get(it.ik),
            games: rGames.get(it.ik),
            legendaries: rLeg.get(it.ik),
            letters: rLetters.get(it.ik),
            uniqueWords: rUniq.get(it.ik),
            subSecond: rSub.get(it.ik),
            daysPlayed: rDays.get(it.ik),
            streak: rStreak.get(it.ik),
            top10Dailies: rTop10.get(it.ik),
            skill: {
              rank: skillRank.get(it.ik).rank, pct: skillRank.get(it.ik).pct,
              ppt: r2(sk.ppt), missRate: r2(sk.missRate),
              medianMs: sk.medianMs == null ? null : r2(sk.medianMs), turns: sk.turns,
            },
            // Batch 48 competitive percentiles: { rank, pct, value } or null.
            pptRank: withVal(rPpt, it.ik, r2(derived.get(it.ik).ppt)),
            survivalRate: withVal(rSurvival, it.ik, derived.get(it.ik).survivalRate == null ? null : r2(derived.get(it.ik).survivalRate)),
            roundsPerLife: withVal(rRoundsLife, it.ik, derived.get(it.ik).roundsPerLife == null ? null : r2(derived.get(it.ik).roundsPerLife)),
            lettersPerLife: withVal(rLettersLife, it.ik, derived.get(it.ik).meanEl == null ? null : r2(derived.get(it.ik).meanEl)),
            legendaryRate: withVal(rLegRate, it.ik, r2(derived.get(it.ik).legendaryRate)),
            // Raw counts for the client rows that show them even when excluded.
            roundsAppeared: it.roundsAppeared,
            misses: it.misses,
          },
        };
      });

      const nowIso = new Date().toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM rank_snapshots');
        if (toInsert.length) {
          const params = [], values = [];
          toInsert.forEach((r, i) => { params.push(`($${i * 2 + 1}, $${i * 2 + 2})`); values.push(r.ik, JSON.stringify(r.stats)); });
          await client.query(`INSERT INTO rank_snapshots (identity_key, stats) VALUES ${params.join(',')}`, values);
        }
        await client.query(
          `INSERT INTO snapshot_meta (key, value) VALUES ('last_rebuild', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify({ at: nowIso, population: P })]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return { population: P };
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
      // Batch 43: longest game (max round reached) per mode; missing modes null.
      const maxRoundRows = await rows(`SELECT mode, MAX(round)::int mr FROM word_events WHERE ${IDENT} GROUP BY mode`);
      const maxRounds = { multiplayer: null, scramble: null, sabotage: null, daily: null };
      for (const r of maxRoundRows) if (r.mode in maxRounds) maxRounds[r.mode] = r.mr;

      // Batch 43: attach the global rank snapshot for this identity, or null.
      const identityKey = isAccount ? ('u:' + v) : ('d:' + v);
      let ranks = null;
      try {
        const snap = await pool.query(`SELECT stats FROM rank_snapshots WHERE identity_key = $1`, [identityKey]);
        if (snap.rows.length) ranks = snap.rows[0].stats;
      } catch (e) { ranks = null; }

      const toDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : null;
      return {
        ranks,
        since: first ? new Date(first.played_at).toISOString().slice(0, 10) : null,
        overview: {
          words: core.words, points: core.pts, games: core.games, distinctWords: core.dw,
          tiers,
          best: best.map(b => ({ word: b.word, tier: b.tier, points: b.points, mode: b.mode, date: toDate(b.d) })),
          medianMs: speed.med ?? null,
          fastest: fastest ? { word: fastest.word, ms: fastest.ms } : null,
          slowest: slowest ? { word: slowest.word, ms: slowest.ms } : null,
          modes,
          maxRounds,
          daily: { runs: dailyAgg.runs || 0, best: dailyAgg.best ?? 0, bestRound: dailyAgg.bestround ?? 0, perfect: dailyAgg.perfect || 0, avgRound: dailyAgg.avgr ?? 0 },
        },
        // Batch 48: vault is now three sections. hourHistogram stays at the top
        // for the persona line. Competitive percentiles come from the snapshot
        // (null for a fresh identity); the rest are live-computed rows.
        vault: {
          hourHistogram,
          competitive: {
            pointsPerTurn: (ranks && ranks.pptRank) || null,
            survivalRate: (ranks && ranks.survivalRate) || null,
            roundsPerLife: (ranks && ranks.roundsPerLife) || null,
            lettersPerLife: (ranks && ranks.lettersPerLife) || null,
            legendaryRate: (ranks && ranks.legendaryRate) || null,
            medianAnswerMs: speed.med ?? null,
            skillComponents: (ranks && ranks.skill) || null,
            roundsAppeared: (ranks && ranks.roundsAppeared != null) ? ranks.roundsAppeared : null,
            misses: (ranks && ranks.misses != null) ? ranks.misses : null,
          },
          volume: {
            timeUnderBombMs: Number(scale.tub) || 0,
            lettersTyped: scale.letters || 0,
            daysPlayed,
            busiestDay: busiest ? { date: toDate(busiest.d), n: busiest.n } : null,
            rejections,
          },
          curiosities: {
            firstWord: first ? { word: first.word, date: toDate(first.played_at) } : null,
            favoriteWord: fav ? { word: fav.word, n: fav.n } : null,
            uniqueWords: unique.c || 0,
            longestWord: longest ? { word: longest.word, len: longest.len } : null,
            modalFirstLetter: firstLetter ? firstLetter.l : null,
            usedFirstLetters: usedLetters,
            subSecond: speed.subsec || 0,
            slowestSave: slowest ? { word: slowest.word, ms: slowest.ms } : null,
            longestDayStreak: streak,
            perfectDailies: dailyAgg.perfect || 0,
            top10Dailies: top10,
          },
        },
      };
    },
    // ── Trophies (batch 44) ──
    // Evaluate an identity's achievements and INSERT any newly earned (idempotent
    // via ON CONFLICT DO NOTHING). Returns every earned trophy row for the
    // identity. earned_at is the historical date the criterion was met, except
    // unique_100 whose uniqueness drifts and so is stamped now() on first award.
    async awardTrophies(identity) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      const key = isAccount ? ('u:' + v) : ('d:' + v);
      const SCOPE = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;

      const q1 = (await pool.query(`
        WITH ev AS (
          SELECT tier, ms, played_at,
                 ROW_NUMBER() OVER (ORDER BY played_at, id) AS wn,
                 ROW_NUMBER() OVER (PARTITION BY tier ORDER BY played_at, id) AS tn,
                 CASE WHEN ms IS NOT NULL AND ms < 1000 THEN ROW_NUMBER() OVER (PARTITION BY (ms IS NOT NULL AND ms < 1000) ORDER BY played_at, id) END AS sn
          FROM word_events WHERE ${SCOPE}
        )
        SELECT
          MIN(played_at) FILTER (WHERE tier='LEGENDARY' AND tn=1)  AS leg_1,
          MIN(played_at) FILTER (WHERE tier='LEGENDARY' AND tn=10) AS leg_10,
          MIN(played_at) FILTER (WHERE tier='LEGENDARY' AND tn=25) AS leg_25,
          MIN(played_at) FILTER (WHERE sn=1)  AS subsec_1,
          MIN(played_at) FILTER (WHERE sn=25) AS subsec_25,
          MIN(played_at) FILTER (WHERE wn=1000)  AS words_1k,
          MIN(played_at) FILTER (WHERE wn=10000) AS words_10k
        FROM ev
      `, [v])).rows[0] || {};

      const q2 = (await pool.query(`
        WITH d AS (SELECT DISTINCT (played_at AT TIME ZONE 'UTC')::date AS day FROM word_events WHERE ${SCOPE}),
        g AS (SELECT day, day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp FROM d),
        isl AS (SELECT grp, MIN(day) AS start_day, COUNT(*)::int AS len FROM g GROUP BY grp)
        SELECT
          MIN(start_day + 6)  FILTER (WHERE len >= 7)  AS streak7_earned,
          MIN(start_day + 29) FILTER (WHERE len >= 30) AS streak30_earned
        FROM isl
      `, [v])).rows[0] || {};

      const q3 = (await pool.query(`
        WITH r AS (SELECT date_int, score, round_reached, created_at FROM daily_runs WHERE ${SCOPE}),
        t10 AS (
          SELECT created_at, ROW_NUMBER() OVER (ORDER BY created_at) AS qn
          FROM r
          WHERE (SELECT COUNT(*) FROM daily_runs b WHERE b.date_int = r.date_int AND b.score > r.score)::float
                / NULLIF((SELECT COUNT(*) FROM daily_runs b WHERE b.date_int = r.date_int), 0) < 0.10
        )
        SELECT p.perfect_earned, q.top10x10_earned FROM
          (SELECT MIN(created_at) AS perfect_earned FROM r WHERE round_reached >= 30) p
          CROSS JOIN (SELECT MIN(created_at) FILTER (WHERE qn = 10) AS top10x10_earned FROM t10) q
      `, [v])).rows[0] || {};

      const uniq = (await pool.query(`
        WITH ev AS (SELECT word, COALESCE('u:' || user_id::text, 'd:' || device_id) ik FROM word_events),
        owners AS (SELECT word, MIN(ik) ik FROM ev GROUP BY word HAVING COUNT(DISTINCT ik) = 1)
        SELECT COUNT(*)::int c FROM owners WHERE ik = $1
      `, [key])).rows[0].c;

      const earned = [];
      const add = (id, at) => { if (at) earned.push({ id, at }); };
      add('leg_1', q1.leg_1); add('leg_10', q1.leg_10); add('leg_25', q1.leg_25);
      add('subsec_1', q1.subsec_1); add('subsec_25', q1.subsec_25);
      add('words_1k', q1.words_1k); add('words_10k', q1.words_10k);
      add('streak_7', q2.streak7_earned); add('streak_30', q2.streak30_earned);
      add('daily_perfect', q3.perfect_earned); add('daily_top10x10', q3.top10x10_earned);
      if (uniq >= 100) earned.push({ id: 'unique_100', at: new Date() });

      for (const e of earned) {
        await pool.query(
          `INSERT INTO trophies (identity_key, trophy_id, earned_at) VALUES ($1, $2, $3)
           ON CONFLICT (identity_key, trophy_id) DO NOTHING`,
          [key, e.id, e.at]
        );
      }
      const rows = (await pool.query(`SELECT trophy_id, earned_at FROM trophies WHERE identity_key = $1`, [key])).rows;
      return rows.map(r => ({ id: r.trophy_id, earned_at: r.earned_at }));
    },
    // Every DISTINCT legendary word for an identity, best-scoring instance kept.
    async legendaryWall(identity) {
      const isAccount = identity.userId != null;
      const v = isAccount ? identity.userId : identity.deviceId;
      const SCOPE = isAccount ? `user_id = $1` : `device_id = $1 AND user_id IS NULL`;
      const rows = (await pool.query(`
        SELECT word, points, prompt, mode, (played_at AT TIME ZONE 'UTC')::date AS day FROM (
          SELECT word, points, prompt, mode, played_at,
                 ROW_NUMBER() OVER (PARTITION BY word ORDER BY points DESC, played_at ASC) AS rn
          FROM word_events WHERE tier = 'LEGENDARY' AND ${SCOPE}
        ) s WHERE rn = 1 ORDER BY points DESC
      `, [v])).rows;
      return rows.map(r => ({
        word: r.word, points: r.points, prompt: r.prompt, mode: r.mode,
        date: r.day ? new Date(r.day).toISOString().slice(0, 10) : null,
      }));
    },
  };
}

// The all-zero career shape (fresh identity). The endpoint still returns 200.
function emptyCareer() {
  return {
    ranks: null,
    since: null,
    overview: {
      words: 0, points: 0, games: 0, distinctWords: 0,
      tiers: { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 },
      best: [], medianMs: null, fastest: null, slowest: null,
      modes: { multiplayer: 0, scramble: 0, sabotage: 0, daily: 0 },
      maxRounds: { multiplayer: null, scramble: null, sabotage: null, daily: null },
      daily: { runs: 0, best: 0, bestRound: 0, perfect: 0, avgRound: 0 },
    },
    vault: {
      hourHistogram: new Array(24).fill(0),
      competitive: {
        pointsPerTurn: null, survivalRate: null, roundsPerLife: null, lettersPerLife: null,
        legendaryRate: null, medianAnswerMs: null, skillComponents: null,
        roundsAppeared: null, misses: null,
      },
      volume: { timeUnderBombMs: 0, lettersTyped: 0, daysPlayed: 0, busiestDay: null, rejections: 0 },
      curiosities: {
        firstWord: null, favoriteWord: null, uniqueWords: 0, longestWord: null,
        modalFirstLetter: null, usedFirstLetters: [], subSecond: 0, slowestSave: null,
        longestDayStreak: 0, perfectDailies: 0, top10Dailies: 0,
      },
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
    // ── Percentiles (batch 43) ── postgres-only, same posture as accounts.
    async recordTurnMiss() { /* no database: misses are skipped */ },
    async rebuildRankSnapshots() { return null; },
    async getRankSnapshot() { return null; },
    async getSnapshotMeta() { return null; },
    // ── Trophies (batch 44) ── postgres-only, same posture as accounts.
    async awardTrophies() { return []; },
    async legendaryWall() { return []; },
    // ── Identity (batch 46) ── postgres-only, same posture as accounts.
    async setAvatarAnimal() { /* no database: accounts are postgres-only */ },
    async setFlairTitle() { /* no database: accounts are postgres-only */ },
    async setBio() { /* no database: accounts are postgres-only */ },
    async setSignatureWord() { /* no database: accounts are postgres-only */ },
    async hasPlayedWord() { return false; },
    async distinctWords() { return []; },
    async hasTrophy() { return false; },
    async careerSummary() { return { words: 0, legendaries: 0 }; },
  };
}

module.exports = process.env.DATABASE_URL
  ? createPgBackend(process.env.DATABASE_URL)
  : createMemoryBackend();
