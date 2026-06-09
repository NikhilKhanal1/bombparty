const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * 26)]).join('');
  } while (rooms[code]);
  return code;
}

function broadcastRoom(code) {
  io.to(code).emit('room_updated', { players: rooms[code].players });
}

io.on('connection', (socket) => {
  console.log('a user connected');

  socket.on('create_room', ({ name }) => {
    if (!name || !name.trim()) return;
    const code = generateCode();
    rooms[code] = { players: [] };
    socket.join(code);
    socket.data.roomCode = code;
    rooms[code].players.push({ id: socket.id, name: name.trim() });
    socket.emit('room_joined', { code });
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
    room.players.push({ id: socket.id, name: name.trim() });
    socket.join(upper);
    socket.data.roomCode = upper;
    socket.emit('room_joined', { code: upper });
    broadcastRoom(upper);
    console.log(`${name.trim()} joined room ${upper}`);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (code && rooms[code]) {
      rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
      if (rooms[code].players.length === 0) {
        delete rooms[code];
        console.log(`Room ${code} closed (empty)`);
      } else {
        broadcastRoom(code);
      }
    }
    console.log('user disconnected');
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
