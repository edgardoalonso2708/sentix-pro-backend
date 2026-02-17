# 🚀 DEPLOY PHASE 2 TO PRODUCTION - CRITICAL STEPS

**Status**: ✅ Backend code deployed to GitHub → Railway auto-deploying now
**Pending**: ⚠️ Database migration REQUIRED

---

## ✅ What's Already Done

1. **Backend Code**: ✅ Pushed to GitHub (commit 4d96ac3)
2. **Railway Deploy**: ✅ Auto-deploying from GitHub push
3. **Version**: ✅ Updated to v2.4.0-phase2

---

## ⚠️ CRITICAL: Database Migration (Required NOW)

**Without this migration, the backend WILL FAIL on Railway!**

### Step 1: Open Supabase SQL Editor

1. Go to: https://supabase.com/dashboard
2. Select your project: **SENTIX PRO**
3. Click **SQL Editor** in left sidebar

### Step 2: Run Migration SQL

**Copy and paste this ENTIRE file** into SQL Editor:

```
migrations/001_multi_wallet_schema.sql
```

Or copy from here:
```sql
-- Just open the file migrations/001_multi_wallet_schema.sql
-- It's 314 lines - paste ALL of it
-- Click "Run"
```

### Step 3: Verify Migration Success

Run this query to verify:

```sql
-- Should return 3 rows: wallets, portfolios, wallet_snapshots
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('wallets', 'portfolios', 'wallet_snapshots');
```

### Step 4: Check Data Migration

```sql
-- Should show your existing data in "Main Wallet"
SELECT w.name, COUNT(p.id) as positions
FROM wallets w
LEFT JOIN portfolios p ON w.id = p.wallet_id
GROUP BY w.name;
```

Expected output:
```
Main Wallet | X positions  (X = your existing portfolio count)
```

---

## 🎯 After Migration: Test Production

### Test 1: Check Backend Version

```bash
curl https://sentix-pro-backend.up.railway.app/

# Should show: "version": "2.4.0-phase2"
```

### Test 2: Create a Wallet

```bash
curl -X POST https://sentix-pro-backend.up.railway.app/api/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "name": "Binance Main",
    "type": "exchange",
    "provider": "binance",
    "color": "#F3BA2F"
  }'

# Should return: { "success": true, "wallet": {...} }
```

### Test 3: Get Wallets

```bash
curl https://sentix-pro-backend.up.railway.app/api/wallets/test-user

# Should return: { "wallets": [...] }
```

### Test 4: Get Portfolio (Multi-Wallet)

```bash
curl https://sentix-pro-backend.up.railway.app/api/portfolio/test-user

# Should return: { "byWallet": [...], "consolidated": {...} }
```

---

## 📊 Railway Deployment Status

Check deployment at: https://railway.app/dashboard

**Expected logs after migration**:
```
✅ Server started on port 3001
✅ Supabase connected
✅ Multi-wallet endpoints active
✅ Version: 2.4.0-phase2
```

**If you see errors about missing tables**:
→ Run the database migration NOW (Step 1-4 above)

---

## 🆘 Troubleshooting

### Error: "relation 'wallets' does not exist"
**Cause**: Database migration not run yet
**Fix**: Complete Step 1-4 above

### Error: "column 'wallet_id' does not exist"
**Cause**: Database migration incomplete
**Fix**: Re-run entire migration SQL

### Error: "function calculate_wallet_pnl does not exist"
**Cause**: Migration SQL was only partially executed
**Fix**: Copy ENTIRE file (all 314 lines) and run again

### Railway keeps restarting
**Cause**: Database schema mismatch
**Fix**: Run migration, wait 2-3 minutes for Railway to stabilize

---

## ✅ Success Checklist

- [ ] Supabase migration completed (3 tables created)
- [ ] Railway deployment successful (no errors in logs)
- [ ] Version shows 2.4.0-phase2
- [ ] Test wallet creation works
- [ ] Test portfolio fetch returns byWallet + consolidated
- [ ] Existing portfolio data appears in "Main Wallet"

---

## 🎉 When Everything Works

You'll have:

✅ **Multi-wallet support** in production
✅ **Segregated P&L** by exchange/wallet
✅ **Consolidated view** across all holdings
✅ **9 new API endpoints** ready for frontend

---

## 📞 Need Help?

**Check logs**:
- Railway: https://railway.app/dashboard → View Logs
- Supabase: SQL Editor → Run test queries

**Common issues**: See Troubleshooting section above

**Documentation**: PHASE2_MULTI_WALLET_GUIDE.md

---

**⏱️ Time to complete**: 5-10 minutes
**Critical**: Database migration must be done BEFORE Railway deployment stabilizes

🚀 **GO TO SUPABASE NOW AND RUN THE MIGRATION!**
