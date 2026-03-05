// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - TELEGRAM BOT WRAPPER (SILENT MODE + ALERT DELIVERY)
// Bot opcional sin spam de errores, con entrega automática de alertas
// Phase 0: Hardened with structured logging
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('./logger');

class SilentTelegramBot {
  constructor(token) {
    this.enabled = false;
    this.bot = null;
    this.subscribedChatIds = new Set();

    // Validate token format: must be like "123456789:ABCdef..."
    const isValidToken = token &&
      token.length > 20 &&
      !token.includes('YOUR_') &&
      /^\d+:[A-Za-z0-9_-]+$/.test(token);

    if (isValidToken) {
      try {
        this.bot = new TelegramBot(token, {
          polling: {
            interval: 1000,
            autoStart: true,
            params: {
              timeout: 10
            }
          }
        });

        // Track polling errors but don't spam
        let errorCount = 0;
        this.bot.on('polling_error', (error) => {
          errorCount++;
          if (errorCount <= 3) {
            logger.warn('Telegram polling error', { count: errorCount, error: error.message });
          }
          if (errorCount === 3) {
            logger.warn('Telegram: suppressing further polling errors');
          }
          // If persistent auth errors, mark as disabled and stop polling
          if (error.response?.statusCode === 401) {
            logger.error('Telegram Bot token is INVALID (401 Unauthorized). Bot disabled.');
            this.enabled = false;
            try { this.bot.stopPolling(); } catch (_e) { /* silent */ }
          }
        });

        this.enabled = true;
        logger.info('Telegram Bot initialized');

      } catch (error) {
        logger.warn('Telegram Bot disabled (invalid token or network issue)');
        this.enabled = false;
      }
    } else {
      if (token && token.length > 5) {
        logger.warn('Telegram Bot token format invalid (expected: 123456789:ABCdef...)');
      } else {
        logger.info('Telegram Bot not configured (set TELEGRAM_BOT_TOKEN)');
      }
    }
  }

  /**
   * Subscribe a chat to receive automatic alerts
   */
  subscribe(chatId) {
    this.subscribedChatIds.add(chatId);
    logger.info('Telegram subscriber added', { chatId, total: this.subscribedChatIds.size });
  }

  /**
   * Unsubscribe a chat from automatic alerts
   */
  unsubscribe(chatId) {
    this.subscribedChatIds.delete(chatId);
    logger.info('Telegram subscriber removed', { chatId, total: this.subscribedChatIds.size });
  }

  /**
   * Get all subscribed chat IDs
   */
  getSubscribers() {
    return [...this.subscribedChatIds];
  }

  /**
   * Send message (silent fail if bot not enabled)
   */
  async sendMessage(chatId, message, options = {}) {
    if (!this.enabled || !this.bot) {
      return { success: false, reason: 'bot_disabled' };
    }

    try {
      await this.bot.sendMessage(chatId, message, options);
      return { success: true };
    } catch (error) {
      // Silent fail - no spam
      return { success: false, reason: error.message };
    }
  }

  /**
   * Broadcast alert to all subscribed chats
   * Returns count of successful deliveries
   */
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
   * Register command handler
   */
  onText(regex, callback) {
    if (this.enabled && this.bot) {
      this.bot.onText(regex, callback);
    }
  }

  /**
   * Check if bot is active
   */
  isActive() {
    return this.enabled;
  }

  /**
   * Stop bot gracefully
   */
  stop() {
    if (this.bot) {
      try {
        this.bot.stopPolling();
      } catch (error) {
        // Silent
      }
    }
  }
}

/**
 * Setup Telegram bot commands if enabled
 */
function setupTelegramCommands(bot, marketDataGetter, signalsGetter) {
  if (!bot.isActive()) {
    return;
  }

  // /start command - auto-subscribe to alerts
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

  // /stop command - unsubscribe from alerts
  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    bot.unsubscribe(chatId);
    await bot.sendMessage(
      chatId,
      '🔕 Alertas desactivadas.\nEnvía /start para reactivarlas.',
      { parse_mode: 'Markdown' }
    );
  });

  // /señales command - show active signals
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

  // /precio command
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

  // /mercado command
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
