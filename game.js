'use strict';

/**
 * Игровое состояние города. Хранится ТОЛЬКО в памяти (без базы данных).
 *
 * Ресурсы измеряются в процентах (0..MAX) и показываются полосами прогресса.
 * Каждые 30 секунд ресурсы убывают (tick). События TikTok Live их пополняют.
 */

const MAX = 100; // потолок каждого ресурса

// Сколько ресурса теряется каждый тик (раз в 30 сек)
const DECAY = {
  population: 2, // население потихоньку уходит
  food: 4, // еда расходуется быстрее всего
  treasury: 3, // казна тратится на содержание
  defense: 3, // защита изнашивается
};

// Стартовые значения города
function freshCity() {
  return {
    population: 50,
    food: 60,
    treasury: 40,
    defense: 50,
  };
}

class CityGame {
  constructor() {
    this.reset();
  }

  reset() {
    this.city = freshCity();
    this.level = 1;
    this.xp = 0; // опыт для следующего уровня
    this.totalXp = 0; // всего набрано
    this.ticks = 0; // сколько прошло циклов убывания
    this.lastEventAt = null;
  }

  // Опыт, нужный чтобы перейти с текущего уровня на следующий
  xpForNextLevel() {
    return 100 + (this.level - 1) * 60;
  }

  clamp(v) {
    return Math.max(0, Math.min(MAX, v));
  }

  // Применить изменения ресурсов и начислить опыт
  apply(changes, xpGain = 0) {
    for (const key of Object.keys(changes)) {
      if (this.city[key] === undefined) continue;
      this.city[key] = this.clamp(this.city[key] + changes[key]);
    }
    if (xpGain > 0) {
      this.xp += xpGain;
      this.totalXp += xpGain;
      while (this.xp >= this.xpForNextLevel()) {
        this.xp -= this.xpForNextLevel();
        this.level += 1;
      }
    }
    this.lastEventAt = Date.now();
  }

  // Убывание ресурсов раз в 30 сек
  tick() {
    this.ticks += 1;
    for (const key of Object.keys(DECAY)) {
      this.city[key] = this.clamp(this.city[key] - DECAY[key]);
    }
  }

  // Город в опасности, если любой ресурс на нуле
  dangerKeys() {
    return Object.keys(this.city).filter((k) => this.city[k] <= 0);
  }

  snapshot() {
    return {
      city: { ...this.city },
      max: MAX,
      level: this.level,
      xp: this.xp,
      xpForNext: this.xpForNextLevel(),
      totalXp: this.totalXp,
      ticks: this.ticks,
      danger: this.dangerKeys(),
    };
  }
}

/**
 * Правила: как событие TikTok влияет на ресурсы.
 * Возвращает { changes, xp, label, emoji } или null, если событие игнорируем.
 */
function mapEvent(type, payload = {}) {
  switch (type) {
    case 'like': {
      const n = Math.min(payload.likeCount || 1, 30);
      return {
        changes: { food: n * 0.4, population: n * 0.1 },
        xp: Math.ceil(n * 0.3),
        emoji: '❤️',
        label: `${payload.user || 'Зритель'} поставил ${n} лайков (+еда)`,
      };
    }
    case 'chat': {
      return {
        changes: { population: 2 },
        xp: 2,
        emoji: '💬',
        label: `${payload.user || 'Зритель'}: ${truncate(payload.comment, 40)}`,
      };
    }
    case 'gift': {
      const diamonds = Math.max(payload.diamondCount || 1, 1);
      const repeat = Math.max(payload.repeatCount || 1, 1);
      const value = diamonds * repeat;
      return {
        changes: {
          treasury: value * 0.8,
          defense: value * 0.3,
          food: value * 0.2,
        },
        xp: Math.ceil(value * 0.6),
        emoji: '🎁',
        label: `${payload.user || 'Зритель'} прислал «${payload.giftName || 'подарок'}» ×${repeat} (+казна)`,
      };
    }
    case 'follow': {
      return {
        changes: { population: 8 },
        xp: 8,
        emoji: '➕',
        label: `${payload.user || 'Зритель'} подписался (+население)`,
      };
    }
    case 'share': {
      return {
        changes: { defense: 6, population: 3 },
        xp: 6,
        emoji: '🔁',
        label: `${payload.user || 'Зритель'} поделился стримом (+защита)`,
      };
    }
    case 'member': {
      return {
        changes: { population: 1 },
        xp: 1,
        emoji: '👋',
        label: `${payload.user || 'Зритель'} зашёл в город`,
      };
    }
    default:
      return null;
  }
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { CityGame, mapEvent, MAX, DECAY };
