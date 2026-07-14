const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { validWords, playablePrompts, generatePrompt, generatePracticePrompt, solutionCount, killerAnswersFor, exampleWordFor, isValidWord, getWordTier, getWordScore, rarityScore, generateDailyPrompts, letterBaseline } = require('./dictionary');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8kb' }));

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
let dailyLeaderboard = { int: 0, entries: new Map() }; // sessionId -> { id, name, score, round, completed, bestWord, words, tiles }
const dailySessions = new Map();       // sessionId -> session

// (Re)build the day's sequence and reset the day's leaderboard/sessions if the
// UTC day has rolled over since the cache was built.
function ensureDaily() {
  const info = utcDateInfo();
  if (!dailyCache || dailyCache.int !== info.int) {
    dailyCache = { int: info.int, iso: info.iso, prompts: generateDailyPrompts(info.int) };
    dailyLeaderboard = { int: info.int, entries: new Map() };
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
  }
  // One entry per run, keyed by sessionId, so same-named strangers never
  // overwrite each other. Entries hold at most 30 small word objects each and
  // the whole board resets at UTC midnight, so no cleanup is needed.
  dailyLeaderboard.entries.set(session.id, {
    id: session.id, name: session.name, score: session.score, round,
    completed: session.completed, bestWord: session.bestWord,
    words: session.words, tiles: session.tiles,
  });
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
  const id = newSessionId();
  const now = Date.now();
  dailySessions.set(id, {
    id, name, date: daily.int,
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

app.get('/daily/leaderboard', (req, res) => {
  const daily = ensureDaily();
  const sorted = [...dailyLeaderboard.entries.values()]
    .sort((a, b) => b.score - a.score || b.round - a.round);
  const entries = sorted
    .slice(0, 10)
    .map((e, i) => ({ rank: i + 1, id: e.id, name: e.name, score: e.score, round: e.round }));
  // The asking run's own placement (by sessionId), so the client can show its
  // rank even when it falls outside the top 10.
  let me = null;
  const id = String(req.query.id || '');
  if (id) {
    const idx = sorted.findIndex(e => e.id === id);
    if (idx !== -1) me = { rank: idx + 1, id: sorted[idx].id, name: sorted[idx].name, score: sorted[idx].score, round: sorted[idx].round };
  }
  res.json({ date: daily.iso, players: sorted.length, entries, me });
});

// Full detail of one leaderboard run, for the expandable rows. Kept out of
// the main leaderboard payload so the list stays light.
app.get('/daily/run', (req, res) => {
  ensureDaily();
  const e = dailyLeaderboard.entries.get(String(req.query.id || ''));
  if (!e) return res.status(404).json({ error: 'run_not_found' });
  res.json({
    name: e.name, score: e.score, round: e.round, completed: e.completed,
    bestWord: e.bestWord, words: e.words, tiles: e.tiles,
  });
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

const rooms = {};

const DEFAULT_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3, longWordBonus: true, overtime: true, overtimeStart: 20, stringPersistence: true };

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
    if (!room.isPublic || !room.players.length) continue;
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
  if (game && game.started) {
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

  // ── Overtime (Feature 4): the timer decays 0.5s per cycle, a cycle being
  // one turn for every player alive when it started. Prompt length is
  // settings.stringLength forever. ──
  const otEnabled = !!game.settings.overtime;
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
  if (game.settings.stringPersistence && game.persist) {
    game.prompt = game.persist.prompt;
  } else {
    game.prompt = generatePrompt(game.settings.stringLength);
  }
  game.turnStartedAt = Date.now();
  const current = game.players[game.currentIndex];

  io.to(code).emit('turn_start', {
    currentId: current.id,
    currentName: current.name,
    prompt: game.prompt,
    players: game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives })),
    duration: effTimer,
    round: game.round,
    overtime: { active: inOvertime, timer: effTimer },
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

  // String persistence: the failed prompt passes to the next player. It
  // retires when every currently alive player has faced it (checked after
  // the life loss above).
  const persistence = !!game.settings.stringPersistence;
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
  clearTurnTimer(game);

  // A passed prompt still live at game end counts as unsolved.
  if (game.settings.stringPersistence) {
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
    };
  }

  io.to(code).emit('game_over', {
    winner: winner ? { id: winner.id, name: winner.name } : null,
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
    winner: winner ? { id: winner.id, name: winner.name } : null,
    winningWord: lastEntry ? { word: lastEntry.word, prompt: lastEntry.prompt, tier: lastEntry.tier } : null,
    players: endPlayers,
    records: {
      longestWord: longestWord ? { word: longestWord.word, player: longestWord.player } : null,
      fastestAnswer: fastestAnswer
        ? { word: fastestAnswer.word, player: fastestAnswer.player, timeMs: fastestAnswer.timeMs }
        : null,
      // Persistence upgrade: a prompt that took 2+ lives outranks the old
      // retry-count semantics; otherwise fall back to them.
      mostContested: game.mostContestedPersist || game.mostContested,
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
  console.log(`Game over in room ${code}. Winner: ${winner ? winner.name : 'none'}`);
}

io.on('connection', (socket) => {
  console.log('a user connected');

  // Clients on the landing page subscribe to the public lobby feed.
  socket.on('lobby:subscribe', () => {
    socket.join('lobby');
    socket.emit('lobby_update', publicLobbyList());
  });
  socket.on('lobby:unsubscribe', () => {
    socket.leave('lobby');
  });

  socket.on('create_room', ({ name, isPublic }) => {
    if (!name || !name.trim()) return;
    const code = generateCode();
    rooms[code] = {
      hostId: socket.id,
      players: [],
      settings: { ...DEFAULT_SETTINGS },
      playedWords: new Set(), // words played across this room's session (Feature 5)
      isPublic: isPublic !== false, // public by default; private is an opt-out
      lastActivity: Date.now(),
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name.trim();
    rooms[code].players.push({ id: socket.id, name: name.trim(), inGame: false });
    socket.emit('room_joined', { code, socketId: socket.id });
    broadcastRoom(code);
    broadcastLobby();
    console.log(`Room ${code} created by ${name.trim()} (${rooms[code].isPublic ? 'public' : 'private'})`);
  });

  socket.on('join_room', ({ code, name }) => {
    if (!name || !name.trim() || !code) return;
    const upper = code.trim().toUpperCase();
    const room = rooms[upper];
    if (!room) {
      socket.emit('join_error', 'Room not found. Check the code and try again.');
      return;
    }
    room.players.push({ id: socket.id, name: name.trim(), inGame: false });
    socket.join(upper);
    socket.data.roomCode = upper;
    socket.data.name = name.trim();
    socket.emit('room_joined', { code: upper, socketId: socket.id });
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
    rooms[code].settings = {
      timerDuration: clamp(settings.timerDuration, 5, 30),
      startingLives: clamp(settings.startingLives, 1, 5),
      stringLength:  clamp(settings.stringLength,  2, 4),
      longWordBonus: !!settings.longWordBonus,
      overtime:      !!settings.overtime,
      overtimeStart: clamp(settings.overtimeStart, 1, 200),
      stringPersistence: !!settings.stringPersistence,
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
    if (gamePlayers.length < 2) return;

    room.game = {
      started: true,
      settings: { ...room.settings },
      usedWords: new Set(),
      players: gamePlayers.map(p => ({
        id: p.id,
        name: p.name,
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
      })),
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
    };

    io.to(code).emit('game_start');
    broadcastLobby(); // flip the in-progress badge in the public list
    console.log(`Game started in room ${code}`);
    startTurn(code);
  });

  socket.on('submit_word', ({ word }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;
    const current = game.players[game.currentIndex];
    if (!current || current.id !== socket.id) return; // never trust the client
    if (typeof word !== 'string') return;

    const normalized = word.trim().toLowerCase();
    if (!normalized) return;
    touch(code);

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

    game.currentIndex = nextAliveIndex(game, game.currentIndex);
    startTurn(code);
  });

  socket.on('typing', ({ text }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;
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
    const code = socket.data.roomCode;
    if (code && rooms[code]) {
      const stillExists = removePlayerFromRoom(code, socket.id);
      if (stillExists) broadcastRoom(code);
      broadcastLobby(); // player count changed, or the room closed
    }
    console.log('user disconnected');
  });
});

// ── Zombie / idle room sweep ─────────────────────────────────────────────────
// Sockets that drop without a clean disconnect (sleep, network loss, closed tab)
// can leave a room counting a phantom player. Every 60s we (a) drop seats whose
// socket is no longer connected, reusing the same cleanup as disconnect, then
// (b) close any room that is empty or has been idle for 10+ minutes.
const ZOMBIE_SWEEP_MS = 60 * 1000;
const ROOM_IDLE_MS = 10 * 60 * 1000;
setInterval(() => {
  let changed = false;
  for (const code of Object.keys(rooms)) {
    try {
      if (!rooms[code]) continue;
      // (a) drop real zombies: seats whose socket is no longer connected.
      const zombieIds = rooms[code].players
        .filter(p => !io.sockets.sockets.has(p.id))
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
