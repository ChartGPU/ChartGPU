import { describe, it, expect } from 'vitest';
import { formatTooltipItem, formatTooltipAxis } from '../formatTooltip';
import type { TooltipParams } from '../../config/types';

describe('formatTooltip heatmap z', () => {
  it('formatTooltipItem shows z as primary with xy centers', () => {
    const params: TooltipParams = {
      seriesName: 'Power',
      seriesIndex: 0,
      dataIndex: 5,
      value: [1.5, 2.5],
      color: '#f00',
      z: -42.5,
    };
    const html = formatTooltipItem(params);
    expect(html).toContain('Power');
    expect(html).toMatch(/-42\.5|-42\.50/);
    expect(html).toContain('x=');
    expect(html).toContain('y=');
  });

  it('formatTooltipAxis shows z for heatmap rows mixed with line', () => {
    const params: TooltipParams[] = [
      {
        seriesName: 'Line',
        seriesIndex: 0,
        dataIndex: 1,
        value: [10, 3],
        color: '#0af',
      },
      {
        seriesName: 'Heat',
        seriesIndex: 1,
        dataIndex: 7,
        value: [10.5, 4.5],
        color: '#f80',
        z: 12,
      },
    ];
    const html = formatTooltipAxis(params);
    expect(html).toContain('Line');
    expect(html).toContain('Heat');
    expect(html).toMatch(/\b12\b/);
    expect(html).toContain('x=');
  });
});
