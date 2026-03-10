const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ===== DATA =====
const rooms = {};      // roomCode -> room object
const players = {};    // socketId -> player object

// ===== HELPERS =====
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function buildDeck() {
  const suits = ['♠','♥','♦','♣'];
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  for (let d = 0; d < 6; d++)
    for (const s of suits)
      for (const r of ranks)
        deck.push({ suit: s, rank: r });
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(rank) {
  if (['J','Q','K'].includes(rank)) return 10;
  if (rank === 'A') return 11;
  return parseInt(rank);
}

function handTotal(hand) {
  let total = 0, aces = 0;
  for (const c of hand) { total += cardValue(c.rank); if (c.rank === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => r.type === 'public' && r.status === 'waiting')
    .map(r => ({
      code: r.code,
      name: r.name,
      players: r.players.length,
      maxPlayers: r.maxPlayers,
      minBet: r.minBet,
      maxBet: r.maxBet,
      mode: r.mode,
      modeValue: r.modeValue
    }));
}

// ===== SOCKET =====
io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  // ---- JOIN / CREATE ----
  socket.on('createRoom', (data) => {
    const { playerName, avatar, type, maxPlayers, minBet, maxBet, mode, modeValue } = data;
    const code = generateCode();
    const room = {
      code,
      name: `Sala de ${playerName}`,
      type,           // 'public' | 'private'
      status: 'waiting',
      hostId: socket.id,
      players: [],
      maxPlayers: maxPlayers || 4,
      minBet: minBet || 5,
      maxBet: maxBet || 500,
      mode,           // 'rounds' | 'time'
      modeValue,      // number of rounds OR minutes
      currentRound: 0,
      deck: buildDeck(),
      dealerHand: [],
      phase: 'betting',  // betting | playing | dealer | results
      startTime: null,
      timerInterval: null,
      bets: {},
      hands: {},
      acted: new Set(),
    };
    rooms[code] = room;

    const player = {
      id: socket.id,
      name: playerName,
      avatar,
      balance: 1000,
      roomCode: code,
      isHost: true
    };
    players[socket.id] = player;
    room.players.push(player);

    socket.join(code);
    socket.emit('roomCreated', { code, room: sanitizeRoom(room) });
    io.emit('publicRoomsUpdate', getPublicRooms());
    console.log(`Sala creada: ${code} por ${playerName}`);
  });

  socket.on('joinRoom', (data) => {
    const { playerName, avatar, code, balance } = data;
    const room = rooms[code];

    if (!room) return socket.emit('error', { msg: 'Sala no encontrada' });
    if (room.status !== 'waiting') return socket.emit('error', { msg: 'La partida ya comenzó' });
    if (room.players.length >= room.maxPlayers) return socket.emit('error', { msg: 'Sala llena' });

    const player = {
      id: socket.id,
      name: playerName,
      avatar,
      balance: balance || 1000,
      roomCode: code,
      isHost: false
    };
    players[socket.id] = player;
    room.players.push(player);
    socket.join(code);

    socket.emit('roomJoined', { code, room: sanitizeRoom(room) });
    io.to(code).emit('playerJoined', { player: sanitizePlayer(player), room: sanitizeRoom(room) });
    io.emit('publicRoomsUpdate', getPublicRooms());
    console.log(`${playerName} entró a sala ${code}`);
  });

  socket.on('getPublicRooms', () => {
    socket.emit('publicRoomsUpdate', getPublicRooms());
  });

  // ---- START GAME ----
  socket.on('startGame', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', { msg: 'Se necesitan al menos 2 jugadores' });

    room.status = 'playing';
    room.currentRound = 0;
    room.startTime = Date.now();
    startNewRound(room);

    if (room.mode === 'time') {
      const ms = room.modeValue * 60 * 1000;
      room.timerInterval = setTimeout(() => endGame(room), ms);
    }
    io.emit('publicRoomsUpdate', getPublicRooms());
  });

  // ---- BETTING ----
  socket.on('placeBet', (data) => {
    const { amount } = data;
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.phase !== 'betting') return;
    if (amount < room.minBet || amount > room.maxBet) return socket.emit('error', { msg: `Apuesta entre $${room.minBet} y $${room.maxBet}` });
    if (amount > player.balance) return socket.emit('error', { msg: 'Saldo insuficiente' });

    room.bets[socket.id] = amount;
    player.balance -= amount;

    io.to(room.code).emit('betPlaced', {
      playerId: socket.id,
      amount,
      balance: player.balance
    });

    // Check if all players bet
    if (room.players.every(p => room.bets[p.id] !== undefined)) {
      dealCards(room);
    }
  });

  // ---- HIT ----
  socket.on('hit', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.phase !== 'playing') return;
    if (room.acted.has(socket.id)) return;

    const card = room.deck.pop();
    room.hands[socket.id].push(card);
    const total = handTotal(room.hands[socket.id]);

    io.to(room.code).emit('cardDealt', {
      playerId: socket.id,
      card,
      total,
      bust: total > 21
    });

    if (total >= 21) {
      room.acted.add(socket.id);
      checkAllActed(room);
    }
  });

  // ---- STAND ----
  socket.on('stand', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.phase !== 'playing') return;

    room.acted.add(socket.id);
    io.to(room.code).emit('playerStood', { playerId: socket.id });
    checkAllActed(room);
  });

  // ---- DOUBLE DOWN ----
  socket.on('doubleDown', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.phase !== 'playing') return;
    if (room.hands[socket.id].length !== 2) return;
    if (player.balance < room.bets[socket.id]) return socket.emit('error', { msg: 'Saldo insuficiente' });

    player.balance -= room.bets[socket.id];
    room.bets[socket.id] *= 2;

    const card = room.deck.pop();
    room.hands[socket.id].push(card);
    const total = handTotal(room.hands[socket.id]);

    io.to(room.code).emit('doubleDownResult', {
      playerId: socket.id,
      card,
      total,
      newBet: room.bets[socket.id],
      balance: player.balance
    });

    room.acted.add(socket.id);
    checkAllActed(room);
  });

  // ---- CLOSE ROOM (host) ----
  socket.on('closeRoom', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.hostId !== socket.id) return;
    forceCloseRoom(room, 'El anfitrión cerró la sala. Tu apuesta fue devuelta.');
  });

  // ---- LEAVE ROOM ----
  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    console.log('Desconectado:', socket.id);
    handleLeave(socket);
  });

  // ---- CHAT ----
  socket.on('chatMessage', (msg) => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room) return;
    io.to(room.code).emit('chatMessage', {
      playerName: player.name,
      avatar: player.avatar,
      msg: msg.substring(0, 120)
    });
  });

  // ---- REMATCH ----
  socket.on('requestRematch', () => {
    const player = players[socket.id];
    if (!player) return;
    const room = rooms[player.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.currentRound = 0;
    room.status = 'playing';
    startNewRound(room);
  });
});

// ===== GAME LOGIC =====
function startNewRound(room) {
  room.currentRound++;
  room.phase = 'betting';
  room.bets = {};
  room.hands = {};
  room.dealerHand = [];
  room.acted = new Set();

  if (room.deck.length < 52) room.deck = buildDeck();

  io.to(room.code).emit('newRound', {
    round: room.currentRound,
    modeValue: room.modeValue,
    mode: room.mode,
    players: room.players.map(sanitizePlayer)
  });
}

function dealCards(room) {
  room.phase = 'playing';

  // Deal 2 cards to each player
  room.players.forEach(p => {
    room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
  });

  // Dealer gets 2 cards (second face down)
  room.dealerHand = [room.deck.pop(), room.deck.pop()];

  const handsPublic = {};
  room.players.forEach(p => { handsPublic[p.id] = room.hands[p.id]; });

  io.to(room.code).emit('cardsDealt', {
    hands: handsPublic,
    dealerVisible: room.dealerHand[0],   // first card visible
    dealerHidden: null,                   // second card hidden
    totals: Object.fromEntries(
      room.players.map(p => [p.id, handTotal(room.hands[p.id])])
    )
  });

  // Check for blackjacks
  room.players.forEach(p => {
    if (handTotal(room.hands[p.id]) === 21) {
      room.acted.add(p.id);
    }
  });
  checkAllActed(room);
}

function checkAllActed(room) {
  const allActed = room.players.every(p => room.acted.has(p.id));
  if (allActed) playDealer(room);
}

async function playDealer(room) {
  room.phase = 'dealer';

  // Reveal hidden card
  io.to(room.code).emit('dealerReveal', {
    hiddenCard: room.dealerHand[1],
    total: handTotal(room.dealerHand)
  });

  // Dealer draws to 17
  while (handTotal(room.dealerHand) < 17) {
    const card = room.deck.pop();
    room.dealerHand.push(card);
    io.to(room.code).emit('dealerHit', {
      card,
      total: handTotal(room.dealerHand)
    });
    await sleep(800);
  }

  resolveRound(room);
}

function resolveRound(room) {
  const dealerTotal = handTotal(room.dealerHand);
  const results = {};

  room.players.forEach(p => {
    const playerTotal = handTotal(room.hands[p.id]);
    const bet = room.bets[p.id] || 0;
    let result, payout = 0;

    if (playerTotal > 21) {
      result = 'bust'; payout = 0;
    } else if (playerTotal === 21 && room.hands[p.id].length === 2) {
      result = 'blackjack'; payout = Math.floor(bet * 2.5);
    } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
      result = 'win'; payout = bet * 2;
    } else if (playerTotal === dealerTotal) {
      result = 'push'; payout = bet;
    } else {
      result = 'lose'; payout = 0;
    }

    p.balance += payout;
    results[p.id] = { result, payout, balance: p.balance, total: playerTotal };
  });

  io.to(room.code).emit('roundResult', {
    results,
    dealerTotal,
    dealerHand: room.dealerHand
  });

  // Check end condition
  const shouldEnd =
    (room.mode === 'rounds' && room.currentRound >= room.modeValue) ||
    room.players.some(p => p.balance <= 0);

  if (shouldEnd) {
    setTimeout(() => endGame(room), 3000);
  } else {
    setTimeout(() => startNewRound(room), 4000);
  }
}

function endGame(room) {
  if (room.timerInterval) clearTimeout(room.timerInterval);
  const sorted = [...room.players].sort((a, b) => b.balance - a.balance);
  io.to(room.code).emit('gameOver', {
    winner: sorted[0],
    rankings: sorted.map((p, i) => ({ rank: i + 1, ...sanitizePlayer(p) }))
  });
  room.status = 'finished';
  setTimeout(() => {
    delete rooms[room.code];
    io.emit('publicRoomsUpdate', getPublicRooms());
  }, 30000);
}

function forceCloseRoom(room, msg) {
  // Devolver apuestas
  room.players.forEach(p => {
    if (room.bets[p.id]) p.balance += room.bets[p.id];
  });
  if (room.timerInterval) clearTimeout(room.timerInterval);
  io.to(room.code).emit('roomClosed', { msg, players: room.players.map(sanitizePlayer) });
  delete rooms[room.code];
  io.emit('publicRoomsUpdate', getPublicRooms());
}

function handleLeave(socket) {
  const player = players[socket.id];
  if (!player) return;
  const room = rooms[player.roomCode];
  if (!room) { delete players[socket.id]; return; }

  if (room.hostId === socket.id) {
    // Host se fue — cerrar sala
    forceCloseRoom(room, `El anfitrión ${player.name} abandonó la partida. Las apuestas fueron devueltas.`);
  } else {
    // Jugador normal se fue
    room.players = room.players.filter(p => p.id !== socket.id);
    room.acted.add(socket.id); // contar como que actuó para no bloquear la ronda
    io.to(room.code).emit('playerLeft', {
      playerName: player.name,
      players: room.players.map(sanitizePlayer)
    });
    checkAllActed(room);
  }
  delete players[socket.id];
}

// ===== SANITIZE (no exponer datos privados) =====
function sanitizePlayer(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, balance: p.balance, isHost: p.isHost };
}
function sanitizeRoom(r) {
  return {
    code: r.code, name: r.name, type: r.type, status: r.status,
    hostId: r.hostId, maxPlayers: r.maxPlayers, minBet: r.minBet, maxBet: r.maxBet,
    mode: r.mode, modeValue: r.modeValue, currentRound: r.currentRound,
    players: r.players.map(sanitizePlayer)
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Royal Blackjack Server corriendo en puerto ${PORT}`));
