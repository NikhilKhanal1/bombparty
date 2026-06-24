const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { validWords, playablePrompts, generatePrompt, isValidWord, getWordTier, getWordScore, rarityScore, generateDailyPrompts } = require('./dictionary');

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
const DAILY_TOTAL = 30;
const DAILY_TIMER_MS = 15000;
const DAILY_GRACE_MS = 2000;      // network slack before a late answer counts as timeout
const DAILY_STRIKES = 3;
const DAILY_FAST_MS = 3000;       // "answered quickly" bonus threshold
const DAILY_SESSION_TTL_MS = 30 * 60 * 1000;
const DAILY_TIER_RANK = { COMMON: 0, UNCOMMON: 1, RARE: 2, LEGENDARY: 3 };
const DAILY_TIER_SQUARE = { COMMON: '⚪', UNCOMMON: '🟢', RARE: '🟠', LEGENDARY: '🟡' };

function utcDateInfo(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { int: Number(`${y}${m}${day}`), iso: `${y}-${m}-${day}` };
}

let dailyCache = null;                 // { int, iso, prompts }
let dailyLeaderboard = { int: 0, entries: new Map() }; // name -> { name, score, round }
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

function dailyShareText(session, daily, req, round) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const url = `${proto}://${req.get('host')}/daily`;
  const squares = session.tiles.map(t => DAILY_TIER_SQUARE[t] || '⚪');
  const rows = [];
  for (let i = 0; i < squares.length; i += 10) rows.push(squares.slice(i, i + 10).join(''));
  return [
    `Bombparty Daily - ${daily.iso}`,
    `Score: ${session.score} pts | Round ${round}/${DAILY_TOTAL}`,
    `🟡 = LEGENDARY  🟠 = RARE  🟢 = UNCOMMON  ⚪ = COMMON`,
    ...(rows.length ? rows : ['(no words)']),
    `Play at ${url}`,
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
    shareText: dailyShareText(session, daily, req, round),
  };
}

function endDaily(session, daily, req, reason) {
  session.finished = true;
  session.completed = (reason === 'completed');
  const round = session.completed ? DAILY_TOTAL : Math.min(DAILY_TOTAL, session.promptIndex + 1);
  const prev = dailyLeaderboard.entries.get(session.name);
  if (!prev || session.score > prev.score) {
    dailyLeaderboard.entries.set(session.name, { name: session.name, score: session.score, round });
  }
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
    promptIndex: 0, score: 0, streak: 0, maxStreak: 0, strikes: 0,
    tiles: [], bestWord: null, usedWords: new Set(),
    promptStartedAt: now, lastActivity: now,
    finished: false, completed: false,
  });
  res.json({
    sessionId: id, date: daily.iso, total: DAILY_TOTAL,
    promptIndex: 0, prompt: daily.prompts[0],
    score: 0, streak: 0, strikes: 0, timerMs: DAILY_TIMER_MS,
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
    session.strikes += 1;
    session.streak = 0;
    if (session.strikes >= DAILY_STRIKES) {
      return res.json(endDaily(session, daily, req, 'strikeout'));
    }
    return res.json({ valid: false, reason: result.reason, strikes: session.strikes, promptIndex: session.promptIndex });
  }

  // Valid answer: score it with the unified per-word score plus a speed bonus.
  session.usedWords.add(word);
  const tier = getWordTier(word);
  let points = getWordScore(word);
  if (elapsed < DAILY_FAST_MS) points += 5;
  session.score += points;
  session.streak += 1;
  session.maxStreak = Math.max(session.maxStreak, session.streak);
  session.strikes = 0;
  session.tiles.push(tier);
  if (!session.bestWord ||
      DAILY_TIER_RANK[tier] > DAILY_TIER_RANK[session.bestWord.tier] ||
      (DAILY_TIER_RANK[tier] === DAILY_TIER_RANK[session.bestWord.tier] && word.length > session.bestWord.word.length)) {
    session.bestWord = { word, tier };
  }
  session.promptIndex += 1;

  if (session.promptIndex >= DAILY_TOTAL) {
    return res.json(endDaily(session, daily, req, 'completed'));
  }
  session.promptStartedAt = Date.now();
  res.json({
    valid: true, word, tier, points, score: session.score, streak: session.streak,
    strikes: 0, promptIndex: session.promptIndex, prompt: daily.prompts[session.promptIndex],
    total: DAILY_TOTAL,
  });
});

app.get('/daily/leaderboard', (req, res) => {
  const daily = ensureDaily();
  const entries = [...dailyLeaderboard.entries.values()]
    .sort((a, b) => b.score - a.score || b.round - a.round)
    .slice(0, 10)
    .map((e, i) => ({ rank: i + 1, name: e.name, score: e.score, round: e.round }));
  res.json({ date: daily.iso, entries });
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

const DEFAULT_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3, longWordBonus: true, overtime: true, overtimeStart: 20 };

// ── Bonus tuning ────────────────────────────────────────────────────────────
// Lower ALPHABET_GOAL (e.g. 5) temporarily to make the alphabet bonus easy to
// trigger while testing, then set back to 26.
const ALPHABET_GOAL = 26;     // distinct letters needed to complete the alphabet
const LONG_WORD_LENGTH = 12;  // word length that lights one bonus letter (host-toggleable)

// ── Overtime convergence (Feature 4) ─────────────────────────────────────────
// After the host-configured start round, each further round shaves the timer
// and (every 10 OT rounds) grows the prompt — a ratchet that forces games to a
// close. The start round is a per-room setting (settings.overtimeStart); to test
// quickly, the host can simply type a low number in the pre-game panel.
const OVERTIME_MIN_TIMER = 3;     // timer never drops below this many seconds
const OVERTIME_MAX_LENGTH = 4;    // dictionary engine supports prompts up to 4

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
    // Fail safe: no one left to take a turn — end the game cleanly.
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

  // ── Overtime convergence (Feature 4): a one-way ratchet driven by round count.
  // Timer shaves 0.5s per overtime round (floored); prompt grows +1 per 10 OT
  // rounds (capped). Host's timer/length are the baseline; OT applies on top. ──
  const otEnabled = !!game.settings.overtime;
  const overtimeRound = otEnabled ? Math.max(0, game.round - game.settings.overtimeStart) : 0;
  const inOvertime = overtimeRound > 0;
  const effTimer = Math.max(OVERTIME_MIN_TIMER, game.settings.timerDuration - 0.5 * overtimeRound);
  const effLength = Math.min(OVERTIME_MAX_LENGTH, game.settings.stringLength + Math.floor(overtimeRound / 10));

  if (inOvertime && !game.overtimeAnnounced) {
    game.overtimeAnnounced = true;
    io.to(code).emit('overtime:start');
  }

  game.prompt = generatePrompt(effLength);
  game.turnStartedAt = Date.now();
  const current = game.players[game.currentIndex];

  io.to(code).emit('turn_start', {
    currentId: current.id,
    currentName: current.name,
    prompt: game.prompt,
    players: game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives })),
    duration: effTimer,
    round: game.round,
    overtime: { active: inOvertime, timer: effTimer, length: effLength, round: overtimeRound },
  });

  game.turnTimer = setTimeout(() => onTurnTimeout(code), effTimer * 1000);
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
  io.to(code).emit('life_lost', {
    playerId: current.id,
    playerName: current.name,
    lives: current.lives,
    eliminated: current.lives === 0,
  });

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
  const endPlayers = game.players.map(p => {
    const valid = p.stats.words;
    const times = valid.map(w => w.timeMs);
    const longest = valid.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
    // Tier breakdown + the player's single rarest word (Feature 5 award)
    const tierCounts = { COMMON: 0, UNCOMMON: 0, RARE: 0, LEGENDARY: 0 };
    // Genuinely rarest word by the new system: highest rarityScore wins (this
    // also yields the highest tier present, with finer within-tier resolution).
    let rarest = null, rarestScore = -1;
    for (const w of valid) {
      const t = w.tier || 'COMMON';
      tierCounts[t]++;
      const rs = rarityScore(w.word);
      if (rs > rarestScore) { rarestScore = rs; rarest = { word: w.word, tier: t }; }
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
    };
  });
  let wordOfGame = null;
  for (const [w, votes] of Object.entries(game.wordVotes)) {
    if (!wordOfGame || votes > wordOfGame.votes) wordOfGame = { word: w, votes };
  }
  io.to(code).emit('stats:end', {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    winningWord: lastEntry ? { word: lastEntry.word, prompt: lastEntry.prompt } : null,
    players: endPlayers,
    records: {
      longestWord: longestWord ? { word: longestWord.word, player: longestWord.player } : null,
      fastestAnswer: fastestAnswer
        ? { word: fastestAnswer.word, player: fastestAnswer.player, timeMs: fastestAnswer.timeMs }
        : null,
      mostContested: game.mostContested,
    },
    wordOfGame,
  });

  // Back to lobby state so the host can start a fresh game.
  room.game = null;
  broadcastRoom(code);
  console.log(`Game over in room ${code}. Winner: ${winner ? winner.name : 'none'}`);
}

io.on('connection', (socket) => {
  console.log('a user connected');

  socket.on('create_room', ({ name }) => {
    if (!name || !name.trim()) return;
    const code = generateCode();
    rooms[code] = {
      hostId: socket.id,
      players: [],
      settings: { ...DEFAULT_SETTINGS },
      playedWords: new Set(), // words played across this room's session (Feature 5)
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name.trim();
    rooms[code].players.push({ id: socket.id, name: name.trim(), inGame: false });
    socket.emit('room_joined', { code, socketId: socket.id });
    broadcastRoom(code);
    console.log(`Room ${code} created by ${name.trim()}`);
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
    broadcastRoom(upper);
    console.log(`${name.trim()} joined room ${upper}`);
  });

  socket.on('join_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const player = rooms[code].players.find(p => p.id === socket.id);
    if (player) player.inGame = true;
    broadcastRoom(code);
  });

  socket.on('leave_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const player = rooms[code].players.find(p => p.id === socket.id);
    if (player) player.inGame = false;
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
    };
    broadcastRoom(code);
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
      wordVotes: {},           // word -> vote count (ghost/spectator "word of the game")
      voters: new Set(),       // socket ids that have spent their one vote
      overtimeAnnounced: false, // has overtime:start fired this game?
    };

    io.to(code).emit('game_start');
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

    const result = isValidWord(normalized, game.prompt, game.usedWords);
    if (!result.valid) {
      // No advance, no timer reset — the active player keeps the remaining time.
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
    io.to(code).emit('word_accepted', {
      playerId: current.id,
      playerName: current.name,
      word: normalized,
      tier,
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
    io.to(code).emit('chat_message', { name, text: text.trim() });
  });

  // ── Ghost chat (Feature 3): the peanut gallery for eliminated players &
  // spectators. Alive active players may read it but never post or vote. ──
  function isAliveActivePlayer(game) {
    if (!game || !game.started) return false;
    const p = game.players.find(pl => pl.id === socket.id);
    return !!(p && p.lives > 0);
  }

  socket.on('ghost:message', ({ text }) => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (!code || !rooms[code] || !name || !text || !text.trim()) return;
    if (isAliveActivePlayer(rooms[code].game)) return;
    io.to(code).emit('ghost:message', { name, text: text.trim() });
  });

  socket.on('ghost:vote', ({ word }) => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const game = rooms[code].game;
    if (!game || !game.started) return;
    if (typeof word !== 'string') return;
    const w = word.trim().toLowerCase();
    if (!game.usedWords.has(w)) return;        // only real accepted words can be voted
    if (isAliveActivePlayer(game)) return;     // alive players can't vote
    if (game.voters.has(socket.id)) return;    // one vote per game
    game.voters.add(socket.id);
    game.wordVotes[w] = (game.wordVotes[w] || 0) + 1;
    socket.emit('ghost:voted', { word: w });   // confirm to the voter
    io.to(code).emit('ghost:voteUpdate', { word: w, count: game.wordVotes[w] });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (code && rooms[code]) {
      const wasHost = rooms[code].hostId === socket.id;

      // Remove from a running game so the rotation never targets a ghost.
      const game = rooms[code].game;
      if (game && game.started) {
        const gi = game.players.findIndex(p => p.id === socket.id);
        if (gi !== -1) {
          const wasCurrent = gi === game.currentIndex;
          game.players.splice(gi, 1);
          if (gi < game.currentIndex) game.currentIndex--;

          const alive = game.players.filter(p => p.lives > 0);
          if (alive.length <= 1) {
            endGame(code, alive[0] || null);
          } else if (wasCurrent) {
            // Hand the turn to the next alive player cleanly.
            const n = game.players.length;
            game.currentIndex = nextAliveIndex(game, (gi - 1 + n) % n);
            startTurn(code);
          }
        }
      }

      rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
      if (rooms[code].players.length === 0) {
        if (rooms[code].game) clearTurnTimer(rooms[code].game);
        delete rooms[code];
        console.log(`Room ${code} closed (empty)`);
      } else {
        if (wasHost) {
          rooms[code].hostId = rooms[code].players[0].id;
          console.log(`Host transferred in room ${code} to ${rooms[code].players[0].name}`);
        }
        broadcastRoom(code);
      }
    }
    console.log('user disconnected');
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
