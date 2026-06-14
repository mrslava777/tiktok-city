'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const CFG = require('./config');
const { BossBattle } = require('./game');
const { TikTokManager } = require('./tiktok');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const game = new BossBattle();

// ── TikTok ───────────────────────────────────────────────────────────
let lastStatus = { connected: false, username: CFG.TIKTOK_USERNAME || null };

const tiktok = new TikTokManager({
  onStatus: (s) => {
    lastStatus = s;
    pushState();
    if (s.connected) feed({ icon: '🟢', text: `Подключено к лайву @${s.username}` });
    else feed({ icon: '🔴', text: 'Отключено от лайва' });
  },
  onEvent: (type, payload) => {
    if (type === 'gift') return handleGift(payload);
    if (type === 'like') return handleLike(payload);
    // остальные события (chat/follow/share/member) урон не наносят
  },
});

// ── Лайки → урон ─────────────────────────────────────────────────────
function handleLike(payload) {
  const count = Math.max(1, payload.likeCount || 1);
  handleGift({
    userId: payload.userId || payload.user,
    user: payload.user,
    giftName: 'лайк',
    flatBase: CFG.LIKE_DAMAGE,
    repeatCount: count,
    verb: `нанёс лайками (${count}) —`,
    hitIcon: '❤️',
  });
}

// ── Игровая логика → события ────────────────────────────────────────
function handleGift(payload) {
  const events = game.applyGift(payload);
  for (const ev of events) {
    if (ev.kind === 'hit') {
      io.emit('hit', { damage: ev.damage, critX: ev.critX, hpPercent: ev.hpPercent });
      feed({ id: ev.id, icon: ev.icon, text: ev.text });
    } else if (ev.kind === 'mvp') {
      io.emit('newmvp', { name: ev.name });
      feed({ id: ev.id, icon: ev.icon, text: ev.text, gold: true });
    } else if (ev.kind === 'defeated') {
      io.emit('defeated', {
        boss: ev.boss,
        killer: ev.killer,
        mvp: ev.mvp,
        respawnSeconds: ev.respawnSeconds,
      });
      feed({ id: ev.id, icon: ev.icon, text: ev.text, win: true });
    }
  }
  markDirty();
}

// ── Живая лента ──────────────────────────────────────────────────────
function feed(item) {
  io.emit('feed', {
    id: item.id || Date.now() + Math.random(),
    icon: item.icon || '•',
    text: item.text,
    gold: !!item.gold,
    win: !!item.win,
    ts: Date.now(),
  });
}

// ── Трансляция состояния (с троттлингом) ────────────────────────────
let dirty = true;
function markDirty() { dirty = true; }
function pushState() { dirty = true; }

function broadcastState() {
  io.emit('state', game.snapshot(lastStatus));
}
setInterval(() => {
  if (dirty) { dirty = false; broadcastState(); }
}, 250);

// серия MVP — раз в минуту
setInterval(() => {
  const streak = game.tickMvpStreak();
  if (streak >= 2) {
    feed({ icon: '👑', text: `MVP ${streakName()} держит лидерство — серия x${streak}`, gold: true });
    markDirty();
  }
}, CFG.MVP_STREAK_INTERVAL_MS);

function streakName() {
  const m = game.mvp();
  return m ? m.name : '';
}

// возрождение босса
setInterval(() => {
  const left = game.respawnLeft();
  const newBoss = game.tickRespawn();
  if (newBoss) {
    io.emit('newboss', game.snapshot(lastStatus).boss);
    feed({ icon: '🐉', text: `Появился новый босс: ${newBoss.name}` });
    markDirty();
  } else if (!game.boss.alive) {
    io.emit('respawn', { secondsLeft: left });
    markDirty();
  }
}, 1000);

// ── REST API ─────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json(game.snapshot(lastStatus)));
app.get('/api/hall', (req, res) => res.json({ hall: game.hall() }));

app.post('/api/connect', async (req, res) => {
  const username = (req.body && req.body.username) || CFG.TIKTOK_USERNAME;
  try {
    await tiktok.connect(username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: friendlyError(err) });
  }
});

app.post('/api/disconnect', async (req, res) => {
  await tiktok.disconnect();
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  game.reset();
  feed({ icon: '🔄', text: 'Игра сброшена — новый босс' });
  markDirty();
  res.json({ ok: true });
});

// тест без живого стрима: случайный подарок
app.post('/api/simulate', (req, res) => {
  handleGift(randomGift());
  res.json({ ok: true });
});

// ── Сокеты ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('state', game.snapshot(lastStatus));
  socket.emit('hall', { hall: game.hall() });
});

// автоподключение, если username задан в конфиге
if (CFG.TIKTOK_USERNAME) {
  tiktok.connect(CFG.TIKTOK_USERNAME).catch((e) =>
    console.error('[auto-connect]', friendlyError(e))
  );
}

server.listen(PORT, () => {
  console.log(`⚔️  Boss vs Viewers слушает порт ${PORT} — открой http://localhost:${PORT}`);
});

// ── Хелперы ──────────────────────────────────────────────────────────
const FAKE_USERS = ['Алекс', 'Ника', 'Макс777', 'Юля', 'Дэн', 'Кира', 'Гром', 'Лиса', 'Тор', 'Зара'];
const FAKE_GIFTS = [
  { giftName: 'Rose', diamondCount: 1 },
  { giftName: 'Heart', diamondCount: 5 },
  { giftName: 'TikTok', diamondCount: 20 },
  { giftName: 'Galaxy', diamondCount: 99 },
  { giftName: 'Drama Queen', diamondCount: 499 },
  { giftName: 'Sports Car', diamondCount: 1999 },
  { giftName: 'Lion', diamondCount: 5000 },
];
function randomGift() {
  const u = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
  const g = FAKE_GIFTS[Math.floor(Math.random() * FAKE_GIFTS.length)];
  return {
    userId: u,
    user: u,
    giftName: g.giftName,
    diamondCount: g.diamondCount,
    repeatCount: 1 + Math.floor(Math.random() * 3),
  };
}

function friendlyError(err) {
  const msg = (err && err.message ? err.message : String(err)) || '';
  const m = msg.toLowerCase();
  if (m.includes('islive') || m.includes('not live') || m.includes('offline') || m.includes('fetchislive')) {
    return 'Аккаунт сейчас не в эфире. Запусти TikTok Live и попробуй снова.';
  }
  if (m.includes('user') && m.includes('not') && m.includes('found')) {
    return 'Пользователь не найден. Проверь правильность @username.';
  }
  if (m.includes('rate') || m.includes('429')) {
    return 'TikTok временно ограничил запросы. Подожди минуту и попробуй снова.';
  }
  return 'Не удалось подключиться к лайву. Проверь @username и что идёт эфир.';
}
