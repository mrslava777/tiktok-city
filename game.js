'use strict';

const CFG = require('./config');

/**
 * Игровая логика «King of Live».
 * Один Король на эфире. Охотники сбивают его подарками. Кто нанёс
 * последний удар — становится новым Королём. Награда за голову растёт
 * со временем. Всё хранится в памяти (без базы данных).
 */
class KingOfLive {
  constructor() {
    this.reset(true);
  }

  reset(full = false) {
    this.king = null;                 // текущий Король (или null — трон свободен)
    this.feedSeq = 0;
    this.effects = {                  // активные модификаторы
      dmgMult: 1, dmgMultUntil: 0,    // Восстание / Час охоты
      bountyMult: 1, bountyMultUntil: 0, // Двойная награда
    };
    if (full) {
      this.kingsBoard = new Map();    // id → { name, bestSeconds }  (ТОП Королей)
      this.killers = new Map();       // id → { name, kills, points } (ТОП убийц)
      this.records = {
        allTime: null,                // { name, seconds }
        day: null,                    // { name, seconds, key }
        week: null,                   // { name, seconds, key }
      };
      this.totalReigns = 0;
    }
  }

  // ── Главный обработчик подарка/лайка ──────────────────────────────
  // Возвращает массив событий для трансляции клиентам.
  applyGift({ userId, user, giftName, diamondCount = 1, repeatCount = 1, flatBase = null, isLike = false }) {
    const events = [];
    const id = userId || user || 'anon';
    const name = user || 'Зритель';
    const now = Date.now();

    // ── Трон свободен → первый подарок коронует (лайки не коронуют) ──
    if (!this.king) {
      if (isLike) return events;
      this._crown(id, name, now);
      events.push({
        kind: 'crown',
        id: ++this.feedSeq,
        icon: '👑',
        text: `${name} захватил трон и стал КОРОЛЁМ`,
        name,
        first: true,
      });
      return events;
    }

    // ── Король дарит сам себе → лечение (защита) ──────────────────────
    if (id === this.king.id && !isLike) {
      const heal = healAmount(giftName, diamondCount) * Math.max(1, repeatCount);
      const before = this.king.hp;
      this.king.hp = Math.min(this.king.maxHp, this.king.hp + heal);
      const gained = this.king.hp - before;
      events.push({
        kind: 'heal',
        id: ++this.feedSeq,
        icon: '💚',
        text: `Король восстановил +${fmt(gained)} HP`,
        hp: this.king.hp,
        hpPercent: this.percent(),
      });
      return events;
    }
    // Король лайкает сам себя — игнорируем
    if (id === this.king.id && isLike) return events;

    // ── Охотник атакует Короля ───────────────────────────────────────
    // щит — иммунитет
    if (this.king.shieldUntil && now < this.king.shieldUntil) {
      events.push({
        kind: 'blocked',
        id: ++this.feedSeq,
        icon: '🛡️',
        text: `🛡️ Щит Короля поглотил удар от ${name}`,
        hpPercent: this.percent(),
      });
      return events;
    }

    const unit = flatBase != null ? flatBase : giftToDamage(giftName, diamondCount);
    let base = unit * Math.max(1, repeatCount);
    // множитель активного события (Восстание / Час охоты)
    const dmgMult = now < this.effects.dmgMultUntil ? this.effects.dmgMult : 1;
    base *= dmgMult;

    // крит
    let critX = 0;
    if (Math.random() < CFG.CRIT.chance) {
      critX = Math.random() < CFG.CRIT.x5Chance ? 5 : 2;
    }
    const damage = Math.round(base * (critX || 1));
    const dealt = Math.min(damage, this.king.hp);
    this.king.hp -= dealt;

    // учёт урона охотника по текущему Королю
    const h = this.king.hunters.get(id) || { name, dmg: 0 };
    h.name = name;
    h.dmg += dealt;
    this.king.hunters.set(id, h);

    const verb = isLike ? `${name} лайками (${repeatCount})` : name;
    const hitText = critX
      ? `${verb} — КРИТ x${critX} — ${fmt(damage)} урона`
      : `${verb} нанёс ${fmt(damage)} урона`;
    events.push({
      kind: 'hit',
      id: ++this.feedSeq,
      icon: critX ? '💥' : (isLike ? '❤️' : pickHitIcon(damage)),
      text: hitText,
      damage,
      critX,
      hpPercent: this.percent(),
    });

    // ── Король пал ───────────────────────────────────────────────────
    if (this.king.hp <= 0) {
      const fallen = this.king;
      const reignSeconds = Math.floor((now - fallen.throneStart) / 1000);
      const reward = this._bountyValue();

      // очки и убийство — нанёсшему последний удар
      const k = this.killers.get(id) || { name, kills: 0, points: 0 };
      k.name = name;
      k.kills += 1;
      k.points += reward;
      this.killers.set(id, k);

      // обновляем рекорды и таблицу Королей по времени павшего
      const recBroken = this._registerReign(fallen.id, fallen.name, reignSeconds, now);
      this.totalReigns += 1;

      events.push({
        kind: 'fell',
        id: ++this.feedSeq,
        icon: '⚔️',
        text: `${name} убил Короля ${fallen.name} (${clock(reignSeconds)}) и получил ${fmt(reward)} очков`,
        fallenName: fallen.name,
        killer: name,
        reward,
        reignSeconds,
        recordBroken: recBroken,
      });

      if (recBroken) {
        events.push({
          kind: 'record',
          id: ++this.feedSeq,
          icon: '🏆',
          text: `🏆 Новый рекорд трона: ${fallen.name} — ${clock(reignSeconds)}`,
          name: fallen.name,
          seconds: reignSeconds,
        });
      }

      // последний бивший становится новым Королём
      this._crown(id, name, now);
      events.push({
        kind: 'crown',
        id: ++this.feedSeq,
        icon: '👑',
        text: `${name} взошёл на трон — новый КОРОЛЬ!`,
        name,
        first: false,
      });
    }

    return events;
  }

  // ── Коронация ─────────────────────────────────────────────────────
  _crown(id, name, now) {
    this.king = {
      id,
      name,
      hp: CFG.KING_HP,
      maxHp: CFG.KING_HP,
      throneStart: now,
      bountySeconds: 0,     // «возраст» для расчёта награды (растёт быстрее на событии)
      shieldUntil: 0,
      hunters: new Map(),   // id → { name, dmg } по текущему правлению
    };
    // сбрасываем боевые эффекты при смене Короля
    this.effects.dmgMult = 1; this.effects.dmgMultUntil = 0;
    this.effects.bountyMult = 1; this.effects.bountyMultUntil = 0;
  }

  // ── Тик раз в секунду: рост награды и истечение эффектов ───────────
  tick() {
    const now = Date.now();
    if (this.king) {
      const bMult = now < this.effects.bountyMultUntil ? this.effects.bountyMult : 1;
      this.king.bountySeconds += bMult;
    }
    // истечение эффектов фиксируется при чтении (по времени) — отдельно чистить не нужно
    return now;
  }

  // ── Случайное событие трона ───────────────────────────────────────
  // Возвращает событие для ленты/баннера или null.
  triggerRandomEvent() {
    if (!this.king) return null;
    const now = Date.now();
    const pool = [
      {
        key: 'uprising', icon: '🔥', title: 'ВОССТАНИЕ',
        text: '🔥 Восстание! Урон по Королю x2',
        apply: () => { this.effects.dmgMult = CFG.EVENT_DMG_MULT; this.effects.dmgMultUntil = now + CFG.EVENT_DMG_MS; },
        durationMs: CFG.EVENT_DMG_MS,
      },
      {
        key: 'guard', icon: '🛡️', title: 'КОРОЛЕВСКАЯ СТРАЖА',
        text: '🛡️ Королевская стража! Король под щитом',
        apply: () => { this.king.shieldUntil = now + CFG.SHIELD_MS; },
        durationMs: CFG.SHIELD_MS,
      },
      {
        key: 'double', icon: '💰', title: 'ДВОЙНАЯ НАГРАДА',
        text: '💰 Двойная награда! Цена за голову растёт быстрее',
        apply: () => { this.effects.bountyMult = CFG.EVENT_DOUBLE_BOUNTY_MULT; this.effects.bountyMultUntil = now + CFG.EVENT_DOUBLE_BOUNTY_MS; },
        durationMs: CFG.EVENT_DOUBLE_BOUNTY_MS,
      },
      {
        key: 'hunt', icon: '⚔️', title: 'ЧАС ОХОТЫ',
        text: '⚔️ Час охоты! Все атаки усилены x2',
        apply: () => { this.effects.dmgMult = CFG.EVENT_DMG_MULT; this.effects.dmgMultUntil = now + CFG.EVENT_DMG_MS; },
        durationMs: CFG.EVENT_DMG_MS,
      },
    ];
    const ev = pool[Math.floor(Math.random() * pool.length)];
    ev.apply();
    return {
      kind: 'event', key: ev.key, icon: ev.icon, title: ev.title,
      text: ev.text, durationMs: ev.durationMs,
      id: ++this.feedSeq,
    };
  }

  // ── Ручные спец-эффекты (для теста/механики) ──────────────────────
  activateShield() {
    if (!this.king) return null;
    this.king.shieldUntil = Date.now() + CFG.SHIELD_MS;
    return { kind: 'event', key: 'shield', icon: '🛡️', title: 'ЩИТ',
      text: '🛡️ Король активировал щит', durationMs: CFG.SHIELD_MS, id: ++this.feedSeq };
  }
  activateBerserk() {
    if (!this.king) return null;
    this.effects.dmgMult = CFG.BERSERK_MULT;
    this.effects.dmgMultUntil = Date.now() + CFG.BERSERK_MS;
    return { kind: 'event', key: 'berserk', icon: '⚡', title: 'БЕРСЕРК',
      text: `⚡ Берсерк! Урон охотников x${CFG.BERSERK_MULT}`, durationMs: CFG.BERSERK_MS, id: ++this.feedSeq };
  }
  activateHeal() {
    if (!this.king) return null;
    const before = this.king.hp;
    this.king.hp = Math.min(this.king.maxHp, this.king.hp + this.king.maxHp * CFG.HEAL_PERCENT);
    const gained = Math.round(this.king.hp - before);
    return { kind: 'event', key: 'heal', icon: '💚', title: 'ЛЕЧЕНИЕ',
      text: `💚 Король вылечился на +${fmt(gained)} HP`, durationMs: 0, id: ++this.feedSeq,
      hpPercent: this.percent() };
  }

  // ── Рекорды и таблица Королей ─────────────────────────────────────
  _registerReign(id, name, seconds, now) {
    // персональный рекорд для ТОП Королей
    const b = this.kingsBoard.get(id) || { name, bestSeconds: 0 };
    b.name = name;
    if (seconds > b.bestSeconds) b.bestSeconds = seconds;
    this.kingsBoard.set(id, b);

    let broken = false;
    // рекорд за всё время
    if (!this.records.allTime || seconds > this.records.allTime.seconds) {
      this.records.allTime = { name, seconds };
      broken = true;
    }
    // рекорд дня
    const dayKey = dayKeyOf(now);
    if (!this.records.day || this.records.day.key !== dayKey || seconds > this.records.day.seconds) {
      if (!this.records.day || this.records.day.key !== dayKey) this.records.day = { name, seconds, key: dayKey };
      else if (seconds > this.records.day.seconds) this.records.day = { name, seconds, key: dayKey };
    }
    // рекорд недели
    const weekKey = weekKeyOf(now);
    if (!this.records.week || this.records.week.key !== weekKey || seconds > this.records.week.seconds) {
      if (!this.records.week || this.records.week.key !== weekKey) this.records.week = { name, seconds, key: weekKey };
      else if (seconds > this.records.week.seconds) this.records.week = { name, seconds, key: weekKey };
    }
    return broken;
  }

  // ── Награда за голову (по «возрасту» правления) ───────────────────
  _bountyValue() {
    if (!this.king) return 0;
    const s = this.king.bountySeconds;
    const sch = CFG.BOUNTY_SCHEDULE;
    if (s <= sch[0][0]) return sch[0][1];
    for (let i = 1; i < sch.length; i++) {
      if (s <= sch[i][0]) {
        const [t0, v0] = sch[i - 1];
        const [t1, v1] = sch[i];
        const ratio = (s - t0) / (t1 - t0);
        return Math.round(v0 + (v1 - v0) * ratio);
      }
    }
    // за пределами расписания — продолжаем расти по последнему наклону
    const [t0, v0] = sch[sch.length - 2];
    const [t1, v1] = sch[sch.length - 1];
    const slope = (v1 - v0) / (t1 - t0);
    return Math.round(v1 + slope * (s - t1));
  }

  percent() {
    if (!this.king) return 0;
    return Math.max(0, Math.round((this.king.hp / this.king.maxHp) * 100));
  }

  topHunters(n = 5) {
    if (!this.king) return [];
    return [...this.king.hunters.values()]
      .sort((a, b) => b.dmg - a.dmg)
      .slice(0, n)
      .map((h) => ({ name: h.name, dmg: h.dmg }));
  }

  topKings(n = 10) {
    return [...this.kingsBoard.values()]
      .filter((k) => k.bestSeconds > 0)
      .sort((a, b) => b.bestSeconds - a.bestSeconds)
      .slice(0, n)
      .map((k) => ({ name: k.name, seconds: k.bestSeconds }));
  }

  topKillers(n = 10) {
    return [...this.killers.values()]
      .sort((a, b) => b.kills - a.kills || b.points - a.points)
      .slice(0, n)
      .map((k) => ({ name: k.name, kills: k.kills, points: k.points }));
  }

  // ── Снимок состояния для клиента ──────────────────────────────────
  snapshot(status) {
    const now = Date.now();
    const king = this.king
      ? {
          id: this.king.id,
          name: this.king.name,
          hp: Math.max(0, Math.round(this.king.hp)),
          maxHp: this.king.maxHp,
          hpPercent: this.percent(),
          bounty: this._bountyValue(),
          throneSeconds: Math.floor((now - this.king.throneStart) / 1000),
          shield: !!(this.king.shieldUntil && now < this.king.shieldUntil),
          shieldLeft: this.king.shieldUntil ? Math.max(0, Math.ceil((this.king.shieldUntil - now) / 1000)) : 0,
        }
      : null;

    const dmgBoost = now < this.effects.dmgMultUntil;
    const doubleBounty = now < this.effects.bountyMultUntil;

    return {
      status: status || { connected: false, username: null },
      hasKing: !!this.king,
      king,
      effects: {
        dmgBoost,
        dmgMult: dmgBoost ? this.effects.dmgMult : 1,
        doubleBounty,
        shield: king ? king.shield : false,
      },
      topHunters: this.topHunters(5),
      topKings: this.topKings(10),
      topKillers: this.topKillers(10),
      records: {
        allTime: this.records.allTime,
        day: this.records.day ? { name: this.records.day.name, seconds: this.records.day.seconds } : null,
        week: this.records.week ? { name: this.records.week.name, seconds: this.records.week.seconds } : null,
      },
      totalReigns: this.totalReigns,
    };
  }
}

// ── Хелперы урона/лечения ───────────────────────────────────────────
function giftToDamage(giftName, diamondCount) {
  const key = String(giftName || '').toLowerCase().trim();
  if (CFG.GIFT_DAMAGE.byName[key] != null) return CFG.GIFT_DAMAGE.byName[key];
  const d = Number(diamondCount) || 1;
  for (const tier of CFG.GIFT_DAMAGE.byDiamondTier) {
    if (d <= tier.maxDiamonds) return tier.damage;
  }
  return CFG.GIFT_DAMAGE.default;
}

function healAmount(giftName, diamondCount) {
  const d = Number(diamondCount) || 1;
  for (const tier of CFG.HEAL_BY_TIER) {
    if (d <= tier.maxDiamonds) return tier.hp;
  }
  return CFG.HEAL_BY_TIER[CFG.HEAL_BY_TIER.length - 1].hp;
}

function pickHitIcon(damage) {
  if (damage >= 5000) return '🚀';
  if (damage >= 1000) return '💣';
  if (damage >= 250) return '⚔️';
  if (damage >= 50) return '🔥';
  return '🌹';
}

function fmt(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function weekKeyOf(ts) {
  const d = new Date(ts);
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

module.exports = { KingOfLive, giftToDamage, healAmount, clock };
