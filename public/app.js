'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');

let bossBg = 'fire';

// ── Звук (Web Audio, без файлов) ────────────────────────────────────
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('bvv_muted') === '1';
  function ensure() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // тон: частота, длительность, тип, громкость, glide-к частоте
  function tone(freq, dur, type = 'sine', gain = 0.2, toFreq = null, delay = 0) {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq) osc.frequency.exponentialRampToValueAtTime(toFreq, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  // шум (взрыв)
  function noise(dur, gain = 0.35) {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime;
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    src.connect(lp); lp.connect(g); g.connect(c.destination);
    src.start(t0); src.stop(t0 + dur);
  }
  return {
    hit() { tone(420, 0.09, 'square', 0.12, 220); },
    crit(x) { tone(720, 0.12, 'sawtooth', 0.2, 360); tone(1080, 0.14, 'square', 0.12, 540, 0.04); if (x >= 5) tone(1440, 0.16, 'sawtooth', 0.12, 700, 0.08); },
    mvp() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.18, null, i * 0.09)); },
    defeated() { noise(0.6, 0.4); tone(180, 0.7, 'sawtooth', 0.25, 50); tone(90, 0.8, 'square', 0.18, 40, 0.05); },
    isMuted() { return muted; },
    unlock() { ensure(); },
    toggle() { muted = !muted; localStorage.setItem('bvv_muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; }
  };
})();
// разблокировать аудио на первом касании (требование мобильных браузеров)
['pointerdown', 'touchstart', 'click'].forEach(ev =>
  window.addEventListener(ev, () => Sound.unlock(), { once: true, passive: true }));

// ── Состояние ───────────────────────────────────────────────────────
socket.on('state', render);
socket.on('hall', (d) => renderHall(d.hall || []));

function render(s) {
  // статус
  const st = $('status');
  if (s.status && s.status.connected) {
    st.textContent = 'в эфире @' + s.status.username;
    st.classList.add('on');
  } else {
    st.textContent = 'офлайн';
    st.classList.remove('on');
  }

  // MVP
  const mvpEl = $('mvp');
  if (s.mvp) {
    mvpEl.classList.remove('empty');
    $('mvpName').textContent = s.mvp.name;
    $('mvpSub').textContent = `${s.mvp.level} • урон боссу ${fmt(s.mvp.damage)}`;
    $('mvpStreak').textContent = 'MVP x' + (s.mvp.streak || 1);
  } else {
    mvpEl.classList.add('empty');
    $('mvpName').textContent = '—';
    $('mvpSub').textContent = 'пока никто не атаковал';
    $('mvpStreak').textContent = 'x0';
  }

  // Босс
  const b = s.boss;
  $('bossName').textContent = b.name;
  $('bossEmoji').textContent = b.emoji;
  if (b.bg !== bossBg) {
    bossBg = b.bg;
    $('bossBg').className = 'bgglow bg-' + b.bg;
  }
  $('hpFill').style.width = Math.max(0, b.percent) + '%';
  $('hpText').textContent = b.alive ? `${fmt(b.hp)} HP` : 'ПОВЕРЖЕН';
  $('hpNum').textContent = `${fmt(b.hp)} / ${fmt(b.maxHp)}`;
  $('hpPct').textContent = Math.round(b.percent) + '%';

  // отсчёт возрождения
  const rb = $('respawn');
  if (s.respawn && s.respawn.active) {
    rb.classList.add('show');
    $('respawnNum').textContent = s.respawn.secondsLeft;
  } else {
    rb.classList.remove('show');
  }

  // топ-10
  renderTop(s.top || []);

  // счётчик в оверлее победы
  $('vCount').textContent = fmt(s.killCount || 0);
}

function renderTop(top) {
  const ul = $('top');
  if (!top.length) {
    ul.innerHTML = '<li class="top-empty">Ещё никто не наносил урон — будь первым!</li>';
    return;
  }
  ul.innerHTML = top.map((p) => `
    <li class="${p.rank <= 3 ? 'g' + p.rank : ''} ${p.isMvp ? 'is-mvp' : ''}">
      <div class="rk">${p.rank}</div>
      <div class="pn">${esc(p.name)}<span class="lvl">${esc(p.level)}</span></div>
      <div class="pd">${fmt(p.damage)}</div>
    </li>`).join('');
}

// ── Живая лента ─────────────────────────────────────────────────────
socket.on('feed', (item) => {
  const ul = $('feed');
  const li = document.createElement('li');
  if (item.gold) li.className = 'gold';
  if (item.win) li.className = 'win';
  li.innerHTML = `<span class="fi">${item.icon || '•'}</span><span class="ft">${esc(item.text)}</span>`;
  ul.prepend(li);
  while (ul.children.length > 40) ul.removeChild(ul.lastChild);
});

// ── Удар: тряска + всплывающий урон ─────────────────────────────────
socket.on('hit', (d) => {
  const emoji = $('bossEmoji');
  emoji.classList.remove('shake');
  void emoji.offsetWidth; // restart animation
  emoji.classList.add('shake');

  const pop = document.createElement('div');
  pop.className = 'dmg-pop' + (d.critX ? ' crit' : '');
  pop.style.left = (35 + Math.random() * 30) + '%';
  pop.textContent = (d.critX ? `КРИТ x${d.critX} ` : '') + '-' + fmt(d.damage);
  $('popLayer').appendChild(pop);
  setTimeout(() => pop.remove(), 1000);
  if (d.critX) Sound.crit(d.critX); else Sound.hit();
});

// ── Новый MVP ───────────────────────────────────────────────────────
let mvpTimer = null;
socket.on('newmvp', (d) => {
  $('mvpOverlayName').textContent = d.name;
  const ov = $('mvpOverlay');
  ov.classList.add('show');
  clearTimeout(mvpTimer);
  mvpTimer = setTimeout(() => ov.classList.remove('show'), 1800);
  Sound.mvp();
});

// ── Победа над боссом ───────────────────────────────────────────────
socket.on('defeated', (d) => {
  // взрыв
  const emoji = $('bossEmoji');
  emoji.classList.remove('shake');
  emoji.classList.add('dead');
  setTimeout(() => emoji.classList.remove('dead'), 700);

  $('vKiller').textContent = d.killer;
  $('vMvp').textContent = d.mvp;
  const ov = $('victoryOverlay');
  ov.classList.add('show');
  setTimeout(() => ov.classList.remove('show'), (d.respawnSeconds || 10) * 1000 - 1500);
  Sound.defeated();
});

socket.on('respawn', (d) => {
  $('respawn').classList.add('show');
  $('respawnNum').textContent = d.secondsLeft;
});
socket.on('newboss', () => {
  $('respawn').classList.remove('show');
  $('victoryOverlay').classList.remove('show');
});

// ── Управление ──────────────────────────────────────────────────────
$('gearBtn').onclick = () => $('settings').classList.toggle('open');

const soundBtn = $('soundBtn');
if (soundBtn) {
  soundBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
  soundBtn.onclick = () => {
    const m = Sound.toggle();
    soundBtn.textContent = m ? '🔇' : '🔊';
    if (!m) Sound.mvp(); // короткий сигнал «звук включён»
  };
}

$('connectBtn').onclick = async () => {
  const username = $('username').value.trim();
  if (!username) { showErr('Введите @username TikTok-лайва'); return; }
  showErr('');
  $('connectBtn').textContent = '...';
  try {
    const r = await api('/api/connect', { username });
    if (!r.ok) showErr(r.error || 'Не удалось подключиться');
  } catch (e) { showErr('Ошибка соединения'); }
  $('connectBtn').textContent = 'Подключить';
};

function bindSim(btn) { if (btn) btn.onclick = () => api('/api/simulate', {}); }
bindSim($('simBtn')); bindSim($('simBtn2'));
$('resetBtn').onclick = () => api('/api/reset', {});

$('hallBtn').onclick = async () => {
  const r = await fetch('/api/hall').then((x) => x.json()).catch(() => ({ hall: [] }));
  renderHall(r.hall || []);
  $('hallOverlay').classList.add('show');
};
$('hallClose').onclick = () => $('hallOverlay').classList.remove('show');
$('hallOverlay').onclick = (e) => { if (e.target.id === 'hallOverlay') $('hallOverlay').classList.remove('show'); };

function renderHall(hall) {
  const ul = $('hallList');
  if (!hall.length) {
    ul.innerHTML = '<li class="hall-empty">Пока никто не повержен. Стань первым героем!</li>';
    return;
  }
  ul.innerHTML = hall.map((h) => `
    <li>
      <span class="hk">⚔️</span>
      <span class="hn"><b>${esc(h.player)}</b><span>повержен: ${esc(h.boss)} • ${timeAgo(h.time)}</span></span>
      <span class="hd">${fmt(h.damage)}</span>
    </li>`).join('');
}

// ── Утилиты ─────────────────────────────────────────────────────────
async function api(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({ ok: r.ok }));
}
function showErr(m) { $('err').textContent = m; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + ' сек назад';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' мин назад';
  const h = Math.floor(min / 60);
  return h + ' ч назад';
}
