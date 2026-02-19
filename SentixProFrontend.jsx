'use client'

import { useState, useCallback, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - FRONTEND COMPLETO
// Dashboard, Señales, Portfolio, Alertas - Versión Full
// ═══════════════════════════════════════════════════════════════════════════════

export default function SentixProFrontend() {
  
  // ─── CONFIGURATION ─────────────────────────────────────────────────────────
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  
  // ─── STATE ─────────────────────────────────────────────────────────────────
  const [marketData, setMarketData] = useState(null);
  const [signals, setSignals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [tab, setTab] = useState("dashboard");
  
  // Alert config
  const [alertConfig, setAlertConfig] = useState({
    email: "edgardoalonso2708@gmail.com",
    telegramEnabled: false,
    minConfidence: 75,
  });

  // Portfolio & Wallets
  const [portfolio, setPortfolio] = useState([]);
  const [wallets, setWallets] = useState([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const USER_ID = 'default-user';
  
  // ─── FETCH MARKET DATA ─────────────────────────────────────────────────────
  const fetchMarketData = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/market`);
      const data = await response.json();
      setMarketData(data);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Error fetching market data:', error);
    }
  }, [API_URL]);

  const fetchSignals = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/signals`);
      const data = await response.json();
      setSignals(data);
    } catch (error) {
      console.error('Error fetching signals:', error);
    }
  }, [API_URL]);

  const fetchAlerts = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/alerts`);
      const data = await response.json();
      setAlerts(data);
    } catch (error) {
      console.error('Error fetching alerts:', error);
    }
  }, [API_URL]);

  // ─── FETCH WALLETS & PORTFOLIO FROM BACKEND ──────────────────────────────
  const fetchWallets = useCallback(async () => {
    try {
      setWalletsLoading(true);
      const response = await fetch(`${API_URL}/api/wallets/${USER_ID}`);
      if (response.ok) {
        const data = await response.json();
        setWallets(data.wallets || []);
      }
    } catch (error) {
      console.error('Error fetching wallets:', error);
    } finally {
      setWalletsLoading(false);
    }
  }, [API_URL]);

  const fetchPortfolio = useCallback(async () => {
    try {
      setPortfolioLoading(true);
      const response = await fetch(`${API_URL}/api/portfolio/${USER_ID}`);
      if (response.ok) {
        const data = await response.json();
        // Flatten wallet positions into portfolio array
        const positions = [];
        if (data.byWallet && Array.isArray(data.byWallet)) {
          for (const wallet of data.byWallet) {
            if (wallet.positions) {
              for (const pos of wallet.positions) {
                positions.push({
                  id: pos.id,
                  asset: pos.asset,
                  amount: pos.amount,
                  buyPrice: pos.buy_price,
                  date: pos.purchase_date,
                  walletId: pos.wallet_id,
                  walletName: wallet.walletName,
                  walletColor: wallet.walletColor,
                });
              }
            }
          }
        }
        setPortfolio(positions);
      }
    } catch (error) {
      console.error('Error fetching portfolio:', error);
    } finally {
      setPortfolioLoading(false);
    }
  }, [API_URL]);

  // ─── INITIAL LOAD & AUTO-REFRESH ───────────────────────────────────────────
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      // Use Promise.allSettled so one failure doesn't block everything
      await Promise.allSettled([
        fetchMarketData(),
        fetchSignals(),
        fetchAlerts(),
      ]);
      setLoading(false);
    };

    loadData();

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => {
      fetchMarketData();
      fetchSignals();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchMarketData, fetchSignals, fetchAlerts]);

  // ─── PORTFOLIO FUNCTIONS ───────────────────────────────────────────────────
  const addToPortfolio = (asset, amount, buyPrice) => {
    const newPosition = {
      id: Date.now(),
      asset,
      amount: parseFloat(amount),
      buyPrice: parseFloat(buyPrice),
      date: new Date().toISOString(),
    };
    setPortfolio(prev => [...prev, newPosition]);
  };

  const removeFromPortfolio = (id) => {
    setPortfolio(prev => prev.filter(p => p.id !== id));
  };

  const calculatePortfolioValue = () => {
    if (!marketData || !marketData.crypto) return 0;
    
    return portfolio.reduce((total, position) => {
      const currentPrice = marketData.crypto[position.asset]?.price || 0;
      return total + (position.amount * currentPrice);
    }, 0);
  };

  const calculatePortfolioPnL = () => {
    if (!marketData || !marketData.crypto) return { pnl: 0, percentage: 0 };
    
    let totalInvested = 0;
    let totalCurrent = 0;
    
    portfolio.forEach(position => {
      const currentPrice = marketData.crypto[position.asset]?.price || 0;
      totalInvested += position.amount * position.buyPrice;
      totalCurrent += position.amount * currentPrice;
    });
    
    const pnl = totalCurrent - totalInvested;
    const percentage = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
    
    return { pnl, percentage };
  };

  // Test alert is now handled directly in AlertsTab

  // ─── STYLES ────────────────────────────────────────────────────────────────
  const bg = "#0a0a0a";
  const bg2 = "#111111";
  const bg3 = "#1a1a1a";
  const border = "rgba(255,255,255,0.08)";
  const text = "#f9fafb";
  const muted = "#6b7280";
  const green = "#00d4aa";
  const red = "#ef4444";
  const amber = "#f59e0b";
  const blue = "#3b82f6";
  const purple = "#a855f7";
  const gold = "#d4af37";

  const card = {
    background: bg2,
    border: `1px solid ${border}`,
    borderRadius: 10,
    padding: "16px 20px",
    marginBottom: 14,
  };

  const sTitle = {
    fontSize: 10,
    color: muted,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontWeight: 700,
    marginBottom: 12,
  };

  // ─── HELPER FUNCTIONS ──────────────────────────────────────────────────────
  const formatPrice = (price) => {
    if (!price) return '$0';
    if (price >= 1000) return `$${price.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
    if (price >= 1) return `$${price.toFixed(2)}`;
    return `$${price.toFixed(4)}`;
  };

  const formatLargeNumber = (num) => {
    if (!num) return '$0';
    if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    return `$${num.toFixed(2)}`;
  };

  // ─── COMPONENTS ────────────────────────────────────────────────────────────

  const DashboardTab = () => {
    if (!marketData || !marketData.crypto) {
      return <div style={{ padding: 40, textAlign: 'center', color: muted }}>Loading market data...</div>;
    }

    const topGainers = Object.entries(marketData.crypto)
      .sort((a, b) => b[1].change24h - a[1].change24h)
      .slice(0, 3);

    const topLosers = Object.entries(marketData.crypto)
      .sort((a, b) => a[1].change24h - b[1].change24h)
      .slice(0, 3);

    return (
      <div>
        {/* Live Status */}
        <div style={{
          background: "rgba(0, 212, 170, 0.1)",
          border: `1px solid ${green}`,
          borderRadius: 8,
          padding: "12px 16px",
          marginBottom: 16,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: green,
              boxShadow: `0 0 10px ${green}`,
              animation: "pulse 2s infinite"
            }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: green }}>
              🔴 LIVE - Datos actualizándose cada 30 segundos
            </span>
          </div>
          {lastUpdate && (
            <span style={{ fontSize: 11, color: muted, fontFamily: "monospace" }}>
              Última actualización: {lastUpdate.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Macro Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            { 
              label: "Fear & Greed", 
              value: marketData.macro?.fearGreed || 'N/A',
              sublabel: marketData.macro?.fearLabel || '',
              color: (marketData.macro?.fearGreed || 0) < 30 ? red : (marketData.macro?.fearGreed || 0) > 70 ? green : amber
            },
            { 
              label: "BTC Dominance", 
              value: `${marketData.macro?.btcDom || 'N/A'}%`,
              sublabel: "Market share",
              color: amber 
            },
            { 
              label: "Total Market Cap", 
              value: formatLargeNumber(marketData.macro?.globalMcap || 0),
              sublabel: "All cryptocurrencies",
              color: blue 
            },
            { 
              label: "Gold Price", 
              value: formatPrice(marketData.metals?.gold?.price || 0),
              sublabel: "Per ounce",
              color: gold 
            },
            { 
              label: "Silver Price", 
              value: formatPrice(marketData.metals?.silver?.price || 0),
              sublabel: "Per ounce",
              color: text 
            },
          ].map(({ label, value, sublabel, color }) => (
            <div key={label} style={card}>
              <div style={{ ...sTitle, marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
              {sublabel && <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>{sublabel}</div>}
            </div>
          ))}
        </div>

        {/* Top Movers */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div style={card}>
            <div style={sTitle}>🚀 TOP GAINERS 24H</div>
            {topGainers.map(([id, data]) => (
              <div key={id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 0",
                borderBottom: `1px solid ${border}`
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{id.toUpperCase()}</div>
                  <div style={{ fontSize: 11, color: muted }}>{formatPrice(data.price)}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: green }}>
                  +{data.change24h.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>

          <div style={card}>
            <div style={sTitle}>📉 TOP LOSERS 24H</div>
            {topLosers.map(([id, data]) => (
              <div key={id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 0",
                borderBottom: `1px solid ${border}`
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{id.toUpperCase()}</div>
                  <div style={{ fontSize: 11, color: muted }}>{formatPrice(data.price)}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: red }}>
                  {data.change24h.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Signals Preview */}
        {signals.length > 0 && (
          <div style={card}>
            <div style={sTitle}>🎯 SEÑALES ACTIVAS (Top 5)</div>
            <div style={{ display: "grid", gap: 10 }}>
              {signals.slice(0, 5).map((signal, i) => (
                <div key={i} style={{
                  background: bg3,
                  borderLeft: `3px solid ${signal.action === 'BUY' ? green : signal.action === 'SELL' ? red : amber}`,
                  borderRadius: 6,
                  padding: "10px 14px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 10
                }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪'} {signal.asset}
                    </div>
                    <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                      {signal.reasons}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, color: amber, fontWeight: 700 }}>
                      {signal.confidence}% confianza
                    </div>
                    <div style={{ fontSize: 11, color: muted }}>
                      Score: {signal.score}/100
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setTab('signals')}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px",
                background: bg3,
                border: `1px solid ${border}`,
                borderRadius: 6,
                color: text,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Ver todas las señales →
            </button>
          </div>
        )}
      </div>
    );
  };

  const SignalsTab = () => {
    return (
      <div>
        <div style={card}>
          <div style={sTitle}>🎯 TODAS LAS SEÑALES ACTIVAS</div>
          
          {signals.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              No hay señales de alta confianza en este momento
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {signals.map((signal, i) => (
                <div key={i} style={{
                  background: bg3,
                  borderLeft: `4px solid ${signal.action === 'BUY' ? green : signal.action === 'SELL' ? red : amber}`,
                  borderRadius: 8,
                  padding: "14px 18px"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>
                        {signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪'} {signal.asset}
                      </div>
                      <div style={{ fontSize: 13, color: muted }}>
                        {formatPrice(signal.price)} · {signal.change24h >= 0 ? '+' : ''}{signal.change24h.toFixed(2)}% 24h
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{
                        fontSize: 11,
                        color: signal.action === 'BUY' ? green : signal.action === 'SELL' ? red : amber,
                        fontWeight: 700,
                        background: `${signal.action === 'BUY' ? green : signal.action === 'SELL' ? red : amber}22`,
                        padding: "4px 12px",
                        borderRadius: 6,
                        marginBottom: 6
                      }}>
                        {signal.action}
                      </div>
                      <div style={{ fontSize: 12, color: amber, fontWeight: 700 }}>
                        {signal.confidence}% confianza
                      </div>
                      <div style={{ fontSize: 11, color: muted }}>
                        Score: {signal.score}/100
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: text, marginBottom: 8 }}>
                    {signal.reasons}
                  </div>
                  <div style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                    {new Date(signal.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const PortfolioTab = () => {
    const [showAddForm, setShowAddForm] = useState(false);
    const [showBatchUpload, setShowBatchUpload] = useState(false);
    const [showCreateWallet, setShowCreateWallet] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [selectedWalletFilter, setSelectedWalletFilter] = useState('all');
    const [newPosition, setNewPosition] = useState({
      asset: 'bitcoin',
      amount: '',
      buyPrice: '',
      walletId: ''
    });
    const [newWallet, setNewWallet] = useState({
      name: '',
      type: 'exchange',
      provider: 'binance',
      color: '#6366f1'
    });
    const [uploadWalletId, setUploadWalletId] = useState('');

    // Load wallets and portfolio when tab mounts
    useEffect(() => {
      fetchWallets();
      fetchPortfolio();
    }, [fetchWallets, fetchPortfolio]);

    // Set default walletId when wallets load
    useEffect(() => {
      if (wallets.length > 0 && !newPosition.walletId) {
        setNewPosition(prev => ({ ...prev, walletId: wallets[0].id }));
        if (!uploadWalletId) setUploadWalletId(wallets[0].id);
      }
    }, [wallets]);

    const portfolioValue = calculatePortfolioValue();
    const { pnl, percentage } = calculatePortfolioPnL();

    // Filter positions by wallet
    const filteredPositions = selectedWalletFilter === 'all'
      ? portfolio
      : portfolio.filter(p => p.walletId === selectedWalletFilter);

    const handleCreateWallet = async () => {
      if (!newWallet.name.trim()) return;
      try {
        const response = await fetch(`${API_URL}/api/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: USER_ID,
            name: newWallet.name,
            type: newWallet.type,
            provider: newWallet.provider,
            color: newWallet.color
          })
        });
        if (response.ok) {
          await fetchWallets();
          setNewWallet({ name: '', type: 'exchange', provider: 'binance', color: '#6366f1' });
          setShowCreateWallet(false);
        } else {
          const err = await response.json();
          alert(err.error || 'Error creating wallet');
        }
      } catch (error) {
        alert('Network error: ' + error.message);
      }
    };

    const handleAdd = async () => {
      if (!newPosition.amount || !newPosition.buyPrice || !newPosition.walletId) {
        if (!newPosition.walletId) {
          alert('Primero crea una wallet para agregar posiciones');
          setShowCreateWallet(true);
        }
        return;
      }
      setSaving(true);
      try {
        // Get current positions for this wallet, then add the new one
        const res = await fetch(`${API_URL}/api/portfolio/${USER_ID}/wallet/${newPosition.walletId}`);
        const data = res.ok ? await res.json() : { wallet: { positions: [] } };
        const existingPositions = (data.wallet?.positions || []).map(p => ({
          asset: p.asset,
          amount: p.amount,
          buyPrice: p.buy_price,
          purchaseDate: p.purchase_date,
          notes: p.notes || '',
          transactionId: p.transaction_id || ''
        }));

        // Add the new position
        existingPositions.push({
          asset: newPosition.asset,
          amount: parseFloat(newPosition.amount),
          buyPrice: parseFloat(newPosition.buyPrice),
          purchaseDate: new Date().toISOString(),
          notes: '',
          transactionId: ''
        });

        // Save all positions to wallet via JSON endpoint
        const saveRes = await fetch(`${API_URL}/api/portfolio/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: USER_ID,
            walletId: newPosition.walletId,
            positions: existingPositions
          })
        });

        if (saveRes.ok) {
          await fetchPortfolio();
          setNewPosition(prev => ({ ...prev, amount: '', buyPrice: '' }));
          setShowAddForm(false);
        } else {
          // Fallback: add to local state if backend fails
          addToPortfolio(newPosition.asset, newPosition.amount, newPosition.buyPrice);
          setNewPosition(prev => ({ ...prev, amount: '', buyPrice: '' }));
          setShowAddForm(false);
        }
      } catch (error) {
        // Fallback: add to local state
        addToPortfolio(newPosition.asset, newPosition.amount, newPosition.buyPrice);
        setNewPosition(prev => ({ ...prev, amount: '', buyPrice: '' }));
        setShowAddForm(false);
      } finally {
        setSaving(false);
      }
    };

    const handleRemovePosition = async (positionId) => {
      try {
        const response = await fetch(`${API_URL}/api/portfolio/${USER_ID}/${positionId}`, {
          method: 'DELETE'
        });
        if (response.ok) {
          await fetchPortfolio();
        } else {
          removeFromPortfolio(positionId);
        }
      } catch {
        removeFromPortfolio(positionId);
      }
    };

    const handleFileUpload = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!uploadWalletId) {
        setUploadStatus({ type: 'error', message: 'Selecciona una wallet primero' });
        e.target.value = '';
        return;
      }

      setUploading(true);
      setUploadStatus(null);

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('userId', USER_ID);
        formData.append('walletId', uploadWalletId);

        const response = await fetch(`${API_URL}/api/portfolio/upload`, {
          method: 'POST',
          body: formData,
        });

        const result = await response.json();

        if (response.ok) {
          setUploadStatus({ type: 'success', message: result.message });
          await fetchPortfolio();
        } else {
          setUploadStatus({
            type: 'error',
            message: result.error || 'Upload failed',
            details: result.details
          });
        }
      } catch (error) {
        setUploadStatus({ type: 'error', message: 'Network error: ' + error.message });
      } finally {
        setUploading(false);
        e.target.value = '';
      }
    };

    const downloadTemplate = () => {
      window.open(`${API_URL}/api/portfolio/template`, '_blank');
    };

    const walletProviderLabels = {
      binance: 'Binance', bybit: 'Bybit', coinbase: 'Coinbase', kraken: 'Kraken',
      okx: 'OKX', kucoin: 'KuCoin', mercadopago: 'MercadoPago', skipo: 'Skipo',
      lemon: 'Lemon', ripio: 'Ripio', metamask: 'MetaMask', trust_wallet: 'Trust Wallet',
      ledger: 'Ledger', trezor: 'Trezor', phantom: 'Phantom', exodus: 'Exodus', other: 'Otro'
    };

    const walletTypeLabels = {
      exchange: 'Exchange', wallet: 'Wallet', cold_storage: 'Cold Storage', defi: 'DeFi', other: 'Otro'
    };

    const walletColors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];

    return (
      <div>
        {/* Portfolio Summary */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div style={card}>
            <div style={sTitle}>Valor Total</div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>
              {formatLargeNumber(portfolioValue)}
            </div>
          </div>
          <div style={card}>
            <div style={sTitle}>P&L</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: pnl >= 0 ? green : red }}>
              {pnl >= 0 ? '+' : ''}{formatLargeNumber(pnl)}
            </div>
            <div style={{ fontSize: 13, color: pnl >= 0 ? green : red, marginTop: 4 }}>
              {percentage >= 0 ? '+' : ''}{percentage.toFixed(2)}%
            </div>
          </div>
          <div style={card}>
            <div style={sTitle}>Posiciones</div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{portfolio.length}</div>
          </div>
          <div style={card}>
            <div style={sTitle}>Wallets</div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{wallets.length}</div>
          </div>
        </div>

        {/* Wallet Chips */}
        {wallets.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button
              onClick={() => setSelectedWalletFilter('all')}
              style={{
                padding: "6px 14px",
                background: selectedWalletFilter === 'all' ? purple : bg3,
                border: selectedWalletFilter === 'all' ? 'none' : `1px solid ${border}`,
                borderRadius: 20,
                color: text,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Todas ({portfolio.length})
            </button>
            {wallets.map(w => {
              const count = portfolio.filter(p => p.walletId === w.id).length;
              return (
                <button
                  key={w.id}
                  onClick={() => setSelectedWalletFilter(w.id)}
                  style={{
                    padding: "6px 14px",
                    background: selectedWalletFilter === w.id ? (w.color || purple) : bg3,
                    border: selectedWalletFilter === w.id ? 'none' : `1px solid ${w.color || border}`,
                    borderRadius: 20,
                    color: text,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer"
                  }}
                >
                  {w.name} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <button
            onClick={() => { setShowAddForm(!showAddForm); setShowBatchUpload(false); setShowCreateWallet(false); }}
            style={{
              padding: "10px",
              background: `linear-gradient(135deg, ${purple}, #7c3aed)`,
              border: "none",
              borderRadius: 8,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {showAddForm ? 'Cancelar' : 'Agregar Posicion'}
          </button>
          <button
            onClick={() => { setShowBatchUpload(!showBatchUpload); setShowAddForm(false); setShowCreateWallet(false); }}
            style={{
              padding: "10px",
              background: `linear-gradient(135deg, ${blue}, #2563eb)`,
              border: "none",
              borderRadius: 8,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {showBatchUpload ? 'Cancelar' : 'Subir CSV'}
          </button>
          <button
            onClick={() => { setShowCreateWallet(!showCreateWallet); setShowAddForm(false); setShowBatchUpload(false); }}
            style={{
              padding: "10px",
              background: `linear-gradient(135deg, ${green}, #00b894)`,
              border: "none",
              borderRadius: 8,
              color: "#000",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            {showCreateWallet ? 'Cancelar' : 'Nueva Wallet'}
          </button>
        </div>

        {/* Create Wallet Form */}
        {showCreateWallet && (
          <div style={{ ...card, marginBottom: 16, borderColor: green }}>
            <div style={sTitle}>CREAR NUEVA WALLET</div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>NOMBRE</label>
                <input
                  type="text"
                  value={newWallet.name}
                  onChange={e => setNewWallet(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Mi Binance, Ledger Principal..."
                  style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>TIPO</label>
                  <select
                    value={newWallet.type}
                    onChange={e => setNewWallet(prev => ({ ...prev, type: e.target.value }))}
                    style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                  >
                    {Object.entries(walletTypeLabels).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>PROVEEDOR</label>
                  <select
                    value={newWallet.provider}
                    onChange={e => setNewWallet(prev => ({ ...prev, provider: e.target.value }))}
                    style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                  >
                    {Object.entries(walletProviderLabels).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>COLOR</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {walletColors.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewWallet(prev => ({ ...prev, color: c }))}
                      style={{
                        width: 28, height: 28, borderRadius: 6, background: c, border: newWallet.color === c ? '2px solid #fff' : '2px solid transparent', cursor: "pointer"
                      }}
                    />
                  ))}
                </div>
              </div>
              <button
                onClick={handleCreateWallet}
                style={{
                  padding: "10px",
                  background: `linear-gradient(135deg, ${green}, #00b894)`,
                  border: "none",
                  borderRadius: 6,
                  color: "#000",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Crear Wallet
              </button>
            </div>
          </div>
        )}

        {/* Batch Upload Section */}
        {showBatchUpload && (
          <div style={{ ...card, marginBottom: 16, borderColor: blue }}>
            <div style={sTitle}>IMPORTAR PORTFOLIO (CSV/EXCEL)</div>

            {/* Wallet selector for upload */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>WALLET DESTINO</label>
              {wallets.length === 0 ? (
                <div style={{ fontSize: 12, color: amber, padding: "8px 12px", background: `${amber}15`, borderRadius: 6 }}>
                  Crea una wallet primero para poder subir posiciones
                </div>
              ) : (
                <select
                  value={uploadWalletId}
                  onChange={e => setUploadWalletId(e.target.value)}
                  style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                >
                  {wallets.map(w => (
                    <option key={w.id} value={w.id}>{w.name} ({walletProviderLabels[w.provider] || w.provider})</option>
                  ))}
                </select>
              )}
            </div>

            <div style={{
              background: bg3, borderRadius: 8, padding: "16px", marginBottom: 14,
              border: `1px dashed ${border}`, textAlign: "center"
            }}>
              <div style={{ fontSize: 13, color: text, marginBottom: 12 }}>
                Sube un archivo CSV o Excel con tus posiciones
              </div>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileUpload}
                disabled={uploading || wallets.length === 0}
                style={{ display: "block", margin: "0 auto 12px", fontSize: 12, color: text }}
              />
              {uploading && (
                <div style={{ fontSize: 12, color: amber, marginTop: 8 }}>Procesando archivo...</div>
              )}
              {uploadStatus && (
                <div style={{
                  fontSize: 12, color: uploadStatus.type === 'success' ? green : red, marginTop: 8,
                  padding: "8px 12px", background: uploadStatus.type === 'success' ? `${green}15` : `${red}15`, borderRadius: 6
                }}>
                  {uploadStatus.message}
                  {uploadStatus.details && (
                    <div style={{ marginTop: 6, fontSize: 11, whiteSpace: "pre-wrap" }}>{uploadStatus.details.join('\n')}</div>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={downloadTemplate}
              style={{
                width: "100%", padding: "10px", background: bg3, border: `1px solid ${border}`,
                borderRadius: 6, color: text, fontSize: 12, fontWeight: 600, cursor: "pointer"
              }}
            >
              Descargar plantilla CSV
            </button>
            <div style={{ fontSize: 11, color: muted, marginTop: 10, lineHeight: 1.6 }}>
              Formato: Asset, Amount, Buy Price, Purchase Date, Notes<br />
              Assets: bitcoin, ethereum, solana, cardano, ripple, polkadot, dogecoin, binancecoin, avalanche-2, chainlink (o BTC, ETH, SOL, etc.)
            </div>
          </div>
        )}

        {/* Add Position Form */}
        {showAddForm && (
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={sTitle}>Nueva Posicion</div>
            <div style={{ display: "grid", gap: 12 }}>
              {/* Wallet Selector */}
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>WALLET</label>
                {wallets.length === 0 ? (
                  <div style={{ fontSize: 12, color: amber, padding: "8px 12px", background: `${amber}15`, borderRadius: 6 }}>
                    Crea una wallet primero
                    <button
                      onClick={() => { setShowAddForm(false); setShowCreateWallet(true); }}
                      style={{ marginLeft: 8, padding: "4px 10px", background: green, border: "none", borderRadius: 4, color: "#000", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      Crear
                    </button>
                  </div>
                ) : (
                  <select
                    value={newPosition.walletId}
                    onChange={e => setNewPosition(prev => ({ ...prev, walletId: e.target.value }))}
                    style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                  >
                    {wallets.map(w => (
                      <option key={w.id} value={w.id}>{w.name} ({walletProviderLabels[w.provider] || w.provider})</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>ACTIVO</label>
                <select
                  value={newPosition.asset}
                  onChange={e => setNewPosition(prev => ({ ...prev, asset: e.target.value }))}
                  style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                >
                  {marketData && Object.keys(marketData.crypto || {}).map(id => (
                    <option key={id} value={id}>{id.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>CANTIDAD</label>
                  <input
                    type="number" step="0.00000001" value={newPosition.amount}
                    onChange={e => setNewPosition(prev => ({ ...prev, amount: e.target.value }))}
                    placeholder="0.5"
                    style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>PRECIO COMPRA</label>
                  <input
                    type="number" step="0.01" value={newPosition.buyPrice}
                    onChange={e => setNewPosition(prev => ({ ...prev, buyPrice: e.target.value }))}
                    placeholder="65000"
                    style={{ width: "100%", background: bg3, border: `1px solid ${border}`, borderRadius: 6, padding: "10px", color: text, fontSize: 13 }}
                  />
                </div>
              </div>
              <button
                onClick={handleAdd}
                disabled={saving}
                style={{
                  padding: "10px",
                  background: saving ? bg3 : `linear-gradient(135deg, ${green}, #00b894)`,
                  border: "none", borderRadius: 6, color: "#000", fontSize: 13, fontWeight: 700,
                  cursor: saving ? "not-allowed" : "pointer"
                }}
              >
                {saving ? 'Guardando...' : 'Agregar'}
              </button>
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {(portfolioLoading || walletsLoading) && (
          <div style={{ textAlign: "center", padding: 20, color: muted, fontSize: 13 }}>
            Cargando portfolio...
          </div>
        )}

        {/* Positions List */}
        <div style={card}>
          <div style={sTitle}>
            MIS POSICIONES {selectedWalletFilter !== 'all' && wallets.find(w => w.id === selectedWalletFilter)
              ? `- ${wallets.find(w => w.id === selectedWalletFilter).name}`
              : ''}
          </div>
          {filteredPositions.length === 0 && !portfolioLoading ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              {wallets.length === 0
                ? 'Crea una wallet primero, luego agrega posiciones.'
                : 'No tienes posiciones. Agrega una arriba o sube un archivo CSV.'}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {filteredPositions.map(position => {
                const currentPrice = marketData?.crypto?.[position.asset]?.price || 0;
                const positionValue = position.amount * currentPrice;
                const positionPnL = positionValue - (position.amount * position.buyPrice);
                const positionPnLPercent = position.buyPrice > 0 ? ((currentPrice - position.buyPrice) / position.buyPrice) * 100 : 0;

                return (
                  <div key={position.id} style={{
                    background: bg3, borderRadius: 8, padding: "14px",
                    borderLeft: position.walletColor ? `3px solid ${position.walletColor}` : 'none',
                    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10
                  }}>
                    <div style={{ flex: 1, minWidth: 140 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                        {position.asset.toUpperCase()}
                      </div>
                      <div style={{ fontSize: 11, color: muted }}>
                        {position.amount} @ {formatPrice(position.buyPrice)}
                      </div>
                      {position.walletName && (
                        <div style={{ fontSize: 10, color: position.walletColor || purple, marginTop: 3, fontWeight: 600 }}>
                          {position.walletName}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flex: 1, minWidth: 110 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>
                        {formatLargeNumber(positionValue)}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: positionPnL >= 0 ? green : red, marginTop: 4 }}>
                        {positionPnL >= 0 ? '+' : ''}{formatLargeNumber(positionPnL)}
                      </div>
                      <div style={{ fontSize: 11, color: positionPnL >= 0 ? green : red }}>
                        {positionPnL >= 0 ? '+' : ''}{positionPnLPercent.toFixed(2)}%
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemovePosition(position.id)}
                      style={{
                        padding: "6px 12px", background: "transparent",
                        border: `1px solid ${red}`, borderRadius: 6, color: red, fontSize: 11, cursor: "pointer"
                      }}
                    >
                      Eliminar
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Wallet Summary Cards */}
        {wallets.length > 0 && (
          <div style={{ ...card, marginTop: 14 }}>
            <div style={sTitle}>MIS WALLETS</div>
            <div style={{ display: "grid", gap: 10 }}>
              {wallets.map(w => {
                const walletPositions = portfolio.filter(p => p.walletId === w.id);
                let walletValue = 0;
                let walletInvested = 0;
                walletPositions.forEach(p => {
                  const cp = marketData?.crypto?.[p.asset]?.price || 0;
                  walletValue += p.amount * cp;
                  walletInvested += p.amount * p.buyPrice;
                });
                const walletPnl = walletValue - walletInvested;

                return (
                  <div key={w.id} style={{
                    background: bg3, borderRadius: 8, padding: "14px",
                    borderLeft: `3px solid ${w.color || purple}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10
                  }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: text }}>{w.name}</div>
                      <div style={{ fontSize: 11, color: muted }}>
                        {walletProviderLabels[w.provider] || w.provider} · {walletTypeLabels[w.type] || w.type} · {walletPositions.length} pos.
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{formatLargeNumber(walletValue)}</div>
                      <div style={{ fontSize: 12, color: walletPnl >= 0 ? green : red, fontWeight: 600 }}>
                        {walletPnl >= 0 ? '+' : ''}{formatLargeNumber(walletPnl)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const AlertsTab = () => {
    const [testResult, setTestResult] = useState(null);
    const [testing, setTesting] = useState(false);

    const handleTestAlert = async () => {
      setTesting(true);
      setTestResult(null);
      try {
        const response = await fetch(`${API_URL}/api/send-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: alertConfig.email,
            message: 'Test alert from SENTIX Pro - System working correctly!'
          })
        });
        const data = await response.json();
        setTestResult(data);
      } catch (error) {
        setTestResult({ success: false, message: 'Error: ' + error.message });
      } finally {
        setTesting(false);
      }
    };

    return (
      <div>
        {/* Telegram Setup - Primary alert channel */}
        <div style={{
          background: "rgba(59, 130, 246, 0.1)",
          border: `1px solid ${blue}`,
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 16
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: blue, marginBottom: 8 }}>
            ALERTAS POR TELEGRAM (ACTIVO)
          </div>
          <div style={{ fontSize: 12, color: text, lineHeight: 1.8 }}>
            1. Busca el bot de SENTIX Pro en Telegram<br />
            2. Envia <code style={{ background: bg3, padding: "2px 6px", borderRadius: 4 }}>/start</code> para suscribirte a alertas automaticas<br />
            3. Recibiras alertas BUY/SELL cuando la confianza sea alta<br />
            4. Usa <code style={{ background: bg3, padding: "2px 6px", borderRadius: 4 }}>/señales</code> para ver señales activas<br />
            5. Usa <code style={{ background: bg3, padding: "2px 6px", borderRadius: 4 }}>/stop</code> para desactivar alertas
          </div>
        </div>

        {/* Config */}
        <div style={card}>
          <div style={sTitle}>CONFIGURACION DE ALERTAS</div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
              EMAIL PARA ALERTAS
            </label>
            <input
              type="email"
              value={alertConfig.email}
              onChange={e => setAlertConfig(prev => ({ ...prev, email: e.target.value }))}
              style={{
                width: "100%",
                background: bg3,
                border: `1px solid ${border}`,
                borderRadius: 6,
                padding: "10px 14px",
                color: text,
                fontSize: 13
              }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
              CONFIANZA MINIMA: {alertConfig.minConfidence}%
            </label>
            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={alertConfig.minConfidence}
              onChange={e => setAlertConfig(prev => ({ ...prev, minConfidence: parseInt(e.target.value) }))}
              style={{ width: "100%" }}
            />
          </div>

          <button
            onClick={handleTestAlert}
            disabled={testing}
            style={{
              width: "100%",
              padding: "10px",
              background: testing ? bg3 : `linear-gradient(135deg, ${purple}, #7c3aed)`,
              border: "none",
              borderRadius: 7,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: testing ? "not-allowed" : "pointer"
            }}
          >
            {testing ? 'Enviando...' : 'ENVIAR ALERTA DE PRUEBA'}
          </button>

          {testResult && (
            <div style={{
              marginTop: 12,
              padding: "12px 14px",
              background: bg3,
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.8
            }}>
              <div style={{ color: testResult.success ? green : red, fontWeight: 700, marginBottom: 6 }}>
                {testResult.success ? '✅ Test procesado' : '❌ Error'}
              </div>
              {testResult.delivery && (
                <div style={{ color: text, fontSize: 11 }}>
                  📧 Email: <span style={{ color: testResult.delivery.email === 'sent' ? green : amber }}>
                    {testResult.delivery.email === 'sent' ? '✅ Enviado' : testResult.delivery.email}
                  </span><br />
                  📱 Telegram: <span style={{ color: testResult.delivery.telegram === 'sent' ? green : amber }}>
                    {testResult.delivery.telegram === 'sent' ? '✅ Enviado' : testResult.delivery.telegram}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Alert History */}
        <div style={card}>
          <div style={sTitle}>HISTORIAL DE ALERTAS</div>
          {alerts.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              No hay alertas aun. Las alertas se generan automaticamente cuando hay señales de alta confianza.
            </div>
          ) : (
            <div style={{ maxHeight: 500, overflowY: "auto" }}>
              {alerts.map((alert, i) => (
                <div key={alert.id || i} style={{
                  background: bg3,
                  borderLeft: `3px solid ${alert.action === 'BUY' ? green : alert.action === 'SELL' ? red : amber}`,
                  borderRadius: 6,
                  padding: "12px 14px",
                  marginBottom: 10
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {alert.action === 'BUY' ? '🟢' : alert.action === 'SELL' ? '🔴' : '⚪'} {alert.asset}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: alert.action === 'BUY' ? green : alert.action === 'SELL' ? red : amber,
                      fontWeight: 700,
                      background: `${alert.action === 'BUY' ? green : alert.action === 'SELL' ? red : amber}22`,
                      padding: "3px 8px",
                      borderRadius: 4
                    }}>
                      {alert.action}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
                    Score: {alert.score}/100 | Confianza: {alert.confidence}% | Precio: {formatPrice(alert.price)}
                  </div>
                  <div style={{ fontSize: 11, color: text }}>
                    {alert.reasons}
                  </div>
                  <div style={{ fontSize: 10, color: muted, fontFamily: "monospace", marginTop: 6 }}>
                    {new Date(alert.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ─── LOADING STATE ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{
        fontFamily: "'Inter', sans-serif",
        background: bg,
        minHeight: "100vh",
        color: text,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>◈</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Cargando SENTIX Pro...</div>
          <div style={{ fontSize: 13, color: muted, marginTop: 8 }}>Conectando con APIs en tiempo real</div>
        </div>
      </div>
    );
  }

  // ─── MAIN RENDER ───────────────────────────────────────────────────────────
  return (
    <div style={{
      fontFamily: "'Inter', sans-serif",
      background: bg,
      minHeight: "100vh",
      color: text,
      padding: 0
    }}>
      {/* Grid Background */}
      <div style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(168,85,247,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(168,85,247,0.015) 1px, transparent 1px)",
        backgroundSize: "50px 50px",
        zIndex: 0
      }} />

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 24px", position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingBottom: 18,
          marginBottom: 24,
          borderBottom: `1px solid ${border}`,
          flexWrap: "wrap",
          gap: 16
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 42,
              height: 42,
              border: `2px solid ${purple}`,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: purple,
              fontWeight: 700,
              boxShadow: `0 0 20px rgba(168,85,247,0.3)`
            }}>◈</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "0.02em" }}>
                SENTIX <span style={{ fontSize: 12, color: purple, fontWeight: 500 }}>PRO</span>
              </div>
              <div style={{ fontSize: 10, color: muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Real-time Trading System · Connected
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, fontFamily: "monospace", color: marketData?.macro?.fearGreed < 30 ? red : amber, fontWeight: 700 }}>
                {marketData?.macro?.fearLabel || 'Loading...'} {marketData?.macro?.fearGreed || '--'}/100
              </div>
              <div style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                BTC Dom {marketData?.macro?.btcDom || '--'}%
              </div>
            </div>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: green,
              boxShadow: `0 0 8px ${green}`
            }} />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { k: "dashboard", label: "📊 DASHBOARD", desc: "Overview" },
            { k: "signals", label: "🎯 SEÑALES", desc: "Todas las alertas" },
            { k: "portfolio", label: "💼 PORTFOLIO", desc: "Tus posiciones" },
            { k: "alerts", label: "🔔 ALERTAS", desc: "Configuración" }
          ].map(({ k, label, desc }) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                flex: "1 1 auto",
                minWidth: 140,
                padding: "12px 18px",
                background: tab === k ? `linear-gradient(135deg, ${purple}, #7c3aed)` : bg2,
                border: tab === k ? "none" : `1px solid ${border}`,
                borderRadius: 8,
                color: tab === k ? "#fff" : text,
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                textAlign: "center"
              }}
            >
              <div>{label}</div>
              <div style={{ fontSize: 9, opacity: 0.7, marginTop: 2 }}>{desc}</div>
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === "dashboard" && <DashboardTab />}
        {tab === "signals" && <SignalsTab />}
        {tab === "portfolio" && <PortfolioTab />}
        {tab === "alerts" && <AlertsTab />}

        {/* Footer */}
        <div style={{
          textAlign: "center",
          fontSize: 10,
          color: "#1f2937",
          fontFamily: "monospace",
          padding: "16px 0",
          borderTop: `1px solid ${border}`,
          marginTop: 20,
          lineHeight: 1.8
        }}>
          SENTIX PRO v2.0 · Real-time Trading System · Connected to Live APIs<br />
          ⚠ Herramienta de análisis. No constituye asesoramiento financiero.
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        button:hover:not(:disabled) { opacity: 0.85 !important; }
        * { box-sizing: border-box; }
        input:focus, select:focus { border-color: ${purple} !important; outline: none; }
        
        /* Mobile responsive */
        @media (max-width: 768px) {
          .grid-auto-fit { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
