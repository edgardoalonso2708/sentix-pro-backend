// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - MULTI-WALLET PORTFOLIO MANAGEMENT MODULE
// v2.4: Batch upload, validation, persistence with multi-exchange/wallet support
// ═══════════════════════════════════════════════════════════════════════════════

const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logger } = require('./logger');

// Cross-platform upload directory
const uploadDir = path.join(os.tmpdir(), 'sentix-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

/**
 * Valid asset IDs from CoinGecko
 */
const VALID_ASSETS = [
  'bitcoin', 'ethereum', 'binancecoin', 'solana', 'cardano',
  'ripple', 'polkadot', 'dogecoin', 'avalanche-2', 'chainlink',
  'btc', 'eth', 'bnb', 'sol', 'ada', 'xrp', 'dot', 'doge', 'avax', 'link'
];

/**
 * Map common symbols to CoinGecko IDs
 */
const SYMBOL_TO_ID = {
  'btc': 'bitcoin',
  'eth': 'ethereum',
  'bnb': 'binancecoin',
  'sol': 'solana',
  'ada': 'cardano',
  'xrp': 'ripple',
  'dot': 'polkadot',
  'doge': 'dogecoin',
  'avax': 'avalanche-2',
  'link': 'chainlink'
};

/**
 * Supported wallet/exchange providers
 */
const WALLET_PROVIDERS = [
  'binance', 'bybit', 'coinbase', 'kraken', 'okx', 'kucoin',
  'mercadopago', 'skipo', 'lemon', 'ripio',
  'metamask', 'trust_wallet', 'ledger', 'trezor',
  'phantom', 'exodus', 'other'
];

const WALLET_TYPES = ['exchange', 'wallet', 'cold_storage', 'defi', 'other'];

/**
 * Normalize asset identifier to CoinGecko ID
 */
function normalizeAssetId(input) {
  const normalized = input.toLowerCase().trim();

  // Check if it's already a valid ID
  if (VALID_ASSETS.includes(normalized)) {
    return SYMBOL_TO_ID[normalized] || normalized;
  }

  return null;
}

/**
 * Validate portfolio entry
 */
function validateEntry(entry, lineNumber) {
  const errors = [];

  // Validate asset
  if (!entry.asset || entry.asset.trim() === '') {
    errors.push(`Line ${lineNumber}: Asset is required`);
  } else {
    const assetId = normalizeAssetId(entry.asset);
    if (!assetId) {
      errors.push(`Line ${lineNumber}: Invalid asset "${entry.asset}". Must be one of: ${VALID_ASSETS.slice(0, 10).join(', ')}`);
    }
    entry.normalizedAsset = assetId;
  }

  // Validate amount
  const amount = parseFloat(entry.amount);
  if (isNaN(amount) || amount <= 0) {
    errors.push(`Line ${lineNumber}: Amount must be a positive number (got "${entry.amount}")`);
  }
  entry.validatedAmount = amount;

  // Validate buy price
  const buyPrice = parseFloat(entry.buyPrice || entry['buy price'] || entry['Buy Price']);
  if (isNaN(buyPrice) || buyPrice <= 0) {
    errors.push(`Line ${lineNumber}: Buy Price must be a positive number (got "${entry.buyPrice}")`);
  }
  entry.validatedBuyPrice = buyPrice;

  // Validate date (optional, but if present must be valid)
  if (entry.purchaseDate || entry['purchase date'] || entry['Purchase Date']) {
    const dateStr = entry.purchaseDate || entry['purchase date'] || entry['Purchase Date'];
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      errors.push(`Line ${lineNumber}: Invalid date format "${dateStr}". Use YYYY-MM-DD`);
    }
    entry.validatedDate = date.toISOString();
  } else {
    entry.validatedDate = new Date().toISOString();
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse CSV file and return validated entries
 */
async function parsePortfolioCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    const errors = [];
    let lineNumber = 1; // Start at 1 (header is line 0)

    fs.createReadStream(filePath)
      .pipe(csv({
        mapHeaders: ({ header }) => header.toLowerCase().replace(/\s+/g, '')
      }))
      .on('data', (data) => {
        lineNumber++;

        // Normalize column names
        const entry = {
          asset: data.asset,
          amount: data.amount,
          buyPrice: data.buyprice || data['buyprice'],
          purchaseDate: data.purchasedate || data['purchasedate'],
          notes: data.notes || '',
          transactionId: data.transactionid || data.txid || ''
        };

        const validation = validateEntry(entry, lineNumber);

        if (validation.valid) {
          results.push({
            asset: entry.normalizedAsset,
            amount: entry.validatedAmount,
            buyPrice: entry.validatedBuyPrice,
            purchaseDate: entry.validatedDate,
            notes: entry.notes,
            transactionId: entry.transactionId
          });
        } else {
          errors.push(...validation.errors);
        }
      })
      .on('end', () => {
        // Clean up uploaded file
        fs.unlinkSync(filePath);

        if (errors.length > 0) {
          reject({ type: 'validation', errors });
        } else {
          resolve(results);
        }
      })
      .on('error', (error) => {
        // Clean up uploaded file
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // Ignore cleanup errors
        }
        reject({ type: 'parse', error: error.message });
      });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new wallet/exchange for a user
 */
async function createWallet(supabase, userId, walletData) {
  try {
    const { name, type, provider, color, icon, notes } = walletData;

    // Validate type and provider
    if (!WALLET_TYPES.includes(type)) {
      throw new Error(`Invalid wallet type: ${type}. Must be one of: ${WALLET_TYPES.join(', ')}`);
    }

    if (provider && !WALLET_PROVIDERS.includes(provider)) {
      logger.warn('Unknown wallet provider', { provider, knownProviders: WALLET_PROVIDERS });
    }

    const { data, error } = await supabase
      .from('wallets')
      .insert({
        user_id: userId,
        name: name.trim(),
        type,
        provider: provider || 'other',
        color: color || '#6366f1',
        icon: icon || null,
        notes: notes || null,
        is_active: true
      })
      .select()
      .single();

    if (error) throw error;

    logger.info('Wallet created', { userId, walletId: data.id, name: data.name });
    return data;

  } catch (error) {
    logger.error('Error creating wallet', { error: error.message, userId });
    throw error;
  }
}

/**
 * Get all wallets for a user
 */
async function getWallets(supabase, userId, includeInactive = false) {
  try {
    let query = supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data || [];

  } catch (error) {
    logger.error('Error fetching wallets', { error: error.message, userId });
    return [];
  }
}

/**
 * Update wallet details
 */
async function updateWallet(supabase, walletId, userId, updates) {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .update(updates)
      .eq('id', walletId)
      .eq('user_id', userId) // Ensure user owns this wallet
      .select()
      .single();

    if (error) throw error;

    logger.info('Wallet updated', { walletId, updates: Object.keys(updates) });
    return data;

  } catch (error) {
    logger.error('Error updating wallet', { error: error.message, walletId });
    throw error;
  }
}

/**
 * Soft-delete wallet (set is_active = false)
 */
async function deleteWallet(supabase, walletId, userId) {
  try {
    const { data, error } = await supabase
      .from('wallets')
      .update({ is_active: false })
      .eq('id', walletId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;

    logger.info('Wallet deleted (soft)', { walletId, userId });
    return data;

  } catch (error) {
    logger.error('Error deleting wallet', { error: error.message, walletId });
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO MANAGEMENT (MULTI-WALLET)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save portfolio to a specific wallet (replaces existing positions for that wallet)
 */
async function savePortfolioToWallet(supabase, userId, walletId, positions) {
  try {
    // Verify wallet exists and belongs to user
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', walletId)
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      throw new Error('Wallet not found or access denied');
    }

    // Delete existing positions for this wallet
    const { error: deleteError } = await supabase
      .from('portfolios')
      .delete()
      .eq('wallet_id', walletId);

    if (deleteError && deleteError.code !== 'PGRST116') {
      throw deleteError;
    }

    // Insert new positions
    const records = positions.map(pos => ({
      user_id: userId,
      wallet_id: walletId,
      asset: pos.asset,
      amount: pos.amount,
      buy_price: pos.buyPrice,
      purchase_date: pos.purchaseDate,
      notes: pos.notes || null,
      transaction_id: pos.transactionId || null
    }));

    const { data, error } = await supabase
      .from('portfolios')
      .insert(records)
      .select();

    if (error) throw error;

    logger.info('Portfolio saved to wallet', { userId, walletId, positions: data.length });
    return { success: true, count: data.length };

  } catch (error) {
    logger.error('Error saving portfolio to wallet', { error: error.message, userId, walletId });
    throw error;
  }
}

/**
 * Get portfolio for a specific wallet
 */
async function getWalletPortfolio(supabase, userId, walletId) {
  try {
    const { data, error } = await supabase
      .from('portfolios')
      .select(`
        *,
        wallets:wallet_id (
          name,
          type,
          provider,
          color
        )
      `)
      .eq('user_id', userId)
      .eq('wallet_id', walletId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return data || [];

  } catch (error) {
    logger.error('Error fetching wallet portfolio', { error: error.message, userId, walletId });
    return [];
  }
}

/**
 * Get all portfolios across all wallets for a user
 */
async function getAllPortfolios(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('portfolios')
      .select(`
        *,
        wallets:wallet_id (
          id,
          name,
          type,
          provider,
          color,
          is_active
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Filter only active wallets
    return (data || []).filter(pos => pos.wallets?.is_active !== false);

  } catch (error) {
    logger.error('Error fetching all portfolios', { error: error.message, userId });
    return [];
  }
}

/**
 * Get consolidated portfolio (aggregated across all wallets)
 */
async function getConsolidatedPortfolio(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('portfolio_consolidated')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;

    return data || [];

  } catch (error) {
    logger.error('Error fetching consolidated portfolio', { error: error.message, userId });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// P&L CALCULATIONS (WALLET & CONSOLIDATED)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate P&L for a specific wallet
 */
function calculateWalletPnL(positions, marketData) {
  if (!marketData || !marketData.crypto) {
    return {
      walletId: positions[0]?.wallet_id || null,
      walletName: positions[0]?.wallets?.name || 'Unknown',
      totalValue: 0,
      totalInvested: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      positions: []
    };
  }

  let totalValue = 0;
  let totalInvested = 0;

  const enrichedPositions = positions.map(pos => {
    const currentPrice = marketData.crypto[pos.asset]?.price || 0;
    const positionValue = pos.amount * currentPrice;
    const invested = pos.amount * pos.buy_price;
    const pnl = positionValue - invested;
    const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

    totalValue += positionValue;
    totalInvested += invested;

    return {
      ...pos,
      currentPrice,
      currentValue: positionValue,
      invested,
      pnl,
      pnlPercent
    };
  });

  const totalPnL = totalValue - totalInvested;
  const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  return {
    walletId: positions[0]?.wallet_id || null,
    walletName: positions[0]?.wallets?.name || 'Unknown',
    walletColor: positions[0]?.wallets?.color || '#6366f1',
    totalValue,
    totalInvested,
    totalPnL,
    totalPnLPercent,
    positionCount: enrichedPositions.length,
    positions: enrichedPositions
  };
}

/**
 * Calculate P&L grouped by wallet
 */
function calculatePnLByWallet(allPositions, marketData) {
  // Group positions by wallet_id
  const walletGroups = {};

  for (const pos of allPositions) {
    const walletId = pos.wallet_id;
    if (!walletGroups[walletId]) {
      walletGroups[walletId] = [];
    }
    walletGroups[walletId].push(pos);
  }

  // Calculate P&L for each wallet
  const walletPnLs = Object.entries(walletGroups).map(([walletId, positions]) => {
    return calculateWalletPnL(positions, marketData);
  });

  return walletPnLs.sort((a, b) => b.totalValue - a.totalValue);
}

/**
 * Calculate consolidated P&L across all wallets
 */
function calculateConsolidatedPnL(allPositions, marketData) {
  if (!marketData || !marketData.crypto) {
    return {
      totalValue: 0,
      totalInvested: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
      walletCount: 0,
      positionCount: 0,
      byAsset: []
    };
  }

  // Aggregate positions by asset
  const assetGroups = {};

  for (const pos of allPositions) {
    if (!assetGroups[pos.asset]) {
      assetGroups[pos.asset] = {
        asset: pos.asset,
        totalAmount: 0,
        totalInvested: 0,
        walletCount: new Set()
      };
    }

    assetGroups[pos.asset].totalAmount += pos.amount;
    assetGroups[pos.asset].totalInvested += pos.amount * pos.buy_price;
    assetGroups[pos.asset].walletCount.add(pos.wallet_id);
  }

  // Calculate P&L for each asset
  let totalValue = 0;
  let totalInvested = 0;
  const walletIds = new Set();

  const byAsset = Object.values(assetGroups).map(group => {
    const currentPrice = marketData.crypto[group.asset]?.price || 0;
    const currentValue = group.totalAmount * currentPrice;
    const pnl = currentValue - group.totalInvested;
    const pnlPercent = group.totalInvested > 0 ? (pnl / group.totalInvested) * 100 : 0;

    totalValue += currentValue;
    totalInvested += group.totalInvested;

    return {
      asset: group.asset,
      totalAmount: group.totalAmount,
      avgBuyPrice: group.totalInvested / group.totalAmount,
      currentPrice,
      currentValue,
      invested: group.totalInvested,
      pnl,
      pnlPercent,
      walletCount: group.walletCount.size
    };
  });

  // Count unique wallets
  for (const pos of allPositions) {
    walletIds.add(pos.wallet_id);
  }

  const totalPnL = totalValue - totalInvested;
  const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

  return {
    totalValue,
    totalInvested,
    totalPnL,
    totalPnLPercent,
    walletCount: walletIds.size,
    positionCount: allPositions.length,
    byAsset: byAsset.sort((a, b) => b.currentValue - a.currentValue)
  };
}

module.exports = {
  // File upload
  upload,
  parsePortfolioCSV,

  // Wallet management
  createWallet,
  getWallets,
  updateWallet,
  deleteWallet,

  // Portfolio management
  savePortfolioToWallet,
  getWalletPortfolio,
  getAllPortfolios,
  getConsolidatedPortfolio,

  // P&L calculations
  calculateWalletPnL,
  calculatePnLByWallet,
  calculateConsolidatedPnL,

  // Constants
  VALID_ASSETS,
  WALLET_PROVIDERS,
  WALLET_TYPES
};
