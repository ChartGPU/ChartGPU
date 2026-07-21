// @vitest-environment jsdom
/**
 * Legend identity skip (group 1 axes-only multi-series).
 * When the series array reference is unchanged, update must not rebuild DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLegend } from '../createLegend';
import { resolveOptions } from '../../config/OptionResolver';
import type { SeriesConfig } from '../../config/types';
import type { ThemeConfig } from '../../themes/types';
import type { DataPoint } from '../../config/types';

const theme: ThemeConfig = {
  backgroundColor: '#fff',
  textColor: '#111',
  axisLineColor: '#ccc',
  axisTickColor: '#bbb',
  gridLineColor: '#eee',
  fontFamily: 'sans-serif',
  fontSize: 12,
  colorPalette: ['#f00', '#0f0', '#00f'],
};

function lineSeries(n: number): SeriesConfig[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'line' as const,
    name: `S${i}`,
    data: [
      [0, 0],
      [1, 1],
    ],
    color: `#${(i % 256).toString(16).padStart(2, '0')}0000`,
  }));
}

function getRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function getList(container: HTMLElement): HTMLElement {
  return getRoot(container).firstElementChild as HTMLElement;
}

describe('createLegend identity skip', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('rebuilds DOM on first update', () => {
    const legend = createLegend(container);
    const series = lineSeries(3);
    legend.update(series, theme);
    expect(getList(container).children.length).toBe(3);
    legend.dispose();
  });

  it('uses itemStyle.upColor for ohlc/candlestick swatch when series.color is unset', () => {
    const legend = createLegend(container);
    const series: SeriesConfig[] = [
      {
        type: 'ohlc',
        name: 'OHLC',
        data: [[0, 1, 2, 0.5, 2.5]],
        itemStyle: { upColor: '#26a69a', downColor: '#ef5350' },
      },
    ];
    legend.update(series, theme);
    const item = getList(container).children[0] as HTMLElement;
    // First child is the swatch <div> (label is a <span>)
    const swatch = item.children[0] as HTMLElement;
    // jsdom may keep the raw hex on style.background
    const bg = swatch.style.background || swatch.style.backgroundColor;
    expect(bg.toLowerCase()).toMatch(/#26a69a|rgb\(38,\s*166,\s*154\)/);
    legend.dispose();
  });

  it('sets z-index above axis text overlay so legend masks labels (issue #149)', () => {
    const legend = createLegend(container);
    legend.update(lineSeries(2), theme);
    // createTextOverlay uses z-index 10; legend must paint above it.
    expect(Number(getRoot(container).style.zIndex)).toBeGreaterThan(10);
    expect(getRoot(container).style.zIndex).toBe('15');
    legend.dispose();
  });

  it('skips replaceChildren when series + theme identity are stable (axes-only)', () => {
    const legend = createLegend(container);
    const series = lineSeries(50);
    legend.update(series, theme);
    const list = getList(container);
    const firstChild = list.children[0];
    // Same series + same theme ref
    legend.update(series, theme);
    expect(list.children[0]).toBe(firstChild);
    expect(list.children.length).toBe(50);
    legend.dispose();
  });

  it('updates root theme chrome even when list DOM is preserved (same theme styles reapplied)', () => {
    const legend = createLegend(container);
    const series = lineSeries(3);
    legend.update(series, theme);
    const root = getRoot(container);
    expect(root.style.color).toBe('rgb(17, 17, 17)'); // #111
    // Same series + same theme: still re-applies root styles (no-op values).
    legend.update(series, theme);
    expect(root.style.color).toBe('rgb(17, 17, 17)');
    legend.dispose();
  });

  it('rebuilds list when theme identity changes (per-item swatch borders)', () => {
    const legend = createLegend(container);
    const series = lineSeries(2);
    legend.update(series, theme);
    const list = getList(container);
    const firstChild = list.children[0];
    const theme2: ThemeConfig = { ...theme, textColor: '#222', axisLineColor: '#999' };
    legend.update(series, theme2);
    // Theme ref changed → rebuild so item borders pick up new axisLineColor.
    expect(list.children[0]).not.toBe(firstChild);
    expect(getRoot(container).style.color).toBe('rgb(34, 34, 34)'); // #222
    legend.dispose();
  });

  it('rebuilds when series array identity changes', () => {
    const legend = createLegend(container);
    const a = lineSeries(2);
    const b = lineSeries(2);
    legend.update(a, theme);
    const list = getList(container);
    const firstChild = list.children[0];
    legend.update(b, theme);
    expect(list.children[0]).not.toBe(firstChild);
    expect(list.children.length).toBe(2);
    legend.dispose();
  });

  it('rebuilds when series length changes under same array identity is impossible; new array shorter rebuilds', () => {
    const legend = createLegend(container);
    const a = lineSeries(5);
    legend.update(a, theme);
    expect(getList(container).children.length).toBe(5);
    const b = lineSeries(2);
    legend.update(b, theme);
    expect(getList(container).children.length).toBe(2);
    legend.dispose();
  });

  it('axes-only resolveOptions path: stable series elements + theme reuse → second update does not rebuild list', () => {
    // Production path: resolveOptions always allocated a fresh theme object every
    // frame until theme-identity reuse. Legend skip requires theme ===; without
    // reuse, N DOM nodes rebuild every axes-only setOption when legend is shown.
    const data: DataPoint[] = [
      [0, 0],
      [1, 1],
    ];
    const userSeries = Array.from({ length: 8 }, (_, i) => ({
      type: 'line' as const,
      name: `S${i}`,
      data,
      sampling: 'none' as const,
      color: `#${(i * 10).toString(16).padStart(2, '0')}0000`,
    }));
    const firstUser = {
      series: userSeries,
      theme: 'dark' as const,
      yAxis: { min: -10, max: 10 },
    };
    const first = resolveOptions(firstUser);
    const second = resolveOptions(
      {
        series: userSeries,
        theme: 'dark' as const,
        yAxis: { min: -20, max: 20 },
      },
      {
        previousResolved: first,
        previousUserOptions: firstUser,
        lastUserSeriesElements: userSeries.slice(),
      }
    );
    // Resolved series + theme identities must be stable (production axes-only).
    expect(second.series).toBe(first.series);
    expect(second.theme).toBe(first.theme);

    const legend = createLegend(container);
    legend.update(first.series as unknown as SeriesConfig[], first.theme);
    const list = getList(container);
    const firstChild = list.children[0];
    expect(list.children.length).toBe(8);

    // Same resolved series/theme refs as coordinator would pass after axes-only setOption.
    legend.update(second.series as unknown as SeriesConfig[], second.theme);
    expect(list.children[0]).toBe(firstChild);
    expect(list.children.length).toBe(8);
    legend.dispose();
  });
});
