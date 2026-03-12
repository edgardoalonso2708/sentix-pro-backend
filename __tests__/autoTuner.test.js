// ═══════════════════════════════════════════════════════════════════════════════
// Tests — autoTuner.js (enriched context + parameter conflict detection)
// ═══════════════════════════════════════════════════════════════════════════════

const { detectParameterConflicts, buildAIPrompt } = require('../autoTuner');

// ═══════════════════════════════════════════════════════════════════════════════
// detectParameterConflicts
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectParameterConflicts', () => {
  test('detects aggressive RSI + conservative sizing', () => {
    const conflicts = detectParameterConflicts({
      rsiOversold: 38,
      risk_per_trade: 0.003
    });
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some(c => c.includes('RSI oversold'))).toBe(true);
  });

  test('detects tight stops + long holding period', () => {
    const conflicts = detectParameterConflicts({
      atrStopMult: 0.8,
      max_holding_hours: 200
    });
    expect(conflicts.some(c => c.includes('stop-loss'))).toBe(true);
  });

  test('detects high confluence requirement + low threshold', () => {
    const conflicts = detectParameterConflicts({
      min_confluence: 4,
      buyThreshold: 12
    });
    expect(conflicts.some(c => c.includes('confluence'))).toBe(true);
  });

  test('detects lenient conflicting mult + aggressive strong mult', () => {
    const conflicts = detectParameterConflicts({
      conflictingMult: 0.90,
      strongConfluenceMult: 1.4
    });
    expect(conflicts.some(c => c.includes('Conflicting signal'))).toBe(true);
  });

  test('detects wide stops + small position', () => {
    const conflicts = detectParameterConflicts({
      atrStopMult: 3.5,
      max_position_percent: 8
    });
    expect(conflicts.some(c => c.includes('Wide stop-loss'))).toBe(true);
  });

  test('detects short holding + heavy trend weight', () => {
    const conflicts = detectParameterConflicts({
      max_holding_hours: 6,
      trendWeight: 30
    });
    expect(conflicts.some(c => c.includes('Short max holding'))).toBe(true);
  });

  test('returns empty array for balanced config', () => {
    const conflicts = detectParameterConflicts({
      rsiOversold: 30,
      risk_per_trade: 0.02,
      atrStopMult: 2.0,
      max_holding_hours: 72,
      min_confluence: 3,
      buyThreshold: 25,
      conflictingMult: 0.70,
      strongConfluenceMult: 1.15,
      max_position_percent: 25,
      trendWeight: 15
    });
    expect(conflicts).toEqual([]);
  });

  test('handles null config gracefully', () => {
    expect(detectParameterConflicts(null)).toEqual([]);
    expect(detectParameterConflicts(undefined)).toEqual([]);
  });

  test('handles empty config gracefully', () => {
    expect(detectParameterConflicts({})).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildAIPrompt — new sections
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildAIPrompt', () => {
  const baseProposals = [{
    paramName: 'rsiOversold',
    currentValue: 30,
    proposedValue: 28,
    currentSharpe: 1.2,
    proposedSharpe: 1.5,
    improvementPct: 25
  }];

  const baseContext = {
    marketRegime: 'trending_up',
    lookbackDays: 60,
    asset: 'bitcoin',
    configSource: 'default',
    recentTradeCount: 15
  };

  test('includes last 5 trades section when present', () => {
    const context = {
      ...baseContext,
      recentClosedTrades: [
        { asset: 'BTC', direction: 'LONG', pnl: 45.2, pnlPct: 2.3, regime: 'trending_up', confluence: 'strong', exitReason: 'TP1', holdingHours: 12 },
        { asset: 'ETH', direction: 'SHORT', pnl: -20.1, pnlPct: -1.5, regime: 'ranging', confluence: 'weak', exitReason: 'SL', holdingHours: 6 }
      ]
    };

    const prompt = buildAIPrompt(baseProposals, context);
    expect(prompt).toContain('LAST 5 CLOSED TRADES:');
    expect(prompt).toContain('BTC LONG: +$45.20');
    expect(prompt).toContain('ETH SHORT: $-20.10');
    expect(prompt).toContain('regime: trending_up');
    expect(prompt).toContain('confluence: strong');
  });

  test('includes conflict warnings section when present', () => {
    const context = {
      ...baseContext,
      parameterConflicts: [
        'Aggressive RSI oversold threshold (≥35) with very conservative position sizing.',
        'Tight stop-loss with long holding period.'
      ]
    };

    const prompt = buildAIPrompt(baseProposals, context);
    expect(prompt).toContain('PARAMETER CONFLICTS DETECTED:');
    expect(prompt).toContain('Aggressive RSI');
    expect(prompt).toContain('Tight stop-loss');
  });

  test('includes new instruction lines 7 and 8', () => {
    const prompt = buildAIPrompt(baseProposals, baseContext);
    expect(prompt).toContain('7. Review the last 5 trades');
    expect(prompt).toContain('8. Are there parameter conflicts');
  });

  test('omits trades/conflicts sections when empty', () => {
    const prompt = buildAIPrompt(baseProposals, baseContext);
    expect(prompt).not.toContain('LAST 5 CLOSED TRADES:');
    expect(prompt).not.toContain('PARAMETER CONFLICTS DETECTED:');
  });
});
