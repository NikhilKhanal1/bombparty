const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { validWords, substringCounts, playablePrompts, generatePrompt, isValidWord } = require('./dictionary');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Dictionary summary
console.log(
  `Dictionary loaded: ${validWords.size} words. ` +
  `Playable prompts: 2-letter=${playablePrompts[2].length}, ` +
  `3-letter=${playablePrompts[3].length}, ` +
  `4-letter=${playablePrompts[4].length}.`
);

// ── TEMPORARY SELF-TEST — remove before shipping ────────────────────────────
(function runSelfTest() {
  let pass = 0, fail = 0;
  function check(label, result, expected) {
    const ok = result === expected;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
    ok ? pass++ : fail++;
  }

  console.log('--- Dictionary self-test ---');

  // 1. generatePrompt(3) returns a 3-letter lowercase string with count >= 5
  const p3 = generatePrompt(3);
  const p3Count = substringCounts[3].get(p3) || 0;
  check(
    `generatePrompt(3) → "${p3}" (appears in ${p3Count} words, need ≥5)`,
    typeof p3 === 'string' && p3.length === 3 && p3 === p3.toLowerCase() && p3Count >= 5,
    true
  );

  // 2. Known valid word
  const r2 = isValidWord('money', 'mon', new Set());
  check('isValidWord("money", "mon", {}) → valid', r2.valid, true);

  // 3. Non-word rejected
  const r3 = isValidWord('xqzptv', 'mon', new Set());
  check('isValidWord("xqzptv", "mon", {}) → invalid', r3.valid, false);

  // 4. Too short (< 3 chars)
  const r4 = isValidWord('ab', 'ab', new Set());
  check('isValidWord("ab", "ab", {}) → invalid (too short)', r4.valid, false);

  // 5. Already used
  const used = new Set(['money']);
  const r5 = isValidWord('money', 'mon', used);
  check('isValidWord("money", "mon", {money}) → invalid (already used)', r5.valid, false);

  // 6. Long real word validates against one of its own substrings
  const longWord = 'submarine';
  const sub = longWord.slice(3, 6); // "mar"
  const r6 = isValidWord(longWord, sub, new Set());
  check(`isValidWord("${longWord}", "${sub}", {}) → valid`, r6.valid, true);

  console.log(`--- Self-test complete: ${pass} passed, ${fail} failed ---`);
})();
// ── END TEMPORARY SELF-TEST ─────────────────────────────────────────────────

const rooms = {};

const DEFAULT_SETTINGS = { timerDuration: 10, startingLives: 3, stringLength: 3 };

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
    };
    broadcastRoom(code);
  });

  socket.on('start_game', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    if (rooms[code].hostId !== socket.id) return;
    const inGameCount = rooms[code].players.filter(p => p.inGame).length;
    if (inGameCount < 2) return;
    io.to(code).emit('game_start');
    console.log(`Game started in room ${code}`);
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
      rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
      if (rooms[code].players.length === 0) {
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
