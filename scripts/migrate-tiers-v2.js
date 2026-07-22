// scripts/migrate-tiers-v2.js - retroactive re-stamp for rarity engine v2 (batch 50).
// Re-tiers ALL history to the v2 tier table: word_events tiers + points, daily_runs
// scores + word lists, trophies (re-derived), and rank snapshots (rebuilt). The
// point shift is the exact tier-base delta, so any additive bonus already baked
// into a stored point value (the daily +5 fast bonus) is preserved.
//
// Run at deploy time by Nikhil with DATABASE_URL set. Do NOT run against a real DB
// casually - it rewrites history.
//
// Transaction scope: the raw data re-stamp (steps a-c) is one atomic transaction
// on a dedicated client. Trophies (d) and rank snapshots (e) run AFTER that commit,
// because storage.awardTrophies reads word_events and storage.rebuildRankSnapshots
// opens its own transaction - both on storage's own pool, which cannot observe an
// uncommitted transaction held on another connection. They read the committed,
// re-stamped events and are idempotent re-derivations (safe to re-run).
'use strict';
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=postgres://... node scripts/migrate-tiers-v2.js');
  process.exit(1);
}

// Tier bases x10 (integers) = 10 * TIER_BASE in dictionary.js. The point shift is
// the exact new-minus-old base delta, which preserves additive bonuses in points.
const BASE = { COMMON: 10, UNCOMMON: 16, RARE: 26, EPIC: 40, LEGENDARY: 60 };

// Load the committed tier table: "word<TAB>rarity<TAB>tier". Tiers are decided at
// build time (full precision) in scripts/build-tiers.js; we read column 3 verbatim,
// so there is no local cut function and no rounding drift. (See dictionary.js.)
const tierByWord = new Map();
for (const line of fs.readFileSync(path.join(__dirname, '..', 'data', 'tiers-v2.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const parts = line.split('\t');
  tierByWord.set(parts[0], parts[2]);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const storage = require('../storage'); // selects the PG backend because DATABASE_URL is set

async function main() {
  let weRestamped = 0, dailyUpdated = 0, identities = 0, trophiesAwarded = 0;

  // ── Steps a-c: one atomic transaction (tier_map + word_events + daily_runs). ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // a. TEMP TABLE tier_map, bulk-insert all word->tier (~5,000 rows/statement).
    await client.query('CREATE TEMP TABLE tier_map (word TEXT PRIMARY KEY, tier TEXT NOT NULL)');
    const entries = [...tierByWord.entries()];
    const CHUNK = 5000;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);
      const params = [];
      const placeholders = slice.map(([w, t], k) => {
        params.push(w, t);
        return `($${k * 2 + 1}, $${k * 2 + 2})`;
      });
      await client.query(`INSERT INTO tier_map (word, tier) VALUES ${placeholders.join(',')}`, params);
    }

    // b. Re-stamp word_events. The point shift is the exact tier-base delta.
    const weRes = await client.query(`
      UPDATE word_events we SET
        points = we.points
          + (CASE m.tier WHEN 'COMMON' THEN 10 WHEN 'UNCOMMON' THEN 16 WHEN 'RARE' THEN 26 WHEN 'EPIC' THEN 40 ELSE 60 END)
          - (CASE we.tier WHEN 'COMMON' THEN 10 WHEN 'UNCOMMON' THEN 16 WHEN 'RARE' THEN 26 WHEN 'EPIC' THEN 40 ELSE 60 END),
        tier = m.tier
      FROM tier_map m
      WHERE we.word = m.word AND we.tier <> m.tier
    `);
    weRestamped = weRes.rowCount;

    // c. Re-stamp daily_runs in Node. The words column is JSONB; each element
    // carries tier + points. Apply the same base delta to each changed element's
    // points and to the run's score (which includes +5 fast bonuses baked into
    // points), and set the element's tier. round_reached and every other column
    // are untouched; bestWord is derived at read time from words.
    const runs = await client.query('SELECT session_id, score, words FROM daily_runs');
    for (const row of runs.rows) {
      const words = row.words; // node-pg parses JSONB into a JS array
      if (!Array.isArray(words)) continue;
      let scoreDelta = 0, changed = false;
      for (const el of words) {
        const nt = tierByWord.get(String(el.word || '').toLowerCase());
        if (nt && el.tier && nt !== el.tier) {
          const delta = (BASE[nt] || 0) - (BASE[el.tier] || 0);
          el.points = (el.points || 0) + delta;
          el.tier = nt;
          scoreDelta += delta;
          changed = true;
        }
      }
      if (changed) {
        await client.query(
          'UPDATE daily_runs SET score = $2, words = $3::jsonb WHERE session_id = $1',
          [row.session_id, row.score + scoreDelta, JSON.stringify(words)]
        );
        dailyUpdated++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
    console.error('migration failed (rolled back a-c, nothing committed):', err && err.message);
    process.exit(1);
  }
  client.release();

  // ── Steps d-e: re-derivations against the committed re-stamped events. ──
  try {
    // d. TRUNCATE trophies, then re-derive per identity. unique_100's earned_at
    // re-stamps to now(); every other trophy recovers its historical earned_at
    // from event timestamps (known, accepted drift).
    await pool.query('TRUNCATE trophies');
    const ids = await pool.query('SELECT DISTINCT user_id, device_id FROM word_events');
    for (const r of ids.rows) {
      const identity = r.user_id != null ? { userId: r.user_id } : { deviceId: r.device_id };
      const awarded = await storage.awardTrophies(identity);
      identities++;
      if (Array.isArray(awarded)) trophiesAwarded += awarded.length;
    }

    // e. Rebuild rank snapshots (runs its own transaction inside storage).
    await storage.rebuildRankSnapshots();
  } catch (err) {
    console.error('post-commit re-derivation failed (tiers/scores are committed; safe to re-run trophies + ranks):', err && err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // f. Final report + the post-migration LEGENDARY wall for identity u:1.
  const wall = await pool.query(
    `SELECT COUNT(DISTINCT word)::int AS n FROM word_events WHERE tier = 'LEGENDARY' AND user_id = 1`
  );
  console.log('── rarity v2 migration report ──');
  console.log('word_events re-stamped:', weRestamped);
  console.log('daily runs updated:', dailyUpdated);
  console.log('identities processed:', identities);
  console.log('trophies awarded:', trophiesAwarded);
  console.log('legendary wall (u:1):', wall.rows[0].n);

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('unexpected migration error:', err && err.stack || err);
  await pool.end().catch(() => {});
  process.exit(1);
});
