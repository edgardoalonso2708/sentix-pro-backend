// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - TELEGRAM BOT WRAPPER (SILENT MODE)
// Bot opcional sin spam de errores
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');

class SilentTelegramBot {
  constructor(token) {
    this.enabled = false;
    this.bot = null;
    
    // Solo inicializar si hay un token válido
    if (token && token.length > 20 && !token.includes('YOUR_')) {
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
        
        // Suprimir errores de polling
        this.bot.on('polling_error', () => {
          // Silent - no spam
        });
        
        this.enabled = true;
        console.log('✅ Telegram Bot initialized successfully');
        
      } catch (error) {
        console.log('⚠️  Telegram Bot disabled (invalid token or network issue)');
        this.enabled = false;
      }
    } else {
      console.log('ℹ️  Telegram Bot not configured (optional)');
    }
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
function setupTelegramCommands(bot, marketDataGetter) {
  if (!bot.isActive()) {
    return;
  }
  
  // /start command
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
      chatId,
      '🚀 *SENTIX Pro Bot Activado*\n\n' +
      'Comandos disponibles:\n' +
      '/precio [ASSET] - Precio actual\n' +
      '/señales - Señales de trading\n' +
      '/mercado - Resumen del mercado\n' +
      '/stop - Detener alertas',
      { parse_mode: 'Markdown' }
    );
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
      await bot.sendMessage(chatId, '❌ Asset no encontrado');
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
        `Fear & Greed: ${marketData.macro.fearGreed}/100\n` +
        `BTC Dominance: ${marketData.macro.btcDom}%\n` +
        `Market Cap: $${(marketData.macro.globalMcap / 1e12).toFixed(2)}T`,
        { parse_mode: 'Markdown' }
      );
    }
  });
}

module.exports = {
  SilentTelegramBot,
  setupTelegramCommands
};
