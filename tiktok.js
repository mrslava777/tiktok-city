'use strict';

const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

/**
 * Обёртка над TikTok Live Connector.
 * Подключается к лайву по @username и пробрасывает события наружу через onEvent.
 */
class TikTokManager {
  constructor({ onEvent, onStatus }) {
    this.onEvent = onEvent; // (type, payload) => void
    this.onStatus = onStatus; // (status) => void
    this.connection = null;
    this.username = null;
    this.connected = false;
  }

  status() {
    return { connected: this.connected, username: this.username };
  }

  async connect(rawUsername) {
    const username = String(rawUsername || '').trim().replace(/^@/, '');
    if (!username) throw new Error('Не указан username TikTok');

    await this.disconnect();

    this.username = username;
    this.connection = new TikTokLiveConnection(username);
    this._wire(this.connection);

    const state = await this.connection.connect();
    this.connected = true;
    this._emitStatus();
    return state;
  }

  async disconnect() {
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch (_) {
        /* ignore */
      }
      this.connection = null;
    }
    this.connected = false;
    this._emitStatus();
  }

  _emitStatus() {
    if (this.onStatus) this.onStatus(this.status());
  }

  _wire(conn) {
    conn.on(ControlEvent.CONNECTED, () => {
      this.connected = true;
      this._emitStatus();
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
      this.connected = false;
      this._emitStatus();
    });
    conn.on(ControlEvent.ERROR, (err) => {
      // не роняем сервер из-за ошибок стрима
      console.error('[tiktok] error:', err && err.message ? err.message : err);
    });
    conn.on(WebcastEvent.STREAM_END, () => {
      this.connected = false;
      this._emitStatus();
    });

    conn.on(WebcastEvent.CHAT, (d) => {
      this.onEvent('chat', { user: nick(d), comment: d.comment });
    });

    conn.on(WebcastEvent.LIKE, (d) => {
      this.onEvent('like', { userId: uid(d), user: nick(d), likeCount: d.likeCount || 1 });
    });

    conn.on(WebcastEvent.FOLLOW, (d) => {
      this.onEvent('follow', { user: nick(d) });
    });

    conn.on(WebcastEvent.SHARE, (d) => {
      this.onEvent('share', { user: nick(d) });
    });

    conn.on(WebcastEvent.MEMBER, (d) => {
      this.onEvent('member', { user: nick(d) });
    });

    conn.on(WebcastEvent.GIFT, (d) => {
      // Стрик-подарки приходят много раз; считаем только финальное событие,
      // чтобы не начислить казну несколько раз.
      const giftType = d.giftType ?? d.gift?.type;
      const repeatEnd = d.repeatEnd ?? true;
      if (giftType === 1 && !repeatEnd) return;

      this.onEvent('gift', {
        userId: uid(d),
        user: nick(d),
        giftName: d.giftName || d.gift?.name || 'подарок',
        diamondCount: diamonds(d),
        repeatCount: d.repeatCount || 1,
      });
    });
  }
}

function nick(d) {
  return d?.user?.nickname || d?.nickname || d?.uniqueId || 'Зритель';
}

function uid(d) {
  return d?.user?.uniqueId || d?.uniqueId || d?.userId || d?.user?.userId || nick(d);
}

function diamonds(d) {
  return (
    d?.diamondCount ||
    d?.giftDetails?.diamondCount ||
    d?.gift?.diamond_count ||
    d?.extendedGiftInfo?.diamond_count ||
    1
  );
}

module.exports = { TikTokManager };
