// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Authentication Middleware (Supabase Auth)
// Verifies JWT tokens from Supabase Auth and extracts user identity
// ═══════════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { logger } = require('./logger');

// Separate Supabase client for auth verification (uses anon key)
let _authClient = null;

function getAuthClient() {
  if (!_authClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY; // anon key
    if (!url || !key) {
      logger.warn('SUPABASE_URL or SUPABASE_KEY not configured — auth disabled');
      return null;
    }
    _authClient = createClient(url, key);
  }
  return _authClient;
}

/**
 * Express middleware that requires a valid Supabase Auth JWT.
 * Extracts user from Authorization: Bearer <token> header.
 * Sets req.user (Supabase user object) and req.userId (UUID).
 *
 * If AUTH_REQUIRED env var is 'false', auth is bypassed (development mode).
 */
async function requireAuth(req, res, next) {
  // Development bypass — allows running without auth during dev
  if (process.env.AUTH_REQUIRED === 'false') {
    req.userId = req.params.userId || 'default-user';
    req.user = null;
    return next();
  }

  const authClient = getAuthClient();
  if (!authClient) {
    // No Supabase configured — fall back to legacy userId from params
    req.userId = req.params.userId || 'default-user';
    req.user = null;
    return next();
  }

  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Missing or invalid Authorization header. Expected: Bearer <token>'
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Empty token'
    });
  }

  try {
    const { data: { user }, error } = await authClient.auth.getUser(token);

    if (error || !user) {
      logger.debug('Auth failed', { error: error?.message });
      return res.status(401).json({
        error: 'Invalid or expired token',
        message: error?.message || 'Token verification failed'
      });
    }

    // Set user info on request
    req.user = user;
    req.userId = user.id;

    // If route has :userId param, validate it matches the authenticated user
    if (req.params.userId && req.params.userId !== user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You can only access your own data'
      });
    }

    next();
  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    return res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during authentication'
    });
  }
}

/**
 * Optional auth — sets req.user/req.userId if token present, but doesn't block.
 * Useful for SSE stream and public endpoints that can optionally be personalized.
 */
async function optionalAuth(req, res, next) {
  if (process.env.AUTH_REQUIRED === 'false') {
    req.userId = req.params.userId || req.query.userId || 'default-user';
    req.user = null;
    return next();
  }

  const authClient = getAuthClient();
  if (!authClient) {
    req.userId = req.params.userId || req.query.userId || 'default-user';
    req.user = null;
    return next();
  }

  // Try Authorization header first, then query param (for SSE)
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    req.userId = req.params.userId || 'default-user';
    req.user = null;
    return next();
  }

  try {
    const { data: { user }, error } = await authClient.auth.getUser(token);
    if (!error && user) {
      req.user = user;
      req.userId = user.id;
    } else {
      req.userId = req.params.userId || 'default-user';
      req.user = null;
    }
  } catch {
    req.userId = req.params.userId || 'default-user';
    req.user = null;
  }

  next();
}

module.exports = { requireAuth, optionalAuth };
