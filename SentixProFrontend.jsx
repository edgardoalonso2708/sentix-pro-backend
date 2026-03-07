'use client'

import { useState, useCallback, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - FRONTEND COMPLETO
// Dashboard, Señales, Portfolio, Alertas - Versión Full
// ═══════════════════════════════════════════════════════════════════════════════

export default function SentixProFrontend() {
  
  // ─── CONFIGURATION ─────────────────────────────────────────────────────────
  const rawApiUrl = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const API_URL = rawApiUrl.startsWith('http') ? rawApiUrl : `https://${rawApiUrl}`;
  
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

  // Paper Trading
  const [paperConfig, setPaperConfig] = useState(null);
  const [paperPositions, setPaperPositions] = useState([]);
  const [paperHistory, setPaperHistory] = useState([]);
  const [paperMetrics, setPaperMetrics] = useState(null);
  const [paperLoading, setPaperLoading] = useState(false);

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
              label: "DXY (Dollar)",
              value: marketData.macro?.dxy || '—',
              sublabel: marketData.macro?.dxyTrend === 'rising' ? 'Rising (bearish crypto)' : marketData.macro?.dxyTrend === 'falling' ? 'Falling (bullish crypto)' : 'Stable',
              color: marketData.macro?.dxyTrend === 'rising' ? red : marketData.macro?.dxyTrend === 'falling' ? green : muted
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
              {signals.slice(0, 5).map((signal, i) => {
                const ac = signal.action === 'BUY' ? green : signal.action === 'SELL' ? red : amber;
                const cc = signal.timeframes?.confluence === 'strong' ? green : signal.timeframes?.confluence === 'moderate' ? amber : signal.timeframes?.confluence === 'conflicting' ? red : muted;
                return (
                  <div key={i} style={{
                    background: bg3,
                    borderLeft: `3px solid ${ac}`,
                    borderRadius: 6,
                    padding: "10px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 10
                  }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                        {signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪'} {signal.asset}
                        {signal.timeframes?.confluence && (
                          <span style={{
                            fontSize: 8,
                            color: cc,
                            fontWeight: 700,
                            background: `${cc}18`,
                            padding: "2px 6px",
                            borderRadius: 3,
                            textTransform: "uppercase"
                          }}>
                            {signal.timeframes.confluence === 'strong' ? '3/3' : signal.timeframes.confluence === 'moderate' ? '2/3' : '!'}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                        {signal.tradeLevels ? `R:R ${signal.tradeLevels.riskRewardRatio?.toFixed(1)} · ` : ''}{signal.reasons?.substring(0, 80)}{signal.reasons?.length > 80 ? '...' : ''}
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
                );
              })}
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
    const confluenceColor = (c) => c === 'strong' ? green : c === 'moderate' ? amber : c === 'conflicting' ? red : muted;
    const confluenceLabel = (c) => c === 'strong' ? 'CONFLUENCIA FUERTE' : c === 'moderate' ? 'CONFLUENCIA MODERADA' : c === 'conflicting' ? 'CONFLICTO' : 'DEBIL';
    const actionColor = (a) => a === 'BUY' ? green : a === 'SELL' ? red : amber;
    const tfLabel = { '4h': '4H', '1h': '1H', '15m': '15M' };

    return (
      <div>
        <div style={card}>
          <div style={sTitle}>🎯 TODAS LAS SEÑALES ACTIVAS</div>

          {signals.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: muted }}>
              No hay señales en este momento
            </div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {signals.map((signal, i) => (
                <div key={i} style={{
                  background: bg3,
                  borderLeft: `4px solid ${actionColor(signal.action)}`,
                  borderRadius: 8,
                  padding: "14px 18px"
                }}>
                  {/* Header: Asset + Action + Confidence */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>
                        {signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪'} {signal.asset}
                      </div>
                      <div style={{ fontSize: 13, color: muted }}>
                        {formatPrice(signal.price)} · {signal.change24h >= 0 ? '+' : ''}{signal.change24h?.toFixed(2) || '0.00'}% 24h
                      </div>
                    </div>
                    <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {/* Confluence Badge */}
                        {signal.timeframes?.confluence && (
                          <div style={{
                            fontSize: 9,
                            color: confluenceColor(signal.timeframes.confluence),
                            fontWeight: 700,
                            background: `${confluenceColor(signal.timeframes.confluence)}18`,
                            padding: "3px 8px",
                            borderRadius: 4,
                            letterSpacing: 0.5,
                            textTransform: "uppercase"
                          }}>
                            {confluenceLabel(signal.timeframes.confluence)}
                          </div>
                        )}
                        {/* Action Badge */}
                        <div style={{
                          fontSize: 11,
                          color: actionColor(signal.action),
                          fontWeight: 700,
                          background: `${actionColor(signal.action)}22`,
                          padding: "4px 12px",
                          borderRadius: 6
                        }}>
                          {signal.action}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: amber, fontWeight: 700 }}>
                        {signal.confidence}% confianza
                      </div>
                      <div style={{ fontSize: 11, color: muted }}>
                        Score: {signal.score}/100
                      </div>
                    </div>
                  </div>

                  {/* Timeframe Mini-Bar */}
                  {signal.timeframes && signal.timeframes['4h'] && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      {['4h', '1h', '15m'].map(tf => {
                        const tfData = signal.timeframes[tf];
                        if (!tfData) return null;
                        const tfActionColor = actionColor(tfData.action);
                        return (
                          <div key={tf} style={{
                            flex: 1,
                            background: bg2,
                            borderRadius: 6,
                            padding: "6px 8px",
                            borderTop: `2px solid ${tfActionColor}`
                          }}>
                            <div style={{ fontSize: 10, color: muted, fontWeight: 700, marginBottom: 2 }}>
                              {tfLabel[tf]}
                            </div>
                            <div style={{ fontSize: 11, color: tfActionColor, fontWeight: 700 }}>
                              {tfData.action}
                            </div>
                            <div style={{ fontSize: 10, color: muted }}>
                              {tfData.score}/100
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Trade Levels Panel */}
                  {signal.tradeLevels && signal.action !== 'HOLD' && (
                    <div style={{
                      background: bg2,
                      borderRadius: 6,
                      padding: "10px 12px",
                      marginBottom: 10
                    }}>
                      <div style={{ fontSize: 10, color: muted, fontWeight: 700, marginBottom: 6, letterSpacing: 0.5 }}>
                        NIVELES DE OPERACION
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 9, color: muted }}>ENTRADA</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: text }}>{formatPrice(signal.tradeLevels.entry)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: red }}>STOP LOSS</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: red }}>{formatPrice(signal.tradeLevels.stopLoss)}</div>
                          <div style={{ fontSize: 9, color: muted }}>{signal.tradeLevels.stopLossPercent?.toFixed(1)}%</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: green }}>TP1</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: green }}>{formatPrice(signal.tradeLevels.takeProfit1)}</div>
                          <div style={{ fontSize: 9, color: muted }}>{signal.tradeLevels.takeProfit1Percent?.toFixed(1)}%</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: green }}>TP2</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: green }}>{formatPrice(signal.tradeLevels.takeProfit2)}</div>
                          <div style={{ fontSize: 9, color: muted }}>{signal.tradeLevels.takeProfit2Percent?.toFixed(1)}%</div>
                        </div>
                      </div>
                      {/* Trailing Stop Row */}
                      {signal.tradeLevels.trailingStop && (
                        <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          <div>
                            <div style={{ fontSize: 9, color: amber }}>TRAILING STOP</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: amber }}>{formatPrice(signal.tradeLevels.trailingStop)}</div>
                            <div style={{ fontSize: 9, color: muted }}>{signal.tradeLevels.trailingStopPercent?.toFixed(1)}%</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 9, color: muted }}>ACTIVA EN</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: text }}>{formatPrice(signal.tradeLevels.trailingActivation)}</div>
                            <div style={{ fontSize: 9, color: muted }}>+{Math.abs(signal.tradeLevels.trailingActivationPercent || 0).toFixed(1)}% profit</div>
                          </div>
                        </div>
                      )}
                      <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "center" }}>
                        <div style={{ fontSize: 10, color: signal.tradeLevels.riskRewardOk ? green : red, fontWeight: 700 }}>
                          R:R {signal.tradeLevels.riskRewardRatio?.toFixed(2) || '—'}
                        </div>
                        {!signal.tradeLevels.riskRewardOk && (
                          <div style={{ fontSize: 9, color: red }}>
                            ⚠ R:R bajo (&lt;1.5)
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Derivatives Row */}
                  {signal.derivatives && signal.derivatives.fundingRate !== undefined && (
                    <div style={{
                      display: "flex",
                      gap: 12,
                      marginBottom: 10,
                      flexWrap: "wrap"
                    }}>
                      <div style={{ fontSize: 11, color: muted }}>
                        <span style={{ fontSize: 9, letterSpacing: 0.3 }}>FUNDING </span>
                        <span style={{ color: signal.derivatives.fundingRate >= 0 ? green : red, fontWeight: 700 }}>
                          {(signal.derivatives.fundingRate * 100).toFixed(4)}%
                        </span>
                      </div>
                      {signal.derivatives.longShortRatio && (
                        <div style={{ fontSize: 11, color: muted }}>
                          <span style={{ fontSize: 9, letterSpacing: 0.3 }}>L/S </span>
                          <span style={{ color: text, fontWeight: 700 }}>
                            {signal.derivatives.longShortRatio.toFixed(2)}
                          </span>
                        </div>
                      )}
                      {signal.derivatives.sentiment && signal.derivatives.sentiment !== 'unavailable' && (
                        <div style={{
                          fontSize: 9,
                          color: signal.derivatives.sentiment.includes('bullish') ? green : signal.derivatives.sentiment.includes('bearish') ? red : amber,
                          fontWeight: 700,
                          background: `${signal.derivatives.sentiment.includes('bullish') ? green : signal.derivatives.sentiment.includes('bearish') ? red : amber}15`,
                          padding: "2px 8px",
                          borderRadius: 4,
                          textTransform: "uppercase"
                        }}>
                          {signal.derivatives.sentiment.replace(/_/g, ' ')}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Macro Context */}
                  {signal.macroContext && (
                    <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                      {signal.macroContext.btcDomRegime && signal.macroContext.btcDomRegime !== 'neutral' && (
                        <div style={{
                          fontSize: 9,
                          color: signal.macroContext.btcDomRegime === 'alt_season' ? green : red,
                          fontWeight: 700,
                          background: `${signal.macroContext.btcDomRegime === 'alt_season' ? green : red}15`,
                          padding: "2px 8px",
                          borderRadius: 4,
                          textTransform: "uppercase"
                        }}>
                          {signal.macroContext.btcDomRegime === 'alt_season' ? 'ALT SEASON' : 'BTC SEASON'} ({signal.macroContext.btcDominance}%)
                        </div>
                      )}
                      {signal.macroContext.dxyRegime && signal.macroContext.dxyRegime !== 'neutral' && (
                        <div style={{
                          fontSize: 9,
                          color: signal.macroContext.dxyRegime === 'risk_on' ? green : red,
                          fontWeight: 700,
                          background: `${signal.macroContext.dxyRegime === 'risk_on' ? green : red}15`,
                          padding: "2px 8px",
                          borderRadius: 4,
                          textTransform: "uppercase"
                        }}>
                          DXY {signal.macroContext.dxy} {signal.macroContext.dxyRegime === 'risk_on' ? 'RISK ON' : 'RISK OFF'}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Reasons */}
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

  // ─── PAPER TRADING TAB ────────────────────────────────────────────────────
  const PaperTradingTab = () => {
    const [showConfig, setShowConfig] = useState(false);
    const [configForm, setConfigForm] = useState(null);
    const [savingConfig, setSavingConfig] = useState(false);
    const [closingTrade, setClosingTrade] = useState(null);
    const [historyPage, setHistoryPage] = useState(0);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [confirmReset, setConfirmReset] = useState(false);

    const HISTORY_PAGE_SIZE = 10;

    // Fetch all paper trading data
    const loadPaperData = async () => {
      setPaperLoading(true);
      try {
        const [configRes, posRes, histRes, perfRes] = await Promise.allSettled([
          fetch(`${API_URL}/api/paper/config/${USER_ID}`),
          fetch(`${API_URL}/api/paper/positions/${USER_ID}`),
          fetch(`${API_URL}/api/paper/history/${USER_ID}?status=closed&limit=${HISTORY_PAGE_SIZE}&offset=${historyPage * HISTORY_PAGE_SIZE}`),
          fetch(`${API_URL}/api/paper/performance/${USER_ID}`)
        ]);

        if (configRes.status === 'fulfilled' && configRes.value.ok) {
          const d = await configRes.value.json();
          setPaperConfig(d.config);
          if (!configForm) setConfigForm(d.config);
        }
        if (posRes.status === 'fulfilled' && posRes.value.ok) {
          const d = await posRes.value.json();
          setPaperPositions(d.positions || []);
        }
        if (histRes.status === 'fulfilled' && histRes.value.ok) {
          const d = await histRes.value.json();
          setPaperHistory(d.trades || []);
          setHistoryTotal(d.total || 0);
        }
        if (perfRes.status === 'fulfilled' && perfRes.value.ok) {
          const d = await perfRes.value.json();
          setPaperMetrics(d.metrics);
        }
      } catch (err) {
        console.error('Paper data load error:', err);
      } finally {
        setPaperLoading(false);
      }
    };

    useEffect(() => { loadPaperData(); }, [historyPage]);

    // Auto refresh every 30s
    useEffect(() => {
      const interval = setInterval(loadPaperData, 30000);
      return () => clearInterval(interval);
    }, [historyPage]);

    const handleSaveConfig = async () => {
      if (!configForm) return;
      setSavingConfig(true);
      try {
        const res = await fetch(`${API_URL}/api/paper/config/${USER_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_enabled: configForm.is_enabled,
            initial_capital: parseFloat(configForm.initial_capital),
            risk_per_trade: parseFloat(configForm.risk_per_trade),
            max_open_positions: parseInt(configForm.max_open_positions),
            max_daily_loss_percent: parseFloat(configForm.max_daily_loss_percent),
            cooldown_minutes: parseInt(configForm.cooldown_minutes),
            min_confluence: parseInt(configForm.min_confluence),
            min_rr_ratio: parseFloat(configForm.min_rr_ratio)
          })
        });
        if (res.ok) {
          const d = await res.json();
          setPaperConfig(d.config);
          setConfigForm(d.config);
        }
      } catch (err) {
        console.error('Save config error:', err);
      } finally {
        setSavingConfig(false);
      }
    };

    const handleCloseTrade = async (tradeId) => {
      setClosingTrade(tradeId);
      try {
        const res = await fetch(`${API_URL}/api/paper/close/${tradeId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: USER_ID })
        });
        if (res.ok) await loadPaperData();
      } catch (err) {
        console.error('Close trade error:', err);
      } finally {
        setClosingTrade(null);
      }
    };

    const handleReset = async () => {
      try {
        const res = await fetch(`${API_URL}/api/paper/reset/${USER_ID}`, { method: 'POST' });
        if (res.ok) {
          setConfirmReset(false);
          await loadPaperData();
        }
      } catch (err) {
        console.error('Reset error:', err);
      }
    };

    const handleToggleEnabled = async () => {
      const newVal = !paperConfig?.is_enabled;
      try {
        const res = await fetch(`${API_URL}/api/paper/config/${USER_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_enabled: newVal })
        });
        if (res.ok) {
          const d = await res.json();
          setPaperConfig(d.config);
          if (configForm) setConfigForm(prev => ({ ...prev, is_enabled: newVal }));
        }
      } catch (err) {
        console.error('Toggle error:', err);
      }
    };

    const formatDuration = (entryAt, exitAt) => {
      const ms = new Date(exitAt || Date.now()) - new Date(entryAt);
      const hours = Math.floor(ms / 3600000);
      const mins = Math.floor((ms % 3600000) / 60000);
      if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    };

    const inputStyle = {
      width: '100%', padding: '8px 12px', background: bg3,
      border: `1px solid ${border}`, borderRadius: 6,
      color: text, fontFamily: 'monospace', fontSize: 12
    };

    const isEnabled = paperConfig?.is_enabled;
    const capital = parseFloat(paperConfig?.current_capital || 10000);
    const initialCap = parseFloat(paperConfig?.initial_capital || 10000);
    const capitalPnl = capital - initialCap;
    const capitalPnlPct = initialCap > 0 ? ((capitalPnl / initialCap) * 100) : 0;

    return (
      <div>
        {/* Status Banner */}
        <div style={{
          background: isEnabled ? "rgba(0, 212, 170, 0.08)" : "rgba(239, 68, 68, 0.08)",
          border: `1px solid ${isEnabled ? green : red}`,
          borderRadius: 8, padding: "14px 18px", marginBottom: 16,
          display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: isEnabled ? green : red,
              boxShadow: `0 0 8px ${isEnabled ? green : red}`,
              animation: isEnabled ? "pulse 2s infinite" : "none"
            }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: isEnabled ? green : red }}>
                PAPER TRADING {isEnabled ? 'ACTIVO' : 'DESACTIVADO'}
              </div>
              <div style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                Capital: ${capital.toLocaleString(undefined, { minimumFractionDigits: 2 })} ·
                P&L: <span style={{ color: capitalPnl >= 0 ? green : red }}>
                  {capitalPnl >= 0 ? '+' : ''}${capitalPnl.toFixed(2)} ({capitalPnlPct.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
          <button onClick={handleToggleEnabled} style={{
            padding: "6px 16px", background: isEnabled ? "rgba(239,68,68,0.2)" : "rgba(0,212,170,0.2)",
            border: `1px solid ${isEnabled ? red : green}`, borderRadius: 6,
            color: isEnabled ? red : green, fontFamily: "monospace", fontSize: 11,
            fontWeight: 700, cursor: "pointer"
          }}>
            {isEnabled ? '⏸ PAUSAR' : '▶ ACTIVAR'}
          </button>
        </div>

        {/* Performance Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
          {[
            { label: "P&L TOTAL", value: `$${(paperMetrics?.totalPnl || 0).toFixed(2)}`, color: (paperMetrics?.totalPnl || 0) >= 0 ? green : red },
            { label: "WIN RATE", value: `${paperMetrics?.winRate || 0}%`, color: (paperMetrics?.winRate || 0) >= 50 ? green : (paperMetrics?.winRate || 0) > 0 ? amber : muted },
            { label: "TRADES", value: `${paperMetrics?.totalTrades || 0}`, sub: `${paperMetrics?.winCount || 0}W / ${paperMetrics?.lossCount || 0}L`, color: text },
            { label: "CAPITAL", value: `$${capital.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: capital >= initialCap ? green : red },
            { label: "MAX DRAWDOWN", value: `$${(paperMetrics?.maxDrawdown || 0).toFixed(2)}`, color: red },
            { label: "PROFIT FACTOR", value: paperMetrics?.profitFactor === Infinity ? '∞' : `${(paperMetrics?.profitFactor || 0).toFixed(2)}`, color: (paperMetrics?.profitFactor || 0) >= 1.5 ? green : (paperMetrics?.profitFactor || 0) >= 1 ? amber : red },
          ].map((stat, i) => (
            <div key={i} style={{ ...card, padding: "12px 14px", textAlign: "center" }}>
              <div style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>{stat.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", color: stat.color }}>{stat.value}</div>
              {stat.sub && <div style={{ fontSize: 10, color: muted, fontFamily: "monospace", marginTop: 2 }}>{stat.sub}</div>}
            </div>
          ))}
        </div>

        {/* Open Positions */}
        <div style={{ ...card, padding: "16px 20px" }}>
          <div style={sTitle}>
            POSICIONES ABIERTAS ({paperPositions.length})
          </div>
          {paperPositions.length === 0 ? (
            <div style={{ textAlign: "center", padding: 20, color: muted, fontSize: 12 }}>
              No hay trades abiertos. El sistema abrirá automáticamente cuando detecte señales fuertes.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {paperPositions.map(pos => {
                const isLong = pos.direction === 'LONG';
                const pnlColor = pos.unrealizedPnl >= 0 ? green : red;
                return (
                  <div key={pos.id} style={{
                    background: bg3, borderRadius: 8, padding: "12px 16px",
                    borderLeft: `3px solid ${isLong ? green : red}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    flexWrap: "wrap", gap: 8
                  }}>
                    <div style={{ minWidth: 120 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>
                        <span style={{ color: isLong ? green : red }}>{isLong ? '▲' : '▼'}</span>{' '}
                        {pos.asset}
                      </div>
                      <div style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                        {pos.direction} · {pos.entry_signal_strength} · {formatDuration(pos.entry_at)}
                      </div>
                    </div>

                    <div style={{ textAlign: "center", minWidth: 100 }}>
                      <div style={{ fontSize: 10, color: muted }}>Entrada → Actual</div>
                      <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>
                        ${Number(pos.entry_price).toLocaleString()} → <span style={{ color: pnlColor }}>${pos.currentPrice ? pos.currentPrice.toLocaleString() : '...'}</span>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <span style={{ background: "rgba(239,68,68,0.15)", color: red, padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: "monospace" }}>
                        SL ${Number(pos.stop_loss).toLocaleString()}
                      </span>
                      <span style={{ background: "rgba(0,212,170,0.15)", color: green, padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: "monospace" }}>
                        TP1 ${Number(pos.take_profit_1).toLocaleString()}
                      </span>
                      {pos.trailing_active && (
                        <span style={{ background: "rgba(245,158,11,0.15)", color: amber, padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: "monospace" }}>
                          TRAIL ${Number(pos.trailing_stop_current).toLocaleString()}
                        </span>
                      )}
                      <span style={{ background: pos.status === 'partial' ? "rgba(245,158,11,0.15)" : "transparent", color: pos.status === 'partial' ? amber : muted, padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: "monospace" }}>
                        {pos.status === 'partial' ? 'PARCIAL' : 'OPEN'}
                      </span>
                    </div>

                    <div style={{ textAlign: "right", minWidth: 90 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, fontFamily: "monospace", color: pnlColor }}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                      </div>
                      <div style={{ fontSize: 10, fontFamily: "monospace", color: pnlColor }}>
                        {pos.unrealizedPnlPercent >= 0 ? '+' : ''}{pos.unrealizedPnlPercent.toFixed(2)}%
                      </div>
                    </div>

                    <button
                      onClick={() => handleCloseTrade(pos.id)}
                      disabled={closingTrade === pos.id}
                      style={{
                        padding: "4px 10px", background: "rgba(239,68,68,0.15)",
                        border: `1px solid ${red}`, borderRadius: 4,
                        color: red, fontFamily: "monospace", fontSize: 10,
                        fontWeight: 700, cursor: "pointer", opacity: closingTrade === pos.id ? 0.5 : 1
                      }}
                    >
                      {closingTrade === pos.id ? '...' : 'CERRAR'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Trade History */}
        <div style={{ ...card, padding: "16px 20px" }}>
          <div style={sTitle}>
            HISTORIAL DE TRADES ({historyTotal})
          </div>
          {paperHistory.length === 0 ? (
            <div style={{ textAlign: "center", padding: 20, color: muted, fontSize: 12 }}>
              Aún no hay trades cerrados.
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11 }}>
                  <thead>
                    <tr>
                      {["Asset", "Dir", "Entrada", "Salida", "P&L", "%", "Duración", "Razón"].map((h, i) => (
                        <th key={i} style={{
                          padding: "6px 8px", textAlign: "left", fontSize: 9, color: muted,
                          textTransform: "uppercase", letterSpacing: "0.08em",
                          borderBottom: `1px solid ${border}`, fontWeight: 700
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paperHistory.map((trade, i) => {
                      const pnl = parseFloat(trade.realized_pnl || 0);
                      const pnlPct = parseFloat(trade.realized_pnl_percent || 0);
                      const isWin = pnl > 0;
                      return (
                        <tr key={trade.id} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                          <td style={{ padding: "6px 8px", fontWeight: 600 }}>{trade.asset}</td>
                          <td style={{ padding: "6px 8px", color: trade.direction === 'LONG' ? green : red }}>{trade.direction === 'LONG' ? '▲ L' : '▼ S'}</td>
                          <td style={{ padding: "6px 8px" }}>${Number(trade.entry_price).toLocaleString()}</td>
                          <td style={{ padding: "6px 8px" }}>${Number(trade.exit_price).toLocaleString()}</td>
                          <td style={{ padding: "6px 8px", color: isWin ? green : red, fontWeight: 700 }}>
                            {isWin ? '+' : ''}${pnl.toFixed(2)}
                          </td>
                          <td style={{ padding: "6px 8px", color: isWin ? green : red }}>
                            {isWin ? '+' : ''}{pnlPct.toFixed(2)}%
                          </td>
                          <td style={{ padding: "6px 8px", color: muted }}>{formatDuration(trade.entry_at, trade.exit_at)}</td>
                          <td style={{ padding: "6px 8px" }}>
                            <span style={{
                              padding: "2px 6px", borderRadius: 4, fontSize: 9,
                              background: trade.exit_reason === 'stop_loss' ? "rgba(239,68,68,0.15)" :
                                trade.exit_reason?.includes('take_profit') ? "rgba(0,212,170,0.15)" :
                                trade.exit_reason === 'trailing_stop' ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.05)",
                              color: trade.exit_reason === 'stop_loss' ? red :
                                trade.exit_reason?.includes('take_profit') ? green :
                                trade.exit_reason === 'trailing_stop' ? amber : muted
                            }}>
                              {(trade.exit_reason || 'unknown').replace(/_/g, ' ').toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Pagination */}
              {historyTotal > HISTORY_PAGE_SIZE && (
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, alignItems: "center" }}>
                  <button onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0}
                    style={{ padding: "4px 12px", background: bg3, border: `1px solid ${border}`, borderRadius: 4, color: historyPage === 0 ? muted : text, fontFamily: "monospace", fontSize: 10, cursor: historyPage === 0 ? "default" : "pointer" }}>
                    ← Prev
                  </button>
                  <span style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                    {historyPage + 1} / {Math.ceil(historyTotal / HISTORY_PAGE_SIZE)}
                  </span>
                  <button onClick={() => setHistoryPage(p => p + 1)} disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal}
                    style={{ padding: "4px 12px", background: bg3, border: `1px solid ${border}`, borderRadius: 4, color: (historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal ? muted : text, fontFamily: "monospace", fontSize: 10, cursor: (historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal ? "default" : "pointer" }}>
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Configuration Panel */}
        <div style={{ ...card, padding: "16px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
            onClick={() => setShowConfig(!showConfig)}>
            <div style={sTitle}>⚙ CONFIGURACIÓN</div>
            <span style={{ color: muted, fontSize: 12 }}>{showConfig ? '▲' : '▼'}</span>
          </div>

          {showConfig && configForm && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Capital Inicial ($)</label>
                  <input type="number" value={configForm.initial_capital || 10000}
                    onChange={e => setConfigForm(prev => ({ ...prev, initial_capital: e.target.value }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Riesgo por Trade (%)</label>
                  <input type="number" step="0.5" min="0.5" max="5" value={(configForm.risk_per_trade || 0.02) * 100}
                    onChange={e => setConfigForm(prev => ({ ...prev, risk_per_trade: parseFloat(e.target.value) / 100 }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Máx Posiciones Abiertas</label>
                  <input type="number" min="1" max="10" value={configForm.max_open_positions || 3}
                    onChange={e => setConfigForm(prev => ({ ...prev, max_open_positions: e.target.value }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Pérdida Diaria Máx (%)</label>
                  <input type="number" step="1" min="1" max="20" value={(configForm.max_daily_loss_percent || 0.05) * 100}
                    onChange={e => setConfigForm(prev => ({ ...prev, max_daily_loss_percent: parseFloat(e.target.value) / 100 }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Cooldown entre Trades (min)</label>
                  <input type="number" min="5" max="120" value={configForm.cooldown_minutes || 30}
                    onChange={e => setConfigForm(prev => ({ ...prev, cooldown_minutes: e.target.value }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>Confluencia Mínima (1-3)</label>
                  <input type="number" min="1" max="3" value={configForm.min_confluence || 2}
                    onChange={e => setConfigForm(prev => ({ ...prev, min_confluence: e.target.value }))}
                    style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: muted, marginBottom: 4, display: "block" }}>R:R Mínimo</label>
                  <input type="number" step="0.1" min="1.0" max="5.0" value={configForm.min_rr_ratio || 1.5}
                    onChange={e => setConfigForm(prev => ({ ...prev, min_rr_ratio: e.target.value }))}
                    style={inputStyle} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                <button onClick={handleSaveConfig} disabled={savingConfig}
                  style={{
                    padding: "8px 20px", background: `linear-gradient(135deg, ${purple}, #7c3aed)`,
                    border: "none", borderRadius: 6, color: "#fff",
                    fontFamily: "monospace", fontSize: 12, fontWeight: 700, cursor: "pointer",
                    opacity: savingConfig ? 0.6 : 1
                  }}>
                  {savingConfig ? 'Guardando...' : '💾 GUARDAR CONFIG'}
                </button>

                {!confirmReset ? (
                  <button onClick={() => setConfirmReset(true)}
                    style={{
                      padding: "8px 20px", background: "rgba(239,68,68,0.1)",
                      border: `1px solid ${red}`, borderRadius: 6,
                      color: red, fontFamily: "monospace", fontSize: 12, fontWeight: 700, cursor: "pointer"
                    }}>
                    🔄 RESET CUENTA
                  </button>
                ) : (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: red }}>¿Seguro? Cierra todos los trades y resetea capital.</span>
                    <button onClick={handleReset} style={{
                      padding: "6px 14px", background: red, border: "none", borderRadius: 4,
                      color: "#fff", fontFamily: "monospace", fontSize: 11, fontWeight: 700, cursor: "pointer"
                    }}>SÍ</button>
                    <button onClick={() => setConfirmReset(false)} style={{
                      padding: "6px 14px", background: bg3, border: `1px solid ${border}`, borderRadius: 4,
                      color: muted, fontFamily: "monospace", fontSize: 11, cursor: "pointer"
                    }}>NO</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Extra stats */}
        {paperMetrics && paperMetrics.totalTrades > 0 && (
          <div style={{ ...card, padding: "16px 20px" }}>
            <div style={sTitle}>ESTADÍSTICAS DETALLADAS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              {[
                { label: "Promedio Ganancia", value: `+$${(paperMetrics.avgProfit || 0).toFixed(2)}`, color: green },
                { label: "Promedio Pérdida", value: `-$${(paperMetrics.avgLoss || 0).toFixed(2)}`, color: red },
                { label: "Mejor Trade", value: paperMetrics.bestTrade ? `${paperMetrics.bestTrade.asset} +$${paperMetrics.bestTrade.pnl.toFixed(2)}` : '-', color: green },
                { label: "Peor Trade", value: paperMetrics.worstTrade ? `${paperMetrics.worstTrade.asset} $${paperMetrics.worstTrade.pnl.toFixed(2)}` : '-', color: red },
                { label: "Tiempo Promedio", value: `${(paperMetrics.avgHoldingTimeHours || 0).toFixed(1)}h`, color: text },
                { label: "Racha Actual", value: `${paperMetrics.currentStreak || 0} ${paperMetrics.streakType === 'win' ? 'victorias' : paperMetrics.streakType === 'loss' ? 'derrotas' : '-'}`, color: paperMetrics.streakType === 'win' ? green : paperMetrics.streakType === 'loss' ? red : muted },
              ].map((stat, i) => (
                <div key={i} style={{ background: bg3, padding: "10px 14px", borderRadius: 6 }}>
                  <div style={{ fontSize: 9, color: muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{stat.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {paperLoading && (
          <div style={{ textAlign: "center", padding: 10, fontSize: 10, color: muted, fontFamily: "monospace" }}>
            Actualizando datos...
          </div>
        )}
      </div>
    );
  };

  // ─── GUIDE TAB ────────────────────────────────────────────────────────────
  const GuideTab = () => {
    const [guideSection, setGuideSection] = useState(0);

    const sectionHeaderStyle = {
      fontSize: 16, fontWeight: 800, color: purple, letterSpacing: "0.02em",
      marginBottom: 16, paddingBottom: 8,
      borderBottom: `2px solid ${purple}`,
      display: "flex", alignItems: "center", gap: 10
    };
    const tableStyle = {
      width: "100%", borderCollapse: "collapse", fontFamily: "monospace", fontSize: 11
    };
    const thStyle = {
      background: "rgba(168,85,247,0.2)", color: purple, fontWeight: 700,
      padding: "8px 12px", textAlign: "left", fontSize: 10,
      textTransform: "uppercase", letterSpacing: "0.08em",
      borderBottom: `1px solid ${border}`
    };
    const tdStyle = (i) => ({
      padding: "7px 12px", borderBottom: `1px solid ${border}`,
      background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
      fontSize: 11, lineHeight: 1.5
    });
    const tipBox = {
      background: "rgba(245,158,11,0.08)", borderLeft: `3px solid ${amber}`,
      padding: "10px 14px", borderRadius: "0 6px 6px 0", marginBottom: 14,
      fontSize: 11, lineHeight: 1.6, color: "#fbbf24"
    };
    const alertBox = {
      background: "rgba(239,68,68,0.08)", borderLeft: `3px solid ${red}`,
      padding: "10px 14px", borderRadius: "0 6px 6px 0", marginBottom: 14,
      fontSize: 11, lineHeight: 1.6, color: "#fca5a5"
    };
    const flowBox = {
      background: bg3, border: `1px solid ${border}`, borderRadius: 8,
      padding: 16, fontFamily: "monospace", fontSize: 11,
      lineHeight: 1.8, whiteSpace: "pre-wrap", color: muted
    };

    const sections = [
      { icon: "🧬", title: "Anatomía de una Señal" },
      { icon: "⏱", title: "Barra de Timeframes" },
      { icon: "🎯", title: "Niveles de Operación" },
      { icon: "🛡", title: "Trailing Stop" },
      { icon: "📊", title: "Derivados" },
      { icon: "🌍", title: "Contexto Macro" },
      { icon: "💪", title: "Fuerza de la Señal" },
      { icon: "⚙", title: "Los 13 Factores" },
      { icon: "📈", title: "Dashboard Macro" },
      { icon: "🔄", title: "Flujo de Decisión" },
      { icon: "⚠", title: "Errores Comunes" },
      { icon: "📖", title: "Glosario" },
    ];

    const GuideTable = ({ headers, rows }) => (
      <table style={tableStyle}>
        <thead><tr>{headers.map((h, i) => <th key={i} style={thStyle}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, ri) => (
          <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={tdStyle(ri)}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
    );

    const renderSection = () => {
      switch(guideSection) {
        case 0: return (<div>
          <div style={sectionHeaderStyle}>🧬 1. Anatomía de una Señal</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Cada tarjeta de señal muestra esta información de arriba a abajo:</p>
          <div style={{ ...sTitle, marginTop: 10 }}>Encabezado</div>
          <GuideTable headers={["Elemento", "Significado"]} rows={[
            ["🟢 + nombre", "Señal de COMPRA"],
            ["🔴 + nombre", "Señal de VENTA"],
            ["⚪ + nombre", "HOLD (esperar)"],
            ["Precio actual", "Último precio del activo"],
            ["% 24h", "Cambio de precio en las últimas 24 horas"],
          ]} />
          <div style={{ ...sTitle, marginTop: 18 }}>Badges (esquina superior derecha)</div>
          <GuideTable headers={["Badge", "Significado"]} rows={[
            [<span style={{color: green, fontWeight: 700}}>CONFLUENCIA FUERTE</span>, "Los 3 timeframes (4H, 1H, 15M) están de acuerdo"],
            [<span style={{color: amber, fontWeight: 700}}>CONFLUENCIA MODERADA</span>, "2 de 3 timeframes de acuerdo"],
            [<span style={{color: red, fontWeight: 700}}>CONFLICTO</span>, "Los timeframes se contradicen"],
            ["BUY / SELL / HOLD", "La acción recomendada"],
            ["X% confianza", "Qué tan seguro está el motor de la señal"],
            ["Score X/100", "Puntaje general de la señal"],
          ]} />
        </div>);

        case 1: return (<div>
          <div style={sectionHeaderStyle}>⏱ 2. Barra de Timeframes (4H / 1H / 15M)</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Tres bloques que muestran qué dice cada temporalidad:</p>
          <GuideTable headers={["Timeframe", "Peso", "Qué representa"]} rows={[
            [<span style={{fontWeight: 700}}>4H</span>, "40%", "Tendencia macro. La dirección del mercado en las últimas horas."],
            [<span style={{fontWeight: 700}}>1H</span>, "40%", "Señal principal. El timeframe donde se genera la señal de trading."],
            [<span style={{fontWeight: 700}}>15M</span>, "20%", "Timing de entrada. Confirma si el momento exacto es bueno para entrar."],
          ]} />
          <div style={{ ...sTitle, marginTop: 18 }}>Cómo interpretarlo</div>
          <div style={{ ...card, padding: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: green, fontWeight: 700, fontSize: 12 }}>● 3/3 de acuerdo</span>
              <span style={{ color: muted, fontSize: 11 }}>— Alta probabilidad. Todas las temporalidades apuntan en la misma dirección.</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: amber, fontWeight: 700, fontSize: 12 }}>● 2/3 de acuerdo</span>
              <span style={{ color: muted, fontSize: 11 }}>— Probabilidad moderada. Entra con menor posición.</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: red, fontWeight: 700, fontSize: 12 }}>● Conflicto</span>
              <span style={{ color: muted, fontSize: 11 }}>— El mercado está indeciso. No operes hasta que se aclare.</span>
            </div>
          </div>
          <div style={tipBox}>💡 <strong>Regla de oro:</strong> El 4H es el "gobernador". Si el 4H dice SELL pero 1H y 15M dicen BUY, la señal se debilita automáticamente. Nunca vayas contra la tendencia macro.</div>
        </div>);

        case 2: return (<div>
          <div style={sectionHeaderStyle}>🎯 3. Niveles de Operación (Trade Levels)</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Este panel solo aparece en señales de BUY o SELL (no en HOLD):</p>
          <GuideTable headers={["Nivel", "Color", "Qué significa"]} rows={[
            [<strong>ENTRADA</strong>, <span style={{color: text}}>⬜ Blanco</span>, "Precio al que deberías entrar"],
            [<strong>STOP LOSS</strong>, <span style={{color: red}}>🟥 Rojo</span>, "Precio máximo de pérdida. Si llega aquí, vende para proteger tu capital."],
            [<strong>TP1</strong>, <span style={{color: green}}>🟩 Verde</span>, "Primer objetivo de ganancia. Toma al menos 50% de tu posición aquí."],
            [<strong>TP2</strong>, <span style={{color: green}}>🟩 Verde</span>, "Segundo objetivo (más ambicioso). Deja correr el resto hasta aquí."],
            [<strong>TRAILING STOP</strong>, <span style={{color: amber}}>🟨 Amarillo</span>, "Stop dinámico que sube con el precio para proteger ganancias."],
            [<strong>ACTIVA EN</strong>, <span style={{color: text}}>⬜ Blanco</span>, "Precio donde se activa el trailing stop (cuando ya tienes ganancia)."],
            [<strong>R:R</strong>, <span style={{color: green}}>Verde/Rojo</span>, "Ratio riesgo/recompensa. Verde si ≥ 1.5, rojo si menor."],
          ]} />
          <div style={{ ...sTitle, marginTop: 18 }}>Para una señal de BUY - paso a paso</div>
          <div style={{ ...card, padding: 14 }}>
            {[
              "1. Coloca tu orden de compra en el precio de ENTRADA",
              "2. Inmediatamente coloca un stop-loss en STOP LOSS (protección obligatoria)",
              "3. Cuando el precio suba a TP1, vende el 50% de tu posición (asegura ganancia)",
              "4. Activa el TRAILING STOP cuando el precio alcance el nivel de activación",
              "5. Deja el 50% restante correr hacia TP2 con el trailing protegiéndote"
            ].map((step, i) => (
              <div key={i} style={{ color: muted, fontSize: 11, lineHeight: 1.8, paddingLeft: 8, borderLeft: i === 0 ? "none" : undefined }}>
                {step}
              </div>
            ))}
          </div>
          <div style={{ ...sTitle, marginTop: 18 }}>Ratio Riesgo/Recompensa (R:R)</div>
          <GuideTable headers={["R:R", "Interpretación", "Acción"]} rows={[
            ["≥ 2.5", "Excelente", <span style={{color: green}}>Operar con posición completa</span>],
            ["≥ 1.5", "Aceptable", "Operar normalmente"],
            ["< 1.5", <span style={{color: red, fontWeight: 700}}>Peligroso</span>, <span style={{color: red}}>NO operes. Arriesgas más de lo que puedes ganar.</span>],
          ]} />
        </div>);

        case 3: return (<div>
          <div style={sectionHeaderStyle}>🛡 4. Trailing Stop - Tu Protector de Ganancias</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>El trailing stop es un stop-loss que se mueve automáticamente a tu favor:</p>
          <GuideTable headers={["Concepto", "Detalle"]} rows={[
            [<strong>Distancia inicial</strong>, "2.5 × ATR (más ancho que acciones por la volatilidad crypto)"],
            [<strong>Se activa cuando</strong>, "Tu trade tiene 1 ATR de ganancia"],
            [<strong>Paso</strong>, "Sube 1 ATR cada vez que el precio avanza"],
          ]} />
          <div style={{ ...sTitle, marginTop: 18 }}>Ejemplo práctico (BUY en Bitcoin a $100,000)</div>
          <div style={{ ...card, padding: 14, fontFamily: "monospace", fontSize: 11, lineHeight: 2, color: muted }}>
            <div>ATR = $2,000</div>
            <div>Trailing stop inicial: <span style={{color: amber}}>$95,000</span> (100,000 - 2.5 × 2,000)</div>
            <div>Se activa en: <span style={{color: text}}>$102,000</span> (ganancia de 1 ATR)</div>
            <div>BTC sube a $104,000 → trailing sube a <span style={{color: amber}}>$99,000</span></div>
            <div>BTC sube a $108,000 → trailing sube a <span style={{color: amber}}>$103,000</span></div>
            <div>BTC cae a $103,000 → vendes con <span style={{color: green}}>ganancia de $3,000</span></div>
          </div>
          <div style={alertBox}>⚠ <strong>Sin trailing stop:</strong> Muchos traders ven +20% de ganancia y luego el precio se devuelve a 0%. El trailing evita esto.</div>
        </div>);

        case 4: return (<div>
          <div style={sectionHeaderStyle}>📊 5. Derivados (Funding Rate, L/S Ratio)</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Esta fila muestra datos del mercado de futuros de Binance:</p>
          <div style={{ ...sTitle }}>Funding Rate</div>
          <GuideTable headers={["Valor", "Color", "Significado"]} rows={[
            ["> +0.10%", <span style={{color: red}}>🔴</span>, <span style={{color: red}}>Peligro: Demasiados longs apalancados. Probable caída.</span>],
            ["+0.05% a +0.10%", <span style={{color: red}}>🔴</span>, "Cautela: Longs elevados"],
            ["-0.05% a +0.05%", "Normal", "Mercado equilibrado"],
            ["-0.05% a -0.10%", <span style={{color: green}}>🟢</span>, "Oportunidad: Shorts elevados, posible squeeze alcista"],
            ["< -0.10%", <span style={{color: green}}>🟢</span>, <span style={{color: green}}>Shorts extremos: Alta probabilidad de rebote explosivo</span>],
          ]} />
          <div style={tipBox}>💡 <strong>Clave:</strong> El funding rate es una señal <strong>contraria</strong>. Cuando todo el mundo está long (funding alto positivo), es probable que el precio caiga para liquidarlos.</div>
          <div style={{ ...sTitle, marginTop: 14 }}>Long/Short Ratio</div>
          <GuideTable headers={["Valor", "Significado"]} rows={[
            ["> 2.0", "Longs abrumadores. Riesgo de liquidación en cascada hacia abajo."],
            ["1.0 - 2.0", "Sesgo alcista moderado"],
            ["0.67 - 1.0", "Equilibrado"],
            ["< 0.5", "Shorts abrumadores. Riesgo de squeeze alcista."],
          ]} />
          <div style={{ ...sTitle, marginTop: 14 }}>Sentimiento</div>
          <GuideTable headers={["Etiqueta", "Significado"]} rows={[
            [<span style={{color: red}}>OVER LEVERAGED LONG</span>, "Exceso de apalancamiento alcista. Cuidado con comprar."],
            [<span style={{color: green}}>OVER LEVERAGED SHORT</span>, "Exceso de apalancamiento bajista. Oportunidad de compra."],
            ["NEUTRAL", "Posicionamiento equilibrado"],
          ]} />
        </div>);

        case 5: return (<div>
          <div style={sectionHeaderStyle}>🌍 6. Contexto Macro (BTC Dominance + DXY)</div>
          <div style={{ ...sTitle }}>BTC Dominance (Dominancia de Bitcoin)</div>
          <GuideTable headers={["Badge", "Color", "Significado", "Qué hacer"]} rows={[
            [<span style={{color: green, fontWeight: 700}}>ALT SEASON</span>, <span style={{color: green}}>🟢</span>, "BTC dom baja (<45%). Dinero rotando a altcoins.", "Comprar altcoins."],
            [<span style={{color: red, fontWeight: 700}}>BTC SEASON</span>, <span style={{color: red}}>🔴</span>, "BTC dom alta (>55%). Dinero concentrado en BTC.", "Solo operar BTC. Evitar alts."],
            ["(no aparece)", "—", "Neutral (45-55%)", "Operar normalmente"],
          ]} />
          <div style={alertBox}>🚨 <strong>Regla crítica:</strong> Cuando ves "BTC SEASON" en rojo, no compres altcoins aunque la señal diga BUY. Las alts caen 2-3x más que BTC en estas fases.</div>
          <div style={{ ...sTitle, marginTop: 14 }}>DXY (Índice del Dólar)</div>
          <GuideTable headers={["Badge", "Color", "Significado", "Qué hacer"]} rows={[
            [<span style={{color: green, fontWeight: 700}}>DXY RISK ON</span>, <span style={{color: green}}>🟢</span>, "Dólar débil y cayendo. Dinero fluye a crypto.", "Operar con confianza. Macro a favor."],
            [<span style={{color: red, fontWeight: 700}}>DXY RISK OFF</span>, <span style={{color: red}}>🔴</span>, "Dólar fuerte y subiendo. Dinero sale de crypto.", "Reducir exposición. Macro en contra."],
            ["(no aparece)", "—", "DXY estable", "Operar normalmente"],
          ]} />
          <div style={tipBox}>💡 La correlación inversa entre DXY y crypto es de ~85%. Cuando el dólar sube fuerte, crypto baja.</div>
        </div>);

        case 6: return (<div>
          <div style={sectionHeaderStyle}>💪 7. Fuerza de la Señal</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Qué tan en serio tomar cada señal:</p>
          <GuideTable headers={["Etiqueta", "Score", "Confianza", "Posición sugerida"]} rows={[
            [<span style={{color: green, fontWeight: 700}}>STRONG BUY</span>, "≥ 75", "≥ 60%", "100% de tu tamaño normal"],
            [<span style={{color: green}}>BUY</span>, "≥ 67", "≥ 45%", "75% de tu tamaño normal"],
            [<span style={{color: amber}}>WEAK BUY</span>, "≥ 62", "< 45%", "50% o menos"],
            ["HOLD", "38-62", "Cualquiera", <span style={{color: amber, fontWeight: 700}}>No operes. Espera mejor oportunidad.</span>],
            [<span style={{color: amber}}>WEAK SELL</span>, "≤ 38", "< 45%", "Posición pequeña o no compres"],
            [<span style={{color: red}}>SELL</span>, "≤ 33", "≥ 45%", "75% (short o cierra long)"],
            [<span style={{color: red, fontWeight: 700}}>STRONG SELL</span>, "≤ 25", "≥ 60%", "Cierra posiciones long. Protege capital."],
          ]} />
        </div>);

        case 7: return (<div>
          <div style={sectionHeaderStyle}>⚙ 8. Los 13 Factores del Motor de Señales</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Cada señal se genera analizando estos 13 factores:</p>
          <GuideTable headers={["#", "Factor", "Peso máx", "Qué analiza"]} rows={[
            ["1", <strong>Tendencia EMA</strong>, "±20", "Dirección de medias móviles 9, 21, 50"],
            ["2", <strong>ADX</strong>, "Multi.", "Fuerza de la tendencia (amplifica o reduce)"],
            ["3", <strong>RSI</strong>, "±18", "Sobrecompra/sobreventa"],
            ["4", <strong>MACD</strong>, "±15", "Momentum y cruces de señal"],
            ["5", <strong>Bollinger Bands</strong>, "±10", "Volatilidad y posición del precio"],
            ["6", <strong>Soporte/Resistencia</strong>, "±8", "Niveles clave de precio"],
            ["7", <strong>Divergencias RSI</strong>, "±20", "Divergencias ocultas (cambios de tendencia)"],
            ["8", <strong>Volumen</strong>, "±10", "Confirmación o negación del movimiento"],
            ["9", <strong>Momentum 24h</strong>, "±10", "Fuerza del cambio diario"],
            ["10", <strong>Fear & Greed</strong>, "±3", "Sentimiento extremo (contrarian)"],
            ["11", <strong>Derivados</strong>, "±15", "Funding rate, OI, L/S ratio"],
            ["12", <strong>BTC Dominance</strong>, "±10", "Flujo de capital BTC vs Alts"],
            ["13", <strong>DXY Macro</strong>, "±10", "Fortaleza del dólar (contexto macro global)"],
          ]} />
        </div>);

        case 8: return (<div>
          <div style={sectionHeaderStyle}>📈 9. Dashboard - Sección Macro</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>En el dashboard principal verás estas estadísticas:</p>
          <GuideTable headers={["Indicador", "Qué es", "Cómo leerlo"]} rows={[
            [<strong>Fear & Greed</strong>, "Sentimiento del mercado (0-100)", "< 25 = miedo extremo (oportunidad). > 75 = codicia (precaución)."],
            [<strong>BTC Dominance</strong>, "% del mercado total que es Bitcoin", "> 55% = BTC season. < 45% = alt season."],
            [<strong>DXY (Dollar)</strong>, "Índice de fuerza del dólar", "Rising = bearish crypto. Falling = bullish crypto."],
            [<strong>Total Market Cap</strong>, "Capitalización total crypto", "Tendencia general del mercado"],
            [<strong>Gold / Silver</strong>, "Precios de metales preciosos", "Refugios de valor. Si suben junto con crypto, el movimiento es más fuerte."],
          ]} />
        </div>);

        case 9: return (<div>
          <div style={sectionHeaderStyle}>🔄 10. Flujo de Decisión para Operar</div>
          <p style={{ color: muted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>Sigue este proceso antes de cada trade:</p>
          <div style={flowBox}>{`1. Mira la ACCIÓN (BUY/SELL/HOLD)
   └─ HOLD? → NO OPERES. Espera.
   └─ BUY o SELL? → Continúa...

2. Verifica CONFLUENCIA
   └─ Conflicto/Débil? → NO OPERES
   └─ Moderada? → Reduce tamaño de posición a 50%
   └─ Fuerte? → Posición normal. Continúa...

3. Revisa R:R (Riesgo/Recompensa)
   └─ < 1.5? → NO OPERES. No vale la pena.
   └─ ≥ 1.5? → Continúa...

4. Chequea DERIVADOS
   └─ Funding > +0.10%? → Cuidado con BUY
   └─ Funding < -0.10%? → Cuidado con SELL
   └─ Normal? → Continúa...

5. Revisa MACRO
   └─ BTC SEASON + operando alt? → NO COMPRES
   └─ DXY RISK OFF? → Reduce exposición
   └─ Todo OK? → Continúa...

6. EJECUTA
   ✓ Compra/vende en precio de ENTRADA
   ✓ Coloca STOP LOSS inmediatamente
   ✓ Programa TP1 (vende 50%)
   ✓ Activa TRAILING STOP en el nivel indicado
   ✓ Deja correr el resto hacia TP2`}</div>
        </div>);

        case 10: return (<div>
          <div style={sectionHeaderStyle}>⚠ 11. Errores Comunes a Evitar</div>
          <GuideTable headers={["Error", "Por qué es peligroso", "Qué hacer"]} rows={[
            [<strong>Operar sin stop-loss</strong>, "Una sola caída puede destruir tu cuenta", <span style={{color: green}}>Siempre usa el SL que indica la señal</span>],
            [<strong>Ignorar R:R {'<'} 1.5</strong>, "Arriesgas más de lo que puedes ganar", "Si es rojo, no operes"],
            [<strong>Comprar alts en BTC SEASON</strong>, "Las alts caen 2-3x más que BTC", "Solo opera BTC con badge rojo"],
            [<strong>Ignorar confluencia en conflicto</strong>, "Los timeframes se contradicen", "Espera a que se alineen"],
            [<strong>No tomar ganancias en TP1</strong>, "El precio puede devolverse a 0%", "Siempre vende al menos 50% en TP1"],
            [<strong>WEAK BUY como STRONG</strong>, "Son señales muy diferentes en fiabilidad", "Reduce posición o espera mejor señal"],
            [<strong>Ignorar funding rate extremo</strong>, "Las liquidaciones masivas causan crashes", "Si funding > 0.10%, no compres"],
          ]} />
        </div>);

        case 11: return (<div>
          <div style={sectionHeaderStyle}>📖 12. Glosario Rápido</div>
          <GuideTable headers={["Término", "Significado"]} rows={[
            [<strong>ATR</strong>, "Average True Range. Mide la volatilidad típica del activo."],
            [<strong>RSI</strong>, "Relative Strength Index. Sobrecompra (>70) y sobreventa (<30)."],
            [<strong>MACD</strong>, "Indicador de momentum. Cruces indican cambios de tendencia."],
            [<strong>EMA</strong>, "Media móvil exponencial. 9 > 21 > 50 = tendencia alcista."],
            [<strong>Bollinger Bands</strong>, "Bandas de volatilidad. Precio fuera = movimiento extremo."],
            [<strong>ADX</strong>, "Mide fuerza de tendencia. > 30 = fuerte. < 20 = sin tendencia."],
            [<strong>Funding Rate</strong>, "Tasa que pagan longs a shorts (o viceversa) cada 8 horas."],
            [<strong>OI</strong>, "Open Interest. Total de posiciones abiertas en futuros."],
            [<strong>L/S Ratio</strong>, "Proporción de longs vs shorts en el mercado."],
            [<strong>DXY</strong>, "Índice del dólar americano contra una canasta de monedas."],
            [<strong>Trailing Stop</strong>, "Stop-loss que se mueve automáticamente a tu favor."],
            [<strong>R:R</strong>, "Risk/Reward. Cuánto puedes ganar vs cuánto puedes perder."],
            [<strong>Confluence</strong>, "Cuando múltiples timeframes están de acuerdo en la dirección."],
          ]} />
          <div style={{ textAlign: "center", marginTop: 20, fontSize: 10, color: muted, fontFamily: "monospace" }}>
            Sentix Pro v4.5 · Motor de 13 factores · Multi-timeframe · Derivados · Contexto Macro
          </div>
        </div>);

        default: return null;
      }
    };

    return (
      <div>
        {/* Guide Header */}
        <div style={{
          ...card,
          background: `linear-gradient(135deg, rgba(168,85,247,0.12), rgba(59,130,246,0.08))`,
          border: `1px solid rgba(168,85,247,0.3)`,
          textAlign: "center", padding: "24px 20px"
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📖</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.02em" }}>
            GUÍA COMPLETA DE SEÑALES
          </div>
          <div style={{ fontSize: 11, color: muted, marginTop: 6, lineHeight: 1.5 }}>
            Cómo interpretar y utilizar las señales de Sentix Pro para un trading efectivo
          </div>
          <div style={{
            display: "inline-block", marginTop: 10, padding: "4px 12px",
            background: "rgba(168,85,247,0.2)", borderRadius: 20,
            fontSize: 10, color: purple, fontWeight: 700
          }}>
            v4.5 · 13 Factores · Multi-Timeframe
          </div>
        </div>

        {/* Section Navigation */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {sections.map((sec, i) => (
            <button
              key={i}
              onClick={() => setGuideSection(i)}
              style={{
                padding: "6px 12px",
                background: guideSection === i ? `linear-gradient(135deg, ${purple}, #7c3aed)` : bg3,
                border: guideSection === i ? "none" : `1px solid ${border}`,
                borderRadius: 6,
                color: guideSection === i ? "#fff" : muted,
                fontFamily: "monospace",
                fontSize: 10,
                fontWeight: guideSection === i ? 700 : 500,
                cursor: "pointer",
                transition: "all 0.2s"
              }}
            >
              {sec.icon} {sec.title}
            </button>
          ))}
        </div>

        {/* Section Content */}
        <div style={{ ...card, padding: "20px 24px" }}>
          {renderSection()}
        </div>

        {/* Navigation arrows */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          <button
            onClick={() => setGuideSection(Math.max(0, guideSection - 1))}
            disabled={guideSection === 0}
            style={{
              padding: "8px 16px", background: bg3, border: `1px solid ${border}`,
              borderRadius: 6, color: guideSection === 0 ? muted : text,
              fontFamily: "monospace", fontSize: 11, cursor: guideSection === 0 ? "default" : "pointer",
              opacity: guideSection === 0 ? 0.4 : 1
            }}
          >
            ← Anterior
          </button>
          <span style={{ fontSize: 10, color: muted, fontFamily: "monospace", alignSelf: "center" }}>
            {guideSection + 1} / {sections.length}
          </span>
          <button
            onClick={() => setGuideSection(Math.min(sections.length - 1, guideSection + 1))}
            disabled={guideSection === sections.length - 1}
            style={{
              padding: "8px 16px", background: bg3, border: `1px solid ${border}`,
              borderRadius: 6, color: guideSection === sections.length - 1 ? muted : text,
              fontFamily: "monospace", fontSize: 11, cursor: guideSection === sections.length - 1 ? "default" : "pointer",
              opacity: guideSection === sections.length - 1 ? 0.4 : 1
            }}
          >
            Siguiente →
          </button>
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
            { k: "alerts", label: "🔔 ALERTAS", desc: "Configuración" },
            { k: "paper", label: "📈 PAPER", desc: "Trading simulado" },
            { k: "guide", label: "📖 GUÍA", desc: "Cómo usar" }
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
        {tab === "paper" && <PaperTradingTab />}
        {tab === "guide" && <GuideTab />}

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
