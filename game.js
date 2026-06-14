'use strict';

const CFG = require('./config');

/**
 * Движок боя «Boss vs Viewers».
 * Хранит босса, игроков, MVP с серией, Зал Славы. Всё в памяти.
 */
class BossBattle {
  constructor() {
    this.reset();
  }

  reset() {
    this.players = new Map(); // id -> { id, name, total, boss }
    this.hallOfFame = [];     // последние убийцы боссов
    this.killCount = 0;
    this.feedSeq = 0;
    this.currentMvpId = null;
    this.mvpStreak = 0;
    this.respawnAt = null;    // timestamp, когда появится новый босс
    this.lastBossIndex = -1;
    this._spawnBoss();
  }

  // ── БОСС ────────────────────────────────────────────────────────────
  _spawnBoss() {
    const pool = CFG.BOSSES;
    let idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && idx === this.lastBossIndex) idx = (idx + 1) % pool.length;
    this.lastBossIndex = idx;
    const def = pool[idx];
    const maxHp = CFG.BOSS_HP_POOL[Math.floor(Math.random() * CFG.BOSS_HP_POOL.length)];
    this.boss = {
      name: def.name,
      emoji: def.emoji,
      bg: def.bg,
      maxHp,
      hp: maxHp,
      alive: true,
      bornAt: Date.now(),
    };
    // статистика урона по боссу обнуляется для всех игроков
    for (const p of this.players.values()) p.boss = 0;
    this.currentMvpId = null;
    this.mvpStreak = 0;
    this.respawnAt = null;
  }

  // ── ИГРОКИ / УРОВНИ ────────────────────────────────────────────────
  _player(id, name) {
    let p = this.players.get(id);
    if (!p) {
      p = { id, name: name || 'Зритель', total: 0, boss: 0 };
      this.players.set(id, p);
    } else if (name) {
      p.name = name;
    }
    return p;
  }

  levelOf(total) {
    let title = CFG.LEVELS[0].title;
    for (const lv of CFG.LEVELS) if (total >= lv.min) title = lv.title;
    return title;
  }

  // ── ОСНОВНОЕ: УДАР ПОДАРКОМ ────────────────────────────────────────
  /**
   * Возвращает массив событий для трансляции:
   *  { kind:'hit'|'crit'|'mvp'|'defeated', ... }
   */
  applyGift({ userId, user, giftName, diamondCount = 1, repeatCount = 1, flatBase = null, verb = 'нанёс', hitIcon = null }) {
    const events = [];
    // во время отсчёта до нового босса урон не проходит
    if (!this.boss.alive) return events;

    const unit = flatBase != null ? flatBase : giftToDamage(giftName, diamondCount);
    const base = unit * Math.max(1, repeatCount);

    // крит
    let mult = 1;
    let critX = 0;
    if (Math.random() < CFG.CRIT.chance) {
      critX = Math.random() < CFG.CRIT.x5Chance ? 5 : 2;
      mult = critX;
    }
    const damage = Math.round(base * mult);
    const dealt = Math.min(damage, this.boss.hp);

    const id = userId || user || 'anon';
    const p = this._player(id, user);
    p.total += dealt;
    p.boss += dealt;
    this.boss.hp -= dealt;

    const feedText = critX
      ? `${user} нанёс КРИТ x${critX} — ${fmt(damage)} урона`
      : `${user} ${verb} ${fmt(damage)} урона`;
    events.push({
      kind: 'hit',
      id: ++this.feedSeq,
      icon: critX ? '💥' : (hitIcon || pickHitIcon(damage)),
      text: feedText,
      damage,
      critX,
      hpPercent: this.percent(),
    });

    // смена MVP?
    const mvpChanged = this._recomputeMvp();
    if (mvpChanged && this.currentMvpId) {
      const mvp = this.players.get(this.currentMvpId);
      events.push({
        kind: 'mvp',
        id: ++this.feedSeq,
        icon: '👑',
        text: `${mvp.name} стал новым MVP`,
        name: mvp.name,
      });
    }

    // босс повержен?
    if (this.boss.hp <= 0) {
      this.boss.hp = 0;
      this.boss.alive = false;
      this.killCount += 1;
      this.respawnAt = Date.now() + CFG.RESPAWN_SECONDS * 1000;

      const mvp = this.currentMvpId ? this.players.get(this.currentMvpId) : p;
      const record = {
        player: p.name,
        boss: this.boss.name,
        damage: p.boss,
        mvp: mvp ? mvp.name : p.name,
        time: Date.now(),
      };
      this.hallOfFame.unshift(record);
      if (this.hallOfFame.length > CFG.HALL_OF_FAME_LIMIT) this.hallOfFame.pop();

      events.push({
        kind: 'defeated',
        id: ++this.feedSeq,
        icon: '🏆',
        text: `${p.name} нанёс последний удар! ${this.boss.name} повержен`,
        killer: p.name,
        boss: this.boss.name,
        mvp: mvp ? mvp.name : p.name,
        respawnSeconds: CFG.RESPAWN_SECONDS,
      });
    }

    return events;
  }

  // пересчёт MVP по урону текущему боссу. true, если лидер сменился
  _recomputeMvp() {
    let leader = null;
    for (const p of this.players.values()) {
      if (p.boss <= 0) continue;
      if (!leader || p.boss > leader.boss) leader = p;
    }
    const newId = leader ? leader.id : null;
    if (newId && newId !== this.currentMvpId) {
      this.currentMvpId = newId;
      this.mvpStreak = 1;
      return true;
    }
    return false;
  }

  // вызывается раз в минуту: если MVP держится — серия растёт
  tickMvpStreak() {
    if (this.currentMvpId && this.boss.alive) {
      this.mvpStreak += 1;
      return this.mvpStreak;
    }
    return 0;
  }

  // проверка таймера возрождения. Возвращает нового босса, если появился
  tickRespawn() {
    if (!this.boss.alive && this.respawnAt && Date.now() >= this.respawnAt) {
      this._spawnBoss();
      return this.boss;
    }
    return null;
  }

  // ── СНИМОК СОСТОЯНИЯ ДЛЯ ИНТЕРФЕЙСА ────────────────────────────────
  percent() {
    return this.boss.maxHp ? Math.max(0, (this.boss.hp / this.boss.maxHp) * 100) : 0;
  }

  top(n = CFG.TOP_N) {
    const arr = [...this.players.values()]
      .filter((p) => p.boss > 0)
      .sort((a, b) => b.boss - a.boss)
      .slice(0, n);
    return arr.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      damage: p.boss,
      level: this.levelOf(p.total),
      isMvp: p.id === this.currentMvpId,
    }));
  }

  mvp() {
    if (!this.currentMvpId) return null;
    const p = this.players.get(this.currentMvpId);
    if (!p) return null;
    return {
      name: p.name,
      damage: p.boss,
      total: p.total,
      streak: this.mvpStreak,
      level: this.levelOf(p.total),
    };
  }

  respawnLeft() {
    if (this.boss.alive || !this.respawnAt) return 0;
    return Math.max(0, Math.ceil((this.respawnAt - Date.now()) / 1000));
  }

  snapshot(status = {}) {
    return {
      status,
      boss: {
        name: this.boss.name,
        emoji: this.boss.emoji,
        bg: this.boss.bg,
        hp: Math.round(this.boss.hp),
        maxHp: this.boss.maxHp,
        percent: this.percent(),
        alive: this.boss.alive,
      },
      mvp: this.mvp(),
      top: this.top(),
      respawn: { active: !this.boss.alive, secondsLeft: this.respawnLeft() },
      killCount: this.killCount,
      players: this.players.size,
    };
  }

  hall() {
    return this.hallOfFame.map((r) => ({
      player: r.player,
      boss: r.boss,
      damage: r.damage,
      time: r.time,
    }));
  }
}

// ── ХЕЛПЕРЫ ──────────────────────────────────────────────────────────
function giftToDamage(giftName, diamondCount) {
  const key = String(giftName || '').trim().toLowerCase();
  if (key && CFG.GIFT_DAMAGE.byName[key] != null) return CFG.GIFT_DAMAGE.byName[key];
  const d = Number(diamondCount) || 1;
  for (const tier of CFG.GIFT_DAMAGE.byDiamondTier) {
    if (d <= tier.maxDiamonds) return tier.damage;
  }
  return CFG.GIFT_DAMAGE.default;
}

function pickHitIcon(damage) {
  if (damage >= 2000) return '🚀';
  if (damage >= 500) return '💣';
  if (damage >= 100) return '⚔️';
  if (damage >= 25) return '🔥';
  return '🌹';
}

function fmt(n) {
  return Number(n).toLocaleString('ru-RU');
}

module.exports = { BossBattle, giftToDamage };
