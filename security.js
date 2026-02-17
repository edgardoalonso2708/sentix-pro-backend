// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - SECURITY MODULE
// Safe secret management, rate limiting, validation
// ═══════════════════════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');
const { logger } = require('./logger');

// Placeholder patterns that indicate unconfigured values
const PLACEHOLDERS = ['YOUR_', 'REPLACE_', 'CHANGE_', 'EXAMPLE_', 'xxx', 'yyy', 'TODO', 'FIXME'];

/**
 * Format validation rules for known env vars
 */
const ENV_RULES = {
  SUPABASE_URL: {
    required: true,
    label: 'Supabase URL',
    validate: (v) => {
      if (!v.startsWith('https://')) return 'must start with https://';
      if (!v.includes('.supabase.co')) return 'must be a valid Supabase URL (*.supabase.co)';
      return null;
    }
  },
  SUPABASE_KEY: {
    required: true,
    label: 'Supabase Key',
    validate: (v) => {
      if (!v.startsWith('eyJ')) return 'must be a valid JWT (starts with eyJ)';
      const parts = v.split('.');
      if (parts.length < 3) return 'must be a valid JWT (at least three dot-separated parts)';
      return null;
    }
  },
  TELEGRAM_BOT_TOKEN: {
    required: false,
    label: 'Telegram Bot',
    validate: (v) => {
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(v)) return 'invalid format (expected 123456789:ABCdef...)';
      return null;
    }
  },
  RESEND_API_KEY: {
    required: false,
    label: 'Resend (Email)',
    validate: (v) => {
      if (!v.startsWith('re_')) return 'must start with re_';
      return null;
    }
  },
  ALPHA_VANTAGE_KEY: {
    required: false,
    label: 'Alpha Vantage (Metals)',
    validate: null
  }
};

/**
 * Validate that required environment variables are present, safe, and well-formed.
 * Exits process on critical failures. Returns validation summary.
 */
function validateEnvironment() {
  const errors = [];
  const warnings = [];
  const status = {};

  for (const [key, rule] of Object.entries(ENV_RULES)) {
    const value = process.env[key];
    const isEmpty = !value || value.trim() === '';

    // Check presence
    if (isEmpty) {
      if (rule.required) {
        errors.push(`${key} is missing (required)`);
      } else {
        status[key] = { configured: false, label: rule.label };
      }
      continue;
    }

    // Check placeholders
    const hasPlaceholder = PLACEHOLDERS.some(ph => value.toUpperCase().includes(ph));
    if (hasPlaceholder) {
      if (rule.required) {
        errors.push(`${key} contains a placeholder value`);
      } else {
        warnings.push(`${key} appears to contain a placeholder`);
        status[key] = { configured: false, label: rule.label };
      }
      continue;
    }

    // Run format validation
    if (rule.validate) {
      const formatError = rule.validate(value);
      if (formatError) {
        if (rule.required) {
          errors.push(`${key}: ${formatError}`);
        } else {
          warnings.push(`${key}: ${formatError}`);
          status[key] = { configured: false, label: rule.label };
        }
        continue;
      }
    }

    status[key] = { configured: true, label: rule.label };
  }

  // Fatal: exit on required env var failures
  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(`ENV validation failed: ${err}`);
    }
    logger.error('Fix the above environment variable issues and restart');
    process.exit(1);
  }

  // Non-fatal warnings
  for (const w of warnings) {
    logger.warn(`ENV warning: ${w}`);
  }

  // Summary
  logger.info('Environment validated', {
    required: 'OK',
    optional: Object.entries(status)
      .filter(([k]) => !ENV_RULES[k].required)
      .reduce((acc, [k, v]) => { acc[v.label] = v.configured ? 'configured' : 'not configured'; return acc; }, {})
  });

  return status;
}

/**
 * Mask sensitive data for safe logging
 * @deprecated Use logger module directly — kept for backward compatibility
 */
function maskSecret(value) {
  const { maskValue } = require('./logger');
  return maskValue(value);
}

/**
 * Safe logger that never exposes secrets
 * @deprecated Use logger module directly — kept for backward compatibility
 */
function safeLog(level, message, data = {}) {
  logger[level] ? logger[level](message, data) : logger.info(message, data);
}

/**
 * Rate limiter for API endpoints
 */
const createRateLimiter = (windowMs = 60000, max = 100) => {
  return rateLimit({
    windowMs, // time window in milliseconds
    max, // max requests per window
    message: {
      error: 'Too many requests',
      retryAfter: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for localhost in development
    skip: (req) => {
      return process.env.NODE_ENV === 'development' && 
             (req.ip === '::1' || req.ip === '127.0.0.1');
    }
  });
};

/**
 * API key validator middleware
 */
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  // In production, you'd check against a database
  // For now, we'll check against an environment variable
  const validKey = process.env.API_KEY;
  
  if (!validKey) {
    // API key auth not configured, allow through
    return next();
  }
  
  if (!apiKey || apiKey !== validKey) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Valid API key required'
    });
  }
  
  next();
}

/**
 * Sanitize user input to prevent injection attacks
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  
  // Remove potential SQL injection patterns
  let sanitized = input.replace(/['";\\]/g, '');
  
  // Remove potential XSS patterns
  sanitized = sanitized.replace(/<script[^>]*>.*?<\/script>/gi, '');
  sanitized = sanitized.replace(/<iframe[^>]*>.*?<\/iframe>/gi, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  return sanitized;
}

/**
 * Validate user ID format
 */
function isValidUserId(userId) {
  // UUID v4 format, email, or safe alphanumeric identifier (e.g. "default-user")
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;

  return uuidPattern.test(userId) || emailPattern.test(userId) || safeIdPattern.test(userId);
}

module.exports = {
  validateEnvironment,
  maskSecret,
  safeLog,
  createRateLimiter,
  validateApiKey,
  sanitizeInput,
  isValidUserId
};
