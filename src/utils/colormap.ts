/**
 * Shared colormap LUT builders (scatter density + uniform heatmap).
 *
 * Named stops stay consistent across series types so viridis/plasma/inferno
 * match visually whether used as densityColormap or heatmap.colormap.
 */

import { parseCssColorToRgba01, type Rgba01 } from './colors';

export type NamedColormap = 'viridis' | 'plasma' | 'inferno' | 'magma' | 'grayscale';

export type ColormapSpec = NamedColormap | readonly string[];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v | 0));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpRgba = (a: Rgba01, b: Rgba01, t: number): Rgba01 =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)] as const;

const parseColorStop = (css: string): Rgba01 => parseCssColorToRgba01(css) ?? ([0, 0, 0, 1] as const);

/**
 * Compact CSS stop lists for named colormaps (interpolated to 256 entries).
 */
export function getNamedColormapStops(name: NamedColormap): readonly string[] {
  if (name === 'plasma') {
    return ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'] as const;
  }
  if (name === 'inferno') {
    return ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'] as const;
  }
  if (name === 'magma') {
    return ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'] as const;
  }
  if (name === 'grayscale') {
    return ['#000000', '#ffffff'] as const;
  }
  // viridis
  return ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] as const;
}

export function isNamedColormap(v: unknown): v is NamedColormap {
  return v === 'viridis' || v === 'plasma' || v === 'inferno' || v === 'magma' || v === 'grayscale';
}

/**
 * Stable string key for dirty-gating LUT rebuilds.
 */
export function colormapKey(colormap: ColormapSpec): string {
  if (typeof colormap === 'string') return colormap;
  try {
    return JSON.stringify(colormap);
  } catch {
    return 'custom';
  }
}

/**
 * Build a 256×RGBA8 unorm LUT (1024 bytes) from named or custom stops.
 * Endpoints match first/last stop colors (t=0 and t=1).
 */
export function buildColormapLut(colormap: ColormapSpec): Uint8Array<ArrayBuffer> {
  const stopsCss =
    typeof colormap === 'string'
      ? getNamedColormapStops(colormap)
      : Array.isArray(colormap) && colormap.length > 0
        ? colormap
        : getNamedColormapStops('viridis');

  const stops = stopsCss.map(parseColorStop);
  const n = Math.max(2, stops.length);

  const out: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256 * 4));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const x = t * (n - 1);
    const seg = Math.min(n - 2, Math.max(0, Math.floor(x)));
    const localT = x - seg;
    const c = lerpRgba(stops[seg]!, stops[seg + 1]!, localT);

    out[i * 4 + 0] = clampInt(Math.round(clamp01(c[0]) * 255), 0, 255);
    out[i * 4 + 1] = clampInt(Math.round(clamp01(c[1]) * 255), 0, 255);
    out[i * 4 + 2] = clampInt(Math.round(clamp01(c[2]) * 255), 0, 255);
    out[i * 4 + 3] = clampInt(Math.round(clamp01(c[3]) * 255), 0, 255);
  }
  return out;
}

/**
 * Sample colormap at t ∈ [0,1] (clamped). Useful for tests and CPU reference.
 */
export function sampleHeatmapColormap(colormap: ColormapSpec, t: number): Rgba01 {
  const lut = buildColormapLut(colormap);
  const t01 = clamp01(Number.isFinite(t) ? t : 0);
  const i = clampInt(Math.round(t01 * 255), 0, 255);
  const o = i * 4;
  return [lut[o]! / 255, lut[o + 1]! / 255, lut[o + 2]! / 255, lut[o + 3]! / 255] as const;
}
