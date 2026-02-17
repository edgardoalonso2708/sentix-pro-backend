// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STRUCTURED LOGGER
// Centralized logging with secret protection and structured output
// ═══════════════════════════════════════════════════════════════════════════════

const SECRET_PATTERNS = [
  'password', 'token', 'key', 'secret', 'auth',
  'supabase', 'telegram', 'resend', 'alpha', 'credential'
];

/**
 * Mask sensitive values for safe logging
 */
function maskValue(value) {
  if (!value || typeof value !== 'string') return '***';
  if (value.length < 8) return '***';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Check if a key name looks like it contains a secret
 */
function isSecretKey(key) {
  const lower = key.toLowerCase();
  return SECRET_PATTERNS.some(p => lower.includes(p));
}

/**
 * Deep-sanitize an object, masking any secret-looking values
 */
function sanitizeData(data) {
  if (!data || typeof data !== 'object') return data;

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSecretKey(key) && typeof value === 'string') {
      sanitized[key] = maskValue(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Logger levels
 */
const Level = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

/**
 * Create a structured log entry and output it
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} [data] - Additional structured data
 */
function log(level, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message
  };

  if (data !== undefined && data !== null) {
    const safe = typeof data === 'object' ? sanitizeData(data) : data;
    entry.data = safe;
  }

  // Use appropriate console method
  switch (level) {
    case Level.ERROR:
      console.error(JSON.stringify(entry));
      break;
    case Level.WARN:
      console.warn(JSON.stringify(entry));
      break;
    case Level.DEBUG:
      if (process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug') {
        console.log(JSON.stringify(entry));
      }
      break;
    default:
      console.log(JSON.stringify(entry));
  }
}

// Convenience methods
const logger = {
  debug: (msg, data) => log(Level.DEBUG, msg, data),
  info: (msg, data) => log(Level.INFO, msg, data),
  warn: (msg, data) => log(Level.WARN, msg, data),
  error: (msg, data) => log(Level.ERROR, msg, data),

  /**
   * Log a ProviderError with full context
   * @param {import('./errors').ProviderError} providerError
   */
  providerError: (providerError) => {
    log(Level.WARN, `${providerError.provider}: ${providerError.message}`, {
      type: providerError.type,
      statusCode: providerError.statusCode,
      endpoint: providerError.endpoint,
      retryable: providerError.retryable
    });
  }
};

module.exports = { logger, maskValue, sanitizeData };
