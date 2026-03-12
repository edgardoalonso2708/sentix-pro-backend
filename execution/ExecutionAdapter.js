// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Execution Adapter (Base Class)
// Abstract interface for order execution. Concrete implementations:
//   - PaperExecutionAdapter (simulated)
//   - BybitExecutionAdapter  (future — real exchange)
// ═══════════════════════════════════════════════════════════════════════════════

class ExecutionAdapter {
  /**
   * @param {string} name - Adapter identifier (e.g., 'paper', 'bybit')
   */
  constructor(name) {
    if (new.target === ExecutionAdapter) {
      throw new Error('ExecutionAdapter is abstract — use a concrete implementation');
    }
    this.name = name;
  }

  /**
   * Place an order for execution.
   * MARKET orders should fill immediately.
   * LIMIT/STOP_LIMIT may not fill if price conditions aren't met.
   *
   * @param {object} order - Order record from DB
   * @param {object} [marketData] - Current market data
   * @returns {Promise<{filled: boolean, fillPrice?: number, fillQuantity?: number,
   *           slippage?: number, trade?: object, reason?: string}>}
   */
  async placeOrder(order, marketData) {
    throw new Error('placeOrder() must be implemented by subclass');
  }

  /**
   * Cancel a previously submitted order on the exchange.
   * @param {string} exchangeOrderId - External exchange order ID
   * @returns {Promise<{cancelled: boolean, reason?: string}>}
   */
  async cancelOrder(exchangeOrderId) {
    throw new Error('cancelOrder() must be implemented by subclass');
  }

  /**
   * Get current position for an asset.
   * @param {string} userId
   * @param {string} asset
   * @returns {Promise<{position: object|null}>}
   */
  async getPosition(userId, asset) {
    throw new Error('getPosition() must be implemented by subclass');
  }

  /**
   * Get account balance.
   * @param {string} userId
   * @returns {Promise<{available: number, total: number}>}
   */
  async getBalance(userId) {
    throw new Error('getBalance() must be implemented by subclass');
  }

  /**
   * Health check — is the adapter connected and operational?
   * @returns {Promise<{healthy: boolean, adapter: string, details?: object}>}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }
}

module.exports = { ExecutionAdapter };
