/**
 * Tooltip and legend helper utilities.
 *
 * Provides utilities for managing tooltip state, caching content to avoid
 * unnecessary DOM updates, and computing tooltip anchor positions for special
 * chart types like candlesticks.
 *
 * @module tooltipLegendHelpers
 */

import type { OHLCDataPoint } from '../../../config/types';
import type { LinearScale } from '../../../utils/scales';
import type { GridArea } from '../../../renderers/createGridRenderer';
import { isTupleOHLCDataPoint } from '../utils/dataPointUtils';

/**
 * Cached tooltip state for content deduplication.
 *
 * Tracks the last displayed content and position to avoid unnecessary DOM updates
 * when the tooltip hasn't actually changed.
 */
interface TooltipCache {
  content: string | null;
  x: number | null;
  y: number | null;
}

/**
 * Creates a new empty tooltip cache.
 *
 * @returns Fresh tooltip cache with null values
 */
export function createTooltipCache(): TooltipCache {
  return {
    content: null,
    x: null,
    y: null,
  };
}

/**
 * Checks if tooltip content or position has changed.
 *
 * Returns true if any of the values differ from the cache, indicating that
 * a DOM update is needed.
 *
 * @param cache - Current cached state
 * @param content - New content to display
 * @param x - New X position in CSS pixels
 * @param y - New Y position in CSS pixels
 * @returns True if update is needed (values differ from cache)
 */
export function shouldUpdateTooltip(cache: TooltipCache, content: string, x: number, y: number): boolean {
  return cache.content !== content || cache.x !== x || cache.y !== y;
}

/**
 * Updates the tooltip cache with new values.
 *
 * Should be called after successfully updating the DOM to keep cache in sync.
 *
 * @param cache - Tooltip cache to update (mutated)
 * @param content - New content that was displayed
 * @param x - New X position that was set
 * @param y - New Y position that was set
 */
export function updateTooltipCache(cache: TooltipCache, content: string, x: number, y: number): void {
  cache.content = content;
  cache.x = x;
  cache.y = y;
}

/**
 * Clears the tooltip cache.
 *
 * Should be called when the tooltip is hidden to ensure fresh state
 * when it's shown again.
 *
 * @param cache - Tooltip cache to clear (mutated)
 */
export function clearTooltipCache(cache: TooltipCache): void {
  cache.content = null;
  cache.x = null;
  cache.y = null;
}

/**
 * Determines if a data point is an OHLC/candlestick point.
 *
 * Checks if the point is a 5-element tuple (timestamp, open, close, low, high)
 * or an object with OHLC properties.
 *
 * @param point - Data point to check
 * @returns True if point is OHLC format
 */
export function isOHLCDataPoint(point: any): point is OHLCDataPoint {
  if (Array.isArray(point)) {
    return point.length === 5;
  }
  if (point && typeof point === 'object') {
    return 'timestamp' in point && 'open' in point && 'close' in point && 'low' in point && 'high' in point;
  }
  return false;
}

/**
 * Resolve the Y scale for candlestick tooltip anchoring.
 *
 * Dual-Y candle+volume charts put `vol` first in the scale map (bar renderer
 * samples the first Y). Anchoring OHLC body mid against that scale maps price
 * domain values near the plot floor. Prefer the series `yAxis` id, then common
 * price ids, then the first scale as last resort.
 */
function resolveCandlestickYScale(
  yScales: Map<string, LinearScale>,
  yAxisId?: string
): LinearScale | undefined {
  if (yAxisId) {
    const byId = yScales.get(yAxisId);
    if (byId) return byId;
  }
  for (const id of ['price', 'y', 'default'] as const) {
    const s = yScales.get(id);
    if (s) return s;
  }
  return yScales.values().next().value;
}

export function computeCandlestickTooltipAnchorFromMatch(
  match: { readonly point: OHLCDataPoint; readonly yAxisId?: string },
  xScale: LinearScale,
  yScales: Map<string, LinearScale>,
  gridArea: GridArea,
  canvas: HTMLCanvasElement
): Readonly<{ x: number; y: number }> | null {
  const point = match.point;

  const timestamp = isTupleOHLCDataPoint(point) ? point[0] : point.timestamp;
  const open = isTupleOHLCDataPoint(point) ? point[1] : point.open;
  const close = isTupleOHLCDataPoint(point) ? point[2] : point.close;

  if (!Number.isFinite(timestamp) || !Number.isFinite(open) || !Number.isFinite(close)) {
    return null;
  }

  // Body center in domain space
  const bodyMidY = (open + close) / 2;

  // Transform to grid-local CSS pixels on the *price* Y scale (not volume).
  const xGridCss = xScale.scale(timestamp);
  const yScale = resolveCandlestickYScale(yScales, match.yAxisId);
  const yGridCss = yScale ? yScale.scale(bodyMidY) : 0;

  if (!Number.isFinite(xGridCss) || !Number.isFinite(yGridCss)) {
    return null;
  }

  // Convert to canvas-local CSS pixels
  const xCanvasCss = gridArea.left + xGridCss;
  const yCanvasCss = gridArea.top + yGridCss;

  // Convert to container-local CSS pixels
  const xContainerCss = typeof (canvas as any).offsetLeft === 'number' ? canvas.offsetLeft + xCanvasCss : xCanvasCss;
  const yContainerCss = typeof (canvas as any).offsetLeft === 'number' ? canvas.offsetTop + yCanvasCss : yCanvasCss;

  if (!Number.isFinite(xContainerCss) || !Number.isFinite(yContainerCss)) {
    return null;
  }

  return { x: xContainerCss, y: yContainerCss };
}
