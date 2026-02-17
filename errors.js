// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - ERROR TAXONOMY
// Normalized error types for all HTTP providers and internal operations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Error categories for provider failures
 */
const ErrorType = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',         // 429 Too Many Requests
  TIMEOUT: 'TIMEOUT',               // Request timed out (ECONNABORTED, ETIMEDOUT)
  SERVER_ERROR: 'SERVER_ERROR',      // 5xx responses
  CLIENT_ERROR: 'CLIENT_ERROR',      // 4xx (non-429)
  NETWORK_ERROR: 'NETWORK_ERROR',    // DNS, connection refused, reset
  INVALID_RESPONSE: 'INVALID_RESPONSE', // Unexpected payload shape
  AUTH_ERROR: 'AUTH_ERROR',          // 401/403
  UNKNOWN: 'UNKNOWN'
});

/**
 * Providers tracked by the system
 */
const Provider = Object.freeze({
  BINANCE: 'Binance',
  COINGECKO: 'CoinGecko',
  COINCAP: 'CoinCap',
  ALTERNATIVE_ME: 'Alternative.me',
  METALS: 'Metals',
  SUPABASE: 'Supabase',
  RESEND: 'Resend',
  TELEGRAM: 'Telegram'
});

class ProviderError extends Error {
  /**
   * @param {string} provider - Provider name (use Provider enum)
   * @param {string} type - Error type (use ErrorType enum)
   * @param {string} message - Human-readable message
   * @param {Object} [meta] - Additional context (status code, endpoint, etc.)
   */
  constructor(provider, type, message, meta = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.type = type;
    this.statusCode = meta.statusCode || null;
    this.endpoint = meta.endpoint || null;
    this.retryable = meta.retryable !== undefined ? meta.retryable : isRetryable(type);
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      type: this.type,
      message: this.message,
      statusCode: this.statusCode,
      endpoint: this.endpoint,
      retryable: this.retryable,
      timestamp: this.timestamp
    };
  }
}

/**
 * Determine if an error type is retryable by default
 */
function isRetryable(type) {
  switch (type) {
    case ErrorType.RATE_LIMIT:
    case ErrorType.TIMEOUT:
    case ErrorType.SERVER_ERROR:
    case ErrorType.NETWORK_ERROR:
      return true;
    case ErrorType.CLIENT_ERROR:
    case ErrorType.AUTH_ERROR:
    case ErrorType.INVALID_RESPONSE:
    case ErrorType.UNKNOWN:
    default:
      return false;
  }
}

/**
 * Classify an axios error into a ProviderError
 * @param {Error} error - Raw axios error
 * @param {string} provider - Provider name
 * @param {string} [endpoint] - URL or endpoint description
 * @returns {ProviderError}
 */
function classifyAxiosError(error, provider, endpoint) {
  const status = error.response?.status;
  const code = error.code; // ECONNABORTED, ETIMEDOUT, ECONNREFUSED, etc.

  // Timeout
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
    return new ProviderError(provider, ErrorType.TIMEOUT, `Request timed out: ${error.message}`, {
      statusCode: null, endpoint, retryable: true
    });
  }

  // Network errors (no response received)
  if (!error.response && (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ERR_NETWORK' || code === 'ECONNRESET')) {
    return new ProviderError(provider, ErrorType.NETWORK_ERROR, `Network error: ${error.message}`, {
      statusCode: null, endpoint, retryable: true
    });
  }

  // Rate limit
  if (status === 429) {
    return new ProviderError(provider, ErrorType.RATE_LIMIT, `Rate limited (429)`, {
      statusCode: 429, endpoint, retryable: true
    });
  }

  // Auth errors
  if (status === 401 || status === 403) {
    return new ProviderError(provider, ErrorType.AUTH_ERROR, `Auth error (${status})`, {
      statusCode: status, endpoint, retryable: false
    });
  }

  // Server errors
  if (status >= 500) {
    return new ProviderError(provider, ErrorType.SERVER_ERROR, `Server error (${status})`, {
      statusCode: status, endpoint, retryable: true
    });
  }

  // Other client errors
  if (status >= 400) {
    return new ProviderError(provider, ErrorType.CLIENT_ERROR, `Client error (${status})`, {
      statusCode: status, endpoint, retryable: false
    });
  }

  // Unknown
  return new ProviderError(provider, ErrorType.UNKNOWN, error.message || 'Unknown error', {
    endpoint, retryable: false
  });
}

module.exports = {
  ErrorType,
  Provider,
  ProviderError,
  classifyAxiosError
};
