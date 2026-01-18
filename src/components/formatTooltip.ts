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
    /^rgba?\(\s*\d{1,3}\s*(?:,\s*|\s+)\d{1,3}\s*(?:,\s*|\s+)\d{1,3}(?:\s*(?:,\s*|\/\s*)(?:0|1|0?\.\d+))?\s*\)$/.test(
      s,
    )
  ) {
    return s;
  }

  // Named colors: basic CSS ident (letters only) to avoid weird tokens.
  if (/^[a-zA-Z]+$/.test(s)) return s;

  return '#888';
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

/**
 * Default tooltip formatter for item mode.
 * Returns a compact single-row HTML snippet: dot + series name + y value.
 */
export function formatTooltipItem(params: TooltipParams): string {
  return formatRowHtml(params, formatNumber(params.value[1]));
}

/**
 * Default tooltip formatter for axis mode.
 * Renders an x header line then one row per series with the y value.
 */
export function formatTooltipAxis(params: TooltipParams[]): string {
  if (params.length === 0) return '';

  const xText = `x: ${formatNumber(params[0].value[0])}`;
  const header = `<div style="margin:0 0 6px 0;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(
    xText,
  )}</div>`;

  const rows = params
    .map((p) => formatRowHtml(p, formatNumber(p.value[1])))
    .join('<div style="height:4px;"></div>');

  return `${header}${rows}`;
}

