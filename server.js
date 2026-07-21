const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require('crypto');
const { Server } = require('socket.io');
// Persistence spine: postgres when DATABASE_URL is set, else in-memory.
// Gameplay NEVER blocks on it; word-event writes are fire-and-forget.
const storage = require('./storage');
const { validWords, playablePrompts, generatePrompt, generateSabotagePrompt, generatePracticePrompt, solutionCount, killerAnswersFor, exampleWordFor, isValidWord, getWordTier, getWordScore, rarityScore, generateDailyPrompts, letterBaseline } = require('./dictionary');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8kb' }));

// ── Accounts / auth (batch 41) ────────────────────────────────────────────────
// Optional, stateless, signed-cookie sessions over Discord/Google OAuth. Auth is
// ENABLED only when the storage backend is postgres, SESSION_SECRET is set, and
// at least one provider's id+secret pair is configured. Otherwise every /auth/*
// route except /auth/config answers 503, /me returns { user: null }, and the
// client hides the whole account surface. Local dev and verification runs work
// with zero setup. Accounts are optional forever: no gameplay path depends on
// them, and a signed-out user sees exactly the old flows plus two header buttons.
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SESSION_MAX_AGE_S = 15552000; // 180 days
const OAUTH_PROVIDERS = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scope: 'identify',
    userInfoUrl: 'https://discord.com/api/users/@me',
    // Discord identity -> { providerId, seedName, avatarUrl }. The avatar field is
    // a hash (may be null); build the CDN URL when present (batch 42).
    identity: (u) => ({
      providerId: String(u.id),
      seedName: u.global_name || u.username || '',
      avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null,
    }),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid profile',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    identity: (u) => ({ providerId: String(u.sub), seedName: u.name || 'Player', avatarUrl: u.picture || null }),
  },
};
const configuredProviders = () =>
  Object.keys(OAUTH_PROVIDERS).filter(k => OAUTH_PROVIDERS[k].clientId && OAUTH_PROVIDERS[k].clientSecret);
const authEnabled = () =>
  storage.name === 'postgres' && !!SESSION_SECRET && configuredProviders().length > 0;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (str) => createHmac('sha256', SESSION_SECRET).update(str).digest();

// Cookie value: base64url(payloadJSON) + '.' + base64url(hmac(payloadJSON)).
function signSession(uid) {
  const payload = JSON.stringify({ uid, iat: Math.floor(Date.now() / 1000) });
  return b64url(payload) + '.' + b64url(hmac(payload));
}
// Parse a raw Cookie header string and return { uid } or null. Batch 42 pulled
// this core out of readSession so the socket handshake (which has no req object)
// can reuse the exact same verification. Behavior is byte-identical for HTTP.
function readSessionFromCookieHeader(cookieHeader) {
  if (!SESSION_SECRET) return null;
  const raw = (cookieHeader || '')
    .split('; ').find(c => c.startsWith('bp_session='));
  if (!raw) return null;
  const value = raw.slice('bp_session='.length);
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  let payloadJSON, sig;
  try {
    payloadJSON = Buffer.from(value.slice(0, dot), 'base64url').toString('utf8');
    sig = Buffer.from(value.slice(dot + 1), 'base64url');
  } catch { return null; }
  const expected = hmac(payloadJSON);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(payloadJSON); } catch { return null; }
  if (!payload || typeof payload.uid !== 'number' || typeof payload.iat !== 'number') return null;
  if (Math.floor(Date.now() / 1000) - payload.iat > SESSION_MAX_AGE_S) return null;
  return { uid: payload.uid };
}
function readSession(req) {
  return readSessionFromCookieHeader(req.headers.cookie || '');
}
const cookieSecure = () => (BASE_URL.startsWith('https') ? '; Secure' : '');
function setSessionCookie(res, value) {
  res.append('Set-Cookie',
    `bp_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}${cookieSecure()}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie',
    `bp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecure()}`);
}
function readOAuthState(req) {
  const raw = (req.headers.cookie || '')
    .split('; ').find(c => c.startsWith('bp_oauth_state='));
  return raw ? raw.slice('bp_oauth_state='.length) : null;
}
function setOAuthStateCookie(res, value) {
  res.append('Set-Cookie',
    `bp_oauth_state=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${cookieSecure()}`);
}
function clearOAuthStateCookie(res) {
  res.append('Set-Cookie',
    `bp_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSecure()}`);
}

// ── Daily solo mode (Feature 8) ──────────────────────────────────────────────
// A single-player, HTTP-driven gauntlet. The day's 30-prompt sequence is seeded
// by the UTC date so everyone worldwide plays the same run. The server is the
// sole authority on prompts, validation, timing, and scoring. Per-player state
// lives in short-lived in-memory sessions; the leaderboard resets at UTC midnight.
// One life, base-game rules: wrong submissions are free retries within the
// fuse; only a fuse expiring (or clearing all 30 prompts) ends the run.
const DAILY_TOTAL = 30;
const DAILY_TIMER_MS = 15000;
const DAILY_GRACE_MS = 2000;      // network slack before a late answer counts as timeout
const DAILY_FAST_MS = 3000;       // "answered quickly" bonus threshold
const DAILY_ALPHABET_BONUS = 50;  // points for lighting all 26 letters (repeatable)
const DAILY_SESSION_TTL_MS = 30 * 60 * 1000;
const DAILY_TIER_RANK = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 };
// LEGENDARY is a star, not a yellow square: green vs yellow squares are
// indistinguishable to protan viewers, so the top tier stands out by shape.
const DAILY_TIER_SQUARE = { COMMON: '⚪', UNCOMMON: '🟢', RARE: '🔵', EPIC: '🟣', LEGENDARY: '⭐' };

function utcDateInfo(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { int: Number(`${y}${m}${day}`), iso: `${y}-${m}-${day}` };
}

let dailyCache = null;                 // { int, iso, prompts }
const dailySessions = new Map();       // sessionId -> session

// (Re)build the day's sequence and reset the day's sessions if the UTC day
// has rolled over since the cache was built. The leaderboard itself lives
// behind the storage interface, keyed by date_int, so it needs no reset here
// (the memory backend wipes its own single-day board on rollover).
function ensureDaily() {
  const info = utcDateInfo();
  if (!dailyCache || dailyCache.int !== info.int) {
    dailyCache = { int: info.int, iso: info.iso, prompts: generateDailyPrompts(info.int) };
    dailySessions.clear();
    console.log(`Daily sequence generated for ${info.iso}`);
  }
  return dailyCache;
}

function sweepDailySessions() {
  const cutoff = Date.now() - DAILY_SESSION_TTL_MS;
  for (const [id, s] of dailySessions) {
    if (s.lastActivity < cutoff) dailySessions.delete(id);
  }
}

function newSessionId() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// A simple incrementing day number from the UTC date (Daily #1 = 2025-01-01).
function dailyDayNumber(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const EPOCH = Date.UTC(2025, 0, 1);
  return Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / 86400000) + 1;
}

// Compact, scannable share card: a title line, a stats line, one row of up to
// 30 tier-colored squares, and the URL. The colors are self-explanatory, so no
// legend line.
function dailyShareText(session, daily, req, round) {
  const host = String(req.get('host') || 'bombparty.app');
  const squares = session.tiles.map(t => DAILY_TIER_SQUARE[t] || '⚪').join('');
  return [
    `Bombparty Daily #${dailyDayNumber(daily.iso)}  ${session.score} pts`,
    `Reached round ${round}/${DAILY_TOTAL}  best streak ${session.maxStreak}`,
    squares || '(no words)',
    `${host}/daily`,
  ].join('\n');
}

function dailyResult(session, daily, req) {
  const round = session.completed ? DAILY_TOTAL : Math.min(DAILY_TOTAL, session.promptIndex + 1);
  return {
    gameOver: true,
    completed: session.completed,
    finalScore: session.score,
    round,
    total: DAILY_TOTAL,
    answered: session.tiles.length,
    maxStreak: session.maxStreak,
    bestWord: session.bestWord,
    tiles: session.tiles,
    words: session.words,                 // full recap: {word, tier, points}
    alphabetClears: session.alphabetClears,
    killer: session.killer || null,       // { prompt, exampleWord } on timeout only
    shareText: dailyShareText(session, daily, req, round),
  };
}

function endDaily(session, daily, req, reason) {
  session.finished = true;
  session.completed = (reason === 'completed');
  const round = session.completed ? DAILY_TOTAL : Math.min(DAILY_TOTAL, session.promptIndex + 1);
  // The prompt that ended the run, plus one word that would have answered it.
  if (reason === 'timeout') {
    const prompt = daily.prompts[session.promptIndex];
    session.killer = { prompt, exampleWord: exampleWordFor(prompt, session.usedWords) };
    // Batch 43: the fuse ended the run - a miss for the safety meter.
    storage.recordTurnMiss({
      mode: 'daily', deviceId: session.deviceId, userId: session.userId, gameId: session.id,
    }).catch(err => console.error('turn_miss insert failed:', err.message));
  }
  // One durable entry per run, keyed by sessionId, so same-named strangers
  // never overwrite each other; a repeat finish for the same session updates
  // in place (matching the old Map.set overwrite). Fire-and-forget: the run
  // is already over, a storage failure must never surface to the player.
  storage.saveDailyRun({
    sessionId: session.id, dateInt: session.date, deviceId: session.deviceId || null,
    userId: session.userId ?? null,
    id: session.id, name: session.name, score: session.score, round,
    completed: session.completed, bestWord: session.bestWord,
    words: session.words, tiles: session.tiles,
  }).catch(err => console.error('daily run save failed:', err.message));
  // Tier distribution of the run, for later calibration from live logs.
  const tc = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
  for (const t of session.tiles) tc[t] = (tc[t] || 0) + 1;
  console.log(`[tiers] daily round=${round} score=${session.score} C=${tc.COMMON} U=${tc.UNCOMMON} R=${tc.RARE} E=${tc.EPIC} L=${tc.LEGENDARY}`);
  return dailyResult(session, daily, req);
}

// Serve the SPA for the daily route; the client renders the daily screen.
app.get('/daily', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/daily/start', (req, res) => {
  const daily = ensureDaily();
  sweepDailySessions();
  let name = String((req.body && req.body.name) || '').trim().slice(0, 20);
  if (!name) name = 'Anonymous';
  // Device identity for the persistence spine; absent on older tabs is fine.
  const deviceId = String((req.body && req.body.deviceId) || '').trim().slice(0, 64) || null;
  // Batch 42: write-time identity. Daily is HTTP, so read the session here once.
  const userId = readSession(req)?.uid ?? null;
  const id = newSessionId();
  const now = Date.now();
  dailySessions.set(id, {
    id, name, deviceId, userId, date: daily.int,
    promptIndex: 0, score: 0, streak: 0, maxStreak: 0,
    tiles: [], words: [], bestWord: null, usedWords: new Set(),
    alphabet: new Set(), alphabetClears: 0,
    promptStartedAt: now, lastActivity: now,
    finished: false, completed: false,
  });
  res.json({
    sessionId: id, date: daily.iso, total: DAILY_TOTAL,
    promptIndex: 0, prompt: daily.prompts[0],
    score: 0, streak: 0, timerMs: DAILY_TIMER_MS,
  });
});

app.post('/daily/submit', (req, res) => {
  const daily = ensureDaily();
  const body = req.body || {};
  const session = dailySessions.get(String(body.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.date !== daily.int) {
    dailySessions.delete(session.id);
    return res.status(410).json({ error: 'stale_day' });
  }
  session.lastActivity = Date.now();
  if (session.finished) return res.json(dailyResult(session, daily, req));

  // Ignore out-of-order / duplicate submissions (e.g. a timeout that races a
  // valid answer). The promptIndex disambiguates without penalising the player.
  if (Number(body.promptIndex) !== session.promptIndex) {
    return res.json({ ignored: true, promptIndex: session.promptIndex, prompt: daily.prompts[session.promptIndex] });
  }

  const elapsed = Date.now() - session.promptStartedAt;
  const prompt = daily.prompts[session.promptIndex];

  // Timer expiry (client-signalled or server-measured past the grace) ends the run.
  if (body.timeout === true || elapsed > DAILY_TIMER_MS + DAILY_GRACE_MS) {
    return res.json(endDaily(session, daily, req, 'timeout'));
  }

  const word = String(body.word || '').trim().toLowerCase();
  const result = isValidWord(word, prompt, session.usedWords);
  if (!result.valid) {
    // Free retry (base-game parity): no penalty, it just breaks the clean streak.
    session.streak = 0;
    storage.recordWordRejection({
      mode: 'daily', deviceId: session.deviceId, userId: session.userId, gameId: session.id,
      word, reason: result.reason,
    }).catch(err => console.error('word_rejection insert failed:', err.message));
    return res.json({ valid: false, reason: result.reason, promptIndex: session.promptIndex });
  }

  // Valid answer: score it with the unified per-word score plus a speed bonus.
  session.usedWords.add(word);
  const tier = getWordTier(word);
  let points = getWordScore(word);
  if (elapsed < DAILY_FAST_MS) points += 5;
  session.score += points;
  session.streak += 1;
  session.maxStreak = Math.max(session.maxStreak, session.streak);
  session.tiles.push(tier);
  session.words.push({ word, tier, points, prompt });
  // Persistence spine: one event per accepted word, fire-and-forget (rule:
  // gameplay never blocks on the database).
  storage.recordWordEvent({
    mode: 'daily', deviceId: session.deviceId, userId: session.userId, gameId: session.id,
    round: session.promptIndex, word, tier, points, ms: elapsed,
  }).catch(err => console.error('word_event insert failed:', err.message));

  // Alphabet tracker: light this word's letters; all 26 pays a bonus and
  // resets so it can be completed again (multiplayer parity, points not lives).
  for (const ch of word) {
    if (ch >= 'a' && ch <= 'z') session.alphabet.add(ch);
  }
  let alphaCleared = false;
  if (session.alphabet.size >= 26) {
    session.score += DAILY_ALPHABET_BONUS;
    session.alphabetClears += 1;
    session.alphabet = new Set();
    alphaCleared = true;
  }

  if (!session.bestWord ||
      DAILY_TIER_RANK[tier] > DAILY_TIER_RANK[session.bestWord.tier] ||
      (DAILY_TIER_RANK[tier] === DAILY_TIER_RANK[session.bestWord.tier] && word.length > session.bestWord.word.length)) {
    session.bestWord = { word, tier, points };
  }
  session.promptIndex += 1;

  if (session.promptIndex >= DAILY_TOTAL) {
    return res.json(endDaily(session, daily, req, 'completed'));
  }
  session.promptStartedAt = Date.now();
  res.json({
    valid: true, word, tier, points, score: session.score, streak: session.streak,
    promptIndex: session.promptIndex, prompt: daily.prompts[session.promptIndex],
    total: DAILY_TOTAL,
    alphabet: [...session.alphabet],
    alphaCleared,
    alphaBonus: alphaCleared ? DAILY_ALPHABET_BONUS : 0,
  });
});

app.get('/daily/leaderboard', async (req, res) => {
  const daily = ensureDaily();
  try {
    // Sorted score desc then round desc by the backend (SQL or memory).
    const sorted = await storage.getDailyBoard(daily.int);
    const players = await storage.getDailyPlayCount(daily.int);
    const entries = sorted
      .slice(0, 10)
      .map((e, i) => ({ rank: i + 1, id: e.id, name: e.name, score: e.score, round: e.round, accountId: e.accountId ?? null }));
    // The asking run's own placement (by sessionId), so the client can show
    // its rank even when it falls outside the top 10.
    let me = null;
    const id = String(req.query.id || '');
    if (id) {
      const idx = sorted.findIndex(e => e.id === id);
      if (idx !== -1) me = { rank: idx + 1, id: sorted[idx].id, name: sorted[idx].name, score: sorted[idx].score, round: sorted[idx].round, accountId: sorted[idx].accountId ?? null };
    }
    res.json({ date: daily.iso, players, entries, me });
  } catch (err) {
    console.error('daily leaderboard read failed:', err.message);
    res.status(503).json({ error: 'leaderboard_unavailable' });
  }
});

// Full detail of one leaderboard run, for the expandable rows. Kept out of
// the main leaderboard payload so the list stays light.
app.get('/daily/run', async (req, res) => {
  ensureDaily();
  try {
    const e = await storage.getDailyRun(String(req.query.id || ''));
    if (!e) return res.status(404).json({ error: 'run_not_found' });
    res.json({
      name: e.name, score: e.score, round: e.round, completed: e.completed,
      bestWord: e.bestWord, words: e.words, tiles: e.tiles,
    });
  } catch (err) {
    console.error('daily run read failed:', err.message);
    res.status(503).json({ error: 'run_unavailable' });
  }
});

// ── Practice solo mode ───────────────────────────────────────────────────────
// Endless solo sessions over HTTP, following the daily's pattern: an in-memory
// sessions Map with a TTL sweep, per-prompt server timestamps, and the same
// generous solo grace window. Practice is fully isolated: it writes NOTHING to
// the daily leaderboard, daily state, or any career-facing structure.
const PRACTICE_GRACE_MS = 2000;        // network slack, same pattern as DAILY_GRACE_MS
const PRACTICE_SESSION_TTL_MS = 30 * 60 * 1000;
const PRACTICE_LONG_WORD_LENGTH = 12;  // long-word bonus threshold (matches main game)
const practiceSessions = new Map();

function sweepPracticeSessions() {
  const cutoff = Date.now() - PRACTICE_SESSION_TTL_MS;
  for (const [id, s] of practiceSessions) {
    if (s.lastActivity < cutoff) practiceSessions.delete(id);
  }
}

// Overtime in practice: with one player a cycle is one turn, so past the
// configured round the timer drops 0.5 per round to the main-game floor.
// String length never changes.
function practiceEffTimerSec(s) {
  const st = s.settings;
  if (st.overtime && s.round > st.overtimeAfterRound) {
    return Math.max(OVERTIME_MIN_TIMER, st.timer - 0.5 * (s.round - st.overtimeAfterRound));
  }
  return st.timer;
}

function practiceNextPrompt(s) {
  s.prompt = generatePracticePrompt(s.settings.stringLength, s.settings.difficulty, s.usedPrompts);
  s.usedPrompts.add(s.prompt);
  s.effTimerMs = practiceEffTimerSec(s) * 1000;
  s.promptStartedAt = Date.now();
}

function practiceSummary(s) {
  const words = s.words;
  const times = words.map(w => w.ms);
  const livesLost = s.timeouts.length;
  const roundsSurvived = words.length + s.timeouts.length;
  let best = null, longest = null, hardest = null, slowest = null, rarest = null;
  const tierCounts = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
  let placeStart = 0, placeEnd = 0, placeMiddle = 0, inflected = 0;
  for (const w of words) {
    tierCounts[w.tier] = (tierCounts[w.tier] || 0) + 1;
    if (!best || w.points > best.points) best = w;
    if (!longest || w.word.length > longest.word.length) longest = w;
    if (!hardest || w.solutionCount < hardest.solutionCount) hardest = w;
    if (!slowest || w.ms > slowest.ms) slowest = w;
    const r = rarityScore(w.word);
    if (!rarest || r > rarest.r) rarest = { w, r };
    if (w.word.startsWith(w.prompt)) placeStart += 1;
    else if (w.word.endsWith(w.prompt)) placeEnd += 1;
    else placeMiddle += 1;
    if (w.word.endsWith('s') || w.word.endsWith('ed') || w.word.endsWith('ing')) inflected += 1;
  }
  const pct = n => Math.round((n / words.length) * 100);
  // Pace trend: first third of words versus last third (needs at least 3)
  let paceTrend = null;
  if (words.length >= 3) {
    const third = Math.max(1, Math.floor(words.length / 3));
    const avg = arr => Math.round(arr.reduce((a, w) => a + w.ms, 0) / arr.length);
    paceTrend = { startMs: avg(words.slice(0, third)), endMs: avg(words.slice(words.length - third)) };
  }
  // Median solution count across every prompt faced (solved and timed out)
  const solvabilities = words.map(w => w.solutionCount)
    .concat(s.timeouts.map(t => solutionCount(t.prompt)))
    .sort((a, b) => a - b);
  const mid = solvabilities.length >> 1;
  const medianSolvability = solvabilities.length
    ? (solvabilities.length % 2 ? solvabilities[mid] : Math.round((solvabilities[mid - 1] + solvabilities[mid]) / 2))
    : null;
  // Per-letter counts across the session's VALID words only (timeout prompts
  // do not count), for the postgame letter-habits heatmap.
  const letterUsage = {};
  let totalLetters = 0;
  for (const w of words) {
    for (const ch of w.word) {
      if (ch >= 'a' && ch <= 'z') { letterUsage[ch] = (letterUsage[ch] || 0) + 1; totalLetters++; }
    }
  }
  return {
    finished: true,
    settings: s.settings,
    totalPoints: s.score,
    wordsPlayed: words.length,
    roundsSurvived,
    livesLost,
    bestWord: best ? { word: best.word, tier: best.tier, points: best.points, prompt: best.prompt } : null,
    longestWord: longest ? { word: longest.word, length: longest.word.length, prompt: longest.prompt } : null,
    fastestMs: times.length ? Math.min(...times) : null,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    avgWordLength: words.length
      ? Number((words.reduce((a, w) => a + w.word.length, 0) / words.length).toFixed(1))
      : null,
    avgPointsPerWord: words.length ? Number((s.score / words.length).toFixed(1)) : null,
    bestStreak: s.bestStreak,
    clutchSaves: words.filter(w => w.remainingMs < 1000).length,
    slowestAnswer: slowest ? { word: slowest.word, ms: slowest.ms } : null,
    paceTrend, // { startMs, endMs } or null when under 3 words
    placement: words.length ? { start: pct(placeStart), end: pct(placeEnd), middle: pct(placeMiddle) } : null,
    inflectionPct: words.length ? pct(inflected) : null,
    medianSolvability,
    // Rarest word, omitted when it is the same word as bestWord
    rarestWord: (rarest && (!best || rarest.w.word !== best.word))
      ? { word: rarest.w.word, tier: rarest.w.tier, points: rarest.w.points, prompt: rarest.w.prompt }
      : null,
    hardestSolved: hardest ? { prompt: hardest.prompt, solutionCount: hardest.solutionCount, word: hardest.word } : null,
    comeback: { rounds: s.oneLifeRounds, points: s.oneLifePoints },
    roundsPerLife: livesLost ? Number((roundsSurvived / livesLost).toFixed(1)) : null,
    nemesis: s.timeouts.map(t => ({ prompt: t.prompt, exampleWord: t.exampleWord })),
    killers: s.timeouts, // full detail: { prompt, exampleWord, easiestAnswers }
    tierCounts,
    lettersUsed: [...s.letters],
    alphabetClears: s.alphabetClears,
    letterUsage, totalLetters,
    letterBaseline, // dictionary-wide letter shares, for the usage heatmap
    words, // full recap: { word, tier, points, prompt, ms, remainingMs, solutionCount }
    endedBy: (s.lives <= 0 && s.timeouts.length) ? {
      prompt: s.timeouts[s.timeouts.length - 1].prompt,
      exampleWord: s.timeouts[s.timeouts.length - 1].exampleWord,
    } : null,
  };
}

function finishPractice(s) {
  if (!s.finished) {
    s.finished = true;
    // Labeled tier line so calibration data from live logs stays separable.
    const tc = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
    for (const w of s.words) tc[w.tier] = (tc[w.tier] || 0) + 1;
    console.log(`[tiers] practice rounds=${s.words.length + s.timeouts.length} score=${s.score} C=${tc.COMMON} U=${tc.UNCOMMON} R=${tc.RARE} E=${tc.EPIC} L=${tc.LEGENDARY}`);
  }
  return practiceSummary(s);
}

app.post('/practice/start', (req, res) => {
  sweepPracticeSessions();
  const b = req.body || {};
  const settings = {
    timer: clamp(b.timer, 5, 15),
    lives: clamp(b.lives, 1, 5),
    stringLength: clamp(b.stringLength, 2, 4),
    difficulty: ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : 'medium',
    longWordBonus: b.longWordBonus !== false,
    overtime: !!b.overtime,
    overtimeAfterRound: clamp(b.overtimeAfterRound, 1, 200),
  };
  const id = newSessionId();
  const now = Date.now();
  const s = {
    id, settings,
    round: 1, lives: settings.lives, score: 0,
    usedWords: new Set(), usedPrompts: new Set(),
    prompt: null, promptStartedAt: now, effTimerMs: settings.timer * 1000,
    words: [], timeouts: [],
    streak: 0, bestStreak: 0,
    oneLifeRounds: 0, oneLifePoints: 0, // comeback stats while at exactly 1 life
    letters: new Set(),                  // all-session letter coverage (stats only)
    alphabet: new Set(), alphabetClears: 0, // multiplayer-parity tracker: 26 letters = +1 life
    lastActivity: now, finished: false,
  };
  practiceNextPrompt(s);
  practiceSessions.set(id, s);
  res.json({ sessionId: id, prompt: s.prompt, settings, timerMs: s.effTimerMs, round: s.round, lives: s.lives, score: 0, alphabet: [] });
});

app.post('/practice/answer', (req, res) => {
  const b = req.body || {};
  const s = practiceSessions.get(String(b.sessionId || ''));
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  s.lastActivity = Date.now();
  if (s.finished) return res.json(practiceSummary(s));

  const elapsed = Date.now() - s.promptStartedAt;

  // Timer expiry (client-signalled or server-measured past the grace).
  if (b.timeout === true || elapsed > s.effTimerMs + PRACTICE_GRACE_MS) {
    s.lives -= 1;
    s.streak = 0;
    // Solo mode spoils nobody: always reveal, and record the cheapest way out
    // plus four random non-legendary answers for the postgame "what killed
    // you" banners. Computed once here so the postgame is stable.
    s.timeouts.push({
      prompt: s.prompt,
      exampleWord: exampleWordFor(s.prompt, s.usedWords),
      easiestAnswers: killerAnswersFor(s.prompt, s.usedWords),
    });
    const reveal = s.timeouts[s.timeouts.length - 1];
    if (s.lives <= 0) return res.json(finishPractice(s));
    s.round += 1;
    practiceNextPrompt(s);
    return res.json({
      timeout: true, exampleWord: reveal.exampleWord, killedBy: reveal.prompt,
      lives: s.lives, round: s.round, prompt: s.prompt, timerMs: s.effTimerMs, score: s.score, streak: 0,
    });
  }

  const word = String(b.word || '').trim().toLowerCase();
  const result = isValidWord(word, s.prompt, s.usedWords);
  if (!result.valid) {
    // Free retry on the same prompt; only the streak breaks.
    s.streak = 0;
    return res.json({ valid: false, reason: result.reason, prompt: s.prompt });
  }

  s.usedWords.add(word);
  const tier = getWordTier(word);
  const points = getWordScore(word);
  const remainingMs = Math.max(0, s.effTimerMs - elapsed);
  s.words.push({
    word, tier, points, prompt: s.prompt, ms: elapsed,
    remainingMs, solutionCount: solutionCount(s.prompt),
  });
  s.score += points;
  s.streak += 1;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  if (s.lives === 1) { s.oneLifeRounds += 1; s.oneLifePoints += points; }

  // ── Alphabet tracker + bonuses (multiplayer parity) ──
  for (const ch of word) {
    if (ch >= 'a' && ch <= 'z') { s.letters.add(ch); s.alphabet.add(ch); }
  }
  // Long-word bonus: 12+ letters lights one random unlit letter.
  let bonusLetter = null;
  if (s.settings.longWordBonus && word.length >= PRACTICE_LONG_WORD_LENGTH) {
    const unlit = [];
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      if (!s.alphabet.has(ch)) unlit.push(ch);
    }
    if (unlit.length) {
      bonusLetter = unlit[Math.floor(Math.random() * unlit.length)];
      s.alphabet.add(bonusLetter);
    }
  }
  // Completing the alphabet grants a life and resets the tracker (repeatable).
  let alphabetCleared = false;
  if (s.alphabet.size >= 26) {
    s.lives += 1;
    s.alphabetClears += 1;
    s.alphabet = new Set();
    alphabetCleared = true;
  }

  s.round += 1;
  practiceNextPrompt(s);
  res.json({
    valid: true, word, tier, points, score: s.score, streak: s.streak,
    lives: s.lives, round: s.round, prompt: s.prompt, timerMs: s.effTimerMs,
    alphabet: [...s.alphabet], alphabetCleared, bonusLetter,
  });
});

// Ends the session immediately (the Finish button and the leave-via-logo flow).
app.post('/practice/finish', (req, res) => {
  const s = practiceSessions.get(String((req.body || {}).sessionId || ''));
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  s.lastActivity = Date.now();
  res.json(finishPractice(s));
});

// ── Auth / accounts routes (batch 41) ─────────────────────────────────────────
// All placed before the /:code catch-all. When auth is disabled every route
// here except /auth/config short-circuits to 503, so nothing depends on config.
function authGate(req, res) {
  if (!authEnabled()) { res.status(503).json({ error: 'auth disabled' }); return false; }
  return true;
}
// requireUser: 503 if auth disabled, 401 if no valid session. Returns uid or null.
function requireUser(req, res) {
  if (!authGate(req, res)) return null;
  const sess = readSession(req);
  if (!sess) { res.status(401).json({ error: 'not signed in' }); return null; }
  return sess.uid;
}

app.get('/auth/config', (req, res) => {
  const enabled = authEnabled();
  res.json({ enabled, providers: enabled ? configuredProviders() : [] });
});

// Start OAuth: random state in a short-lived cookie, then redirect to provider.
function startOAuth(providerKey) {
  return (req, res) => {
    if (!authGate(req, res)) return;
    const p = OAUTH_PROVIDERS[providerKey];
    if (!p.clientId || !p.clientSecret) return res.status(503).json({ error: 'auth disabled' });
    const state = randomBytes(32).toString('hex');
    setOAuthStateCookie(res, state);
    const params = new URLSearchParams({
      client_id: p.clientId,
      response_type: 'code',
      redirect_uri: `${BASE_URL}/auth/${providerKey}/callback`,
      scope: p.scope,
      state,
    });
    res.redirect(302, `${p.authorizeUrl}?${params.toString()}`);
  };
}
app.get('/auth/discord', startOAuth('discord'));
app.get('/auth/google', startOAuth('google'));

// OAuth callback: verify state, exchange code, fetch identity, sign a session.
function oauthCallback(providerKey) {
  return async (req, res) => {
    if (!authGate(req, res)) return;
    const p = OAUTH_PROVIDERS[providerKey];
    const cookieState = readOAuthState(req);
    clearOAuthStateCookie(res);
    const { state, code } = req.query;
    if (!code || !state || !cookieState || String(state) !== cookieState) {
      return res.redirect(302, '/?auth=error');
    }
    try {
      const tokenRes = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({
          client_id: p.clientId,
          client_secret: p.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${BASE_URL}/auth/${providerKey}/callback`,
        }).toString(),
      });
      if (!tokenRes.ok) { console.error(`oauth ${providerKey}: token exchange failed (${tokenRes.status})`); return res.redirect(302, '/?auth=error'); }
      const token = await tokenRes.json();
      const accessToken = token.access_token;
      if (!accessToken) { console.error(`oauth ${providerKey}: no access_token in response`); return res.redirect(302, '/?auth=error'); }

      const infoRes = await fetch(p.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!infoRes.ok) { console.error(`oauth ${providerKey}: userinfo failed (${infoRes.status})`); return res.redirect(302, '/?auth=error'); }
      const info = await infoRes.json();
      const { providerId, seedName, avatarUrl } = p.identity(info);
      if (!providerId) { console.error(`oauth ${providerKey}: identity missing provider id`); return res.redirect(302, '/?auth=error'); }
      const displayName = (String(seedName || '').trim().slice(0, 24)) || 'Player';

      const account = await storage.findOrCreateAccount({ provider: providerKey, providerId, displayName });
      // Batch 42: avatars sync on every login (names never do). Fire-and-forget.
      storage.setAvatarUrl(account.id, avatarUrl || null).catch(err => console.error(`oauth ${providerKey}: avatar sync failed:`, err.message));
      setSessionCookie(res, signSession(account.id));
      return res.redirect(302, '/?signedin=1');
    } catch (err) {
      console.error(`oauth ${providerKey}: callback error: ${err.message}`);
      return res.redirect(302, '/?auth=error');
    }
  };
}
app.get('/auth/discord/callback', oauthCallback('discord'));
app.get('/auth/google/callback', oauthCallback('google'));

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/me', async (req, res) => {
  if (!authEnabled()) return res.json({ user: null });
  const sess = readSession(req);
  if (!sess) return res.json({ user: null });
  try {
    const acct = await storage.getAccount(sess.uid);
    if (!acct) return res.json({ user: null });
    res.json({ user: { id: acct.id, displayName: acct.displayName, provider: acct.provider, avatarUrl: acct.avatarUrl || null } });
  } catch (err) {
    console.error('GET /me failed:', err.message);
    res.json({ user: null });
  }
});

app.patch('/me', async (req, res) => {
  const uid = requireUser(req, res);
  if (uid == null) return;
  const name = String((req.body || {}).displayName || '').trim();
  if (name.length < 1 || name.length > 24) return res.status(400).json({ error: 'invalid name' });
  try {
    await storage.setDisplayName(uid, name);
    const acct = await storage.getAccount(uid);
    if (!acct) return res.status(404).json({ error: 'not found' });
    res.json({ user: { id: acct.id, displayName: acct.displayName, provider: acct.provider, avatarUrl: acct.avatarUrl || null } });
  } catch (err) {
    console.error('PATCH /me failed:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/claim/preview', async (req, res) => {
  const uid = requireUser(req, res);
  if (uid == null) return;
  const deviceId = String(req.query.deviceId || '').trim().slice(0, 64);
  if (!deviceId) return res.json({ words: 0, games: 0 });
  try {
    res.json(await storage.claimPreview(deviceId));
  } catch (err) {
    console.error('GET /claim/preview failed:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/claim', async (req, res) => {
  const uid = requireUser(req, res);
  if (uid == null) return;
  const deviceId = String((req.body || {}).deviceId || '').trim().slice(0, 64);
  if (!deviceId) return res.json({ claimed: 0 });
  try {
    const r = await storage.claimDevice(deviceId, uid);
    res.json({ claimed: r.words });
  } catch (err) {
    console.error('POST /claim failed:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── Feedback (batch 41) ───────────────────────────────────────────────────────
// Works in both backends (memory saveFeedback is a no-op, route still returns
// ok). Rate limited to 5 per rolling hour per deviceId (falling back to req.ip).
const FEEDBACK_LIMIT = 5;
const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
const feedbackHits = new Map(); // key -> array of timestamps within the window
app.post('/feedback', (req, res) => {
  const body = req.body || {};
  const text = String(body.text || '').trim();
  if (text.length < 1 || text.length > 2000) return res.status(400).json({ error: 'invalid text' });
  const deviceId = body.deviceId == null ? null : String(body.deviceId).trim().slice(0, 64) || null;
  const key = deviceId || req.ip || 'unknown';
  const now = Date.now();
  // Opportunistic prune: drop keys whose newest hit fell out of the window.
  for (const [k, arr] of feedbackHits) {
    const kept = arr.filter(t => now - t < FEEDBACK_WINDOW_MS);
    if (kept.length) feedbackHits.set(k, kept); else feedbackHits.delete(k);
  }
  const hits = (feedbackHits.get(key) || []).filter(t => now - t < FEEDBACK_WINDOW_MS);
  if (hits.length >= FEEDBACK_LIMIT) return res.status(429).json({ error: 'rate limited' });
  hits.push(now);
  feedbackHits.set(key, hits);
  // Fire-and-forget, same discipline as recordWordEvent.
  storage.saveFeedback({ deviceId, text }).catch(err => console.error('feedback save failed:', err.message));
  res.json({ ok: true });
});

// ── Career (batch 42) ─────────────────────────────────────────────────────────
// Own career. A valid session makes the identity the account (the deviceId param
// is then used only for the unclaimed-words banner); otherwise it is the guest
// device. Career data is postgres-only; the memory backend returns available:false.
app.get('/career/stats', async (req, res) => {
  const sess = readSession(req);
  try {
    if (sess) {
      const acct = await storage.getAccount(sess.uid);
      if (!acct) return res.json({ available: false });
      const payload = await storage.careerStats({ userId: acct.id });
      if (!payload) return res.json({ available: false });
      const deviceId = String(req.query.deviceId || '').trim().slice(0, 64);
      let unclaimedWords = 0;
      if (deviceId) { try { unclaimedWords = (await storage.claimPreview(deviceId)).words; } catch (e) { unclaimedWords = 0; } }
      return res.json({ available: true, self: true, displayName: acct.displayName, avatarUrl: acct.avatarUrl || null, unclaimedWords, ...payload });
    }
    // Guest device career: only unclaimed rows for that device.
    const deviceId = String(req.query.deviceId || '').trim().slice(0, 64);
    if (!deviceId) return res.json({ available: false });
    const payload = await storage.careerStats({ deviceId });
    if (!payload) return res.json({ available: false });
    return res.json({ available: true, self: true, displayName: null, ...payload });
  } catch (err) {
    console.error('GET /career/stats failed:', err.message);
    return res.json({ available: false });
  }
});

// Batch 43: cheap own-rank lookup for the landing card badge (one indexed
// snapshot read, so it can run on every landing load without the full career
// query fan-out). Never exposes another identity's data.
app.get('/career/rank', async (req, res) => {
  if (storage.name !== 'postgres') return res.json({ ranked: false });
  try {
    const sess = readSession(req);
    let key = null;
    if (sess) {
      const acct = await storage.getAccount(sess.uid);
      if (acct) key = 'u:' + acct.id;
    }
    if (!key) {
      const deviceId = String(req.query.deviceId || '').trim().slice(0, 64);
      if (deviceId) key = 'd:' + deviceId;
    }
    if (!key) return res.json({ ranked: false });
    const snap = await storage.getRankSnapshot(key);
    if (!snap || !snap.skill) return res.json({ ranked: false });
    return res.json({ ranked: true, skill: snap.skill, population: snap.population });
  } catch (err) {
    console.error('GET /career/rank failed:', err.message);
    return res.json({ ranked: false });
  }
});

// Public career of an account (numeric id). No auth: this is a public page.
app.get('/career/player/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
  // Career data is postgres-only; the memory backend has no accounts to serve.
  if (storage.name !== 'postgres') return res.json({ available: false });
  const id = Number(req.params.id);
  try {
    const acct = await storage.getAccount(id);
    if (!acct) return res.status(404).json({ error: 'not found' });
    const payload = await storage.careerStats({ userId: id });
    if (!payload) return res.json({ available: false });
    return res.json({ available: true, self: false, displayName: acct.displayName, avatarUrl: acct.avatarUrl || null, ...payload });
  } catch (err) {
    console.error('GET /career/player failed:', err.message);
    return res.json({ available: false });
  }
});

// Serve the SPA for a public career URL; the client opens the career screen for
// that account on boot. Numeric ids only; placed before the /:code catch-all.
app.get('/player/:id', (req, res, next) => {
  if (/^\d+$/.test(req.params.id)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// Shareable room URLs: serve the app for any /<CODE> path (4 uppercase letters).
// The client reads the path and auto-joins that room. Other paths fall through.
app.get('/:code', (req, res, next) => {
  if (/^[A-Z]{4}$/.test(req.params.code)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// Dictionary summary
console.log(
  `Dictionary loaded: ${validWords.size} words. ` +
  `Playable prompts: 2-letter=${playablePrompts[2].length}, ` +
  `3-letter=${playablePrompts[3].length}, ` +
  `4-letter=${playablePrompts[4].length}.`
);

ensureDaily(); // build today's daily sequence up front

// Persistence boot: run migrations (pg) and print exactly one status line;
// these lines are the deploy-logs verification signal. A failed init is loud
// but non-fatal: the game keeps running, inserts fail-and-log individually.
storage.init().then(async () => {
  if (storage.name === 'postgres') {
    const c = await storage.counts();
    console.log(`persistence: postgres, word_events: ${c.wordEvents}, daily_runs: ${c.dailyRuns}`);
    startRankScheduler();
  } else {
    console.log('persistence: disabled (no DATABASE_URL)');
  }
}).catch(err => {
  console.error('persistence init failed (continuing without durable writes):', err.message);
});

// ── Rank snapshot scheduler (batch 43) ────────────────────────────────────────
// The first background job in this codebase; kept small and boring. A rebuild
// fires ~30s after boot when the last one is missing or older than 20 hours, and
// a 30-minute interval catches the UTC-date rollover so the nightly refresh lands
// within 30 minutes of midnight. A module-level guard prevents overlapping runs.
let rankRebuildRunning = false;
async function runRankRebuild(trigger) {
  if (rankRebuildRunning) { console.log(`rank snapshot: skipped (${trigger}), a rebuild is already running`); return; }
  rankRebuildRunning = true;
  const t0 = Date.now();
  try {
    const res = await storage.rebuildRankSnapshots();
    console.log(`rank snapshot: rebuilt, population ${res ? res.population : 0}, took ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`rank snapshot: rebuild failed (${trigger}):`, err.message);
  } finally {
    rankRebuildRunning = false;
  }
}
function startRankScheduler() {
  const utcDateStr = (d) => d.toISOString().slice(0, 10);
  // Boot-staleness: rebuild if never run or the last run is older than 20 hours.
  setTimeout(async () => {
    try {
      const meta = await storage.getSnapshotMeta('last_rebuild');
      const stale = !meta || !meta.at || (Date.now() - new Date(meta.at).getTime()) > 20 * 60 * 60 * 1000;
      if (stale) runRankRebuild('boot-staleness');
    } catch (err) {
      console.error('rank snapshot: boot check failed:', err.message);
    }
  }, 30 * 1000);
  // Rollover: every 30 minutes, rebuild once the UTC date has advanced past the
  // last rebuild's UTC date (lands the nightly refresh within 30 min of midnight).
  setInterval(async () => {
    try {
      const meta = await storage.getSnapshotMeta('last_rebuild');
      const lastDate = meta && meta.at ? utcDateStr(new Date(meta.at)) : null;
      if (lastDate !== utcDateStr(new Date())) runRankRebuild('utc-rollover');
    } catch (err) {
      console.error('rank snapshot: rollover check failed:', err.message);
    }
  }, 30 * 60 * 1000);
}

const rooms = {};

const DEFAULT_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3, longWordBonus: true, overtime: true, overtimeStart: 20, stringPersistence: true, mode: 'classic' };
const GAME_MODES = ['classic', 'scramble', 'sabotage']; // game objects carry the mode
const ROOM_MODES = ['classic', 'scramble'];             // modes a room can be created/set to
// Sabotage's entire config surface: server-owned, players configure nothing.
const SABOTAGE_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3, longWordBonus: true, overtime: false, overtimeStart: 20, stringPersistence: false, mode: 'sabotage' };
const READY_WINDOW_MS = 30000; // both players must ready within this window or the match aborts
const GRACE_MS = Number(process.env.BP_GRACE_MS) || 30000; // a disconnected seat is held (reconnectable) this long before removal (env-overridable for tests)

// ── Scramble mode (simultaneous rounds) ──────────────────────────────────────
// Everyone faces one shared string per round with hidden inputs; the first
// valid claim of a word locks it out for the rest of the game. At the horn the
// round reveals and non-submitters (or, on an all-submit round, the single
// lowest scorer) lose a life. These rounds ARE the cycle, so overtime shrinks
// the timer per ROUND past the threshold, not per turn-rotation cycle.
// The reveal window varies with the round's drama: a full window when there is
// a stage-2 loser sequence (all-submit round with a lowest-word loss), a short
// one otherwise (non-submitter losses already exploded at the horn, nothing to
// wait for). The client stays fully server-paced by the next round_start.
const SCRAMBLE_REVEAL_FULL_MS = 6500;  // flips, beat, loser heat-tremble-detonate
const SCRAMBLE_REVEAL_SHORT_MS = 3500; // flips + settle only
const SCRAMBLE_EARLY_HORN_MS = 1200; // beat after the last lock so it registers, then resolve
// A never-mutated empty set: lets isValidWord run its contains/dictionary/length
// checks without its used-word check, so scramble can report 'already claimed'
// as a distinct reason for a claimed word.
const EMPTY_USED = new Set();

// ── Bonus tuning ────────────────────────────────────────────────────────────
// Lower ALPHABET_GOAL (e.g. 5) temporarily to make the alphabet bonus easy to
// trigger while testing, then set back to 26.
const ALPHABET_GOAL = 26;     // distinct letters needed to complete the alphabet
const LONG_WORD_LENGTH = 12;  // word length that lights one bonus letter (host-toggleable)

// ── Overtime convergence (Feature 4, cycle-based) ────────────────────────────
// After the host-configured start round, the timer decays 0.5s per CYCLE,
// where a cycle is one turn for every player alive when the cycle began
// (eliminations shrink the next cycle). Prompt length never changes. The start
// round is a per-room setting (settings.overtimeStart); to test quickly, the
// host can simply type a low number in the pre-game panel.
const OVERTIME_MIN_TIMER = 5;     // timer never drops below this many seconds

function generateCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * 26)]).join('');
  } while (rooms[code]);
  return code;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, Number(val) || min));
}

function getRoomState(code) {
  const room = rooms[code];
  return { players: room.players, hostId: room.hostId, settings: room.settings };
}

function broadcastRoom(code) {
  io.to(code).emit('room_updated', getRoomState(code));
}

// ── Public lobby list ────────────────────────────────────────────────────────
// A lightweight snapshot of joinable public rooms for clients sitting on the
// landing page (the 'lobby' socket channel). Private rooms and empty rooms are
// omitted. Waiting rooms sort ahead of in-progress ones, then by player count.
function publicLobbyList() {
  const list = [];
  for (const [code, room] of Object.entries(rooms)) {
    // Private rooms are already excluded by !room.isPublic; hidden sabotage
    // match rooms are excluded explicitly too (they are also isPublic:false).
    if (room.hidden || !room.isPublic || !room.players.length) continue;
    const host = room.players.find(p => p.id === room.hostId);
    list.push({
      code,
      hostName: host ? host.name : '?',
      playerCount: room.players.length,
      inProgress: !!(room.game && room.game.started),
      settings: {
        timerDuration: room.settings.timerDuration,
        startingLives: room.settings.startingLives,
        stringLength: room.settings.stringLength,
        mode: room.settings.mode, // batch 28 badges rooms by mode
      },
    });
  }
  list.sort((a, b) =>
    (a.inProgress - b.inProgress) ||
    (b.playerCount - a.playerCount) ||
    a.code.localeCompare(b.code));
  return list;
}

function broadcastLobby() {
  io.to('lobby').emit('lobby_update', publicLobbyList());
}

// Mark a room as recently active so the idle sweep leaves it alone.
function touch(code) {
  if (rooms[code]) rooms[code].lastActivity = Date.now();
}

// Remove a player (by socket id) from a room, mirroring disconnect cleanup:
// pull them from a running game (turn handoff or end), drop their seat, transfer
// host if needed, and delete the room if it becomes empty. Returns true if the
// room still exists afterward. Does NOT broadcast; the caller decides.
function removePlayerFromRoom(code, socketId) {
  const room = rooms[code];
  if (!room) return false;
  const wasHost = room.hostId === socketId;

  // Remove from a running game so the rotation never targets a ghost.
  const game = room.game;
  if (game && game.started && game.mode === 'scramble') {
    // No rotation to repair. Drop the player and any pending submission; their
    // claimed word stays claimed in usedWords (a claim is permanent). If this
    // leaves 1 or 0 alive, end now (clearTurnTimer inside endGame cancels the
    // pending round/reveal timeout). A departure during 'reveal' just drops
    // them before the pending advance starts the next round.
    const gi = game.players.findIndex(p => p.id === socketId);
    if (gi !== -1) {
      game.players.splice(gi, 1);
      game.roundSubs.delete(socketId);
      const alive = game.players.filter(p => p.lives > 0);
      if (alive.length <= 1) endGame(code, alive[0] || null);
    }
  } else if (game && game.started) {
    const gi = game.players.findIndex(p => p.id === socketId);
    if (gi !== -1) {
      const wasCurrent = gi === game.currentIndex;
      game.players.splice(gi, 1);
      if (gi < game.currentIndex) game.currentIndex--;

      const alive = game.players.filter(p => p.lives > 0);
      if (alive.length <= 1) {
        endGame(code, alive[0] || null);
      } else if (wasCurrent) {
        const n = game.players.length;
        game.currentIndex = nextAliveIndex(game, (gi - 1 + n) % n);
        startTurn(code);
      }
    }
  }

  room.players = room.players.filter(p => p.id !== socketId);
  if (room.players.length === 0) {
    if (room.game) clearTurnTimer(room.game);
    delete rooms[code];
    console.log(`Room ${code} closed (empty)`);
    return false;
  }
  if (wasHost) {
    room.hostId = room.players[0].id;
    console.log(`Host transferred in room ${code} to ${room.players[0].name}`);
  }
  return true;
}

// The post-pendingMatch body of the disconnect handler, shared verbatim by an
// immediate removal (lobby member / spectator) and a grace expiry, so the two
// paths are identical: splice + endgame checks + host handoff + empty close,
// then the broadcasts.
function finalizeRemoval(code, socketId) {
  const wasSabotage = code && rooms[code] && rooms[code].game && rooms[code].game.mode === 'sabotage';
  if (code && rooms[code]) {
    const stillExists = removePlayerFromRoom(code, socketId);
    if (stillExists) broadcastRoom(code);
    broadcastLobby(); // player count changed, or the room closed
  }
  if (wasSabotage) broadcastSabotageOnline();
}

// Grace window elapsed with no rebind: run the original removal. Defensive - a
// timer that fires after the game ended, after a rebind, or into a different
// game is a no-op.
function expireGrace(code, socketId, gameId) {
  const room = rooms[code];
  if (!room || !room.game || room.game.gameId !== gameId) return; // game ended / replaced
  const seat = room.game.players.find(p => p.id === socketId);
  if (!seat || !seat.disconnectedAt) return; // rebound (id changed) or already gone
  finalizeRemoval(code, socketId);
  console.log(`grace expired: removed ${socketId} from ${code}`);
}

// The full in-game snapshot a rebinding player needs to reconstruct its view.
// One shape for all modes; fields the mode does not use are null / []. Scramble
// NEVER exposes a word, points, or tier (secrecy is a hard correctness rule):
// only the set of submitter ids.
function buildRejoinState(game, seat) {
  const mode = game.mode;
  const players = game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives }));
  const eliminatedIds = game.players.filter(p => p.lives <= 0).map(p => p.id);
  const effTimer = game.effTimer || game.settings.timerDuration;
  const state = {
    mode,
    round: game.round,
    players,
    eliminatedIds,
    myAlphabet: mode === 'sabotage' ? [] : [...seat.alphabet], // sabotage strip is restriction-only
    overtime: { active: !!game.overtimeActive, timer: effTimer },
    // classic / sabotage fields
    currentId: null,
    prompt: null,
    remainingMs: null,
    disabledLetters: [],
    // scramble fields
    phase: null,
    submittedIds: null,
    iSubmitted: null,
  };
  if (mode === 'scramble') {
    const elapsed = Date.now() - (game.roundStartedAt || Date.now());
    state.phase = game.phase;
    state.prompt = game.prompt; // the prompt is public; only submissions are secret
    state.remainingMs = Math.max(0, effTimer * 1000 - elapsed);
    state.submittedIds = [...game.roundSubs.keys()];
    state.iSubmitted = game.roundSubs.has(seat.id);
  } else {
    const current = game.players[game.currentIndex];
    const elapsed = Date.now() - (game.turnStartedAt || Date.now());
    state.currentId = current ? current.id : null;
    state.prompt = game.prompt;
    state.remainingMs = Math.max(0, effTimer * 1000 - elapsed);
    state.disabledLetters = mode === 'sabotage' ? [...(game.currentRestriction || [])].sort() : [];
  }
  return state;
}

// Rebind a held (graced) seat to a reconnecting socket. Re-keys every id-keyed
// server structure so play continues seamlessly.
function rebindSeat(code, seat, socket) {
  const room = rooms[code];
  const game = room.game;
  const oldId = seat.id;
  const newId = socket.id;
  if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
  seat.disconnectedAt = null;
  // Re-key: game seat, room.players entry, hostId.
  seat.id = newId;
  // Batch 42: the rebinding socket's identity wins - the same human may have
  // signed in between disconnect and reconnect. Guests (null) leave it null.
  seat.userId = socket.data.uid ?? null;
  const rp = room.players.find(p => p.id === oldId);
  if (rp) { rp.id = newId; rp.disconnectedAt = null; rp.userId = socket.data.uid ?? null; }
  if (room.hostId === oldId) room.hostId = newId;
  // Re-key: scramble roundSubs (a pre-disconnect submission survives).
  if (game.roundSubs && game.roundSubs.has(oldId)) {
    game.roundSubs.set(newId, game.roundSubs.get(oldId));
    game.roundSubs.delete(oldId);
  }
  // Re-key: wordSubmitters values (self-vote block) and voters set.
  if (game.wordSubmitters) {
    for (const [w, id] of game.wordSubmitters) if (id === oldId) game.wordSubmitters.set(w, newId);
  }
  if (game.voters && game.voters.has(oldId)) { game.voters.delete(oldId); game.voters.add(newId); }
  // Wire the new socket to the room. The SEAT name wins (no mid-game renames).
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.name = seat.name;
  socket.emit('room_joined', { code, socketId: newId, mode: room.settings.mode });
  io.to(code).emit('seat_rebound', { oldId, newId, name: seat.name });
  socket.emit('rejoin_state', buildRejoinState(game, seat));
  broadcastRoom(code);
  if (game.mode === 'sabotage') broadcastSabotageOnline();
  console.log(`${seat.name} reconnected to room ${code} (rebind)`);
}

// ── Game turn loop ──────────────────────────────────────────────────────────

function clearTurnTimer(game) {
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }
}

// First alive player strictly after fromIndex, wrapping. -1 if none alive.
function nextAliveIndex(game, fromIndex) {
  const n = game.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    if (game.players[idx].lives > 0) return idx;
  }
  return -1;
}

function startTurn(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const game = room.game;
  clearTurnTimer(game);

  if (game.players.length < 1) {
    // Fail safe: no one left to take a turn - end the game cleanly.
    room.game = null;
    return;
  }
  if (game.currentIndex >= game.players.length) game.currentIndex = 0;
  // Fail safe: never hand the turn to an eliminated player.
  if (game.players[game.currentIndex].lives <= 0) {
    const idx = nextAliveIndex(game, game.currentIndex);
    if (idx === -1) {
      endGame(code, null);
      return;
    }
    game.currentIndex = idx;
  }

  game.round += 1;
  game.turnAttempts = 0;

  // Sabotage: consume the restriction created by the previous valid submission.
  // It applies to exactly this turn, then is gone.
  const isSabotage = game.mode === 'sabotage';
  if (isSabotage) {
    game.currentRestriction = game.pendingRestriction;
    game.pendingRestriction = null;
  }

  // ── Overtime (Feature 4): the timer decays 0.5s per cycle, a cycle being
  // one turn for every player alive when it started. Prompt length is
  // settings.stringLength forever. Inert in sabotage (forced off here, not by
  // mutating settings). ──
  const otEnabled = !isSabotage && !!game.settings.overtime;
  const inOvertime = otEnabled && game.round > game.settings.overtimeStart;
  const aliveNow = game.players.filter(p => p.lives > 0).length;
  if (inOvertime && !game.otCycle) {
    game.otCycle = { length: Math.max(1, aliveNow), turns: 0, decrements: 0 };
  }
  const effTimer = inOvertime
    ? Math.max(OVERTIME_MIN_TIMER, game.settings.timerDuration - 0.5 * game.otCycle.decrements)
    : game.settings.timerDuration;
  if (inOvertime) {
    // Count this turn against the cycle AFTER computing its timer, so the
    // first shortened turn arrives once everyone has had one at the old speed.
    game.otCycle.turns += 1;
    if (game.otCycle.turns >= game.otCycle.length) {
      game.otCycle.decrements += 1;
      game.otCycle.turns = 0;
      game.otCycle.length = Math.max(1, aliveNow); // eliminations shrink the next cycle
    }
  }

  if (inOvertime && !game.overtimeAnnounced) {
    game.overtimeAnnounced = true;
    io.to(code).emit('overtime:start');
  }

  // String persistence: a failed prompt passes along with a fresh fuse until
  // someone solves it or every alive player has faced it (see onTurnTimeout).
  // Sabotage skips persistence and generates a prompt solvable under the
  // current restriction instead.
  if (isSabotage) {
    game.prompt = generateSabotagePrompt(game.settings.stringLength, game.currentRestriction || new Set());
  } else if (game.settings.stringPersistence && game.persist) {
    game.prompt = game.persist.prompt;
  } else {
    game.prompt = generatePrompt(game.settings.stringLength);
  }
  game.turnStartedAt = Date.now();
  game.effTimer = effTimer;         // mirrored by rejoin_state remainingMs
  game.overtimeActive = inOvertime; // mirrored by rejoin_state overtime
  const current = game.players[game.currentIndex];

  io.to(code).emit('turn_start', {
    currentId: current.id,
    currentName: current.name,
    prompt: game.prompt,
    players: game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives })),
    duration: effTimer,
    round: game.round,
    overtime: { active: inOvertime, timer: effTimer },
    mode: game.mode, // turn_start did not carry mode before; the client reads it for sabotage
    disabledLetters: isSabotage ? [...(game.currentRestriction || [])].sort() : [],
  });

  game.turnTimer = setTimeout(() => onTurnTimeout(code), effTimer * 1000);
}

// Track the game's most contested prompt under string persistence: the prompt
// that took the most lives (2+), with the player who finally solved it (null
// when it retired unsolved).
function recordContestedPrompt(game, solverName) {
  const rec = game.persist;
  if (!rec || rec.livesTaken < 2) return;
  if (!game.mostContestedPersist || rec.livesTaken > game.mostContestedPersist.livesTaken) {
    game.mostContestedPersist = { prompt: rec.prompt, livesTaken: rec.livesTaken, solver: solverName };
  }
}

function onTurnTimeout(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const game = room.game;
  game.turnTimer = null;

  const current = game.players[game.currentIndex];
  current.lives = Math.max(0, current.lives - 1);
  current.stats.livesLost += 1;
  current.stats.currentStreak = 0; // a timeout breaks the valid-word streak
  // Batch 43: the bomb exploded on this player's turn - a miss for the safety meter.
  storage.recordTurnMiss({
    mode: game.mode === 'sabotage' ? 'sabotage' : 'multiplayer',
    deviceId: current.deviceId, userId: current.userId, gameId: game.gameId,
  }).catch(err => console.error('turn_miss insert failed:', err.message));

  // Sabotage: a timeout plays no word, so the opponent gets a clean next turn.
  if (game.mode === 'sabotage') game.pendingRestriction = null;

  // String persistence: the failed prompt passes to the next player. It
  // retires when every currently alive player has faced it (checked after
  // the life loss above). Inert in sabotage (life_lost then carries exampleWord
  // to everyone via the non-persistence branch below).
  const persistence = game.mode !== 'sabotage' && !!game.settings.stringPersistence;
  let retired = null;
  if (persistence) {
    if (!game.persist || game.persist.prompt !== game.prompt) {
      game.persist = { prompt: game.prompt, facedBy: new Set(), livesTaken: 0 };
    }
    game.persist.facedBy.add(current.id);
    game.persist.livesTaken += 1;
    const aliveNow = game.players.filter(p => p.lives > 0);
    if (aliveNow.every(p => game.persist.facedBy.has(p.id))) retired = game.persist;
  }

  const basePayload = {
    playerId: current.id,
    playerName: current.name,
    lives: current.lives,
    eliminated: current.lives === 0,
  };
  if (!persistence) {
    // Everyone may see the answer: the string dies with this turn.
    io.to(code).emit('life_lost', { ...basePayload, exampleWord: exampleWordFor(game.prompt, game.usedWords) });
  } else if (retired) {
    // The retire reveal below shows everyone the answer; no private copy needed.
    io.to(code).emit('life_lost', basePayload);
  } else {
    // The string passes on: reveal the answer ONLY to the player who failed,
    // so the next player is not spoiled.
    io.to(code).except(current.id).emit('life_lost', basePayload);
    io.to(current.id).emit('life_lost', { ...basePayload, exampleWord: exampleWordFor(game.prompt, game.usedWords) });
  }

  if (retired) {
    // Group payoff: the string is dead, so the answer spoils nothing.
    io.to(code).emit('prompt:retired', {
      prompt: retired.prompt,
      exampleWord: exampleWordFor(retired.prompt, game.usedWords),
    });
    recordContestedPrompt(game, null); // retired unsolved
    game.persist = null;
  }

  const alive = game.players.filter(p => p.lives > 0);
  if (alive.length <= 1) {
    endGame(code, alive[0] || null);
    return;
  }
  game.currentIndex = nextAliveIndex(game, game.currentIndex);
  startTurn(code);
}

function endGame(code, winner) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const game = room.game;
  const wasSabotage = game.mode === 'sabotage';
  clearTurnTimer(game);
  // Any held grace timers on this game's seats must not fire after game end.
  for (const p of game.players) { if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; } }

  // A passed prompt still live at game end counts as unsolved. Classic only;
  // scramble and sabotage have no string persistence (never read the setting).
  if (game.mode === 'classic' && game.settings.stringPersistence) {
    recordContestedPrompt(game, null);
    game.persist = null;
  }

  const allWords = [];
  for (const p of game.players) {
    for (const w of p.stats.words) allWords.push({ ...w, player: p.name });
  }
  const totalWords = allWords.length;
  const longestWord = allWords.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
  const fastestAnswer = allWords.reduce((a, b) => (!a || b.timeMs < a.timeMs ? b : a), null);
  const avgAnswerTimeMs = totalWords
    ? Math.round(allWords.reduce((s, w) => s + w.timeMs, 0) / totalWords)
    : null;
  const avgWordLength = totalWords
    ? Number((allWords.reduce((s, w) => s + w.length, 0) / totalWords).toFixed(1))
    : null;
  let mostExtraLives = null;
  for (const p of game.players) {
    if (p.stats.extraLives > 0 && (!mostExtraLives || p.stats.extraLives > mostExtraLives.count)) {
      mostExtraLives = { player: p.name, count: p.stats.extraLives };
    }
  }
  const lastEntry = winner && winner.stats.words.length
    ? winner.stats.words[winner.stats.words.length - 1]
    : null;

  // Per-player stats so each client can show its own numbers on the end screen
  const statsByPlayer = {};
  for (const p of game.players) {
    const words = p.stats.words;
    const longest = words.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
    const fastest = words.reduce((a, b) => (!a || b.timeMs < a.timeMs ? b : a), null);
    statsByPlayer[p.id] = {
      longestWord: longest ? longest.word : null,
      fastestAnswer: fastest ? { word: fastest.word, timeMs: fastest.timeMs } : null,
      avgAnswerTimeMs: words.length
        ? Math.round(words.reduce((s, w) => s + w.timeMs, 0) / words.length)
        : null,
      avgWordLength: words.length
        ? Number((words.reduce((s, w) => s + w.length, 0) / words.length).toFixed(1))
        : null,
      totalWords: words.length,
      extraLives: p.stats.extraLives,
      accountId: p.userId ?? null, // batch 42: makes the postgame name clickable
    };
  }

  io.to(code).emit('game_over', {
    mode: game.mode, // 'classic' | 'scramble'; batch 28 restyles per mode
    winner: winner ? { id: winner.id, name: winner.name, accountId: winner.userId ?? null } : null,
    winningWord: lastEntry ? { word: lastEntry.word, prompt: lastEntry.prompt } : null,
    statsByPlayer,
    stats: {
      longestWord: longestWord ? { word: longestWord.word, player: longestWord.player } : null,
      fastestAnswer: fastestAnswer
        ? { word: fastestAnswer.word, player: fastestAnswer.player, timeMs: fastestAnswer.timeMs }
        : null,
      avgAnswerTimeMs,
      avgWordLength,
      totalWords,
      mostExtraLives,
    },
  });

  // ── Detailed end-of-game stats (Feature 2) + word of the game (Feature 3) ──
  let topWord = null; // single highest-scoring word of the whole game
  const gameTiers = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 }; // for the [tiers] log
  const endPlayers = game.players.map(p => {
    const valid = p.stats.words;
    const times = valid.map(w => w.timeMs);
    const longest = valid.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
    // Tier breakdown + the player's single rarest word (Feature 5 award)
    const tierCounts = { COMMON: 0, UNCOMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
    // Genuinely rarest word by the new system: highest rarityScore wins (this
    // also yields the highest tier present, with finer within-tier resolution).
    let rarest = null, rarestScore = -1;
    // Per-player highlight: best word by getWordScore. The game-wide best feeds topWord.
    let best = null, bestScore = -1;
    for (const w of valid) {
      const t = w.tier || 'COMMON';
      tierCounts[t]++;
      gameTiers[t]++;
      const rs = rarityScore(w.word);
      if (rs > rarestScore) { rarestScore = rs; rarest = { word: w.word, tier: t }; }
      const sc = getWordScore(w.word);
      if (sc > bestScore) { bestScore = sc; best = { word: w.word, tier: t, score: sc }; }
      if (!topWord || sc > topWord.score) topWord = { word: w.word, tier: t, score: sc, player: p.name };
    }
    return {
      id: p.id,
      name: p.name,
      accountId: p.userId ?? null, // batch 42: clickable public-career name
      livesRemaining: p.lives,
      totalValid: valid.length,
      totalInvalid: p.stats.submissions.filter(s => !s.valid).length,
      longestWord: longest ? longest.word : null,
      fastestMs: times.length ? Math.min(...times) : null,
      slowestMs: times.length ? Math.max(...times) : null,
      avgMs: times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null,
      livesLost: p.stats.livesLost,
      livesGained: p.stats.extraLives,
      alphabetCompletions: p.stats.extraLives,
      longWordBonuses: p.stats.longWordBonuses,
      longestStreak: p.stats.longestStreak,
      tierCounts,
      rarestTier: rarest ? rarest.tier : 'COMMON',
      rarestWord: rarest ? rarest.word : null,
      bestWord: best, // { word, tier, score } | null
    };
  });
  // Word of the Game: most voted word with tier and submitter for the header
  // row (explicit null when nothing got a vote).
  let wordOfGame = null;
  for (const [w, votes] of Object.entries(game.wordVotes)) {
    if (!wordOfGame || votes > wordOfGame.votes) wordOfGame = { word: w, votes };
  }
  if (wordOfGame) {
    wordOfGame.tier = getWordTier(wordOfGame.word);
    const submitterId = game.wordSubmitters.get(wordOfGame.word);
    const submitterP = game.players.find(p => p.id === submitterId);
    wordOfGame.submitter = submitterP ? submitterP.name : null;
  }
  io.to(code).emit('stats:end', {
    mode: game.mode, // 'classic' | 'scramble'
    winner: winner ? { id: winner.id, name: winner.name, accountId: winner.userId ?? null } : null,
    winningWord: lastEntry ? { word: lastEntry.word, prompt: lastEntry.prompt, tier: lastEntry.tier } : null,
    players: endPlayers,
    records: {
      longestWord: longestWord ? { word: longestWord.word, player: longestWord.player } : null,
      fastestAnswer: fastestAnswer
        ? { word: fastestAnswer.word, player: fastestAnswer.player, timeMs: fastestAnswer.timeMs }
        : null,
      // Persistence upgrade: a prompt that took 2+ lives outranks the old
      // retry-count semantics; otherwise fall back to them. Both are null on
      // the scramble path (turn-mode concepts), so this is null there.
      mostContested: game.mostContestedPersist || game.mostContested || null,
    },
    topWord, // highest-scoring word of the game: { word, tier, score, player }
    wordOfGame,
  });

  // Tier distribution of the game, for later calibration from live logs.
  console.log(`[tiers] room=${code} words=${totalWords} C=${gameTiers.COMMON} U=${gameTiers.UNCOMMON} R=${gameTiers.RARE} E=${gameTiers.EPIC} L=${gameTiers.LEGENDARY}`);

  // Back to lobby state so the host can start a fresh game.
  room.game = null;
  broadcastRoom(code);
  broadcastLobby(); // clear the in-progress badge in the public list
  if (wasSabotage) broadcastSabotageOnline(); // the two players are no longer in an active match
  console.log(`Game over in room ${code}. Winner: ${winner ? winner.name : 'none'}`);
}

// ── Scramble round loop ──────────────────────────────────────────────────────
// Simultaneous rounds instead of a turn rotation. One shared prompt, hidden
// inputs, first valid claim locks a word out of the whole game, reveal at the
// horn, non-submitters (or the single lowest scorer on an all-submit round)
// lose a life. Uses game.turnTimer as its timer so all the classic teardown
// paths (clearTurnTimer, room sweep) clean it up unchanged.

function startScrambleRound(code) {
  const room = rooms[code];
  if (!room || !room.game || room.game.mode !== 'scramble') return;
  const game = room.game;
  clearTurnTimer(game);

  const alive = game.players.filter(p => p.lives > 0);
  if (alive.length <= 1) { endGame(code, alive[0] || null); return; }

  game.round += 1;
  game.phase = 'round';
  game.roundSubs = new Map();

  // Overtime, simultaneous version: rounds ARE the cycle, so the timer shrinks
  // 0.5s per round past the threshold, floored at OVERTIME_MIN_TIMER. This
  // deliberately replaces the classic per-turn-cycle decay.
  const roundsPast = Math.max(0, game.round - game.settings.overtimeStart);
  const inOvertime = !!game.settings.overtime && roundsPast > 0;
  const effTimer = Math.max(OVERTIME_MIN_TIMER,
    game.settings.timerDuration - 0.5 * (inOvertime ? roundsPast : 0));
  // Announce the first time the timer actually shrinks below the base.
  if (inOvertime && effTimer < game.settings.timerDuration && !game.overtimeAnnounced) {
    game.overtimeAnnounced = true;
    io.to(code).emit('overtime:start');
  }

  game.prompt = generatePrompt(game.settings.stringLength);
  game.roundStartedAt = Date.now();
  game.effTimer = effTimer;         // mirrored by rejoin_state remainingMs
  game.overtimeActive = inOvertime; // mirrored by rejoin_state overtime

  io.to(code).emit('round_start', {
    prompt: game.prompt,
    duration: effTimer,
    round: game.round,
    overtime: { active: inOvertime, timer: effTimer },
  });

  // Exactly the effective timer, no grace (timer discipline is a final decision).
  game.turnTimer = setTimeout(() => onScrambleTimeout(code), effTimer * 1000);
}

function onScrambleTimeout(code) {
  const room = rooms[code];
  if (!room || !room.game || room.game.mode !== 'scramble') return;
  const game = room.game;
  game.turnTimer = null;
  game.phase = 'reveal';

  // Snapshot the field entering resolution (before any life loss).
  const alive = game.players.filter(p => p.lives > 0);
  const nonSubmitters = alive.filter(p => !game.roundSubs.has(p.id));
  // Batch 43: every living player who converted nothing this round missed it.
  for (const p of nonSubmitters) {
    storage.recordTurnMiss({
      mode: 'scramble', deviceId: p.deviceId, userId: p.userId, gameId: game.gameId,
    }).catch(err => console.error('turn_miss insert failed:', err.message));
  }

  let losers;
  if (nonSubmitters.length > 0) {
    // Anyone who missed the horn loses a life.
    losers = nonSubmitters;
  } else {
    // Everyone alive submitted: exactly one loses - the lowest points, ties
    // broken by the LATER submission (earlier submission survives; this is the
    // only place speed decides anything).
    let worst = null;
    for (const p of alive) {
      const sub = game.roundSubs.get(p.id);
      if (!worst || sub.points < worst.sub.points ||
          (sub.points === worst.sub.points && sub.ms > worst.sub.ms)) {
        worst = { p, sub };
      }
    }
    losers = worst ? [worst.p] : [];
  }

  const eliminated = [];
  for (const p of losers) {
    p.lives = Math.max(0, p.lives - 1);
    p.stats.livesLost += 1;
    p.stats.currentStreak = 0;
    if (p.lives === 0) eliminated.push(p.id);
    io.to(code).emit('life_lost', {
      playerId: p.id, playerName: p.name, lives: p.lives, eliminated: p.lives === 0,
    });
  }

  // Words become public NOW: build the reveal from every submission this round
  // (including a just-eliminated submitter), and feed wordSubmitters so votes
  // can attribute them. Nothing carried a word before this point.
  const submissions = [];
  for (const [pid, sub] of game.roundSubs) {
    const p = game.players.find(x => x.id === pid);
    if (!p) continue; // left mid-round; their claim stays in usedWords
    game.wordSubmitters.set(sub.word, pid);
    submissions.push({ id: pid, name: p.name, word: sub.word, points: sub.points, tier: sub.tier, ms: sub.ms });
  }
  submissions.sort((a, b) => b.points - a.points || a.ms - b.ms);

  io.to(code).emit('round_reveal', {
    round: game.round,
    prompt: game.prompt,
    submissions,
    losers: losers.map(p => ({ id: p.id, name: p.name })),
    nonSubmitters: nonSubmitters.map(p => p.id),
    lives: game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives })),
    eliminated,
  });

  // After the reveal pause: advance, or end. The window is full only when a
  // stage-2 loser sequence will play (all-submit round with a lowest-word loss);
  // otherwise it is short. Reuse game.turnTimer so teardown never leaks it.
  const hasLoserSequence = nonSubmitters.length === 0 && losers.length > 0;
  const revealMs = hasLoserSequence ? SCRAMBLE_REVEAL_FULL_MS : SCRAMBLE_REVEAL_SHORT_MS;
  game.turnTimer = setTimeout(() => {
    const r = rooms[code];
    if (!r || !r.game || r.game.mode !== 'scramble') return;
    r.game.turnTimer = null;
    const stillAlive = r.game.players.filter(p => p.lives > 0);
    if (stillAlive.length > 1) startScrambleRound(code);
    else endGame(code, stillAlive[0] || null); // 1 = winner, 0 = null (double KO)
  }, revealMs);
}

// A scramble submission from any alive, unlocked player during the round.
// Server-side validation and claiming only; the client is never trusted.
function handleScrambleSubmit(code, socket, word) {
  const room = rooms[code];
  const game = room.game;
  if (game.phase !== 'round') return; // not accepting between rounds / during reveal
  const player = game.players.find(p => p.id === socket.id);
  if (!player || player.lives <= 0) return; // must be an alive in-game player
  if (typeof word !== 'string') return;
  const normalized = word.trim().toLowerCase();
  if (!normalized) return;
  touch(code);

  const reject = (reason) => {
    socket.emit('word_rejected', {
      playerId: player.id, playerName: player.name, word: normalized, reason,
    });
    storage.recordWordRejection({
      mode: 'scramble', deviceId: player.deviceId, userId: player.userId, gameId: game.gameId,
      word: normalized, reason,
    }).catch(err => console.error('word_rejection insert failed:', err.message));
  };

  // Already locked this round? (does not consume the try; a rejection never locks)
  if (game.roundSubs.has(player.id)) { reject('already submitted'); return; }

  // Validation order: contains prompt, in dictionary, min length (via isValidWord
  // against an empty set), then the claim check with its own 'already claimed'.
  const base = isValidWord(normalized, game.prompt, EMPTY_USED);
  if (!base.valid) { reject(base.reason); return; }
  if (game.usedWords.has(normalized)) { reject('already claimed'); return; }

  // Valid: FINAL for the round. Claim the word immediately (locks it game-wide).
  game.usedWords.add(normalized);
  const ms = Date.now() - game.roundStartedAt;
  const tier = getWordTier(normalized);
  const points = getWordScore(normalized);
  game.roundSubs.set(player.id, { word: normalized, points, tier, ms });

  const firstTimeThisGame = !room.playedWords.has(normalized);
  room.playedWords.add(normalized);

  // Same per-player stats classic updates on an accept.
  player.stats.words.push({ word: normalized, length: normalized.length, timeMs: ms, prompt: game.prompt, tier });
  player.stats.answerTimes.push(ms);
  player.stats.submissions.push({ word: normalized, valid: true, timeToAnswer: ms, turnNumber: game.round });
  player.stats.currentStreak += 1;
  if (player.stats.currentStreak > player.stats.longestStreak) {
    player.stats.longestStreak = player.stats.currentStreak;
  }

  // Persistence spine: fire-and-forget, same as classic.
  storage.recordWordEvent({
    mode: 'scramble', deviceId: player.deviceId, userId: player.userId, gameId: game.gameId,
    round: game.round, word: normalized, tier, points, ms,
  }).catch(err => console.error('word_event insert failed:', err.message));

  // Alphabet mechanic, identical to classic per accepted word.
  for (const ch of normalized) {
    if (ch >= 'a' && ch <= 'z') player.alphabet.add(ch);
  }
  let bonusLetter = null;
  if (game.settings.longWordBonus && normalized.length >= LONG_WORD_LENGTH) {
    const unlit = [];
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      if (!player.alphabet.has(ch)) unlit.push(ch);
    }
    if (unlit.length) {
      bonusLetter = unlit[Math.floor(Math.random() * unlit.length)];
      player.alphabet.add(bonusLetter);
      player.stats.longWordBonuses += 1;
    }
  }
  let gainedLife = false;
  if (player.alphabet.size >= ALPHABET_GOAL) {
    player.lives += 1;
    player.stats.extraLives += 1;
    player.alphabet = new Set();
    gainedLife = true;
  }

  // ── Secrecy (hard rule): the submitter alone learns their own word. The
  // room hears only that this player is locked, with no word content. ──
  socket.emit('word_accepted', {
    playerId: player.id,
    playerName: player.name,
    word: normalized,
    tier,
    score: points,
    prompt: game.prompt,
    firstTimeThisGame,
  });
  io.to(code).emit('player_submitted', { id: player.id });

  // Alphabet emissions: the strip and the long-word bonus letter are the
  // submitter's private business in scramble (revealing "someone found a 12+
  // word" mid-round is unwanted noise), so letter_bonus goes only to them. A
  // +1 life is material public state, so alphabet_bonus stays broadcast.
  socket.emit('alphabet_update', { letters: [...player.alphabet] });
  if (bonusLetter) {
    socket.emit('letter_bonus', { playerId: player.id, playerName: player.name, letter: bonusLetter });
  }
  if (gainedLife) {
    io.to(code).emit('alphabet_bonus', { playerId: player.id, playerName: player.name, lives: player.lives });
  }

  // Early horn: once every alive player is locked, the rest of the timer is
  // dead air. Cancel the natural round timeout and, after a short beat so the
  // final submission visibly registers, run the exact same resolution path.
  // The beat reuses game.turnTimer (the tracked slot) so teardown can never
  // leak it; a disconnect during the beat just resolves with the submissions
  // as they stand.
  if (game.phase === 'round') {
    const alive = game.players.filter(p => p.lives > 0);
    if (alive.length > 0 && alive.every(p => game.roundSubs.has(p.id))) {
      clearTurnTimer(game);
      game.turnTimer = setTimeout(() => onScrambleTimeout(code), SCRAMBLE_EARLY_HORN_MS);
    }
  }
}

// Build and start a game from a room that has already passed its guards (>= 2
// inGame players, not already started). Reads everything from the room; takes
// no socket, so both the host-started start_game handler and sabotage
// matchmaking start games identically. Host-started classic/scramble behavior
// is byte-identical to before the extraction (the regression suites are proof).
function beginGame(code) {
  const room = rooms[code];
  if (!room) return;
  const gamePlayers = room.players.filter(p => p.inGame);

  // Per-player game seats: identical shape for both modes (same stats object,
  // alphabet Set, deviceId) so all shared postgame/stats code reads them the
  // same way.
  const seats = gamePlayers.map(p => ({
    id: p.id,
    name: p.name,
    deviceId: p.deviceId || null,
    userId: p.userId ?? null, // batch 42: write-time identity for word_events
    lives: room.settings.startingLives,
    alphabet: new Set(),
    stats: {
      words: [],          // valid words: {word, length, timeMs, prompt}
      submissions: [],     // every attempt: {word, valid, timeToAnswer, turnNumber}
      answerTimes: [],
      extraLives: 0,       // alphabet completions = lives gained
      longWordBonuses: 0,
      livesLost: 0,
      currentStreak: 0,
      longestStreak: 0,
    },
  }));
  const mode = GAME_MODES.includes(room.settings.mode) ? room.settings.mode : 'classic';

  if (mode === 'scramble') {
    room.game = {
      started: true,
      gameId: randomUUID(),
      mode: 'scramble',
      settings: { ...room.settings },
      usedWords: new Set(),   // every claimed word this game (prior rounds + this one)
      players: seats,
      round: 0,
      turnTimer: null,        // reused as the round / reveal timer, so clearTurnTimer catches it
      wordVotes: {},          // word -> vote count (populated at reveal, then votes)
      voters: new Set(),
      wordSubmitters: new Map(), // word -> submitter id (populated at reveal)
      overtimeAnnounced: false,
      // ── scramble-specific state ──
      phase: 'round',         // 'round' | 'reveal'
      roundStartedAt: null,
      roundSubs: new Map(),   // socketId -> { word, points, tier, ms }; first valid locks
    };
    io.to(code).emit('game_start');
    broadcastLobby();
    console.log(`Game started in room ${code} (scramble)`);
    startScrambleRound(code);
    return;
  }

  // Sabotage rides the CLASSIC game shape (startTurn / onTurnTimeout / classic
  // submit path). It adds the restriction lifecycle fields; overtime and
  // string persistence are forced inert by branching in the loop, never by
  // mutating the saved settings (settings must round-trip unchanged).
  room.game = {
    started: true,
    gameId: randomUUID(), // one id per game instance, for word events
    mode, // 'classic' | 'sabotage' (scramble returned above)
    settings: { ...room.settings },
    usedWords: new Set(),
    players: seats,
    currentIndex: Math.floor(Math.random() * gamePlayers.length),
    prompt: null,
    turnTimer: null,
    turnStartedAt: null,
    round: 0,
    turnAttempts: 0,         // invalid attempts in the current turn (for "most contested")
    mostContested: null,     // { word, player, attempts }
    wordVotes: {},           // word -> vote count ("Word of the Game")
    voters: new Set(),       // socket ids that have spent their one vote
    wordSubmitters: new Map(), // word -> submitting socket id (blocks self-votes)
    overtimeAnnounced: false, // has overtime:start fired this game?
    otCycle: null,           // overtime decay cycle { length, turns, decrements }
    persist: null,           // live passed-prompt record { prompt, facedBy, livesTaken }
    mostContestedPersist: null, // most lives taken by one prompt (2+): { prompt, livesTaken, solver }
    pendingRestriction: null,   // sabotage: letters the NEXT turn will consume (Set | null)
    currentRestriction: null,   // sabotage: letters active for the turn in progress
  };

  io.to(code).emit('game_start');
  broadcastLobby(); // flip the in-progress badge in the public list
  console.log(`Game started in room ${code}${mode === 'sabotage' ? ' (sabotage)' : ''}`);
  startTurn(code);
}

// ── Sabotage matchmaking ─────────────────────────────────────────────────────
// A single global FIFO queue. Press one button, get paired with whoever else is
// searching, the game starts immediately with a fixed server-owned config. No
// lobby, no settings, no room codes.
const sabotageQueue = []; // { socketId, name, deviceId, joinedAt }

function sabotageQueueRemove(socketId) {
  const i = sabotageQueue.findIndex(e => e.socketId === socketId);
  if (i !== -1) { sabotageQueue.splice(i, 1); return true; }
  return false;
}

// Live sabotage population: everyone searching, everyone seated awaiting ready,
// and everyone seated in an active (started, not ended) sabotage game.
function sabotageOnlineCount() {
  let n = sabotageQueue.length;
  for (const room of Object.values(rooms)) {
    if (room.pendingMatch) { n += room.players.length; continue; } // matched, awaiting ready
    // endGame nulls room.game, so a finished match no longer counts.
    if (room.game && room.game.started && room.game.mode === 'sabotage') {
      n += room.players.length;
    }
  }
  return n;
}
function broadcastSabotageOnline() {
  io.emit('sabotage_online', { count: sabotageOnlineCount() });
}

// Seat two queued sockets into a fresh hidden room and start immediately.
function sabotageMatch(a, b) {
  const code = generateCode();
  rooms[code] = {
    hostId: a.socketId, // first-queued hosts; postgame rematch reuses host-started flow
    players: [],
    settings: { ...SABOTAGE_SETTINGS }, // a copy, never the shared object
    playedWords: new Set(),
    isPublic: false,
    hidden: true, // never appears in the public lobby list
    lastActivity: Date.now(),
  };
  for (const e of [a, b]) {
    const sock = io.sockets.sockets.get(e.socketId);
    if (!sock) continue;
    sock.join(code);
    sock.data.roomCode = code;
    sock.data.name = e.name;
    rooms[code].players.push({ id: e.socketId, name: e.name, inGame: true, deviceId: e.deviceId, userId: e.userId ?? null });
  }
  // A departure between shift and here could leave < 2 seated; bail cleanly.
  if (rooms[code].players.length < 2) { delete rooms[code]; return; }
  for (const e of [a, b]) {
    const opp = e === a ? b : a;
    // room_joined MUST precede match_found (the client wires the room first).
    io.to(e.socketId).emit('room_joined', { code, socketId: e.socketId, mode: 'sabotage' });
    io.to(e.socketId).emit('match_found', { code, opponent: { name: opp.name } });
  }
  broadcastRoom(code); // roster for the client's idle ready-stage arena
  // The game does NOT start yet: both players must Ready within the window.
  rooms[code].pendingMatch = {
    ready: new Set(),
    timer: setTimeout(() => sabotageAbortMatch(code, 'timeout'), READY_WINDOW_MS),
  };
  broadcastSabotageOnline();
}

// Abort a match still awaiting ready (timeout or a seated player leaving).
// Readied-and-still-connected players go to the FRONT of the queue (they did
// nothing wrong); everyone else is dropped. The room is destroyed.
function sabotageAbortMatch(code, reason, leavingId) {
  const room = rooms[code];
  if (!room || !room.pendingMatch) return;
  const pm = room.pendingMatch;
  clearTimeout(pm.timer);
  const readySet = pm.ready;
  delete room.pendingMatch;
  const seated = room.players.slice(); // snapshot before teardown

  const requeue = [];
  for (const p of seated) {
    const connected = p.id !== leavingId && io.sockets.sockets.has(p.id);
    if (connected) io.to(p.id).emit('match_cancelled', { reason });
    if (connected && readySet.has(p.id)) {
      requeue.push({ socketId: p.id, name: p.name, deviceId: p.deviceId, userId: p.userId ?? null, joinedAt: Date.now() });
    }
  }
  // Destroy the room: leave the socket.io room, clear roomCode, and reuse the
  // empty-room cleanup in removePlayerFromRoom (room.game is null while pending,
  // so no game teardown runs; the last removal deletes rooms[code]).
  for (const p of seated) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) { sock.leave(code); sock.data.roomCode = null; }
    removePlayerFromRoom(code, p.id);
  }
  // Front of the line, preserving the original pairing order.
  for (let i = requeue.length - 1; i >= 0; i--) sabotageQueue.unshift(requeue[i]);
  sabotageRunMatcher(); // re-queued players may match instantly
  broadcastSabotageOnline();
}

function sabotageRunMatcher() {
  while (sabotageQueue.length >= 2) {
    const a = sabotageQueue.shift();
    const b = sabotageQueue.shift();
    sabotageMatch(a, b);
  }
}

io.on('connection', (socket) => {
  console.log('a user connected');
  // Batch 42: read the session once per connection from the handshake cookie.
  // Auth disabled or no cookie yields null; this never throws. Every player /
  // seat / queue entry created from this socket copies it as userId.
  socket.data.uid = readSessionFromCookieHeader(socket.handshake.headers.cookie || '')?.uid ?? null;
  socket.emit('sabotage_online', { count: sabotageOnlineCount() }); // correct landing card at once

  // Clients on the landing page subscribe to the public lobby feed.
  socket.on('lobby:subscribe', () => {
    socket.join('lobby');
    socket.emit('lobby_update', publicLobbyList());
  });
  socket.on('lobby:unsubscribe', () => {
    socket.leave('lobby');
  });

  // ── Sabotage queue ──
  socket.on('sabotage_queue_join', ({ name, deviceId }) => {
    if (!name || !name.trim()) return; // same validation as create_room
    sabotageQueueRemove(socket.id); // re-join replaces the existing entry
    sabotageQueue.push({
      socketId: socket.id,
      name: name.trim(),
      deviceId: String(deviceId || '').trim().slice(0, 64) || null,
      userId: socket.data.uid ?? null,
      joinedAt: Date.now(),
    });
    broadcastSabotageOnline();
    sabotageRunMatcher(); // pairs off the moment two are waiting
  });
  socket.on('sabotage_queue_leave', () => {
    if (sabotageQueueRemove(socket.id)) broadcastSabotageOnline();
  });
  // A matched player signals ready. When both seated players are ready the game
  // starts (beginGame); until then the match sits in its pendingMatch window.
  socket.on('sabotage_ready', () => {
    const code = socket.data.roomCode;
    const room = code && rooms[code];
    if (!room || !room.pendingMatch) return;
    if (!room.players.some(p => p.id === socket.id)) return; // seated players only
    const pm = room.pendingMatch;
    pm.ready.add(socket.id);
    io.to(code).emit('sabotage_ready_state', { readyIds: [...pm.ready] });
    if (room.players.every(p => pm.ready.has(p.id))) {
      clearTimeout(pm.timer);
      delete room.pendingMatch;
      beginGame(code); // game_start + first turn_start follow at once
      broadcastSabotageOnline();
    }
  });

  socket.on('create_room', ({ name, isPublic, deviceId, mode }) => {
    if (!name || !name.trim()) return;
    const devId = String(deviceId || '').trim().slice(0, 64) || null;
    const gameMode = ROOM_MODES.includes(mode) ? mode : 'classic'; // rooms are classic/scramble only; sabotage is matchmade
    sabotageQueueRemove(socket.id); // queuing and entering a room are mutually exclusive
    const code = generateCode();
    rooms[code] = {
      hostId: socket.id,
      players: [],
      settings: { ...DEFAULT_SETTINGS, mode: gameMode },
      playedWords: new Set(), // words played across this room's session (Feature 5)
      isPublic: isPublic !== false, // public by default; private is an opt-out
      lastActivity: Date.now(),
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name.trim();
    rooms[code].players.push({ id: socket.id, name: name.trim(), inGame: false, deviceId: devId, userId: socket.data.uid ?? null });
    socket.emit('room_joined', { code, socketId: socket.id, mode: gameMode });
    broadcastRoom(code);
    broadcastLobby();
    console.log(`Room ${code} created by ${name.trim()} (${rooms[code].isPublic ? 'public' : 'private'})`);
  });

  socket.on('join_room', ({ code, name, deviceId }) => {
    if (!name || !name.trim() || !code) return;
    const upper = code.trim().toUpperCase();
    const room = rooms[upper];
    if (!room) {
      socket.emit('join_error', 'Room not found. Check the code and try again.');
      return;
    }
    sabotageQueueRemove(socket.id); // queuing and entering a room are mutually exclusive
    const devId = String(deviceId || '').trim().slice(0, 64) || null;

    // Reconnect grace: a started game holding a graced seat for THIS device is a
    // REBIND, not a join. (A live, non-graced seat with the same device is two
    // tabs - fall through to the normal join / room-full rejection below.)
    const game = room.game;
    if (game && game.started && devId) {
      const seat = game.players.find(p => p.disconnectedAt && p.deviceId === devId);
      if (seat) { rebindSeat(upper, seat, socket); return; }
    }
    // Sabotage is a strict 1v1: a non-rebind third socket is rejected. (Batch 35
    // removed the old code-join guard on the assumption sabotage rooms are never
    // joined by code; reconnect now joins by code, so the guard is restored.)
    if (room.settings.mode === 'sabotage' && room.players.length >= 2) {
      socket.emit('join_error', 'This match is full.');
      return;
    }
    room.players.push({ id: socket.id, name: name.trim(), inGame: false, deviceId: devId, userId: socket.data.uid ?? null });
    socket.join(upper);
    socket.data.roomCode = upper;
    socket.data.name = name.trim();
    socket.emit('room_joined', { code: upper, socketId: socket.id, mode: room.settings.mode });
    touch(upper);
    broadcastRoom(upper);
    broadcastLobby();
    console.log(`${name.trim()} joined room ${upper}`);
  });

  socket.on('join_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const player = rooms[code].players.find(p => p.id === socket.id);
    if (player) player.inGame = true;
    touch(code);
    broadcastRoom(code);
  });

  socket.on('leave_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const player = rooms[code].players.find(p => p.id === socket.id);
    if (player) player.inGame = false;
    touch(code);
    broadcastRoom(code);
  });

  socket.on('update_settings', (settings) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    if (rooms[code].hostId !== socket.id) return;
    // Lobby-only in effect: a running game snapshots settings at start, so
    // changes here only ever apply to the NEXT game. Mode is whitelisted; an
    // omitted or invalid mode preserves the current one.
    const prevMode = rooms[code].settings.mode || 'classic';
    const nextMode = ROOM_MODES.includes(settings.mode) ? settings.mode : prevMode; // sabotage is not a room mode
    rooms[code].settings = {
      timerDuration: clamp(settings.timerDuration, 5, 30),
      startingLives: clamp(settings.startingLives, 1, 5),
      stringLength:  clamp(settings.stringLength,  2, 4),
      longWordBonus: !!settings.longWordBonus,
      overtime:      !!settings.overtime,
      overtimeStart: clamp(settings.overtimeStart, 1, 200),
      stringPersistence: !!settings.stringPersistence,
      mode: nextMode,
    };
    touch(code);
    broadcastRoom(code);
    broadcastLobby(); // settings summary shown in the public list
  });

  socket.on('start_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.hostId !== socket.id) return;
    if (room.game && room.game.started) return;
    const gamePlayers = room.players.filter(p => p.inGame);
    if (gamePlayers.length < 2) return; // scramble and classic share the 2+ gate
    beginGame(code);
  });

  socket.on('submit_word', ({ word }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;

    // Scramble accepts from ANY alive, unlocked player during the round; its
    // own path handles validation, claiming, secrecy, and stats.
    if (game.mode === 'scramble') { handleScrambleSubmit(code, socket, word); return; }

    // ── Classic: only the current player, unchanged. ──
    const current = game.players[game.currentIndex];
    if (!current || current.id !== socket.id) return; // never trust the client
    if (typeof word !== 'string') return;

    const normalized = word.trim().toLowerCase();
    if (!normalized) return;
    touch(code);

    // Sabotage: before dictionary validation, reject any word using a disabled
    // letter. This is a free retry exactly like an invalid word (turnAttempts
    // increments, the timer keeps running).
    if (game.mode === 'sabotage' && game.currentRestriction && game.currentRestriction.size) {
      const offending = [...new Set(normalized)].filter(ch => game.currentRestriction.has(ch)).sort();
      if (offending.length) {
        current.stats.submissions.push({ word: normalized, valid: false, timeToAnswer: Date.now() - game.turnStartedAt, turnNumber: game.round });
        current.stats.currentStreak = 0;
        game.turnAttempts += 1;
        io.to(code).emit('word_rejected', {
          playerId: current.id,
          playerName: current.name,
          word: normalized,
          reason: 'restricted',
          letters: offending,
        });
        storage.recordWordRejection({
          mode: game.mode === 'sabotage' ? 'sabotage' : 'multiplayer', deviceId: current.deviceId, userId: current.userId,
          gameId: game.gameId, word: normalized, reason: 'restricted',
        }).catch(err => console.error('word_rejection insert failed:', err.message));
        return;
      }
    }

    const result = isValidWord(normalized, game.prompt, game.usedWords);
    if (!result.valid) {
      // No advance, no timer reset - the active player keeps the remaining time.
      current.stats.submissions.push({ word: normalized, valid: false, timeToAnswer: Date.now() - game.turnStartedAt, turnNumber: game.round });
      current.stats.currentStreak = 0;
      game.turnAttempts += 1;
      io.to(code).emit('word_rejected', {
        playerId: current.id,
        playerName: current.name,
        word: normalized,
        reason: result.reason,
      });
      storage.recordWordRejection({
        mode: game.mode === 'sabotage' ? 'sabotage' : 'multiplayer', deviceId: current.deviceId, userId: current.userId,
        gameId: game.gameId, word: normalized, reason: result.reason,
      }).catch(err => console.error('word_rejection insert failed:', err.message));
      return;
    }

    game.usedWords.add(normalized);
    game.wordSubmitters.set(normalized, current.id);
    const timeMs = Date.now() - game.turnStartedAt;
    // Rarity tier + first-time-in-this-room-session flag (Feature 5)
    const tier = getWordTier(normalized);
    const firstTimeThisGame = !rooms[code].playedWords.has(normalized);
    rooms[code].playedWords.add(normalized);
    current.stats.words.push({ word: normalized, length: normalized.length, timeMs, prompt: game.prompt, tier });
    // Persistence spine: one event per accepted word, fire-and-forget (rule:
    // gameplay never blocks on the database).
    storage.recordWordEvent({
      mode: game.mode === 'sabotage' ? 'sabotage' : 'multiplayer', deviceId: current.deviceId, userId: current.userId, gameId: game.gameId,
      round: game.round, word: normalized, tier, points: getWordScore(normalized), ms: timeMs,
    }).catch(err => console.error('word_event insert failed:', err.message));
    current.stats.answerTimes.push(timeMs);
    current.stats.submissions.push({ word: normalized, valid: true, timeToAnswer: timeMs, turnNumber: game.round });
    current.stats.currentStreak += 1;
    if (current.stats.currentStreak > current.stats.longestStreak) {
      current.stats.longestStreak = current.stats.currentStreak;
    }
    const attemptsForWord = game.turnAttempts + 1; // failed tries this turn + the winner
    if (!game.mostContested || attemptsForWord > game.mostContested.attempts) {
      game.mostContested = { word: normalized, player: current.name, attempts: attemptsForWord };
    }

    clearTurnTimer(game);

    // String persistence: a solve retires the passed prompt.
    if (game.settings.stringPersistence && game.persist && game.persist.prompt === game.prompt) {
      recordContestedPrompt(game, current.name);
      game.persist = null;
    }

    io.to(code).emit('word_accepted', {
      playerId: current.id,
      playerName: current.name,
      word: normalized,
      tier,
      score: getWordScore(normalized), // lets clients spot a new game-high word
      prompt: game.prompt,             // so lists can highlight the substring
      firstTimeThisGame,
    });

    // ── Alphabet tracker + bonuses ──
    // Sabotage has no alphabet lives: the whole tracker/bonus block is skipped,
    // so an accepted word never lights a letter, never emits alphabet_update /
    // letter_bonus / alphabet_bonus, and never grants an extra life or bumps
    // stats.extraLives. Classic and scramble are unchanged.
    if (game.mode !== 'sabotage') {
      for (const ch of normalized) {
        if (ch >= 'a' && ch <= 'z') current.alphabet.add(ch);
      }

      // Long-word bonus (host-toggleable): 12+ letters lights one random unlit letter.
      let bonusLetter = null;
      if (game.settings.longWordBonus && normalized.length >= LONG_WORD_LENGTH) {
        const unlit = [];
        for (let c = 97; c <= 122; c++) {
          const ch = String.fromCharCode(c);
          if (!current.alphabet.has(ch)) unlit.push(ch);
        }
        if (unlit.length) {
          bonusLetter = unlit[Math.floor(Math.random() * unlit.length)];
          current.alphabet.add(bonusLetter);
          current.stats.longWordBonuses += 1;
        }
      }

      // Completing the alphabet grants a life and resets the tracker (repeatable).
      let gainedLife = false;
      if (current.alphabet.size >= ALPHABET_GOAL) {
        current.lives += 1;
        current.stats.extraLives += 1;
        current.alphabet = new Set();
        gainedLife = true;
      }

      // The submitting player owns this tracker; only they render the tiles.
      socket.emit('alphabet_update', { letters: [...current.alphabet] });
      if (bonusLetter) {
        io.to(code).emit('letter_bonus', {
          playerId: current.id, playerName: current.name, letter: bonusLetter,
        });
      }
      if (gainedLife) {
        io.to(code).emit('alphabet_bonus', {
          playerId: current.id, playerName: current.name, lives: current.lives,
        });
      }
    }

    // Sabotage: this valid word disables its distinct letters for the opponent's
    // next (and only next) turn. No cap; the restriction constrains its author
    // too, which is what balances it.
    if (game.mode === 'sabotage') game.pendingRestriction = new Set(normalized);

    game.currentIndex = nextAliveIndex(game, game.currentIndex);
    startTurn(code);
  });

  socket.on('typing', ({ text }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;
    // Secrecy (hard rule): the typing relay would leak a live word, so it is
    // suppressed entirely on scramble rooms.
    if (game.mode === 'scramble') return;
    const current = game.players[game.currentIndex];
    if (!current || current.id !== socket.id) return; // only the active player
    // Cosmetic channel: mirror raw, unfiltered, to everyone else in the room.
    socket.to(code).emit('typing', { playerId: current.id, text: String(text == null ? '' : text) });
  });

  socket.on('chat_message', ({ text }) => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (!code || !name || !text || !text.trim()) return;
    touch(code);
    io.to(code).emit('chat_message', { name, text: text.trim() });
  });

  // ── Word of the Game vote: every seat in the room (players, eliminated,
  // spectators) gets exactly one vote per game, enforced by socket id. ──
  socket.on('words:vote', ({ word }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;
    if (typeof word !== 'string') return;
    const w = word.trim().toLowerCase();
    if (!game.usedWords.has(w)) return;        // only real accepted words can be voted
    if (game.wordSubmitters.get(w) === socket.id) return; // no self-votes
    if (game.voters.has(socket.id)) return;    // one vote per socket per game
    game.voters.add(socket.id);
    game.wordVotes[w] = (game.wordVotes[w] || 0) + 1;
    socket.emit('words:voted', { word: w });   // confirm to the voter
    io.to(code).emit('words:voteUpdate', { word: w, count: game.wordVotes[w] });
  });

  // Explicit "Leave room" from the client: drop the seat like a disconnect, but
  // keep the socket connected (it returns to the landing page and the lobby feed).
  socket.on('leave_room', () => {
    const code = socket.data.roomCode;
    if (code && rooms[code]) {
      socket.leave(code);
      const stillExists = removePlayerFromRoom(code, socket.id);
      if (stillExists) broadcastRoom(code);
      broadcastLobby();
    }
    socket.data.roomCode = null;
  });

  socket.on('disconnect', () => {
    if (sabotageQueueRemove(socket.id)) broadcastSabotageOnline(); // drop from the search queue
    const code = socket.data.roomCode;
    // A seated player leaving DURING the ready window aborts the match (the
    // survivor, if readied, is re-queued). This runs BEFORE any grace logic.
    if (code && rooms[code] && rooms[code].pendingMatch) {
      sabotageAbortMatch(code, 'opponent_left', socket.id);
      console.log('user disconnected');
      return;
    }
    // Reconnect grace: a seated player in a STARTED game keeps their seat for
    // GRACE_MS instead of being spliced. Same-device rejoin rebinds it.
    const room = code && rooms[code];
    const game = room && room.game;
    if (game && game.started) {
      const seat = game.players.find(p => p.id === socket.id);
      if (seat && !seat.disconnectedAt) {
        seat.disconnectedAt = Date.now();
        const rp = room.players.find(p => p.id === socket.id);
        if (rp) rp.disconnectedAt = seat.disconnectedAt;
        const gameId = game.gameId;
        seat.graceTimer = setTimeout(() => expireGrace(code, socket.id, gameId), GRACE_MS);
        io.to(code).emit('player_connection', { id: socket.id, name: seat.name, connected: false });
        broadcastRoom(code);
        if (game.mode === 'sabotage') broadcastSabotageOnline(); // still in-match until expiry
        console.log(`user disconnected (grace held) ${seat.name}`);
        return;
      }
    }
    // Lobby member / spectator / already-graced: the existing removal path.
    finalizeRemoval(code, socket.id);
    console.log('user disconnected');
  });
});

// ── Zombie / idle room sweep ─────────────────────────────────────────────────
// Sockets that drop without a clean disconnect (sleep, network loss, closed tab)
// can leave a room counting a phantom player. Every 60s we (a) drop seats whose
// socket is no longer connected, reusing the same cleanup as disconnect, then
// (b) close any room that is empty or has been idle for 10+ minutes.
const ZOMBIE_SWEEP_MS = Number(process.env.BP_ZOMBIE_SWEEP_MS) || 60 * 1000; // env-overridable for tests
const ROOM_IDLE_MS = 10 * 60 * 1000;
setInterval(() => {
  let changed = false;
  for (const code of Object.keys(rooms)) {
    try {
      if (!rooms[code]) continue;
      // (a) drop real zombies: seats whose socket is no longer connected. A
      // seat inside its reconnect-grace window (disconnectedAt set) is NOT a
      // zombie - it is the feature - and its own graceTimer handles expiry.
      const zombieIds = rooms[code].players
        .filter(p => !io.sockets.sockets.has(p.id) && !p.disconnectedAt)
        .map(p => p.id);
      for (const id of zombieIds) {
        if (!rooms[code]) break; // a removal may have deleted the room
        removePlayerFromRoom(code, id);
        changed = true;
      }
      if (!rooms[code]) continue; // deleted by the removals above

      // (b) empty or idle → close it out.
      const idle = Date.now() - (rooms[code].lastActivity || 0) > ROOM_IDLE_MS;
      if (rooms[code].players.length === 0 || idle) {
        if (rooms[code].game) clearTurnTimer(rooms[code].game);
        delete rooms[code];
        changed = true;
        console.log(`Room ${code} swept (${idle ? 'idle 10m+' : 'empty'})`);
        continue;
      }
      if (zombieIds.length) broadcastRoom(code);
    } catch (e) {
      console.error(`Room sweep error for ${code}:`, e);
    }
  }
  if (changed) broadcastLobby();
}, ZOMBIE_SWEEP_MS);

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
