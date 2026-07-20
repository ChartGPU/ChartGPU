import type { TooltipParams } from '../config/types';

const EM_DASH = '\u2014';

function escapeHtml(text: string): string {
  // Escapes text for safe insertion into HTML text/attribute contexts.
  // (We only use it for text nodes here, but keeping it generic is fine.)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;

  // Normalize -0 to 0 for display stability.
  const normalized = Object.is(value, -0) ? 0 : value;

  // Maximum 2 decimal places, trim trailing zeros.
  const fixed = normalized.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function resolveSeriesName(params: TooltipParams): string {
  const trimmed = params.seriesName.trim();
  return trimmed.length > 0 ? trimmed : `Series ${params.seriesIndex + 1}`;
}

function sanitizeCssColor(value: string): string {
  // Tooltip content is assigned via innerHTML, so treat color as untrusted.
  // Allow only common safe color syntaxes; otherwise fall back.
  const s = value.trim();
  if (s.length === 0) return '#888';

  // Hex: #RGB, #RRGGBB, #RRGGBBAA
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{8}$/.test(s)) return s;

  // rgb()/rgba() numeric forms (commas or space-separated with optional slash alpha)
  if (
    /^rgba?\(\s*\d{1,3}\s*(?:,\s*|\s+)\d{1,3}\s*(?:,\s*|\s+)\d{1,3}(?:\s*(?:,\s*|\/\s*)(?:0|1|0?\.\d+))?\s*\)$/.test(s)
  ) {
    return s;
  }

  // Named colors: basic CSS ident (letters only) to avoid weird tokens.
  if (/^[a-zA-Z]+$/.test(s)) return s;

  return '#888';
}

function isCandlestickValue(
  value: readonly [number, number] | readonly [number, number, number, number, number]
): value is readonly [number, number, number, number, number] {
  return value.length === 5;
}

function formatPercentChange(open: number, close: number): string {
  if (!Number.isFinite(open) || !Number.isFinite(close)) return EM_DASH;
  if (open === 0) return EM_DASH; // Avoid division by zero

  const change = ((close - open) / open) * 100;
  if (!Number.isFinite(change)) return EM_DASH;

  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

function formatRowHtml(params: TooltipParams, valueText: string): string {
  const safeName = escapeHtml(resolveSeriesName(params));
  const safeValue = escapeHtml(valueText);
  const safeColor = escapeHtml(sanitizeCssColor(params.color));

  return [
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">',
    '<span style="display:flex;align-items:center;gap:8px;min-width:0;">',
    `<span style="width:8px;height:8px;border-radius:999px;flex:0 0 auto;background-color:${safeColor};"></span>`,
    `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</span>`,
    '</span>',
    `<span style="font-variant-numeric:tabular-nums;white-space:nowrap;">${safeValue}</span>`,
    '</div>',
  ].join('');
}

function formatCandlestickRowHtml(params: TooltipParams): string {
  const [, open, close, low, high] = params.value as readonly [number, number, number, number, number];

  const safeName = escapeHtml(resolveSeriesName(params));
  const safeColor = escapeHtml(sanitizeCssColor(params.color));

  // Format OHLC values
  const openStr = formatNumber(open);
  const highStr = formatNumber(high);
  const lowStr = formatNumber(low);
  const closeStr = formatNumber(close);

  // Determine direction and arrow
  const isUp = close > open;
  const arrow = isUp ? '\u25B2' : '\u25BC'; // ▲ or ▼
  const arrowColor = isUp ? '#22c55e' : '#ef4444';
  const percentChange = formatPercentChange(open, close);

  const ohlcText = `O: ${openStr} H: ${highStr} L: ${lowStr} C: ${closeStr}`;
  const safeOHLC = escapeHtml(ohlcText);
  const safeArrow = escapeHtml(arrow);
  const safePercent = escapeHtml(percentChange);
  const safeArrowColor = escapeHtml(arrowColor);

  return [
    '<div style="display:flex;flex-direction:column;gap:4px;">',
    // Series name row
    '<div style="display:flex;align-items:center;gap:8px;">',
    `<span style="width:8px;height:8px;border-radius:999px;flex:0 0 auto;background-color:${safeColor};"></span>`,
    `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${safeName}</span>`,
    '</div>',
    // OHLC values row
    `<div style="font-variant-numeric:tabular-nums;white-space:nowrap;font-size:0.9em;">${safeOHLC}</div>`,
    // Change row with arrow
    '<div style="display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;">',
    `<span style="color:${safeArrowColor};font-weight:700;">${safeArrow}</span>`,
    `<span style="color:${safeArrowColor};font-weight:600;">${safePercent}</span>`,
    '</div>',
    '</div>',
  ].join('');
}

/**
 * Default tooltip formatter for candlestick series in item mode.
 * Renders O/H/L/C values with colored arrow and percentage change.
 */
export function formatCandlestickTooltip(params: TooltipParams): string {
  return formatCandlestickRowHtml(params);
}

/**
 * Default tooltip formatter for item mode.
 * Returns a compact single-row HTML snippet: dot + series name + y value.
 * For candlestick series, returns O/H/L/C with arrow and percentage change.
 */
export function formatTooltipItem(params: TooltipParams): string {
  if (isCandlestickValue(params.value)) {
    return formatCandlestickTooltip(params);
  }
  if (typeof params.z === 'number') {
    // Heatmap: show z as primary value; x/y are cell centers in value[].
    const zText = formatNumber(params.z);
    const xy = `x=${formatNumber(params.value[0])} y=${formatNumber(params.value[1])}`;
    return formatRowHtml(params, `${zText} <span style="opacity:0.7">(${escapeHtml(xy)})</span>`);
  }
  if (typeof params.y1 === 'number' && Number.isFinite(params.y1)) {
    // Band: display ordered envelope; raw TooltipParams y/y1 stay unordered.
    const a = params.value[1];
    const b = params.y1;
    const lo = formatNumber(Math.min(a, b));
    const hi = formatNumber(Math.max(a, b));
    return formatRowHtml(params, `${lo} … ${hi}`);
  }
  return formatRowHtml(params, formatNumber(params.value[1]));
}

/**
 * Default tooltip formatter for axis mode.
 * Renders an x header line then one row per series with the y value.
 * Candlestick series show O/H/L/C values with arrow and percentage change.
 */
export function formatTooltipAxis(params: TooltipParams[]): string {
  if (params.length === 0) return '';

  const xText = `x: ${formatNumber(params[0].value[0])}`;
  const header = `<div style="margin:0 0 6px 0;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(
    xText
  )}</div>`;

  const rows = params
    .map((p) => {
      if (isCandlestickValue(p.value)) {
        return formatCandlestickRowHtml(p);
      }
      if (typeof p.z === 'number') {
        const zText = formatNumber(p.z);
        const xy = `x=${formatNumber(p.value[0])} y=${formatNumber(p.value[1])}`;
        return formatRowHtml(p, `${zText} <span style="opacity:0.7">(${escapeHtml(xy)})</span>`);
      }
      if (typeof p.y1 === 'number' && Number.isFinite(p.y1)) {
        const a = p.value[1];
        const b = p.y1;
        const lo = formatNumber(Math.min(a, b));
        const hi = formatNumber(Math.max(a, b));
        return formatRowHtml(p, `${lo} … ${hi}`);
      }
      return formatRowHtml(p, formatNumber(p.value[1]));
    })
    .join('<div style="height:4px;"></div>');

  return `${header}${rows}`;
}
