/**
 * syncPriceLabelFrame — ownership, coordinates, OOD clamp/hide, hide paths.
 * Multi-layer: UI receives consistent visible/hide transitions; no price line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncPriceLabelFrame } from '../syncPriceLabelFrame';
import type { PriceLabel, PriceLabelUpdateState } from '../../../../components/createPriceLabel';
import type { ContinuousScale } from '../../../../utils/scales';
import type { ResolvedCandlestickSeriesConfig, ResolvedSeriesConfig } from '../../../../config/OptionResolver';
import type { AxisConfig, OHLCDataPoint } from '../../../../config/types';
import type { ResolvedCandlestickPriceLabel } from '../../../../config/resolvePriceLabel';
import { clipXToCanvasCssPx, clipYToCanvasCssPx } from '../../utils/axisUtils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePriceLabel(): PriceLabel & { updates: PriceLabelUpdateState[] } {
  const updates: PriceLabelUpdateState[] = [];
  return {
    updates,
    update(state) {
      updates.push({ ...state });
    },
    setCountdown: vi.fn(),
    dispose: vi.fn(),
  };
}

/** Linear scale domain→clip range (matches coordinator: range(plotBottom, plotTop)). */
function makeYScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): ContinuousScale {
  let d0 = domainMin;
  let d1 = domainMax;
  let r0 = rangeMin;
  let r1 = rangeMax;
  return {
    kind: 'linear',
    domain(min, max) {
      d0 = min;
      d1 = max;
      return this;
    },
    range(min, max) {
      r0 = min;
      r1 = max;
      return this;
    },
    scale(value: number) {
      if (d1 === d0) return (r0 + r1) / 2;
      const t = (value - d0) / (d1 - d0);
      return r0 + t * (r1 - r0);
    },
    invert(pixel: number) {
      if (r1 === r0) return d0;
      const t = (pixel - r0) / (r1 - r0);
      return d0 + t * (d1 - d0);
    },
    getDomain: () => ({ min: d0, max: d1 }),
    getRange: () => ({ min: r0, max: r1 }),
  };
}

const defaultResolvedPriceLabel = (
  overrides: Partial<ResolvedCandlestickPriceLabel> = {}
): ResolvedCandlestickPriceLabel => ({
  show: true,
  showLine: true,
  intervalMs: null,
  showCountdown: false,
  nowMs: null,
  formatter: null,
  outOfDomain: 'clamp',
  color: null,
  lineColor: null,
  lineWidth: 1,
  ...overrides,
});

function makeCandleSeries(
  overrides: Partial<ResolvedCandlestickSeriesConfig> & {
    priceLabel?: ResolvedCandlestickPriceLabel;
  } = {}
): ResolvedCandlestickSeriesConfig {
  const { priceLabel, ...rest } = overrides;
  return {
    type: 'candlestick',
    name: 'BTC',
    data: [],
    rawData: [],
    color: '#22c55e',
    style: 'classic',
    itemStyle: {
      upColor: '#22c55e',
      downColor: '#ef4444',
      upBorderColor: '#22c55e',
      downBorderColor: '#ef4444',
      borderWidth: 1,
    },
    barWidth: '80%',
    barMinWidth: 1,
    barMaxWidth: 50,
    sampling: 'ohlc',
    samplingThreshold: 5000,
    yAxis: 'y',
    visible: true,
    priceLabel: priceLabel ?? defaultResolvedPriceLabel(),
    ...rest,
  } as ResolvedCandlestickSeriesConfig;
}

/** Plot fills full canvas in clip space for simple math. */
const FULL_PLOT = { left: -1, right: 1, top: 1, bottom: -1 } as const;
const CANVAS_W = 400;
const CANVAS_H = 300;

/** Loose args bag for tests (mirrors SyncPriceLabelFrameArgs without exporting it). */
type TestSyncArgs = {
  priceLabelUi: PriceLabel | null;
  series: ReadonlyArray<ResolvedSeriesConfig>;
  runtimeRawDataByIndex: ReadonlyArray<unknown>;
  yScales: ReadonlyMap<string, ContinuousScale>;
  yAxes: ReadonlyArray<AxisConfig>;
  plotClipRect: { left: number; right: number; top: number; bottom: number };
  canvasCssWidth: number;
  canvasCssHeight: number;
  offsetX: number;
  offsetY: number;
  onWarn?: (message: string) => void;
};

function baseArgs(ui: PriceLabel | null, partial: Partial<TestSyncArgs> = {}): TestSyncArgs {
  const series = partial.series ?? [makeCandleSeries()];
  const yScale = makeYScale(0, 100, FULL_PLOT.bottom, FULL_PLOT.top);
  return {
    priceLabelUi: ui,
    series: series as ReadonlyArray<ResolvedSeriesConfig>,
    runtimeRawDataByIndex: partial.runtimeRawDataByIndex ?? [[[1_000, 90, 95, 88, 96] as OHLCDataPoint]],
    yScales: partial.yScales ?? new Map([['y', yScale]]),
    yAxes: partial.yAxes ?? ([{ id: 'y', position: 'right' }] as AxisConfig[]),
    plotClipRect: partial.plotClipRect ?? FULL_PLOT,
    canvasCssWidth: partial.canvasCssWidth ?? CANVAS_W,
    canvasCssHeight: partial.canvasCssHeight ?? CANVAS_H,
    offsetX: partial.offsetX ?? 0,
    offsetY: partial.offsetY ?? 0,
    onWarn: partial.onWarn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncPriceLabelFrame', () => {
  let ui: ReturnType<typeof makePriceLabel>;

  beforeEach(() => {
    ui = makePriceLabel();
  });

  it('no-ops when priceLabelUi is null', () => {
    expect(() => syncPriceLabelFrame(baseArgs(null))).not.toThrow();
  });

  it('hides when no series owns the badge', () => {
    const line = { type: 'line', data: [], yAxis: 'y', color: '#fff' } as unknown as ResolvedSeriesConfig;
    syncPriceLabelFrame(baseArgs(ui, { series: [line] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when priceLabel.show is false', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        series: [makeCandleSeries({ priceLabel: defaultResolvedPriceLabel({ show: false }) })],
      })
    );
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when raw OHLC is empty', () => {
    syncPriceLabelFrame(baseArgs(ui, { runtimeRawDataByIndex: [[]] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when raw slot is null/missing', () => {
    syncPriceLabelFrame(baseArgs(ui, { runtimeRawDataByIndex: [null] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
    syncPriceLabelFrame(baseArgs(ui, { runtimeRawDataByIndex: [] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when open/close non-finite', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        runtimeRawDataByIndex: [[[1, NaN, 10, 0, 12] as OHLCDataPoint]],
      })
    );
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when yScale for series axis is missing', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        series: [makeCandleSeries({ yAxis: 'price' })],
        yScales: new Map([['y', makeYScale(0, 100, -1, 1)]]),
      })
    );
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('hides when canvas CSS size is zero', () => {
    syncPriceLabelFrame(baseArgs(ui, { canvasCssWidth: 0, canvasCssHeight: CANVAS_H }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
    ui.updates.length = 0;
    syncPriceLabelFrame(baseArgs(ui, { canvasCssWidth: CANVAS_W, canvasCssHeight: 0 }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('shows price-only badge at last close with direction color (up)', () => {
    // close 95 in domain 0..100 → near top of plot
    syncPriceLabelFrame(
      baseArgs(ui, {
        runtimeRawDataByIndex: [[[1_000, 90, 95, 88, 96] as OHLCDataPoint]],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.background).toBe('#22c55e');
    expect(last.color).toBe('#ffffff');
    expect(last.countdownText).toBe(null);
    expect(last.side).toBe('right');
    expect(last.priceText).toMatch(/95/);
    expect(last.opacity ?? 1).toBe(1);

    // Y: domain 95/100 → clip from -1..1 range: -1 + 0.95*2 = 0.9
    const yClip = makeYScale(0, 100, -1, 1).scale(95);
    const expectedY = clipYToCanvasCssPx(yClip, CANVAS_H);
    expect(last.y).toBeCloseTo(expectedY, 5);

    // X: right of plot + tick(6) + gap(2)
    const plotRight = clipXToCanvasCssPx(1, CANVAS_W);
    expect(last.x).toBeCloseTo(plotRight + 6 + 2, 5);
  });

  it('uses down color when close < open', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        runtimeRawDataByIndex: [[[1_000, 100, 90, 88, 101] as OHLCDataPoint]],
      })
    );
    expect(ui.updates.at(-1)?.background).toBe('#ef4444');
  });

  it('uses last raw candle index only (not sampled earlier bars)', () => {
    const raw: OHLCDataPoint[] = [
      [1_000, 10, 11, 9, 12],
      [2_000, 11, 20, 10, 21], // last close 20 → up
    ];
    syncPriceLabelFrame(baseArgs(ui, { runtimeRawDataByIndex: [raw] }));
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.priceText).toMatch(/20/);
    expect(last.background).toBe('#22c55e');
  });

  it('applies custom formatter and text color', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        series: [
          makeCandleSeries({
            priceLabel: defaultResolvedPriceLabel({
              formatter: (c) => `$${c.toFixed(0)}`,
              color: '#000000',
            }),
          }),
        ],
        runtimeRawDataByIndex: [[[1, 1, 42, 0, 50] as OHLCDataPoint]],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.priceText).toBe('$42');
    expect(last.color).toBe('#000000');
  });

  it('left-positioned axis anchors badge on the left (right edge at x)', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        yAxes: [{ id: 'y', position: 'left' }] as AxisConfig[],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.side).toBe('left');
    const plotLeft = clipXToCanvasCssPx(-1, CANVAS_W);
    expect(last.x).toBeCloseTo(plotLeft - 6 - 2, 5);
  });

  it('adds canvas offsetLeft/Top for container-local coords', () => {
    syncPriceLabelFrame(baseArgs(ui, { offsetX: 12, offsetY: 34 }));
    const last = ui.updates.at(-1)!;
    const noOffset = makePriceLabel();
    syncPriceLabelFrame(baseArgs(noOffset, { offsetX: 0, offsetY: 0 }));
    const base = noOffset.updates.at(-1)!;
    expect(last.x).toBeCloseTo(base.x + 12, 5);
    expect(last.y).toBeCloseTo(base.y + 34, 5);
  });

  it('OOD clamp: pins to plot edge and dims opacity', () => {
    // Domain 0..100; close 150 is above hi
    const yScale = makeYScale(0, 100, -1, 1);
    syncPriceLabelFrame(
      baseArgs(ui, {
        yScales: new Map([['y', yScale]]),
        runtimeRawDataByIndex: [[[1, 90, 150, 88, 160] as OHLCDataPoint]],
        series: [
          makeCandleSeries({
            priceLabel: defaultResolvedPriceLabel({ outOfDomain: 'clamp' }),
          }),
        ],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.opacity).toBe(0.85);
    const plotTop = clipYToCanvasCssPx(1, CANVAS_H);
    const plotBottom = clipYToCanvasCssPx(-1, CANVAS_H);
    const edgeLo = Math.min(plotTop, plotBottom);
    const edgeHi = Math.max(plotTop, plotBottom);
    expect(last.y).toBeGreaterThanOrEqual(edgeLo - 1e-6);
    expect(last.y).toBeLessThanOrEqual(edgeHi + 1e-6);
  });

  it('OOD hide: hides badge when close outside domain', () => {
    const yScale = makeYScale(0, 100, -1, 1);
    syncPriceLabelFrame(
      baseArgs(ui, {
        yScales: new Map([['y', yScale]]),
        runtimeRawDataByIndex: [[[1, 90, 150, 88, 160] as OHLCDataPoint]],
        series: [
          makeCandleSeries({
            priceLabel: defaultResolvedPriceLabel({ outOfDomain: 'hide' }),
          }),
        ],
      })
    );
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('skips visible:false series and picks next owner', () => {
    const series = [
      makeCandleSeries({
        visible: false,
        priceLabel: defaultResolvedPriceLabel({ show: true }),
      }),
      makeCandleSeries({
        name: 'ETH',
        yAxis: 'y',
        itemStyle: {
          upColor: '#00ff00',
          downColor: '#ff0000',
          upBorderColor: '#00ff00',
          downBorderColor: '#ff0000',
          borderWidth: 1,
        },
        priceLabel: defaultResolvedPriceLabel({ show: true }),
      }),
    ];
    const raw0: OHLCDataPoint[] = [[1, 1, 2, 0, 3]];
    const raw1: OHLCDataPoint[] = [[1, 50, 55, 49, 56]];
    syncPriceLabelFrame(
      baseArgs(ui, {
        series,
        runtimeRawDataByIndex: [raw0, raw1],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.background).toBe('#00ff00');
    expect(last.priceText).toMatch(/55/);
  });

  it('multi-series ownership: first wins + warn; ignores later show:true', () => {
    const onWarn = vi.fn();
    const series = [
      makeCandleSeries({
        name: 'A',
        priceLabel: defaultResolvedPriceLabel({ show: true }),
      }),
      makeCandleSeries({
        name: 'B',
        priceLabel: defaultResolvedPriceLabel({ show: true }),
      }),
    ];
    const rawA: OHLCDataPoint[] = [[1, 10, 12, 9, 13]];
    const rawB: OHLCDataPoint[] = [[1, 100, 200, 90, 210]];
    syncPriceLabelFrame(
      baseArgs(ui, {
        series,
        runtimeRawDataByIndex: [rawA, rawB],
        onWarn,
      })
    );
    expect(onWarn).toHaveBeenCalledTimes(1);
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.priceText).toMatch(/12/);
    expect(last.background).toBe('#22c55e');
  });

  it('hide path after show: consecutive frames stay consistent', () => {
    // Frame 1: show
    syncPriceLabelFrame(baseArgs(ui));
    expect(ui.updates.at(-1)?.visible).toBe(true);

    // Frame 2: series type switch → hide
    const line = { type: 'line', data: [], yAxis: 'y', color: '#fff' } as unknown as ResolvedSeriesConfig;
    syncPriceLabelFrame(baseArgs(ui, { series: [line] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);

    // Frame 3: still hidden
    syncPriceLabelFrame(baseArgs(ui, { series: [line] }));
    expect(ui.updates.at(-1)?.visible).toBe(false);
  });

  it('does not call setCountdown (PR5 owns timer)', () => {
    syncPriceLabelFrame(baseArgs(ui));
    expect(ui.setCountdown).not.toHaveBeenCalled();
  });

  it('frame-syncs countdown text when showCountdown + intervalMs (no timer)', () => {
    const nowMs = () => 10_000 + 30_000; // 30s into a 60s bar
    syncPriceLabelFrame(
      baseArgs(ui, {
        series: [
          makeCandleSeries({
            priceLabel: defaultResolvedPriceLabel({
              showCountdown: true,
              intervalMs: 60_000,
              nowMs,
            }),
          }),
        ],
        runtimeRawDataByIndex: [[[10_000, 1, 2, 0.5, 2.5] as OHLCDataPoint]],
      })
    );
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    // barEnd = 10000+60000=70000; now = 40000; remaining = 30000 → 00:00:30
    expect(last.countdownText).toBe('00:00:30');
    expect(ui.setCountdown).not.toHaveBeenCalled();
  });

  it('countdown null when showCountdown false even with interval', () => {
    syncPriceLabelFrame(
      baseArgs(ui, {
        series: [
          makeCandleSeries({
            priceLabel: defaultResolvedPriceLabel({
              showCountdown: false,
              intervalMs: 60_000,
            }),
          }),
        ],
        runtimeRawDataByIndex: [[[10_000, 1, 2, 0.5, 2.5] as OHLCDataPoint]],
      })
    );
    expect(ui.updates.at(-1)?.countdownText).toBe(null);
  });

  it('uses object OHLC last close', () => {
    const raw: OHLCDataPoint[] = [{ timestamp: 5_000, open: 100, close: 105.5, low: 99, high: 106 }];
    syncPriceLabelFrame(baseArgs(ui, { runtimeRawDataByIndex: [raw] }));
    const last = ui.updates.at(-1)!;
    expect(last.visible).toBe(true);
    expect(last.background).toBe('#22c55e');
    expect(last.priceText).toMatch(/105/);
  });
});
