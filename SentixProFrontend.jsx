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
    const [newPosition, setNewPosition] = useState({
      asset: 'bitcoin',
      amount: '',
      buyPrice: ''
    });

    const portfolioValue = calculatePortfolioValue();
    const { pnl, percentage } = calculatePortfolioPnL();

    const handleAdd = () => {
      if (newPosition.amount && newPosition.buyPrice) {
        addToPortfolio(newPosition.asset, newPosition.amount, newPosition.buyPrice);
        setNewPosition({ asset: 'bitcoin', amount: '', buyPrice: '' });
        setShowAddForm(false);
      }
    };

    return (
      <div>
        {/* Portfolio Summary */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
          <div style={card}>
            <div style={sTitle}>Valor Total</div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>
              {formatLargeNumber(portfolioValue)}
            </div>
          </div>
          <div style={card}>
            <div style={sTitle}>P&L</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: pnl >= 0 ? green : red }}>
              {pnl >= 0 ? '+' : ''}{formatLargeNumber(pnl)}
            </div>
            <div style={{ fontSize: 13, color: pnl >= 0 ? green : red, marginTop: 4 }}>
              {percentage >= 0 ? '+' : ''}{percentage.toFixed(2)}%
            </div>
          </div>
          <div style={card}>
            <div style={sTitle}>Posiciones</div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>
              {portfolio.length}
            </div>
          </div>
        </div>

        {/* Add Position Button */}
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          style={{
            width: "100%",
            padding: "12px",
            background: `linear-gradient(135deg, ${purple}, #7c3aed)`,
            border: "none",
            borderRadius: 8,
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            marginBottom: 16
          }}
        >
          {showAddForm ? '❌ Cancelar' : '➕ Agregar Posición'}
        </button>

        {/* Add Position Form */}
        {showAddForm && (
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={sTitle}>Nueva Posición</div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
                  ACTIVO
                </label>
                <select
                  value={newPosition.asset}
                  onChange={e => setNewPosition(prev => ({ ...prev, asset: e.target.value }))}
                  style={{
                    width: "100%",
                    background: bg3,
                    border: `1px solid ${border}`,
                    borderRadius: 6,
                    padding: "10px",
                    color: text,
                    fontSize: 13
                  }}
                >
                  {marketData && Object.keys(marketData.crypto || {}).map(id => (
                    <option key={id} value={id}>{id.toUpperCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
                  CANTIDAD
                </label>
                <input
                  type="number"
                  step="0.00000001"
                  value={newPosition.amount}
                  onChange={e => setNewPosition(prev => ({ ...prev, amount: e.target.value }))}
                  placeholder="0.5"
                  style={{
                    width: "100%",
                    background: bg3,
                    border: `1px solid ${border}`,
                    borderRadius: 6,
                    padding: "10px",
                    color: text,
                    fontSize: 13
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
                  PRECIO DE COMPRA
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newPosition.buyPrice}
                  onChange={e => setNewPosition(prev => ({ ...prev, buyPrice: e.target.value }))}
                  placeholder="65000"
                  style={{
                    width: "100%",
                    background: bg3,
                    border: `1px solid ${border}`,
                    borderRadius: 6,
                    padding: "10px",
                    color: text,
                    fontSize: 13
                  }}
                />
              </div>
              <button
                onClick={handleAdd}
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
                ✅ Agregar
              </button>
            </div>
          </div>
        )}

        {/* Positions List */}
        <div style={card}>
          <div style={sTitle}>MIS POSICIONES</div>
          {portfolio.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              No tienes posiciones aún. Agrega una arriba.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {portfolio.map(position => {
                const currentPrice = marketData?.crypto?.[position.asset]?.price || 0;
                const positionValue = position.amount * currentPrice;
                const positionPnL = positionValue - (position.amount * position.buyPrice);
                const positionPnLPercent = ((currentPrice - position.buyPrice) / position.buyPrice) * 100;

                return (
                  <div key={position.id} style={{
                    background: bg3,
                    borderRadius: 8,
                    padding: "14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10
                  }}>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                        {position.asset.toUpperCase()}
                      </div>
                      <div style={{ fontSize: 11, color: muted }}>
                        {position.amount} @ {formatPrice(position.buyPrice)}
                      </div>
                      <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                        Actual: {formatPrice(currentPrice)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>
                        {formatLargeNumber(positionValue)}
                      </div>
                      <div style={{ 
                        fontSize: 13, 
                        fontWeight: 700, 
                        color: positionPnL >= 0 ? green : red,
                        marginTop: 4 
                      }}>
                        {positionPnL >= 0 ? '+' : ''}{formatLargeNumber(positionPnL)}
                      </div>
                      <div style={{ fontSize: 11, color: positionPnL >= 0 ? green : red }}>
                        {positionPnL >= 0 ? '+' : ''}{positionPnLPercent.toFixed(2)}%
                      </div>
                    </div>
                    <button
                      onClick={() => removeFromPortfolio(position.id)}
                      style={{
                        padding: "6px 12px",
                        background: "transparent",
                        border: `1px solid ${red}`,
                        borderRadius: 6,
                        color: red,
                        fontSize: 11,
                        cursor: "pointer"
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const AlertsTab = () => {
    return (
      <div>
        {/* Config */}
        <div style={card}>
          <div style={sTitle}>⚙️ CONFIGURACIÓN DE ALERTAS</div>
          
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: muted, display: "block", marginBottom: 6 }}>
              EMAIL
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
              CONFIANZA MÍNIMA: {alertConfig.minConfidence}%
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
            onClick={sendTestAlert}
            style={{
              width: "100%",
              padding: "10px",
              background: `linear-gradient(135deg, ${purple}, #7c3aed)`,
              border: "none",
              borderRadius: 7,
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer"
            }}
          >
            🧪 ENVIAR ALERTA DE PRUEBA
          </button>
        </div>

        {/* Telegram Setup */}
        <div style={{
          background: "rgba(59, 130, 246, 0.1)",
          border: `1px solid ${blue}`,
          borderRadius: 8,
          padding: "14px 18px",
          marginBottom: 16
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: blue, marginBottom: 8 }}>
            📱 ALERTAS POR TELEGRAM (GRATIS)
          </div>
          <div style={{ fontSize: 12, color: text, lineHeight: 1.7 }}>
            1. Busca <code style={{ background: bg3, padding: "2px 6px", borderRadius: 4 }}>@OracleProBot</code> en Telegram<br />
            2. Envía <code style={{ background: bg3, padding: "2px 6px", borderRadius: 4 }}>/start</code><br />
            3. Recibirás alertas instantáneas en tu celular 🚀
          </div>
        </div>

        {/* Alert History */}
        <div style={card}>
          <div style={sTitle}>📋 HISTORIAL DE ALERTAS</div>
          {alerts.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              No hay alertas aún
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
              {alerts.map((alert, i) => (
                <div key={i} style={{
                  background: bg3,
                  borderLeft: `3px solid ${alert.action === 'BUY' ? green : red}`,
                  borderRadius: 6,
                  padding: "12px 14px",
                  marginBottom: 10
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                    {alert.action === 'BUY' ? '🟢' : '🔴'} {alert.asset}
                  </div>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
                    Score: {alert.score}/100 · Confianza: {alert.confidence}%
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
          SENTIX PRO v1.0 · Real-time Trading System · Connected to Live APIs<br />
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
