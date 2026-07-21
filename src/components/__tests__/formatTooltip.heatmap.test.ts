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
    // Trusted secondary span must be real HTML, not escaped entities.
    expect(html).toContain('<span style="opacity:0.7">');
    expect(html).not.toContain('&lt;span');
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
    expect(html).toContain('<span style="opacity:0.7">');
    expect(html).not.toContain('&lt;span');
  });
});

describe('formatTooltip errorBar high/low', () => {
  it('formatTooltipItem shows center with muted high/low span (real HTML)', () => {
    const params: TooltipParams = {
      seriesName: 'Assay ±SEM',
      seriesIndex: 0,
      dataIndex: 1,
      value: [2, 5.45],
      color: '#38bdf8',
      high: 5.74,
      low: 5.16,
    };
    const html = formatTooltipItem(params);
    expect(html).toContain('Assay');
    expect(html).toContain('5.45');
    expect(html).toContain('5.74');
    expect(html).toContain('5.16');
    expect(html).toContain('<span style="opacity:0.7">');
    expect(html).not.toContain('&lt;span');
  });

  it('formatTooltipAxis includes errorBar high/low muted span', () => {
    const params: TooltipParams[] = [
      {
        seriesName: 'EB',
        seriesIndex: 0,
        dataIndex: 0,
        value: [0, 10],
        color: '#fff',
        high: 12,
        low: 8,
      },
    ];
    const html = formatTooltipAxis(params);
    expect(html).toContain('EB');
    expect(html).toContain('10');
    expect(html).toContain('<span style="opacity:0.7">');
    expect(html).not.toContain('&lt;span');
  });
});

describe('formatTooltip band y1', () => {
  it('formatTooltipItem shows ordered y … y1 range for crossing band', () => {
    const params: TooltipParams = {
      seriesName: 'CI',
      seriesIndex: 0,
      dataIndex: 2,
      value: [1, 5],
      color: '#38bdf8',
      y1: 2,
    };
    const html = formatTooltipItem(params);
    expect(html).toContain('CI');
    // Crossing: y=5 > y1=2 → display 2 … 5
    expect(html).toContain('2');
    expect(html).toContain('5');
    expect(html).toMatch(/2\s*…\s*5|2\s*\.\.\.\s*5/);
  });

  it('formatTooltipAxis includes band range row', () => {
    const params: TooltipParams[] = [
      {
        seriesName: 'Band',
        seriesIndex: 0,
        dataIndex: 0,
        value: [0, 1],
        color: '#a78bfa',
        y1: 3,
      },
    ];
    const html = formatTooltipAxis(params);
    expect(html).toContain('Band');
    expect(html).toMatch(/1\s*…\s*3|1\s*\.\.\.\s*3/);
  });
});

describe('formatTooltip impulse baseline', () => {
  it('formatTooltipItem shows y with muted baseline secondary', () => {
    const params = {
      seriesName: 'Events',
      seriesIndex: 0,
      dataIndex: 1,
      value: [2, 4] as const,
      color: '#a78bfa',
      baseline: 0,
    };
    const html = formatTooltipItem(params);
    expect(html).toContain('4');
    expect(html).toMatch(/base/i);
    expect(html).toContain('0');
  });

  it('formatTooltipAxis includes baseline muted span', () => {
    const html = formatTooltipAxis([
      {
        seriesName: 'Events',
        seriesIndex: 0,
        dataIndex: 0,
        value: [1, 3] as const,
        color: '#a78bfa',
        baseline: -1,
      },
    ]);
    expect(html).toContain('3');
    expect(html).toMatch(/base/i);
    expect(html).toContain('-1');
  });
});

describe('formatTooltip stacked mountain stackTotal', () => {
  it('formatTooltipItem shows contribution with muted total', () => {
    const params = {
      seriesName: 'Paid',
      seriesIndex: 1,
      dataIndex: 0,
      value: [1, 2] as const,
      color: '#a78bfa',
      stack: 'traffic',
      stackTotal: 6,
    };
    const html = formatTooltipItem(params);
    expect(html).toContain('Paid');
    expect(html).toContain('2');
    expect(html).toContain('total 6');
    expect(html).toMatch(/opacity:\s*0\.7/);
  });

  it('formatTooltipAxis includes stackTotal muted span', () => {
    const params = [
      {
        seriesName: 'Organic',
        seriesIndex: 0,
        dataIndex: 0,
        value: [1, 1] as const,
        color: '#38bdf8',
        stack: 'traffic',
        stackTotal: 6,
      },
    ];
    const html = formatTooltipAxis(params);
    expect(html).toContain('Organic');
    expect(html).toContain('total 6');
  });
});
