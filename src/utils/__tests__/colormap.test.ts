import { describe, it, expect } from 'vitest';
import { buildColormapLut, sampleHeatmapColormap, getNamedColormapStops, colormapKey } from '../colormap';
import { parseCssColorToRgba01 } from '../colors';

describe('buildColormapLut', () => {
  it('produces 256 RGBA entries (1024 bytes)', () => {
    const lut = buildColormapLut('viridis');
    expect(lut.length).toBe(1024);
  });

  it('endpoints match first/last named stops (viridis)', () => {
    const stops = getNamedColormapStops('viridis');
    const first = parseCssColorToRgba01(stops[0]!)!;
    const last = parseCssColorToRgba01(stops[stops.length - 1]!)!;
    const lut = buildColormapLut('viridis');

    expect(lut[0]).toBeCloseTo(Math.round(first[0] * 255), 0);
    expect(lut[1]).toBeCloseTo(Math.round(first[1] * 255), 0);
    expect(lut[2]).toBeCloseTo(Math.round(first[2] * 255), 0);

    const o = 255 * 4;
    expect(lut[o]).toBeCloseTo(Math.round(last[0] * 255), 0);
    expect(lut[o + 1]).toBeCloseTo(Math.round(last[1] * 255), 0);
    expect(lut[o + 2]).toBeCloseTo(Math.round(last[2] * 255), 0);
  });

  it('custom stops: low→high endpoints', () => {
    const lut = buildColormapLut(['#000000', '#ffffff']);
    expect(lut[0]).toBe(0);
    expect(lut[1]).toBe(0);
    expect(lut[2]).toBe(0);
    expect(lut[255 * 4]).toBe(255);
    expect(lut[255 * 4 + 1]).toBe(255);
    expect(lut[255 * 4 + 2]).toBe(255);
  });

  it('magma and grayscale are available', () => {
    expect(buildColormapLut('magma').length).toBe(1024);
    expect(buildColormapLut('grayscale')[0]).toBe(0);
    expect(buildColormapLut('grayscale')[255 * 4]).toBe(255);
  });
});

describe('sampleHeatmapColormap', () => {
  it('t=0 and t=1 match LUT endpoints', () => {
    const a = sampleHeatmapColormap('inferno', 0);
    const b = sampleHeatmapColormap('inferno', 1);
    const lut = buildColormapLut('inferno');
    expect(a[0]).toBeCloseTo(lut[0]! / 255, 5);
    expect(b[0]).toBeCloseTo(lut[255 * 4]! / 255, 5);
  });
});

describe('colormapKey', () => {
  it('named is identity', () => {
    expect(colormapKey('viridis')).toBe('viridis');
  });
  it('custom serializes', () => {
    expect(colormapKey(['#f00', '#0f0'])).toContain('#f00');
  });
});

describe('sampleHeatmapColormap clamp', () => {
  it('clamps t outside [0,1]', () => {
    const lo = sampleHeatmapColormap('grayscale', -1);
    const hi = sampleHeatmapColormap('grayscale', 2);
    const a = sampleHeatmapColormap('grayscale', 0);
    const b = sampleHeatmapColormap('grayscale', 1);
    expect(lo[0]).toBeCloseTo(a[0], 5);
    expect(hi[0]).toBeCloseTo(b[0], 5);
  });

  it('NaN t treated as 0', () => {
    const a = sampleHeatmapColormap('grayscale', Number.NaN);
    const b = sampleHeatmapColormap('grayscale', 0);
    expect(a[0]).toBeCloseTo(b[0], 5);
  });
});
