const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function calculateScore(hand) {
  if (!hand || hand.length === 0) return 0;
  let total = 0, aces = 0;
  for (const card of hand) {
    if (card.value === 'A') { total += 11; aces++; }
    else if (['J','Q','K'].includes(card.value)) total += 10;
    else total += parseInt(card.value);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && calculateScore(hand) === 21;
}

function isBust(hand) {
  return calculateScore(hand) > 21;
}

function getCardNumericForSplit(card) {
  if (card.value === 'A') return 'A';
  if (['10','J','Q','K'].includes(card.value)) return '10';
  return card.value;
}

function createDeck() {
  const suits = ['♠','♥','♦','♣'];
  const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck = [];
  for (const suit of suits) for (const value of values) deck.push({ suit, value });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function drawCard(deck) {
  if (deck.length < 4) {
    const newDeck = createDeck();
    shuffle(newDeck);
    deck.push(...newDeck);
  }
  return deck.pop();
}

function createRoomState(code) {
  return {
    code,
    players: [],
    dealerHand: [],
    deck: [],
    phase: 'lobby',
    currentPlayerIndex: 0,
    turnOrder: []
  };
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, createRoomState(roomCode));
  }
  return rooms.get(roomCode);
}

function broadcastState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('gameState', room);
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    if (!playerName || playerName.length > 20) return;
    const room = getRoom(roomCode);
    if (room.players.length >= 4) {
      socket.emit('error', 'Raum ist voll (max 4 Spieler)');
      return;
    }
    room.players = room.players.filter(p => p.id !== socket.id);
    const newPlayer = {
      id: socket.id,
      name: playerName,
      bankroll: 1000,
      bet: 0,
      hand: [],
      splitHand: null,
      status: 'waiting'
    };
    room.players.push(newPlayer);
    socket.join(roomCode);
    broadcastState(roomCode);
    socket.emit('joined', { roomCode, playerId: socket.id });
  });

  socket.on('placeBet', ({ roomCode, amount }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'betting') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || amount > player.bankroll || amount < 10) return;
    player.bet = amount;
    player.bankroll -= amount;
    player.status = 'betting';
    broadcastState(roomCode);
    const allBet = room.players.every(p => p.bet > 0);
    if (allBet && room.players.length >= 2) {
      startRound(room);
    }
  });

  socket.on('playerAction', ({ roomCode, action }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;

    if (action === 'hit') {
      const hand = player.splitHand && player.status === 'split' ? player.splitHand : player.hand;
      hand.push(drawCard(room.deck));
      if (isBust(hand)) player.status = 'bust';
    } else if (action === 'stand') {
      player.status = 'stood';
    } else if (action === 'double') {
      if (player.hand.length !== 2 || player.bankroll < player.bet) return;
      player.bankroll -= player.bet;
      player.bet *= 2;
      player.hand.push(drawCard(room.deck));
      player.status = isBust(player.hand) ? 'bust' : 'stood';
    } else if (action === 'split') {
      if (player.hand.length !== 2 || player.splitHand || 
          getCardNumericForSplit(player.hand[0]) !== getCardNumericForSplit(player.hand[1]) ||
          player.bankroll < player.bet) return;
      player.splitHand = [player.hand.pop()];
      player.hand.push(drawCard(room.deck));
      player.splitHand.push(drawCard(room.deck));
      player.bankroll -= player.bet;
      player.status = 'split';
    }
    advanceTurn(room);
    broadcastState(roomCode);
  });

  socket.on('startRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'betting') return;
    const allBet = room.players.every(p => p.bet > 0);
    if (allBet && room.players.length >= 2) {
      startRound(room);
    }
  });

  socket.on('newRound', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    resetForNewRound(room);
    broadcastState(roomCode);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) rooms.delete(code);
        else broadcastState(code);
      }
    }
  });
});

function startRound(room) {
  room.phase = 'playing';
  room.deck = createDeck();
  shuffle(room.deck);
  room.dealerHand = [];
  room.turnOrder = [...room.players.map(p => p.id)];
  room.currentPlayerIndex = 0;

  for (const player of room.players) {
    player.hand = [drawCard(room.deck), drawCard(room.deck)];
    player.splitHand = null;
    player.status = isBlackjack(player.hand) ? 'blackjack' : 'playing';
  }
  room.dealerHand = [drawCard(room.deck), drawCard(room.deck)];

  const allDone = room.players.every(p => ['blackjack','bust'].includes(p.status));
  if (allDone) {
    finishDealerTurn(room);
  } else {
    advanceTurn(room);
  }
  broadcastState(room.code);
}

function advanceTurn(room) {
  let attempts = 0;
  while (attempts < room.players.length) {
    const current = room.players[room.currentPlayerIndex];
    if (!current || ['stood','bust','blackjack'].includes(current.status)) {
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
      attempts++;
    } else {
      return;
    }
  }
  finishDealerTurn(room);
}

function finishDealerTurn(room) {
  room.phase = 'dealer';
  while (calculateScore(room.dealerHand) < 17) {
    room.dealerHand.push(drawCard(room.deck));
  }
  resolveRound(room);
}

function resolveRound(room) {
  room.phase = 'resolve';
  const dealerScore = calculateScore(room.dealerHand);
  const dealerBust = isBust(room.dealerHand);
  const dealerBJ = isBlackjack(room.dealerHand);

  for (const player of room.players) {
    const pScore = calculateScore(player.hand);
    const pBust = isBust(player.hand);
    const pBJ = isBlackjack(player.hand);

    let payout = 0;
    if (pBJ && dealerBJ) payout = player.bet;
    else if (pBJ) payout = Math.floor(player.bet * 2.5);
    else if (dealerBJ) payout = 0;
    else if (pBust) payout = 0;
    else if (dealerBust || pScore > dealerScore) payout = player.bet * 2;
    else if (pScore < dealerScore) payout = 0;
    else payout = player.bet;

    player.bankroll += payout;

    if (player.splitHand) {
      const sScore = calculateScore(player.splitHand);
      const sBust = isBust(player.splitHand);
      let splitPayout = 0;
      if (sBust) splitPayout = 0;
      else if (dealerBust || sScore > dealerScore) splitPayout = player.bet * 2;
      else if (sScore < dealerScore) splitPayout = 0;
      else splitPayout = player.bet;
      player.bankroll += splitPayout;
    }
  }
  broadcastState(room.code);
}

function resetForNewRound(room) {
  room.phase = 'betting';
  room.dealerHand = [];
  room.currentPlayerIndex = 0;
  for (const p of room.players) {
    p.hand = [];
    p.splitHand = null;
    p.bet = 0;
    p.status = 'waiting';
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Retro Blackjack Multiplayer läuft auf Port ${PORT}`);
});
