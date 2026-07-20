/**
 * Pure heatmap tooltip helpers (unit-testable without WebGPU).
 */

import type { TooltipParams } from '../config/types';
import type { HeatmapNullHandling } from '../config/types';
import type { HeatmapColormap } from '../config/types';
import type { HeatmapData } from '../config/types';
import { heatmapHitTest, type HeatmapCellAnchor } from '../utils/heatmapLayout';
import { normalizeZ } from '../utils/heatmapLayout';
import { sampleHeatmapColormap } from '../utils/colormap';

export type HeatmapTooltipSeries = Readonly<{
  readonly name?: string;
  readonly data: HeatmapData;
  readonly cellAnchor: HeatmapCellAnchor;
  readonly nullHandling: HeatmapNullHandling;
  readonly zMin: number;
  readonly zMax: number;
  readonly zScale: 'linear' | 'log';
  readonly colormap: HeatmapColormap;
  readonly drawable?: boolean;
  readonly visible?: boolean;
}>;

/**
 * Resolve a heatmap cell under data-space (x,y) into tooltip params.
 * Returns null when outside the grid, non-drawable, or transparent+non-finite z.
 */
export function resolveHeatmapTooltipParams(
  series: HeatmapTooltipSeries,
  seriesIndex: number,
  dataX: number,
  dataY: number
): TooltipParams | null {
  if (series.visible === false || series.drawable === false) return null;
  if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return null;

  const hit = heatmapHitTest(series.data, dataX, dataY, series.cellAnchor);
  if (!hit) return null;

  // Transparent nullHandling: non-finite z is invisible → miss (no tooltip).
  if (series.nullHandling === 'transparent' && !Number.isFinite(hit.z)) {
    return null;
  }

  const t = normalizeZ(hit.z, series.zMin, series.zMax, series.zScale);
  // lowest/highest map non-finite for color; still show raw z (may be NaN text — only when not transparent)
  const rgba = sampleHeatmapColormap(
    series.colormap,
    Number.isFinite(t) ? t : series.nullHandling === 'highest' ? 1 : 0
  );
  const color = `rgba(${Math.round(rgba[0] * 255)},${Math.round(rgba[1] * 255)},${Math.round(rgba[2] * 255)},${rgba[3]})`;

  return {
    seriesName: series.name ?? '',
    seriesIndex,
    dataIndex: hit.dataIndex,
    value: [hit.x, hit.y] as const,
    color,
    z: hit.z,
  };
}
