// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - SECURITY MODULE
// Safe secret management, rate limiting, validation
// ═══════════════════════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');

/**
 * Validate that required environment variables are present and safe
 * NEVER log the actual values
 */
function validateEnvironment() {
  const required = ['SUPABASE_URL', 'SUPABASE_KEY'];
  const missing = [];
  
  for (const key of required) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('   Please set these in your .env file or Railway dashboard');
    process.exit(1);
  }
  
  // Check for placeholder values (common mistakes)
  const placeholders = ['YOUR_', 'REPLACE_', 'CHANGE_', 'EXAMPLE_', 'xxx', 'yyy'];
  
  for (const key of required) {
    const value = process.env[key];
    const hasPlaceholder = placeholders.some(ph => value.includes(ph));
    
    if (hasPlaceholder) {
      console.error(`❌ ${key} appears to contain a placeholder value`);
      console.error('   Please set a real API key in your environment');
      process.exit(1);
    }
  }
  
  // Validate Supabase URL format
  if (!process.env.SUPABASE_URL.startsWith('https://')) {
    console.error('❌ SUPABASE_URL must start with https://');
    process.exit(1);
  }
  
  // Optional keys - just log status without exposing values
  const optional = {
    'TELEGRAM_BOT_TOKEN': 'Telegram Bot',
    'ALPHA_VANTAGE_KEY': 'Alpha Vantage (Metals)',
    'RESEND_API_KEY': 'Resend (Email)'
  };
  
  console.log('\n🔐 Security Status:');
  console.log('   ✅ Required secrets validated');
  
  for (const [key, name] of Object.entries(optional)) {
    const hasKey = process.env[key] && 
                   process.env[key].length > 10 && 
                   !placeholders.some(ph => process.env[key].includes(ph));
    
    console.log(`   ${hasKey ? '✅' : '⚠️ '} ${name}: ${hasKey ? 'Configured' : 'Not configured (optional)'}`);
  }
  console.log('');
}

/**
 * Mask sensitive data for safe logging
 */
function maskSecret(value) {
  if (!value || value.length < 8) return '***';
  return value.substring(0, 4) + '***' + value.substring(value.length - 4);
}

/**
 * Safe logger that never exposes secrets
 */
function safeLog(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const sanitized = {};
  
  // List of keys that should NEVER be logged
  const secretKeys = [
    'password', 'token', 'key', 'secret', 'api', 'auth',
    'supabase', 'telegram', 'resend', 'alpha'
  ];
  
  // Sanitize data object
  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase();
    const isSecret = secretKeys.some(sk => keyLower.includes(sk));
    
    if (isSecret && typeof value === 'string') {
      sanitized[key] = maskSecret(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  const logEntry = {
    timestamp,
    level,
    message,
    ...sanitized
  };
  
  console.log(JSON.stringify(logEntry));
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
  // UUID v4 format or email
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  return uuidPattern.test(userId) || emailPattern.test(userId);
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
