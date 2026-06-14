'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');

let bossBg = 'fire';

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
});

// ── Новый MVP ───────────────────────────────────────────────────────
let mvpTimer = null;
socket.on('newmvp', (d) => {
  $('mvpOverlayName').textContent = d.name;
  const ov = $('mvpOverlay');
  ov.classList.add('show');
  clearTimeout(mvpTimer);
  mvpTimer = setTimeout(() => ov.classList.remove('show'), 1800);
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
