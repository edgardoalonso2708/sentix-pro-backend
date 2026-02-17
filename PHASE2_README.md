# 🎯 PHASE 2: MULTI-WALLET PORTFOLIO - QUICK START

## 📋 Summary

**Professional multi-exchange portfolio management** with segregated P&L tracking across Binance, Bybit, MercadoPago, Skipo, and more.

---

## 📦 Files Delivered

```
sentix-pro/
├── migrations/
│   └── 001_multi_wallet_schema.sql         (314 lines) - Database migration
├── portfolioManager_v2.4.js                (645 lines) - Multi-wallet module
├── server_wallet_endpoints.js              (523 lines) - API endpoints
├── PHASE2_EXECUTIVE_SUMMARY.md             (523 lines) - Executive overview
└── PHASE2_MULTI_WALLET_GUIDE.md            (832 lines) - Complete guide
```

**Total**: 2,837 lines of production-ready code and documentation

---

## 🚀 Quick Deploy (3 Steps)

### 1. Database Migration (5 min)

```bash
# Go to Supabase → SQL Editor
# Copy/paste entire content of: migrations/001_multi_wallet_schema.sql
# Click "Run"
```

✅ Creates tables: `wallets`, `portfolios`, `wallet_snapshots`
✅ Auto-migrates existing data to "Main Wallet"
✅ Sets up RLS policies

### 2. Backend Update (5 min)

```bash
# Rename files
mv portfolioManager.js portfolioManager.backup.js
mv portfolioManager_v2.4.js portfolioManager.js
```

**Update `server.js`:**

1. **Replace imports** (line ~17-23):
   ```javascript
   const {
     upload, parsePortfolioCSV,
     createWallet, getWallets, updateWallet, deleteWallet,
     savePortfolioToWallet, getWalletPortfolio, getAllPortfolios,
     calculateWalletPnL, calculatePnLByWallet, calculateConsolidatedPnL,
     WALLET_PROVIDERS, WALLET_TYPES
   } = require('./portfolioManager');
   ```

2. **Copy endpoints** from `server_wallet_endpoints.js` (paste after line ~715)

3. **Update version** (line ~576):
   ```javascript
   version: '2.4.0-phase2',
   ```

4. **Test**:
   ```bash
   npm start
   curl http://localhost:3001/api/wallets/test-user
   ```

### 3. Frontend (React Components Ready)

See `PHASE2_MULTI_WALLET_GUIDE.md` for complete React components:
- WalletSelector
- CreateWalletModal
- PortfolioDashboard (with By Wallet / Consolidated toggle)
- PortfolioUpload (updated)

---

## 🎨 Key Features

### Multi-Wallet Management
```javascript
// Create wallet
POST /api/wallets
{
  "userId": "user123",
  "name": "Binance Main",
  "type": "exchange",
  "provider": "binance",
  "color": "#F3BA2F"
}

// Upload to specific wallet
POST /api/portfolio/upload
FormData: { file, userId, walletId }
```

### P&L Views

**By Wallet**:
```json
{
  "byWallet": [
    {
      "walletName": "Binance Main",
      "totalValue": 30000,
      "totalPnL": 10000,
      "totalPnLPercent": 50
    }
  ]
}
```

**Consolidated**:
```json
{
  "consolidated": {
    "totalValue": 50000,
    "totalPnL": 15000,
    "byAsset": [...]
  }
}
```

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/wallets/:userId` | List all wallets |
| `POST` | `/api/wallets` | Create wallet |
| `PATCH` | `/api/wallets/:walletId` | Update wallet |
| `DELETE` | `/api/wallets/:walletId` | Archive wallet |
| `POST` | `/api/portfolio/upload` | Upload to wallet |
| `GET` | `/api/portfolio/:userId` | Multi-wallet P&L |
| `GET` | `/api/portfolio/:userId/wallet/:walletId` | Single wallet |
| `GET` | `/api/portfolio/:userId/consolidated` | Consolidated view |
| `GET` | `/api/wallets/:userId/summary` | High-level summary |

---

## 🧪 Quick Test

```bash
# 1. Create wallet
curl -X POST http://localhost:3001/api/wallets \
  -H "Content-Type: application/json" \
  -d '{"userId": "test", "name": "Binance", "type": "exchange", "provider": "binance"}'

# 2. Create test CSV
cat > test_portfolio.csv << EOF
Asset,Amount,Buy Price,Purchase Date
bitcoin,0.5,42000,2024-01-15
ethereum,5.0,2500,2024-01-20
EOF

# 3. Upload (use walletId from step 1)
curl -F "file=@test_portfolio.csv" \
     -F "userId=test" \
     -F "walletId=<wallet-id>" \
     http://localhost:3001/api/portfolio/upload

# 4. View portfolio
curl http://localhost:3001/api/portfolio/test
```

---

## 📚 Documentation

| File | Purpose |
|------|---------|
| **PHASE2_EXECUTIVE_SUMMARY.md** | High-level overview, architecture, business value |
| **PHASE2_MULTI_WALLET_GUIDE.md** | Complete migration guide, React components, troubleshooting |
| **migrations/001_multi_wallet_schema.sql** | Database schema with inline comments |

---

## 🎯 Supported Providers

**Exchanges**: Binance, Bybit, Coinbase, Kraken, OKX, KuCoin
**LatAm**: MercadoPago, Skipo, Lemon, Ripio
**Wallets**: MetaMask, Trust Wallet, Phantom, Exodus
**Cold Storage**: Ledger, Trezor
**Other**: Custom/DeFi

---

## ⚠️ Important Notes

1. **Backup first**: Migration creates `portfolios_backup` automatically
2. **Test in dev**: Run on test Supabase project before production
3. **Wallet required**: New uploads require `walletId` parameter
4. **Backward compatible**: Old data auto-migrated to "Main Wallet"

---

## 🆘 Troubleshooting

**"Wallet not found"**: Ensure wallet was created and belongs to user
**P&L shows $0**: Check `cachedMarketData` is populated
**Upload fails**: Verify CSV format and walletId
**RLS error**: Check Supabase policies in migration

See **PHASE2_MULTI_WALLET_GUIDE.md** for detailed troubleshooting.

---

## ✅ Checklist

- [ ] Run database migration in Supabase
- [ ] Verify data migrated to "Main Wallet"
- [ ] Update backend code (rename files, update server.js)
- [ ] Test API endpoints locally
- [ ] Build frontend components
- [ ] Deploy to production
- [ ] User testing

---

## 📞 Support

**Questions?** Check the guides:
- Quick answers → This file
- Technical deep-dive → PHASE2_MULTI_WALLET_GUIDE.md
- Business overview → PHASE2_EXECUTIVE_SUMMARY.md

**Contact**: edgardoalonso2708@gmail.com

---

**🚀 Ready to deploy professional multi-wallet portfolio tracking!**

*SENTIX PRO v2.4 - Built by Claude Sonnet 4.5*
