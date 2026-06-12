const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { validWords, playablePrompts, generatePrompt, isValidWord } = require('./dictionary');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Dictionary summary
console.log(
  `Dictionary loaded: ${validWords.size} words. ` +
  `Playable prompts: 2-letter=${playablePrompts[2].length}, ` +
  `3-letter=${playablePrompts[3].length}, ` +
  `4-letter=${playablePrompts[4].length}.`
);

const rooms = {};

const DEFAULT_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3, longWordBonus: true };

// ── Bonus tuning ────────────────────────────────────────────────────────────
// Lower ALPHABET_GOAL (e.g. 5) temporarily to make the alphabet bonus easy to
// trigger while testing, then set back to 26.
const ALPHABET_GOAL = 26;     // distinct letters needed to complete the alphabet
const LONG_WORD_LENGTH = 15;  // word length that lights one bonus letter (host-toggleable)

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

  game.prompt = generatePrompt(game.settings.stringLength);
  game.turnStartedAt = Date.now();
  game.round += 1;
  const current = game.players[game.currentIndex];

  io.to(code).emit('turn_start', {
    currentId: current.id,
    currentName: current.name,
    prompt: game.prompt,
    players: game.players.map(p => ({ id: p.id, name: p.name, lives: p.lives })),
    duration: game.settings.timerDuration,
    round: game.round,
  });

  game.turnTimer = setTimeout(() => onTurnTimeout(code), game.settings.timerDuration * 1000);
}

function onTurnTimeout(code) {
  const room = rooms[code];
  if (!room || !room.game) return;
  const game = room.game;
  game.turnTimer = null;

  const current = game.players[game.currentIndex];
  current.lives = Math.max(0, current.lives - 1);
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

  io.to(code).emit('game_over', {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    winningWord: lastEntry ? { word: lastEntry.word, prompt: lastEntry.prompt } : null,
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
        stats: { words: [], answerTimes: [], extraLives: 0 },
      })),
      currentIndex: Math.floor(Math.random() * gamePlayers.length),
      prompt: null,
      turnTimer: null,
      turnStartedAt: null,
      round: 0,
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
    current.stats.words.push({ word: normalized, length: normalized.length, timeMs, prompt: game.prompt });
    current.stats.answerTimes.push(timeMs);

    clearTurnTimer(game);
    io.to(code).emit('word_accepted', {
      playerId: current.id,
      playerName: current.name,
      word: normalized,
    });

    // ── Alphabet tracker + bonuses ──
    for (const ch of normalized) {
      if (ch >= 'a' && ch <= 'z') current.alphabet.add(ch);
    }

    // Long-word bonus (host-toggleable): 15+ letters lights one random unlit letter.
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
