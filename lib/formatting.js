// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTING UTILITIES - Extracted from frontend for testability
// ═══════════════════════════════════════════════════════════════════════════════

function formatPrice(price) {
  if (!price) return '$0';
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

function formatLargeNumber(num) {
  if (!num) return '$0';
  if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  return `$${num.toFixed(2)}`;
}

module.exports = { formatPrice, formatLargeNumber };
