// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Role-Based Access Control Middleware
// Checks user role from user_profiles table after authentication.
// Must be used AFTER requireAuth (needs req.userId).
// ═══════════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const { logger } = require('./logger');

// Supabase client for profile lookups (uses service role key)
let _supabase = null;

function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) return null;
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// In-memory profile cache (TTL: 5 minutes)
const _profileCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch user profile from user_profiles table.
 * Returns cached result if available and fresh.
 */
async function getProfile(userId) {
  // Check cache
  const cached = _profileCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.profile;
  }

  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !data) {
    return null;
  }

  // Cache it
  _profileCache.set(userId, { profile: data, ts: Date.now() });
  return data;
}

/**
 * Invalidate cached profile for a user (call after role changes).
 */
function invalidateProfileCache(userId) {
  _profileCache.delete(userId);
}

/**
 * Middleware factory that checks if the authenticated user has one of the allowed roles.
 *
 * Usage:
 *   app.post('/api/admin/invite', requireAuth, requireRole('admin'), handler);
 *   app.post('/api/paper/close', requireAuth, requireRole('trader', 'admin'), handler);
 *
 * @param {...string} roles - Allowed roles (e.g., 'admin', 'trader', 'viewer')
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    // Development bypass — same pattern as authMiddleware
    if (process.env.AUTH_REQUIRED === 'false') {
      req.userProfile = { role: 'admin', is_active: true }; // dev mode = full access
      return next();
    }

    if (!req.userId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'No authenticated user found'
      });
    }

    try {
      const profile = await getProfile(req.userId);

      // Auto-admin: if user_profiles is empty, first authenticated user becomes admin
      if (!profile) {
        const supabase = getSupabase();
        if (supabase) {
          const { count } = await supabase
            .from('user_profiles')
            .select('id', { count: 'exact', head: true });

          if (count === 0) {
            // First user — auto-create as admin
            const email = req.user?.email || 'admin@sentixpro.com';
            const { data: newProfile, error: insertErr } = await supabase
              .from('user_profiles')
              .insert({
                id: req.userId,
                email,
                role: 'admin',
                display_name: 'Admin',
                is_active: true
              })
              .select()
              .single();

            if (!insertErr && newProfile) {
              logger.info('Auto-admin: first user registered as admin', { userId: req.userId, email });
              req.userProfile = newProfile;
              _profileCache.set(req.userId, { profile: newProfile, ts: Date.now() });
              return next(); // admin has access to everything
            }
          }
        }

        return res.status(403).json({
          error: 'Profile not found',
          message: 'No user profile exists. Contact an admin to get invited.'
        });
      }

      // Check if user is active
      if (!profile.is_active) {
        return res.status(403).json({
          error: 'Account deactivated',
          message: 'Your account has been deactivated. Contact an admin.'
        });
      }

      // Check role
      if (!roles.includes(profile.role)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: `This action requires one of: ${roles.join(', ')}. Your role: ${profile.role}`
        });
      }

      req.userProfile = profile;
      next();
    } catch (err) {
      logger.error('Role middleware error', { error: err.message, userId: req.userId });
      return res.status(500).json({
        error: 'Authorization error',
        message: 'Internal error checking permissions'
      });
    }
  };
}

module.exports = { requireRole, getProfile, invalidateProfileCache };
