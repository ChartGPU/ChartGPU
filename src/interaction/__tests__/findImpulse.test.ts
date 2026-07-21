/**
 * Unit tests for findImpulseAtPointer — hard expects (no soft if(match)).
 */
import { describe, it, expect } from 'vitest';
import { findImpulseAtPointer } from '../findImpulse';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedImpulseSeriesConfig } from '../../config/OptionResolver';

function impulseSeries(
  data: { x: number[]; y: number[] },
  overrides?: Partial<ResolvedImpulseSeriesConfig>
): ResolvedImpulseSeriesConfig {
  return {
    type: 'impulse',
    name: 'events',
    visible: true,
    color: '#a78bfa',
    baseline: 0,
    lineStyle: { width: 2, opacity: 1, color: '#a78bfa' },
    showMarker: true,
    symbolSize: 6,
    sampling: 'none',
    samplingThreshold: 5000,
    rawData: data,
    data,
    yAxis: 'y',
    ...overrides,
  } as ResolvedImpulseSeriesConfig;
}

describe('findImpulseAtPointer', () => {
  const plot = { width: 400, height: 300 };
  // domain x 0..4 → css 0..400; domain y -2..6 → css 300..0 (inverted)
  const xScale = createLinearScale().domain(0, 4).range(0, 400);
  const yScale = createLinearScale().domain(-2, 6).range(300, 0);

  it('hits stem body at mid height', () => {
    const data = { x: [1, 2, 3], y: [4, 2, 5] };
    const series = impulseSeries(data);
    // x=2 → css 200; y=1 mid of stem 0→2 → css yScale.scale(1)
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(2),
      yScale.scale(1),
      xScale,
      yScale,
      plot
    );
    expect(hit).not.toBeNull();
    expect(hit!.seriesIndex).toBe(0);
    expect(hit!.dataIndex).toBe(1);
    expect(hit!.x).toBe(2);
    expect(hit!.y).toBe(2);
    expect(hit!.baseline).toBe(0);
  });

  it('hits marker at tip', () => {
    const data = { x: [1], y: [4] };
    const series = impulseSeries(data, { showMarker: true, symbolSize: 10 });
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(1),
      yScale.scale(4),
      xScale,
      yScale,
      plot
    );
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
    expect(hit!.y).toBe(4);
  });

  it('misses outside pad', () => {
    const data = { x: [1], y: [4] };
    const series = impulseSeries(data, { showMarker: false, lineStyle: { width: 1, opacity: 1, color: '#a' } });
    // Far from stem in x
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(3.5),
      yScale.scale(2),
      xScale,
      yScale,
      plot,
      { padCssPx: 1 }
    );
    expect(hit).toBeNull();
  });

  it('skips non-finite samples', () => {
    const data = {
      x: [1, Number.NaN, 3],
      y: [2, 5, Number.NaN],
    };
    const series = impulseSeries(data);
    // Only index 0 is drawable
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(1),
      yScale.scale(1),
      xScale,
      yScale,
      plot
    );
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
  });

  it('zero-length + showMarker false: miss even at exact tip (hard contract)', () => {
    const data = { x: [2], y: [0] }; // y === baseline → degenerate stem
    const series = impulseSeries(data, {
      showMarker: false,
      baseline: 0,
      lineStyle: { width: 2, opacity: 1, color: '#a78bfa' },
    });
    // Exact tip: no body, no marker → null (pad does not invent a hit).
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(2),
      yScale.scale(0),
      xScale,
      yScale,
      plot,
      { padCssPx: 0 }
    );
    expect(hit).toBeNull();
  });

  it('zero-length + showMarker true: hits marker', () => {
    const data = { x: [2], y: [0] };
    const series = impulseSeries(data, { showMarker: true, baseline: 0, symbolSize: 12 });
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(2),
      yScale.scale(0),
      xScale,
      yScale,
      plot
    );
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
    expect(hit!.y).toBe(0);
  });

  it('prefers later series when overlapping', () => {
    const data = { x: [2], y: [4] };
    const s0 = impulseSeries(data, { name: 'a' });
    const s1 = impulseSeries(data, { name: 'b' });
    const hit = findImpulseAtPointer(
      [
        { seriesIndex: 0, series: s0 },
        { seriesIndex: 1, series: s1 },
      ],
      xScale.scale(2),
      yScale.scale(2),
      xScale,
      yScale,
      plot
    );
    expect(hit).not.toBeNull();
    expect(hit!.seriesIndex).toBe(1);
  });

  it('skips invisible series', () => {
    const data = { x: [1], y: [3] };
    const series = impulseSeries(data, { visible: false });
    const hit = findImpulseAtPointer(
      [{ seriesIndex: 0, series }],
      xScale.scale(1),
      yScale.scale(1.5),
      xScale,
      yScale,
      plot
    );
    expect(hit).toBeNull();
  });
});
