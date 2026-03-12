// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Bybit Spot Execution Adapter
// Real exchange execution via Bybit V5 Unified API (Spot only).
// Supports testnet for development and mainnet for live trading.
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const axios = require('axios');
const { ExecutionAdapter } = require('./ExecutionAdapter');
const { logger } = require('../logger');
const { classifyAxiosError, Provider } = require('../errors');

const BYBIT_MAINNET = 'https://api.bybit.com';
const BYBIT_TESTNET = 'https://api-testnet.bybit.com';
const RECV_WINDOW = '5000';

// CoinGecko ID → Bybit spot symbol
const SPOT_SYMBOL_MAP = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  binancecoin: 'BNBUSDT',
  solana: 'SOLUSDT',
  cardano: 'ADAUSDT',
  ripple: 'XRPUSDT',
  polkadot: 'DOTUSDT',
  dogecoin: 'DOGEUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink: 'LINKUSDT',
};

class BybitExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {string} apiKey - Bybit API key
   * @param {string} apiSecret - Bybit API secret
   * @param {boolean} [testnet=true] - Use testnet (default true for safety)
   * @param {object} [supabase] - Supabase client (for DB queries if needed)
   */
  constructor(apiKey, apiSecret, testnet = true, supabase = null) {
    super('bybit');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;
    this.baseUrl = testnet ? BYBIT_TESTNET : BYBIT_MAINNET;
    this.supabase = supabase;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ─── SIGNING ──────────────────────────────────────────────────────────────

  /**
   * Generate Bybit V5 HMAC-SHA256 signature.
   * Format: HMAC(timestamp + apiKey + recvWindow + payload)
   */
  _sign(timestamp, payload = '') {
    const preSign = `${timestamp}${this.apiKey}${RECV_WINDOW}${payload}`;
    return crypto.createHmac('sha256', this.apiSecret).update(preSign).digest('hex');
  }

  /**
   * Make an authenticated request to Bybit V5 API.
   */
  async _request(method, path, data = null) {
    const timestamp = Date.now().toString();
    let payload = '';

    if (method === 'GET' && data) {
      payload = new URLSearchParams(data).toString();
    } else if (method === 'POST' && data) {
      payload = JSON.stringify(data);
    }

    const sign = this._sign(timestamp, payload);

    const headers = {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };

    try {
      const config = { method, url: path, headers };
      if (method === 'GET' && data) {
        config.params = data;
      } else if (method === 'POST') {
        config.data = data;
      }

      const res = await this.client(config);

      if (res.data?.retCode !== 0) {
        const msg = res.data?.retMsg || 'Unknown Bybit error';
        logger.warn('Bybit API error response', { path, retCode: res.data?.retCode, retMsg: msg });
        return { success: false, error: msg, data: res.data };
      }

      return { success: true, data: res.data?.result };
    } catch (err) {
      const providerError = classifyAxiosError(err, Provider.BYBIT, path);
      logger.error('Bybit API request failed', { path, error: providerError.message });
      throw providerError;
    }
  }

  // ─── ADAPTER METHODS ──────────────────────────────────────────────────────

  /**
   * Place a spot order on Bybit.
   */
  async placeOrder(order, marketData = null, config = null) {
    try {
      const symbol = this._resolveSymbol(order.asset);
      if (!symbol) {
        return { filled: false, reason: `No Bybit symbol mapping for ${order.asset}` };
      }

      // Build order params
      const params = {
        category: 'spot',
        symbol,
        side: order.side === 'BUY' ? 'Buy' : 'Sell',
        orderType: this._mapOrderType(order.order_type),
        qty: String(parseFloat(order.quantity)),
      };

      // For LIMIT orders, include price and time-in-force
      if (order.order_type === 'LIMIT' || order.order_type === 'STOP_LIMIT') {
        params.price = String(parseFloat(order.price));
        params.timeInForce = this._mapTimeInForce(order.time_in_force);
      }

      // For MARKET orders, use IOC
      if (order.order_type === 'MARKET') {
        params.timeInForce = 'IOC';
        // For market buy, Bybit spot needs quote qty or base qty
        // We use base qty (already in order.quantity)
      }

      logger.info('Placing Bybit spot order', { symbol, side: params.side, type: params.orderType, qty: params.qty });

      const result = await this._request('POST', '/v5/order/create', params);

      if (!result.success) {
        return { filled: false, reason: `Bybit order rejected: ${result.error}` };
      }

      const exchangeOrderId = result.data?.orderId;

      // For MARKET orders, query fill details
      if (order.order_type === 'MARKET' && exchangeOrderId) {
        // Brief delay for fill to propagate
        await new Promise(r => setTimeout(r, 500));
        const fillInfo = await this._getOrderStatus(symbol, exchangeOrderId);

        if (fillInfo && fillInfo.orderStatus === 'Filled') {
          return {
            filled: true,
            fillPrice: parseFloat(fillInfo.avgPrice),
            fillQuantity: parseFloat(fillInfo.cumExecQty),
            slippage: 0, // Could calculate vs expected
            exchange_order_id: exchangeOrderId,
          };
        }

        // Partially filled or still open
        if (fillInfo && fillInfo.orderStatus === 'PartiallyFilled') {
          return {
            filled: false,
            reason: `Partially filled: ${fillInfo.cumExecQty} / ${order.quantity}`,
            exchange_order_id: exchangeOrderId,
          };
        }
      }

      // For LIMIT orders or if market fill not confirmed yet
      return {
        filled: false,
        reason: order.order_type === 'MARKET' ? 'Market order placed, fill not confirmed yet' : 'Limit order placed, waiting for fill',
        exchange_order_id: exchangeOrderId,
      };
    } catch (err) {
      logger.error('BybitExecutionAdapter.placeOrder error', { error: err.message, orderId: order.id });
      return { filled: false, reason: `Execution error: ${err.message}` };
    }
  }

  /**
   * Cancel an order on Bybit.
   */
  async cancelOrder(exchangeOrderId, symbol = null) {
    try {
      if (!exchangeOrderId) {
        return { cancelled: false, reason: 'No exchange_order_id provided' };
      }

      // If no symbol provided, we can't cancel (Bybit requires it)
      // In practice, we should pass symbol through the order record
      const params = {
        category: 'spot',
        orderId: exchangeOrderId,
      };
      if (symbol) params.symbol = symbol;

      const result = await this._request('POST', '/v5/order/cancel', params);

      if (!result.success) {
        return { cancelled: false, reason: `Cancel failed: ${result.error}` };
      }

      return { cancelled: true };
    } catch (err) {
      return { cancelled: false, reason: `Cancel error: ${err.message}` };
    }
  }

  /**
   * Get position (balance) for an asset on Bybit Spot.
   * For spot trading, "position" means the coin balance.
   */
  async getPosition(userId, asset) {
    try {
      const symbol = this._resolveSymbol(asset);
      // Extract base coin from symbol (e.g., BTCUSDT → BTC)
      const coin = symbol ? symbol.replace('USDT', '') : asset.toUpperCase();

      const result = await this._request('GET', '/v5/account/wallet-balance', {
        accountType: 'UNIFIED',
        coin,
      });

      if (!result.success || !result.data?.list?.[0]?.coin) {
        return { position: null };
      }

      const coins = result.data.list[0].coin;
      const coinData = coins.find(c => c.coin === coin);

      if (!coinData || parseFloat(coinData.walletBalance) === 0) {
        return { position: null };
      }

      return {
        position: {
          asset,
          coin,
          quantity: parseFloat(coinData.walletBalance),
          available: parseFloat(coinData.availableToWithdraw || coinData.walletBalance),
          usdValue: parseFloat(coinData.usdValue || 0),
        }
      };
    } catch (err) {
      logger.warn('Bybit getPosition failed', { asset, error: err.message });
      return { position: null };
    }
  }

  /**
   * Get USDT balance on Bybit.
   */
  async getBalance(userId) {
    try {
      const result = await this._request('GET', '/v5/account/wallet-balance', {
        accountType: 'UNIFIED',
        coin: 'USDT',
      });

      if (!result.success || !result.data?.list?.[0]?.coin) {
        return { available: 0, total: 0 };
      }

      const usdtData = result.data.list[0].coin.find(c => c.coin === 'USDT');
      if (!usdtData) return { available: 0, total: 0 };

      return {
        available: parseFloat(usdtData.availableToWithdraw || usdtData.walletBalance),
        total: parseFloat(usdtData.walletBalance),
      };
    } catch (err) {
      logger.warn('Bybit getBalance failed', { error: err.message });
      return { available: 0, total: 0 };
    }
  }

  /**
   * Health check — verify Bybit API connectivity.
   */
  async healthCheck() {
    try {
      const start = Date.now();
      const res = await this.client.get('/v5/market/time');
      const latencyMs = Date.now() - start;

      if (res.data?.retCode === 0) {
        return {
          healthy: true,
          adapter: 'bybit',
          details: {
            testnet: this.testnet,
            serverTime: res.data.result?.timeSecond,
            latencyMs,
          }
        };
      }

      return {
        healthy: false,
        adapter: 'bybit',
        details: { error: res.data?.retMsg || 'Unknown', testnet: this.testnet }
      };
    } catch (err) {
      return {
        healthy: false,
        adapter: 'bybit',
        details: { error: err.message, testnet: this.testnet }
      };
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  /**
   * Get order status from Bybit.
   */
  async _getOrderStatus(symbol, orderId) {
    try {
      const result = await this._request('GET', '/v5/order/realtime', {
        category: 'spot',
        symbol,
        orderId,
      });

      if (result.success && result.data?.list?.length > 0) {
        return result.data.list[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Query order status by exchange_order_id (used by recovery).
   */
  async queryOrderStatus(exchangeOrderId, asset) {
    const symbol = this._resolveSymbol(asset);
    if (!symbol) return null;
    return this._getOrderStatus(symbol, exchangeOrderId);
  }

  /**
   * Resolve CoinGecko asset ID to Bybit spot symbol.
   */
  _resolveSymbol(asset) {
    if (!asset) return null;
    const lower = asset.toLowerCase();
    return SPOT_SYMBOL_MAP[lower] || null;
  }

  /**
   * Map internal order type to Bybit orderType.
   */
  _mapOrderType(type) {
    switch (type) {
      case 'MARKET': return 'Market';
      case 'LIMIT': return 'Limit';
      case 'STOP_LIMIT': return 'Limit'; // Stop handled separately
      default: return 'Market';
    }
  }

  /**
   * Map time-in-force to Bybit TIF.
   */
  _mapTimeInForce(tif) {
    switch (tif) {
      case 'GTC': return 'GTC';
      case 'IOC': return 'IOC';
      case 'FOK': return 'FOK';
      default: return 'GTC';
    }
  }
}

module.exports = { BybitExecutionAdapter, SPOT_SYMBOL_MAP };
