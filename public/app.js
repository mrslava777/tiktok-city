'use strict';

const $ = (id) => document.getElementById(id);
const socket = io();

// ── Звук (Web Audio, без файлов) ────────────────────────────────────
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('kol_muted') === '1';
  function ensure() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type = 'sine', gain = 0.16, delay = 0) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(c.destination);
    const t = c.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur = 0.3, gain = 0.2) {
    if (muted) return;
    const c = ensure(); if (!c) return;
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(c.destination); src.start();
  }
  return {
    hit() { tone(220 + Math.random() * 60, 0.09, 'triangle', 0.12); },
    crit(x) { tone(520, 0.12, 'sawtooth', 0.18); tone(780, 0.16, 'square', 0.14, 0.05); if (x >= 5) tone(1040, 0.2, 'square', 0.12, 0.1); },
    heal() { tone(520, 0.12, 'sine', 0.12); tone(660, 0.16, 'sine', 0.12, 0.08); },
    shield() { tone(330, 0.18, 'sine', 0.12); tone(440, 0.22, 'sine', 0.1, 0.08); },
    crown() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.16, i * 0.1)); },
    fell() { noise(0.4, 0.25); tone(160, 0.4, 'sawtooth', 0.18); tone(80, 0.5, 'sine', 0.16, 0.05); },
    record() { [784, 988, 1319].forEach((f, i) => tone(f, 0.25, 'square', 0.14, i * 0.12)); },
    event() { tone(440, 0.15, 'square', 0.12); tone(660, 0.2, 'square', 0.12, 0.1); },
    isMuted() { return muted; },
    unlock() { ensure(); },
    toggle() { muted = !muted; localStorage.setItem('kol_muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; },
  };
})();
['pointerdown', 'touchstart', 'click'].forEach((ev) =>
  window.addEventListener(ev, () => Sound.unlock(), { once: true, passive: true }));

// ── Утилиты ─────────────────────────────────────────────────────────
const fmt = (n) => Math.round(n || 0).toLocaleString('ru-RU');
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function clockLong(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 1) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

// ── Рендер состояния ────────────────────────────────────────────────
let bannerTimer = null;
function render(st) {
  // статус
  const status = $('status');
  if (st.status && st.status.connected) {
    status.textContent = '🟢 ' + (st.status.username || 'в эфире');
    status.classList.add('online');
  } else {
    status.textContent = 'офлайн';
    status.classList.remove('online');
  }

  const card = $('kingCard');
  if (st.hasKing && st.king) {
    const k = st.king;
    $('kingAvatar').textContent = emojiFor(k.name);
    $('kingName').textContent = k.name;
    $('throneTime').textContent = clock(k.throneSeconds);
    $('hpText').textContent = `${fmt(k.hp)} / ${fmt(k.maxHp)}`;
    $('hpFill').style.width = Math.max(0, k.hpPercent) + '%';
    $('bountyValue').textContent = fmt(k.bounty);
    card.classList.add('has-king');
    card.classList.toggle('shielded', !!k.shield);
    $('shieldTag').classList.toggle('show', !!k.shield);
  } else {
    $('kingAvatar').textContent = '🪑';
    $('kingName').textContent = 'Трон свободен';
    $('throneTime').textContent = '00:00';
    $('hpText').textContent = '—';
    $('hpFill').style.width = '0%';
    $('bountyValue').textContent = fmt(st.king ? st.king.bounty : 1000);
    card.classList.remove('has-king');
    card.classList.remove('shielded');
    $('shieldTag').classList.remove('show');
  }

  // топ охотников
  renderRank($('topHunters'), st.topHunters, (h) => `${fmt(h.dmg)} урона`, 'Пока никто не атаковал');
  // топ королей
  renderRank($('topKings'), st.topKings, (k) => clockLong(k.seconds), 'Ещё нет Королей');
  // топ убийц
  renderRank($('topKillers'), st.topKillers, (k) => `${k.kills} ☠️`, 'Ещё нет убийств');

  // рекорды
  $('recAll').textContent = st.records && st.records.allTime ? `${st.records.allTime.name} — ${clock(st.records.allTime.seconds)}` : '—';
  $('recDay').textContent = st.records && st.records.day ? `${st.records.day.name} — ${clock(st.records.day.seconds)}` : '—';
  $('recWeek').textContent = st.records && st.records.week ? `${st.records.week.name} — ${clock(st.records.week.seconds)}` : '—';
}

function renderRank(el, list, valFn, emptyText) {
  el.innerHTML = '';
  if (!list || !list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  list.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('top1');
    li.innerHTML = `<span class="pos">${i + 1}</span><span class="nm">${esc(it.name)}</span><span class="val">${valFn(it)}</span>`;
    el.appendChild(li);
  });
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function emojiFor(name) {
  const pool = ['🤴', '👑', '🧛', '🦹', '🧙', '🦸', '👸', '🧝', '🐉', '🦁'];
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

// ── Сокет-события ───────────────────────────────────────────────────
socket.on('state', render);

socket.on('hit', (d) => {
  shakeKing();
  popDamage(d);
  if (d.critX) Sound.crit(d.critX); else Sound.hit();
});

socket.on('heal', (d) => {
  popText('+HP', 'heal');
  Sound.heal();
});

socket.on('blocked', () => {
  popText('🛡️', '');
  Sound.shield();
});

socket.on('crown', (d) => {
  $('crownName').textContent = d.name;
  showOverlay('crownOverlay', 2200);
  Sound.crown();
});

socket.on('fell', (d) => {
  $('fellKiller').textContent = d.killer;
  $('fellReward').textContent = fmt(d.reward) + ' очков';
  const card = $('kingCard');
  card.classList.add('dead');
  setTimeout(() => card.classList.remove('dead'), 2600);
  showOverlay('fellOverlay', 2600);
  Sound.fell();
});

socket.on('record', (d) => {
  $('recordName').textContent = d.name;
  $('recordTime').textContent = clock(d.seconds);
  setTimeout(() => showOverlay('recordOverlay', 2400), 600);
  Sound.record();
});

socket.on('event', (d) => {
  showBanner(`${d.icon} ${d.title}`, d.durationMs);
  Sound.event();
});

socket.on('feed', addFeed);

// ── Анимации ────────────────────────────────────────────────────────
let shakeTimer = null;
function shakeKing() {
  const card = $('kingCard');
  card.classList.add('shake');
  clearTimeout(shakeTimer);
  shakeTimer = setTimeout(() => card.classList.remove('shake'), 280);
}

function popDamage(d) {
  const pop = document.createElement('div');
  pop.className = 'pop' + (d.critX ? ' crit' : '');
  pop.textContent = (d.critX ? `КРИТ x${d.critX} ` : '') + '-' + fmt(d.damage);
  pop.style.left = (38 + Math.random() * 24) + '%';
  $('popLayer').appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
}
function popText(text, cls) {
  const pop = document.createElement('div');
  pop.className = 'pop ' + cls;
  pop.textContent = text;
  pop.style.left = (38 + Math.random() * 24) + '%';
  $('popLayer').appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
}

function showOverlay(id, ms) {
  const ov = $(id);
  ov.classList.add('show');
  setTimeout(() => ov.classList.remove('show'), ms);
}

function showBanner(text, durationMs) {
  const eb = $('eventBanner');
  eb.innerHTML = `<div class="eb">${esc(text)}</div>`;
  eb.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => eb.classList.remove('show'), Math.max(3000, durationMs || 4000));
}

const feedEl = $('feed');
function addFeed(item) {
  const li = document.createElement('li');
  li.className = ['', item.gold ? 'gold' : '', item.win ? 'win' : '', item.heal ? 'heal' : '', item.shield ? 'shield' : '', item.event ? 'event' : ''].join(' ').trim();
  li.innerHTML = `<span class="fi">${item.icon || '•'}</span><span>${esc(item.text)}</span>`;
  feedEl.prepend(li);
  while (feedEl.children.length > 40) feedEl.removeChild(feedEl.lastChild);
}

// ── Управление ──────────────────────────────────────────────────────
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()).catch(() => ({ ok: false }));

$('gearBtn').onclick = () => $('settings').classList.add('open');
$('closeGear').onclick = () => $('settings').classList.remove('open');
$('settings').onclick = (e) => { if (e.target.id === 'settings') $('settings').classList.remove('open'); };

const soundBtn = $('soundBtn');
soundBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
soundBtn.onclick = () => {
  const m = Sound.toggle();
  soundBtn.textContent = m ? '🔇' : '🔊';
  if (!m) Sound.crown();
};

$('connectBtn').onclick = async () => {
  const username = $('usernameInput').value.trim();
  const msg = $('connMsg');
  msg.className = 'conn-msg'; msg.textContent = 'Подключаюсь…';
  const r = await api('/api/connect', { username });
  if (r.ok) { msg.className = 'conn-msg ok'; msg.textContent = '✅ Подключено!'; }
  else { msg.className = 'conn-msg err'; msg.textContent = '⚠️ ' + (r.error || 'Не удалось подключиться'); }
};
$('disconnectBtn').onclick = async () => {
  await api('/api/disconnect');
  $('connMsg').className = 'conn-msg'; $('connMsg').textContent = 'Отключено';
};
$('resetBtn').onclick = async () => { await api('/api/reset'); $('settings').classList.remove('open'); };

$('testBtn').onclick = () => api('/api/simulate');
$('eventBtn').onclick = () => api('/api/effect', { kind: 'event' });
$('healSelfBtn').onclick = () => api('/api/simulate-heal');

document.querySelectorAll('[data-effect]').forEach((b) =>
  b.onclick = () => api('/api/effect', { kind: b.getAttribute('data-effect') }));

// табы
document.querySelectorAll('.tab').forEach((tab) =>
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.getAttribute('data-tab');
    $('topKings').classList.toggle('hidden', which !== 'kings');
    $('topKillers').classList.toggle('hidden', which !== 'killers');
  });

// ── Фоновая анимация: непрерывные искры/угольки ─────────────────────
(function ambientFX() {
  const layer = document.getElementById('fxLayer');
  if (!layer) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  function spawn() {
    const d = document.createElement('div');
    const purple = Math.random() < 0.4;
    d.className = 'fx-dot' + (purple ? ' purple' : '');
    const size = 4 + Math.random() * 8;
    d.style.width = size + 'px';
    d.style.height = size + 'px';
    d.style.left = (Math.random() * 100) + 'vw';
    d.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
    const dur = 7 + Math.random() * 7;
    d.style.animationDuration = dur + 's';
    layer.appendChild(d);
    setTimeout(() => d.remove(), dur * 1000 + 200);
  }

  // лёгкая плотность, чтобы не грузить мобильные
  for (let i = 0; i < 10; i++) setTimeout(spawn, Math.random() * 6000);
  setInterval(() => {
    if (document.hidden) return;            // не плодим в фоне вкладки
    if (layer.childElementCount < 26) spawn();
  }, 650);
})();
