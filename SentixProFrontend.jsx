'use client'

import { useState, useCallback, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - FRONTEND CONNECTED
// Real-time Trading System
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
    email: "edgardolonso2708@gmail.com",
    telegramEnabled: false,
    minConfidence: 75,
  });

  // Portfolio
  const [portfolio, setPortfolio] = useState([]);
  
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

  // ─── INITIAL LOAD & AUTO-REFRESH ───────────────────────────────────────────
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([
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

  // ─── SEND TEST ALERT ───────────────────────────────────────────────────────
  const sendTestAlert = async () => {
    try {
      await fetch(`${API_URL}/api/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: alertConfig.email,
          message: '🧪 Test alert from SENTIX Pro - System working correctly!'
        })
      });
      alert('✅ Test alert sent! Check your email.');
    } catch (error) {
      alert('❌ Error sending alert: ' + error.message);
    }
  };

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
    if (price >= 1000) return `$${price.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
    if (price >= 1) return `$${price.toFixed(2)}`;
    return `$${price.toFixed(4)}`;
  };

  const formatLargeNumber = (num) => {
    if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    return `$${num.toFixed(2)}`;
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
      padding: 20
    }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
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
              <div style={{ fontSize: 22, fontWeight: 800 }}>
                SENTIX <span style={{ fontSize: 12, color: purple }}>PRO</span>
              </div>
              <div style={{ fontSize: 10, color: muted }}>
                Real-time Trading System · Connected
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: marketData?.macro?.fearGreed < 30 ? red : amber, fontWeight: 700 }}>
              {marketData?.macro?.fearLabel || 'Loading...'} {marketData?.macro?.fearGreed || '--'}/100
            </div>
            <div style={{ fontSize: 10, color: muted }}>
              {lastUpdate ? lastUpdate.toLocaleTimeString() : 'Connecting...'}
            </div>
          </div>
        </div>

        {/* Status Card */}
        <div style={{
          ...card,
          background: "rgba(168, 85, 247, 0.1)",
          border: `1px solid ${purple}`
        }}>
          <h2 style={{ margin: 0, marginBottom: 10, color: purple }}>
            🎉 SENTIX Pro Conectado!
          </h2>
          <p style={{ margin: 0, color: text, fontSize: 14, lineHeight: 1.6 }}>
            Frontend funcionando correctamente. 
            {marketData ? ' ✅ Conectado al backend en Railway' : ' ⏳ Esperando conexión al backend...'}
          </p>
          {marketData && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                📊 DATOS DE MERCADO RECIBIDOS:
              </div>
              <div style={{ 
                background: bg3, 
                padding: 12, 
                borderRadius: 6, 
                fontSize: 11,
                fontFamily: "monospace",
                color: green,
                maxHeight: 200,
                overflow: "auto"
              }}>
                • Fear & Greed: {marketData.macro?.fearGreed}/100<br/>
                • BTC Dominance: {marketData.macro?.btcDom}%<br/>
                • Total Market Cap: {formatLargeNumber(marketData.macro?.globalMcap || 0)}<br/>
                • Cryptos cargadas: {Object.keys(marketData.crypto || {}).length}<br/>
                • Señales activas: {signals.length}<br/>
                • Alertas históricas: {alerts.length}
              </div>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        {marketData && (
          <div style={card}>
            <div style={sTitle}>🚀 ACCIONES RÁPIDAS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <button
                onClick={() => setTab("signals")}
                style={{
                  padding: "12px",
                  background: `linear-gradient(135deg, ${green}, #00b894)`,
                  border: "none",
                  borderRadius: 8,
                  color: "#000",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                📊 Ver Señales ({signals.length})
              </button>
              <button
                onClick={() => setTab("portfolio")}
                style={{
                  padding: "12px",
                  background: `linear-gradient(135deg, ${blue}, #2563eb)`,
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                💼 Mi Portfolio
              </button>
              <button
                onClick={sendTestAlert}
                style={{
                  padding: "12px",
                  background: `linear-gradient(135deg, ${purple}, #7c3aed)`,
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                🔔 Test Alerta
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{
          textAlign: "center",
          fontSize: 10,
          color: muted,
          padding: "16px 0",
          borderTop: `1px solid ${border}`,
          marginTop: 20,
          lineHeight: 1.8
        }}>
          SENTIX PRO v1.0 · Real-time Trading System · Powered by Claude AI<br/>
          ⚠ Herramienta de análisis. No constituye asesoramiento financiero.
        </div>
      </div>

      <style>{`
        button:hover:not(:disabled) { opacity: 0.85 !important; transform: translateY(-1px); }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}