# 📊 SENTIX PRO - PHASE 2: MULTI-WALLET PORTFOLIO
## v2.3 → v2.4 | Professional Multi-Exchange Portfolio Management

---

## 🎯 Overview

**Phase 2** introduces **professional multi-wallet portfolio management** with segregated P&L tracking across different exchanges and wallets. This allows you to:

✅ **Track multiple wallets/exchanges** (Binance, Bybit, MercadoPago, Skipo, etc.)
✅ **Upload separate CSV files** for each wallet
✅ **View P&L segregated by wallet** with color-coded UI
✅ **Consolidated P&L view** across all holdings
✅ **Professional-grade features**: wallet archiving, transaction IDs, tags

---

## 📦 What's New

### 1. **Database Schema Changes**

#### New Tables:
- **`wallets`**: Store user's exchanges/wallets
- **`wallet_snapshots`**: Historical P&L tracking
- **`portfolios`**: Updated with `wallet_id` foreign key

#### New Views:
- **`portfolio_consolidated`**: Aggregated positions across wallets
- **`wallet_summary`**: High-level wallet statistics

#### New Functions:
- **`calculate_wallet_pnl`**: Real-time P&L with current prices

### 2. **Backend Updates**

- **portfolioManager_v2.4.js**: Complete rewrite with wallet support
- **9 new API endpoints**: Wallet CRUD + Portfolio queries
- **P&L calculations**: By wallet, consolidated, by asset

### 3. **Supported Providers**

| Type | Providers |
|------|-----------|
| **Exchanges** | Binance, Bybit, Coinbase, Kraken, OKX, KuCoin |
| **LatAm** | MercadoPago, Skipo, Lemon, Ripio |
| **Wallets** | MetaMask, Trust Wallet, Phantom, Exodus |
| **Cold Storage** | Ledger, Trezor |
| **Other** | Custom/DeFi |

---

## 🚀 Migration Guide

### Step 1: Run Database Migration

1. **Connect to Supabase**:
   - Go to your Supabase project
   - Navigate to **SQL Editor**

2. **Run migration script**:
   ```sql
   -- Copy and paste entire content of:
   -- migrations/001_multi_wallet_schema.sql
   ```

3. **Verify migration**:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
   AND table_name IN ('wallets', 'portfolios', 'wallet_snapshots');

   -- Should return 3 rows
   ```

4. **Check data migration**:
   ```sql
   -- Check if your old portfolio was migrated to "Main Wallet"
   SELECT w.name, COUNT(p.id) as positions
   FROM wallets w
   LEFT JOIN portfolios p ON w.id = p.wallet_id
   WHERE w.name = 'Main Wallet'
   GROUP BY w.name;
   ```

### Step 2: Update Backend Code

1. **Rename old portfolioManager.js**:
   ```bash
   mv portfolioManager.js portfolioManager.backup.js
   ```

2. **Rename new version**:
   ```bash
   mv portfolioManager_v2.4.js portfolioManager.js
   ```

3. **Update server.js imports** (around line 17-23):
   ```javascript
   // OLD:
   const {
     upload,
     parsePortfolioCSV,
     savePortfolio,
     getPortfolio,
     calculatePortfolioMetrics
   } = require('./portfolioManager');

   // NEW:
   const {
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
     WALLET_PROVIDERS,
     WALLET_TYPES
   } = require('./portfolioManager');
   ```

4. **Replace portfolio endpoints** in server.js:
   - **Delete** lines 796-895 (old portfolio routes)
   - **Copy** all endpoints from `server_wallet_endpoints.js`
   - **Paste** after line 715 (after `/api/features/batch`)

5. **Update version** (line ~576):
   ```javascript
   version: '2.4.0-phase2',  // Multi-Wallet Portfolio
   ```

### Step 3: Test Backend

```bash
# Start server
npm start

# Test wallet creation
curl -X POST http://localhost:3001/api/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "name": "Binance Main",
    "type": "exchange",
    "provider": "binance",
    "color": "#F3BA2F"
  }'

# Expected response:
# { "success": true, "wallet": { "id": "...", "name": "Binance Main", ... } }

# Get wallets
curl http://localhost:3001/api/wallets/test-user

# Expected: Array of wallets with position counts
```

### Step 4: Update Frontend (React)

Create new components for wallet management:

#### `WalletSelector.jsx`
```jsx
import React, { useState, useEffect } from 'react';

export function WalletSelector({ userId, onWalletSelect, selectedWalletId }) {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/wallets/${userId}`)
      .then(res => res.json())
      .then(data => {
        setWallets(data.wallets);
        setLoading(false);
      });
  }, [userId]);

  return (
    <div className="wallet-selector">
      {loading ? (
        <div>Loading wallets...</div>
      ) : (
        <select
          value={selectedWalletId || ''}
          onChange={(e) => onWalletSelect(e.target.value)}
          className="wallet-select"
        >
          <option value="">Select wallet...</option>
          {wallets.map(wallet => (
            <option key={wallet.id} value={wallet.id}>
              {wallet.name} ({wallet.provider}) - {wallet.position_count || 0} positions
            </option>
          ))}
        </select>
      )}

      <button onClick={() => {/* Open create wallet modal */}}>
        + New Wallet
      </button>
    </div>
  );
}
```

#### `CreateWalletModal.jsx`
```jsx
import React, { useState } from 'react';

export function CreateWalletModal({ userId, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    name: '',
    type: 'exchange',
    provider: 'binance',
    color: '#6366f1',
    notes: ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();

    const response = await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...formData })
    });

    const data = await response.json();

    if (data.success) {
      onSuccess(data.wallet);
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>Create New Wallet</h2>

        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Wallet name (e.g., Binance Main)"
            value={formData.name}
            onChange={(e) => setFormData({...formData, name: e.target.value})}
            required
          />

          <select
            value={formData.type}
            onChange={(e) => setFormData({...formData, type: e.target.value})}
          >
            <option value="exchange">Exchange</option>
            <option value="wallet">Wallet</option>
            <option value="cold_storage">Cold Storage</option>
            <option value="defi">DeFi</option>
            <option value="other">Other</option>
          </select>

          <select
            value={formData.provider}
            onChange={(e) => setFormData({...formData, provider: e.target.value})}
          >
            <option value="binance">Binance</option>
            <option value="bybit">Bybit</option>
            <option value="mercadopago">MercadoPago</option>
            <option value="skipo">Skipo</option>
            <option value="metamask">MetaMask</option>
            <option value="ledger">Ledger</option>
            <option value="other">Other</option>
          </select>

          <input
            type="color"
            value={formData.color}
            onChange={(e) => setFormData({...formData, color: e.target.value})}
          />

          <textarea
            placeholder="Notes (optional)"
            value={formData.notes}
            onChange={(e) => setFormData({...formData, notes: e.target.value})}
          />

          <button type="submit">Create Wallet</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </form>
      </div>
    </div>
  );
}
```

#### Update `PortfolioUpload.jsx`
```jsx
import React, { useState } from 'react';
import { WalletSelector } from './WalletSelector';

export function PortfolioUpload({ userId }) {
  const [selectedWallet, setSelectedWallet] = useState(null);
  const [file, setFile] = useState(null);

  const handleUpload = async () => {
    if (!selectedWallet || !file) {
      alert('Please select a wallet and file');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', userId);
    formData.append('walletId', selectedWallet);

    const response = await fetch('/api/portfolio/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      alert(`Successfully uploaded ${data.positions} positions!`);
    }
  };

  return (
    <div className="portfolio-upload">
      <h3>Upload Portfolio</h3>

      <WalletSelector
        userId={userId}
        selectedWalletId={selectedWallet}
        onWalletSelect={setSelectedWallet}
      />

      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files[0])}
      />

      <button onClick={handleUpload} disabled={!selectedWallet || !file}>
        Upload to {selectedWallet ? 'Selected Wallet' : '...'}
      </button>
    </div>
  );
}
```

#### `PortfolioDashboard.jsx` - Multi-Wallet View
```jsx
import React, { useState, useEffect } from 'react';

export function PortfolioDashboard({ userId }) {
  const [view, setView] = useState('consolidated'); // 'consolidated' | 'byWallet'
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`/api/portfolio/${userId}`)
      .then(res => res.json())
      .then(setData);
  }, [userId]);

  if (!data) return <div>Loading...</div>;

  return (
    <div className="portfolio-dashboard">
      {/* View Toggle */}
      <div className="view-toggle">
        <button
          className={view === 'consolidated' ? 'active' : ''}
          onClick={() => setView('consolidated')}
        >
          📊 Consolidated
        </button>
        <button
          className={view === 'byWallet' ? 'active' : ''}
          onClick={() => setView('byWallet')}
        >
          💼 By Wallet
        </button>
      </div>

      {/* Consolidated View */}
      {view === 'consolidated' && (
        <div className="consolidated-view">
          <h2>Total Portfolio</h2>
          <div className="summary-cards">
            <div className="card">
              <label>Total Value</label>
              <h3>${data.consolidated.totalValue.toLocaleString()}</h3>
            </div>
            <div className="card">
              <label>Total Invested</label>
              <h3>${data.consolidated.totalInvested.toLocaleString()}</h3>
            </div>
            <div className={`card ${data.consolidated.totalPnL >= 0 ? 'positive' : 'negative'}`}>
              <label>P&L</label>
              <h3>
                ${Math.abs(data.consolidated.totalPnL).toLocaleString()}
                <span>({data.consolidated.totalPnLPercent.toFixed(2)}%)</span>
              </h3>
            </div>
          </div>

          {/* By Asset Table */}
          <table className="asset-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Amount</th>
                <th>Avg Buy</th>
                <th>Current</th>
                <th>Value</th>
                <th>P&L</th>
                <th>Wallets</th>
              </tr>
            </thead>
            <tbody>
              {data.consolidated.byAsset.map(asset => (
                <tr key={asset.asset}>
                  <td>{asset.asset.toUpperCase()}</td>
                  <td>{asset.totalAmount.toFixed(4)}</td>
                  <td>${asset.avgBuyPrice.toFixed(2)}</td>
                  <td>${asset.currentPrice.toFixed(2)}</td>
                  <td>${asset.currentValue.toLocaleString()}</td>
                  <td className={asset.pnl >= 0 ? 'positive' : 'negative'}>
                    ${Math.abs(asset.pnl).toFixed(2)} ({asset.pnlPercent.toFixed(2)}%)
                  </td>
                  <td>{asset.walletCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* By Wallet View */}
      {view === 'byWallet' && (
        <div className="by-wallet-view">
          <h2>Wallets</h2>
          {data.byWallet.map(wallet => (
            <div
              key={wallet.walletId}
              className="wallet-card"
              style={{ borderLeft: `4px solid ${wallet.walletColor}` }}
            >
              <div className="wallet-header">
                <h3>{wallet.walletName}</h3>
                <div className="wallet-stats">
                  <span>${wallet.totalValue.toLocaleString()}</span>
                  <span className={wallet.totalPnL >= 0 ? 'positive' : 'negative'}>
                    {wallet.totalPnL >= 0 ? '+' : '-'}
                    ${Math.abs(wallet.totalPnL).toFixed(2)}
                    ({wallet.totalPnLPercent.toFixed(2)}%)
                  </span>
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Amount</th>
                    <th>Buy Price</th>
                    <th>Current</th>
                    <th>P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {wallet.positions.map(pos => (
                    <tr key={pos.id}>
                      <td>{pos.asset.toUpperCase()}</td>
                      <td>{pos.amount.toFixed(4)}</td>
                      <td>${pos.buy_price.toFixed(2)}</td>
                      <td>${pos.currentPrice.toFixed(2)}</td>
                      <td className={pos.pnl >= 0 ? 'positive' : 'negative'}>
                        ${Math.abs(pos.pnl).toFixed(2)} ({pos.pnlPercent.toFixed(2)}%)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 📡 API Reference

### Wallet Endpoints

#### `GET /api/wallets/:userId`
Get all wallets for a user.

**Query Params:**
- `includeInactive=true` - Include archived wallets

**Response:**
```json
{
  "wallets": [
    {
      "id": "uuid",
      "name": "Binance Main",
      "type": "exchange",
      "provider": "binance",
      "color": "#F3BA2F",
      "is_active": true,
      "position_count": 5,
      "unique_assets": 3,
      "total_invested": 10000
    }
  ]
}
```

#### `POST /api/wallets`
Create a new wallet.

**Body:**
```json
{
  "userId": "user123",
  "name": "Bybit Futures",
  "type": "exchange",
  "provider": "bybit",
  "color": "#F7931A",
  "notes": "For leverage trading"
}
```

#### `PATCH /api/wallets/:walletId`
Update wallet details.

#### `DELETE /api/wallets/:walletId`
Soft-delete (archive) a wallet.

### Portfolio Endpoints

#### `POST /api/portfolio/upload`
Upload CSV to a specific wallet.

**FormData:**
- `file`: CSV file
- `userId`: string
- `walletId`: UUID

#### `GET /api/portfolio/:userId`
Get all portfolios with P&L by wallet and consolidated.

**Response:**
```json
{
  "userId": "user123",
  "byWallet": [
    {
      "walletId": "uuid",
      "walletName": "Binance Main",
      "totalValue": 15000,
      "totalInvested": 10000,
      "totalPnL": 5000,
      "totalPnLPercent": 50,
      "positions": [...]
    }
  ],
  "consolidated": {
    "totalValue": 25000,
    "totalInvested": 18000,
    "totalPnL": 7000,
    "totalPnLPercent": 38.89,
    "byAsset": [...]
  }
}
```

#### `GET /api/portfolio/:userId/wallet/:walletId`
Get portfolio for a specific wallet.

#### `GET /api/portfolio/:userId/consolidated`
Get consolidated view across all wallets.

#### `GET /api/wallets/:userId/summary`
Get high-level summary of all wallets.

---

## 🎨 UI/UX Recommendations

### Color Coding
Use distinct colors for each wallet to make segregation visual:

```javascript
const PROVIDER_COLORS = {
  binance: '#F3BA2F',   // Gold
  bybit: '#F7931A',     // Orange
  mercadopago: '#00B1EA', // Blue
  skipo: '#6366f1',     // Indigo
  metamask: '#F6851B',  // Fox orange
  ledger: '#000000',    // Black
  default: '#6366f1'    // Indigo
};
```

### Dashboard Layout
```
┌─────────────────────────────────────────┐
│  📊 Total Portfolio                     │
│  Value: $50,000  |  P&L: +$10,000 (25%)│
└─────────────────────────────────────────┘

┌─────────────────┬──────────────────────┐
│ 💼 By Wallet    │  📊 Consolidated     │ <-- Toggle
└─────────────────┴──────────────────────┘

┌──────────────── Binance Main ──────────┐ <-- Color-coded
│ Value: $30,000  |  P&L: +$8,000 (36%)  │
│ ┌───────────────────────────────────┐  │
│ │ BTC  | 0.5   | $45,000 | +20%     │  │
│ │ ETH  | 10    | $25,000 | +15%     │  │
│ └───────────────────────────────────┘  │
└─────────────────────────────────────────┘

┌──────────────── Bybit Futures ─────────┐
│ Value: $20,000  |  P&L: +$2,000 (11%)  │
│ ...                                     │
└─────────────────────────────────────────┘
```

---

## 🧪 Testing

### Manual Test Flow

1. **Create wallets**:
   ```bash
   # Binance
   curl -X POST http://localhost:3001/api/wallets \
     -H "Content-Type: application/json" \
     -d '{"userId": "test", "name": "Binance Main", "type": "exchange", "provider": "binance", "color": "#F3BA2F"}'

   # Bybit
   curl -X POST http://localhost:3001/api/wallets \
     -H "Content-Type: application/json" \
     -d '{"userId": "test", "name": "Bybit", "type": "exchange", "provider": "bybit", "color": "#F7931A"}'
   ```

2. **Create test CSVs**:

   `binance_portfolio.csv`:
   ```csv
   Asset,Amount,Buy Price,Purchase Date,Notes
   bitcoin,0.5,42000,2024-01-15,Long term hold
   ethereum,5.0,2500,2024-01-20,DCA
   ```

   `bybit_portfolio.csv`:
   ```csv
   Asset,Amount,Buy Price,Purchase Date,Notes
   solana,100,85,2024-02-01,Swing trade
   cardano,5000,0.45,2024-02-10,Speculative
   ```

3. **Upload to wallets** (via Postman or frontend)

4. **Test endpoints**:
   ```bash
   # Get all portfolios
   curl http://localhost:3001/api/portfolio/test

   # Get wallet summary
   curl http://localhost:3001/api/wallets/test/summary

   # Get consolidated
   curl http://localhost:3001/api/portfolio/test/consolidated
   ```

5. **Verify P&L calculations**:
   - Check that P&L is calculated correctly per wallet
   - Verify consolidated sums match individual wallets
   - Test with negative P&L positions

---

## ⚠️ Migration Warnings

### Data Safety
- **BACKUP FIRST**: The migration creates `portfolios_backup` automatically
- **Test in dev**: Run migration on a test Supabase project first
- **RLS Policies**: Ensure Row Level Security is properly configured

### Breaking Changes
- Old `/api/portfolio/upload` now **requires `walletId`** parameter
- Old `/api/portfolio/:userId` response structure changed
- Frontend must be updated to handle new data structure

### Rollback Plan
If migration fails:
```sql
-- Restore old portfolios table
DROP TABLE IF EXISTS portfolios;
ALTER TABLE portfolios_backup RENAME TO portfolios;

-- Drop new tables
DROP TABLE IF EXISTS wallets CASCADE;
DROP TABLE IF EXISTS wallet_snapshots CASCADE;
```

---

## 📈 Professional Recommendations

### 1. **Wallet Naming Convention**
Use clear, descriptive names:
- ✅ "Binance Main Account"
- ✅ "Bybit Futures - High Risk"
- ✅ "MercadoPago - LatAm Fiat"
- ❌ "Wallet 1"
- ❌ "Test"

### 2. **CSV Organization**
Keep separate CSV files per wallet:
```
portfolios/
├── binance_main.csv
├── bybit_futures.csv
├── mercadopago.csv
└── ledger_cold_storage.csv
```

### 3. **Transaction IDs**
Include transaction IDs for audit trail:
```csv
Asset,Amount,Buy Price,Purchase Date,Notes,Transaction ID
bitcoin,0.5,42000,2024-01-15,Initial,0x123abc...
```

### 4. **Tags for Strategy Tracking**
Future enhancement - add tags:
```javascript
tags: ['long-term', 'dca', 'btc-maxi']
tags: ['swing-trade', 'high-risk']
tags: ['retirement', 'cold-storage']
```

### 5. **Snapshot Automation**
Set up daily snapshots for historical P&L:
```javascript
// In server.js cron job (daily at midnight)
cron.schedule('0 0 * * *', async () => {
  // Save daily snapshots for all wallets
  const users = await getAllUsers();
  for (const user of users) {
    await saveWalletSnapshots(user.id);
  }
});
```

### 6. **Export Functionality**
Allow users to export wallet data:
- CSV export per wallet
- PDF reports with P&L charts
- Tax report format (FIFO/LIFO)

---

## 🎓 Next Steps

1. ✅ Run database migration
2. ✅ Update backend code
3. ✅ Test API endpoints
4. ⏳ Build frontend UI
5. ⏳ Deploy to production
6. ⏳ User testing
7. ⏳ Documentation & training

---

## 🆘 Troubleshooting

### "Wallet not found" error
- Ensure wallet was created successfully
- Check wallet belongs to the correct userId
- Verify wallet is active (`is_active = true`)

### P&L shows $0
- Check that `cachedMarketData` is populated
- Verify asset IDs match CoinGecko format
- Ensure market data update is running

### Upload fails
- Check CSV format matches template
- Verify walletId is a valid UUID
- Check file size < 5MB

### RLS permission denied
- Verify Supabase RLS policies are enabled
- Check `auth.uid()` matches `user_id`
- Test with Supabase policy tester

---

## 📞 Support

For issues or questions:
- Check logs: `logger` output in console
- Test with Postman collection
- Review SQL migration logs in Supabase
- Contact: edgardoalonso2708@gmail.com

---

**🚀 Happy Multi-Wallet Trading!**

*SENTIX PRO v2.4 - Professional Portfolio Management*
