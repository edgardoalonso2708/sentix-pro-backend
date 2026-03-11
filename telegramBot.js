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
    this._callbackHandlers = [];

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
   * Process a single Telegram update (text messages + callback queries)
   */
  _processUpdate(update) {
    // Handle text messages
    if (update.message?.text) {
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

    // Handle inline keyboard callback queries
    if (update.callback_query) {
      const { id, data } = update.callback_query;
      for (const { pattern, callback } of this._callbackHandlers) {
        if (data.startsWith(pattern)) {
          try {
            callback(update.callback_query);
          } catch (e) {
            logger.warn('Telegram callback handler error', { error: e.message });
          }
          // Acknowledge the callback to remove loading spinner
          this._apiCall('answerCallbackQuery', { callback_query_id: id }).catch(() => {});
          break;
        }
      }
    }
  }

  /**
   * Call Telegram Bot API via HTTPS GET (simple params)
   */
  _apiCall(method, params = {}) {
    // Use POST for methods that need JSON body (reply_markup, etc.)
    const needsPost = Object.values(params).some(v => typeof v === 'object');
    if (needsPost) return this._apiCallPost(method, params);

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
      req.setTimeout(20000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Call Telegram Bot API via HTTPS POST (for JSON body params)
   */
  _apiCallPost(method, params = {}) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(params);
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this._token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
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
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  // ─── Callback query handlers ─────────────────────────────────────────────

  /**
   * Register a callback query handler for inline keyboard buttons.
   * @param {string} pattern - Prefix to match in callback_data
   * @param {Function} callback - Handler receiving the callback_query object
   */
  onCallbackQuery(pattern, callback) {
    if (this.enabled) {
      this._callbackHandlers.push({ pattern, callback });
    }
  }

  /**
   * Broadcast a message with inline keyboard buttons to all subscribers.
   * @param {string} text - Markdown-formatted message
   * @param {Array} inlineKeyboard - Array of button rows: [[{text, callback_data}]]
   * @returns {Object} { sent, total, messageIds }
   */
  async broadcastWithButtons(text, inlineKeyboard) {
    if (!this.enabled || this.subscribedChatIds.size === 0) {
      return { sent: 0, total: this.subscribedChatIds.size, messageIds: {} };
    }

    let sent = 0;
    const messageIds = {};
    for (const chatId of this.subscribedChatIds) {
      try {
        const result = await this._apiCallPost('sendMessage', {
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        if (result.ok) {
          sent++;
          messageIds[chatId] = result.result.message_id;
        }
      } catch (err) {
        logger.debug('broadcastWithButtons failed for chat', { chatId, error: err.message });
      }
    }
    return { sent, total: this.subscribedChatIds.size, messageIds };
  }

  /**
   * Edit a previously sent message (e.g., after button click).
   */
  async editMessage(chatId, messageId, text, inlineKeyboard = null) {
    if (!this.enabled) return { success: false, reason: 'bot_disabled' };
    try {
      const params = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
      };
      if (inlineKeyboard) {
        params.reply_markup = { inline_keyboard: inlineKeyboard };
      } else {
        // Remove keyboard after action
        params.reply_markup = { inline_keyboard: [] };
      }
      await this._apiCallPost('editMessageText', params);
      return { success: true };
    } catch (err) {
      return { success: false, reason: err.message };
    }
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
      '/autotune - Estado del auto-tuner\n' +
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

/**
 * Setup auto-tune Telegram command and callback handlers.
 * Called from alerts worker where autoTuner is available.
 */
function setupAutoTuneCommands(bot, getAutoTuneState) {
  if (!bot.isActive()) return;

  bot.onText(/\/autotune/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const state = getAutoTuneState ? await getAutoTuneState() : null;
      if (!state) {
        await bot.sendMessage(chatId, '🤖 *Auto-Tuner*\n\nNo hay información disponible.', { parse_mode: 'Markdown' });
        return;
      }

      let text = '🤖 *Auto-Parameter Tuner*\n\n';
      text += `Config: ${state.configSource === 'saved' ? '🟢 Auto-Tuned' : '📦 Default'}\n`;
      text += `Régimen: ${state.marketRegime || 'unknown'}\n`;
      text += `Aprobación: ${state.approvalMode || 'auto'}\n`;

      if (state.lastRun) {
        const ago = Math.round((Date.now() - new Date(state.lastRun.started_at).getTime()) / 3600000);
        text += `\nÚltimo run: hace ${ago}h`;
        const applied = state.lastRun.params_applied ? Object.keys(state.lastRun.params_applied).length : 0;
        text += ` (${applied} params aplicados)`;
        if (state.lastRun.ai_review?.decision) {
          text += `\nAI: ${state.lastRun.ai_review.decision}`;
        }
      }

      if (state.pendingCount > 0) {
        text += `\n\n⏳ *${state.pendingCount} propuesta(s) pendiente(s)*`;
      }

      const buttons = [[
        { text: '🔄 Ejecutar ahora', callback_data: 'at_run' },
      ]];

      await bot._apiCallPost('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err) {
      await bot.sendMessage(chatId, '❌ Error obteniendo estado del auto-tuner.');
    }
  });
}

module.exports = {
  SilentTelegramBot,
  setupTelegramCommands,
  setupAutoTuneCommands,
};
