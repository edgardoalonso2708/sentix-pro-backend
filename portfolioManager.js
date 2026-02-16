// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - PORTFOLIO MANAGEMENT MODULE
// Batch upload, validation, persistence
// ═══════════════════════════════════════════════════════════════════════════════

const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/uploads/',
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
          buyPrice: data.buyprice || data['buy price'],
          purchaseDate: data.purchasedate || data['purchase date'],
          notes: data.notes || ''
        };
        
        const validation = validateEntry(entry, lineNumber);
        
        if (validation.valid) {
          results.push({
            asset: entry.normalizedAsset,
            amount: entry.validatedAmount,
            buyPrice: entry.validatedBuyPrice,
            purchaseDate: entry.validatedDate,
            notes: entry.notes
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

/**
 * Save portfolio to database
 */
async function savePortfolio(supabase, userId, positions) {
  try {
    // First, delete existing portfolio for this user
    const { error: deleteError } = await supabase
      .from('portfolios')
      .delete()
      .eq('user_id', userId);
    
    if (deleteError && deleteError.code !== 'PGRST116') {
      // PGRST116 = no rows found, which is fine
      throw deleteError;
    }
    
    // Insert new positions
    const records = positions.map(pos => ({
      user_id: userId,
      asset: pos.asset,
      amount: pos.amount,
      buy_price: pos.buyPrice,
      purchase_date: pos.purchaseDate,
      notes: pos.notes
    }));
    
    const { data, error } = await supabase
      .from('portfolios')
      .insert(records)
      .select();
    
    if (error) throw error;
    
    return { success: true, count: data.length };
    
  } catch (error) {
    console.error('Error saving portfolio:', error);
    throw error;
  }
}

/**
 * Get user portfolio from database
 */
async function getPortfolio(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('portfolios')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    return data || [];
    
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    return [];
  }
}

/**
 * Calculate portfolio metrics with current prices
 */
function calculatePortfolioMetrics(positions, marketData) {
  if (!marketData || !marketData.crypto) {
    return {
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
    totalValue,
    totalInvested,
    totalPnL,
    totalPnLPercent,
    positions: enrichedPositions
  };
}

module.exports = {
  upload,
  parsePortfolioCSV,
  savePortfolio,
  getPortfolio,
  calculatePortfolioMetrics,
  VALID_ASSETS
};
