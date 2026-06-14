'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const CFG = require('./config');
const { KingOfLive } = require('./game');
const { TikTokManager } = require('./tiktok');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const game = new KingOfLive();

// ── TikTok ───────────────────────────────────────────────────────────
let lastStatus = { connected: false, username: CFG.TIKTOK_USERNAME || null };

const tiktok = new TikTokManager({
  onStatus: (s) => {
    lastStatus = s;
    markDirty();
    if (s.connected) feed({ icon: '🟢', text: `Подключено к лайву @${s.username}` });
    else feed({ icon: '🔴', text: 'Отключено от лайва' });
  },
  onEvent: (type, payload) => {
    if (type === 'gift') return handleGift(payload);
    if (type === 'like') return handleLike(payload);
    // chat / follow / share / member — на игру не влияют
  },
});

// ── Лайки → урон ─────────────────────────────────────────────────────
function handleLike(payload) {
  if (!CFG.LIKE_DAMAGE) return;
  const count = Math.max(1, payload.likeCount || 1);
  handleGift({
    userId: payload.userId || payload.user,
    user: payload.user,
    giftName: 'лайк',
    flatBase: CFG.LIKE_DAMAGE,
    repeatCount: count,
    isLike: true,
  });
}

// ── Подарок → события ────────────────────────────────────────────────
function handleGift(payload) {
  const events = game.applyGift(payload);
  emitEvents(events);
  markDirty();
}

function emitEvents(events) {
  for (const ev of events) {
    switch (ev.kind) {
      case 'hit':
        io.emit('hit', { damage: ev.damage, critX: ev.critX, hpPercent: ev.hpPercent });
        feed({ id: ev.id, icon: ev.icon, text: ev.text });
        break;
      case 'heal':
        io.emit('heal', { hpPercent: ev.hpPercent });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, heal: true });
        break;
      case 'blocked':
        io.emit('blocked', { hpPercent: ev.hpPercent });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, shield: true });
        break;
      case 'crown':
        io.emit('crown', { name: ev.name, first: ev.first });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, gold: true });
        break;
      case 'fell':
        io.emit('fell', {
          fallenName: ev.fallenName,
          killer: ev.killer,
          reward: ev.reward,
          reignSeconds: ev.reignSeconds,
        });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, win: true });
        break;
      case 'record':
        io.emit('record', { name: ev.name, seconds: ev.seconds });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, gold: true });
        break;
      case 'event':
        io.emit('event', { key: ev.key, icon: ev.icon, title: ev.title, durationMs: ev.durationMs });
        feed({ id: ev.id, icon: ev.icon, text: ev.text, event: true });
        if (ev.hpPercent != null) io.emit('heal', { hpPercent: ev.hpPercent });
        break;
      default:
        break;
    }
  }
}

// ── Живая лента ──────────────────────────────────────────────────────
function feed(item) {
  io.emit('feed', {
    id: item.id || Date.now() + Math.random(),
    icon: item.icon || '•',
    text: item.text,
    gold: !!item.gold,
    win: !!item.win,
    heal: !!item.heal,
    shield: !!item.shield,
    event: !!item.event,
    ts: Date.now(),
  });
}

// ── Трансляция состояния (с троттлингом) ─────────────────────────────
let dirty = true;
function markDirty() { dirty = true; }
function broadcastState() { io.emit('state', game.snapshot(lastStatus)); }

setInterval(() => {
  if (dirty) { dirty = false; broadcastState(); }
}, 250);

// тик раз в секунду: рост награды + таймеры + всегда обновляем UI
setInterval(() => {
  game.tick();
  markDirty();
}, 1000);

// случайные события трона
setInterval(() => {
  const ev = game.triggerRandomEvent();
  if (ev) { emitEvents([ev]); markDirty(); }
}, CFG.RANDOM_EVENT_INTERVAL_MS);

// ── REST API ─────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json(game.snapshot(lastStatus)));

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
  feed({ icon: '🔄', text: 'Игра сброшена — трон свободен' });
  markDirty();
  res.json({ ok: true });
});

// тест: случайный охотник дарит подарок (наносит урон / коронует)
app.post('/api/simulate', (req, res) => {
  handleGift(randomGift());
  res.json({ ok: true });
});

// тест: текущий Король дарит сам себе (лечение)
app.post('/api/simulate-heal', (req, res) => {
  if (!game.king) return res.json({ ok: false, error: 'Нет Короля' });
  handleGift({ userId: game.king.id, user: game.king.name, giftName: 'Galaxy', diamondCount: 99, repeatCount: 1 });
  res.json({ ok: true });
});

// тест: спец-эффекты и события
app.post('/api/effect', (req, res) => {
  const kind = req.body && req.body.kind;
  let ev = null;
  if (kind === 'shield') ev = game.activateShield();
  else if (kind === 'berserk') ev = game.activateBerserk();
  else if (kind === 'heal') ev = game.activateHeal();
  else if (kind === 'event') ev = game.triggerRandomEvent();
  if (ev) { emitEvents([ev]); markDirty(); }
  res.json({ ok: !!ev });
});

// ── Сокеты ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('state', game.snapshot(lastStatus));
});

// автоподключение, если username задан в конфиге
if (CFG.TIKTOK_USERNAME) {
  tiktok.connect(CFG.TIKTOK_USERNAME).catch((e) =>
    console.error('[auto-connect]', friendlyError(e))
  );
}

server.listen(PORT, () => {
  console.log(`👑  King of Live слушает порт ${PORT} — открой http://localhost:${PORT}`);
});

// ── Хелперы теста ────────────────────────────────────────────────────
const FAKE_USERS = ['Алекс', 'Ника', 'Макс777', 'Юля', 'Дэн', 'Кира', 'Гром', 'Лиса', 'Тор', 'Зара', 'Рекс', 'Майя'];
const FAKE_GIFTS = [
  { giftName: 'Rose', diamondCount: 1 },
  { giftName: 'Heart', diamondCount: 5 },
  { giftName: 'TikTok', diamondCount: 20 },
  { giftName: 'Galaxy', diamondCount: 99 },
  { giftName: 'Drama Queen', diamondCount: 499 },
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
