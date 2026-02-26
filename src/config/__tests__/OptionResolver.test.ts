import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../OptionResolver';

describe('OptionResolver - connectNulls', () => {
  it('defaults connectNulls to false for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('line');
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]], connectNulls: true }],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(true);
    }
  });

  it('defaults connectNulls to false for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('area');
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]], connectNulls: true }],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(true);
    }
  });
});
