'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { CityGame, mapEvent } = require('./game');
const { TikTokManager } = require('./tiktok');

const PORT = process.env.PORT || 3000;
const TICK_MS = 30 * 1000; // ресурсы убывают каждые 30 секунд
const LOG_LIMIT = 60; // сколько событий храним в логе (в памяти)

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// ---- Состояние (только в памяти, без БД) ----
const game = new CityGame();
const eventLog = []; // последние события

function pushLog(entry) {
  const item = { ...entry, ts: Date.now() };
  eventLog.unshift(item);
  if (eventLog.length > LOG_LIMIT) eventLog.length = LOG_LIMIT;
  return item;
}

function broadcastState() {
  io.emit('state', game.snapshot());
}

// Обработка одного игрового события (из TikTok или симуляции)
function handleGameEvent(type, payload) {
  const mapped = mapEvent(type, payload);
  if (!mapped) return;
  game.apply(mapped.changes, mapped.xp);
  const logItem = pushLog({ emoji: mapped.emoji, label: mapped.label, type });
  io.emit('event', logItem);
  broadcastState();
}

// ---- TikTok ----
const tiktok = new TikTokManager({
  onEvent: handleGameEvent,
  onStatus: (status) => {
    io.emit('tiktok-status', status);
    const item = pushLog({
      emoji: status.connected ? '🟢' : '🔴',
      label: status.connected
        ? `Подключено к лайву @${status.username}`
        : 'Отключено от лайва',
      type: 'system',
    });
    io.emit('event', item);
  },
});

// ---- Таймер убывания ресурсов ----
setInterval(() => {
  game.tick();
  const danger = game.dangerKeys();
  if (danger.length) {
    const item = pushLog({
      emoji: '⚠️',
      label: `Ресурсы на нуле: ${danger.join(', ')} — городу нужна помощь!`,
      type: 'system',
    });
    io.emit('event', item);
  }
  broadcastState();
}, TICK_MS);

// ---- REST API ----
app.post('/api/connect', async (req, res) => {
  try {
    await tiktok.connect(req.body.username);
    res.json({ ok: true, status: tiktok.status() });
  } catch (err) {
    res.status(400).json({ ok: false, error: friendlyError(err) });
  }
});

// Переводим технические ошибки TikTok в понятный текст
function friendlyError(err) {
  const name = err && err.constructor ? err.constructor.name : '';
  const msg = (err && err.message) || String(err);
  if (name === 'InvalidUniqueIdError' || /user_not_found/i.test(msg)) {
    return 'Аккаунт не найден — проверь @username';
  }
  if (name === 'FetchIsLiveError' || name === 'UserOfflineError' || /offline|not live|is live/i.test(msg)) {
    return 'Аккаунт сейчас не в эфире. Подключаться можно только к активному лайву.';
  }
  if (/rate/i.test(msg)) return 'Слишком много попыток, подожди немного и повтори.';
  return msg && msg !== 'Error' ? msg : 'Не удалось подключиться к лайву. Возможно, эфир не идёт.';
}

app.post('/api/disconnect', async (_req, res) => {
  await tiktok.disconnect();
  res.json({ ok: true, status: tiktok.status() });
});

app.post('/api/reset', (_req, res) => {
  game.reset();
  eventLog.length = 0;
  broadcastState();
  io.emit('event', pushLog({ emoji: '🔄', label: 'Город перезапущен', type: 'system' }));
  res.json({ ok: true });
});

// Симуляция события — удобно тестировать без живого стрима
app.post('/api/simulate', (req, res) => {
  const type = req.body.type || randomType();
  handleGameEvent(type, demoPayload(type));
  res.json({ ok: true });
});

function randomType() {
  const types = ['like', 'chat', 'gift', 'follow', 'share', 'member'];
  return types[Math.floor(Math.random() * types.length)];
}

function demoPayload(type) {
  const users = ['Аня', 'Макс', 'Лена', 'Гость777', 'Дима', 'Катя'];
  const user = users[Math.floor(Math.random() * users.length)];
  switch (type) {
    case 'like':
      return { user, likeCount: 1 + Math.floor(Math.random() * 15) };
    case 'chat':
      return { user, comment: ['Привет!', 'Круто 🔥', 'Давай ещё', 'Город растёт!'][Math.floor(Math.random() * 4)] };
    case 'gift':
      return { user, giftName: ['Роза', 'Лев', 'Корона'][Math.floor(Math.random() * 3)], diamondCount: [1, 5, 10, 50][Math.floor(Math.random() * 4)], repeatCount: 1 };
    default:
      return { user };
  }
}

// ---- Socket.IO ----
io.on('connection', (socket) => {
  socket.emit('state', game.snapshot());
  socket.emit('tiktok-status', tiktok.status());
  socket.emit('log', eventLog.slice(0, 20));
});

server.listen(PORT, () => {
  console.log(`🏰 TikTok City слушает порт ${PORT} — открой http://localhost:${PORT}`);
});
