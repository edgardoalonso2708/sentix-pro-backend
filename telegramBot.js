// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - TELEGRAM BOT (Custom polling — no library conflicts)
// Uses node-telegram-bot-api only for sendMessage, with manual getUpdates loop
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const { logger } = require('./logger');

class SilentTelegramBot {
  constructor(token) {
    this.enabled = false;
    this.bot = null;
    this.subscribedChatIds = new Set();
    this._token = token;
    this._offset = 0;
    this._polling = false;
    this._handlers = [];

    const isValidToken = token &&
      token.length > 20 &&
      !token.includes('YOUR_') &&
      /^\d+:[A-Za-z0-9_-]+$/.test(token);

    if (isValidToken) {
      // Create bot instance WITHOUT polling — only used for sendMessage
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
      logger.info('Telegram Bot initialized');
    } else {
      if (token && token.length > 5) {
        logger.warn('Telegram Bot token format invalid');
      } else {
        logger.info('Telegram Bot not configured (set TELEGRAM_BOT_TOKEN)');
      }
    }
  }

  /**
   * Start our own polling loop — single connection, no library conflicts
   */
  async startCustomPolling() {
    if (!this.enabled || this._polling) return;
    this._polling = true;

    // Clear stale sessions first
    try {
      await this._apiCall('deleteWebhook', { drop_pending_updates: true });
      logger.info('Telegram: webhook cleared');
    } catch (_) {}

    await new Promise(r => setTimeout(r, 1000));
    logger.info('Telegram: custom polling started');
    this._pollLoop();
  }

  /**
   * Single polling loop using getUpdates with long-poll
   */
  async _pollLoop() {
    while (this._polling) {
      try {
        const data = await this._apiCall('getUpdates', {
          offset: this._offset,
          limit: 20,
          timeout: 15
        });

        if (data.ok && data.result && data.result.length > 0) {
          for (const update of data.result) {
            this._offset = update.update_id + 1;
            this._processUpdate(update);
          }
        }
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('409')) {
          // Conflict — wait and retry (should clear after old connection expires)
          logger.warn('Telegram: 409 conflict in poll loop, waiting 15s');
          await new Promise(r => setTimeout(r, 15000));
        } else if (msg.includes('401')) {
          logger.error('Telegram: 401 Unauthorized — bot disabled');
          this.enabled = false;
          this._polling = false;
          return;
        } else {
          // Network error or timeout — brief pause then retry
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
  }

  /**
   * Process a single Telegram update
   */
  _processUpdate(update) {
    if (!update.message || !update.message.text) return;
    const text = update.message.text;
    for (const { regex, callback } of this._handlers) {
      const match = text.match(regex);
      if (match) {
        try { callback(update.message, match); } catch (e) {
          logger.warn('Telegram handler error', { error: e.message });
        }
      }
    }
  }

  /**
   * Call Telegram Bot API via HTTPS (with timeout)
   */
  _apiCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const query = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const url = `https://api.telegram.org/bot${this._token}/${method}${query ? '?' + query : ''}`;

      const req = https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.ok) {
              const err = new Error(json.description || 'API error');
              err.statusCode = json.error_code;
              reject(err);
            } else {
              resolve(json);
            }
          } catch { reject(new Error('Invalid JSON response')); }
        });
      });

      req.on('error', reject);
      // Timeout: polling timeout (15s) + 5s buffer
      req.setTimeout(20000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  // ─── Standard bot methods ───────────────────────────────────────────────

  subscribe(chatId) {
    this.subscribedChatIds.add(chatId);
    logger.info('Telegram subscriber added', { chatId, total: this.subscribedChatIds.size });
  }

  unsubscribe(chatId) {
    this.subscribedChatIds.delete(chatId);
    logger.info('Telegram subscriber removed', { chatId, total: this.subscribedChatIds.size });
  }

  getSubscribers() {
    return [...this.subscribedChatIds];
  }

  async sendMessage(chatId, message, options = {}) {
    if (!this.enabled || !this.bot) {
      return { success: false, reason: 'bot_disabled' };
    }
    try {
      await this.bot.sendMessage(chatId, message, options);
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  async broadcastAlert(signal) {
    if (!this.enabled || this.subscribedChatIds.size === 0) {
      return { sent: 0, total: this.subscribedChatIds.size };
    }

    const actionEmoji = signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪';
    const message =
      `${actionEmoji} *ALERTA SENTIX PRO*\n\n` +
      `*${signal.asset}* - ${signal.action}\n` +
      `Precio: $${Number(signal.price).toLocaleString()}\n` +
      `Score: ${signal.score}/100\n` +
      `Confianza: ${signal.confidence}%\n\n` +
      `📊 ${signal.reasons}\n\n` +
      `⏰ ${new Date().toLocaleString('es-ES')}`;

    let sent = 0;
    for (const chatId of this.subscribedChatIds) {
      const result = await this.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      if (result.success) sent++;
    }
    return { sent, total: this.subscribedChatIds.size };
  }

  /**
   * Register command handler (replaces library's onText)
   */
  onText(regex, callback) {
    if (this.enabled) {
      this._handlers.push({ regex, callback });
    }
  }

  isActive() {
    return this.enabled;
  }

  stop() {
    this._polling = false;
  }
}

/**
 * Setup Telegram bot commands
 */
function setupTelegramCommands(bot, marketDataGetter, signalsGetter) {
  if (!bot.isActive()) return;

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    bot.subscribe(chatId);
    await bot.sendMessage(
      chatId,
      '🚀 *SENTIX Pro Bot Activado*\n\n' +
      '✅ Suscrito a alertas automáticas\n\n' +
      'Comandos disponibles:\n' +
      '/precio [ASSET] - Precio actual\n' +
      '/señales - Señales activas\n' +
      '/mercado - Resumen del mercado\n' +
      '/stop - Detener alertas',
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    bot.unsubscribe(chatId);
    await bot.sendMessage(chatId, '🔕 Alertas desactivadas.\nEnvía /start para reactivarlas.', { parse_mode: 'Markdown' });
  });

  bot.onText(/\/se[ñn]ales/, async (msg) => {
    const chatId = msg.chat.id;
    const signals = signalsGetter ? signalsGetter() : [];
    if (!signals || signals.length === 0) {
      await bot.sendMessage(chatId, '📊 No hay señales activas en este momento.');
      return;
    }
    let message = '🎯 *Señales Activas*\n\n';
    signals.slice(0, 5).forEach(s => {
      const emoji = s.action === 'BUY' ? '🟢' : s.action === 'SELL' ? '🔴' : '⚪';
      message += `${emoji} *${s.asset}* - ${s.action}\n`;
      message += `   Score: ${s.score} | Confianza: ${s.confidence}%\n`;
      message += `   Precio: $${Number(s.price).toLocaleString()}\n\n`;
    });
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/precio (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const asset = match[1].toLowerCase();
    const marketData = marketDataGetter();
    if (marketData && marketData.crypto && marketData.crypto[asset]) {
      const data = marketData.crypto[asset];
      await bot.sendMessage(
        chatId,
        `💎 *${asset.toUpperCase()}*\n` +
        `Precio: $${data.price.toLocaleString()}\n` +
        `24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId, '❌ Asset no encontrado. Usa el ID de CoinGecko (ej: bitcoin, ethereum, solana)');
    }
  });

  bot.onText(/\/mercado/, async (msg) => {
    const chatId = msg.chat.id;
    const marketData = marketDataGetter();
    if (marketData && marketData.macro) {
      await bot.sendMessage(
        chatId,
        `📊 *Resumen del Mercado*\n\n` +
        `Fear & Greed: ${marketData.macro.fearGreed}/100 (${marketData.macro.fearLabel})\n` +
        `BTC Dominance: ${marketData.macro.btcDom}%\n` +
        `Market Cap: $${(marketData.macro.globalMcap / 1e12).toFixed(2)}T`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId, '⏳ Datos de mercado cargando...');
    }
  });
}

module.exports = {
  SilentTelegramBot,
  setupTelegramCommands
};
