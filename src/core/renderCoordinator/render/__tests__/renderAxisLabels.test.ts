import { describe, it, expect, vi } from 'vitest';
import {
  renderAxisLabels,
  renderYAxisLabels,
  type AxisLabelRenderContext,
  type YAxisLabelRenderContext,
} from '../renderAxisLabels';

/**
 * Creates a minimal mock HTMLSpanElement-like object with style and
 * getBoundingClientRect sufficient for renderAxisLabels.
 */
function createMockSpan(text: string) {
  return {
    textContent: text,
    style: {
      fontFamily: '',
      fontWeight: '',
      userSelect: '',
      pointerEvents: '',
    },
    getBoundingClientRect: () => ({
      width: 40,
      height: 14,
      top: 0,
      left: 0,
      right: 40,
      bottom: 14,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLSpanElement;
}

/**
 * Minimal mock for TextOverlay.
 * Tracks addLabel calls and returns a stub span.
 */
function createMockTextOverlay() {
  const labels: Array<{
    text: string;
    x: number;
    y: number;
    options?: { anchor?: string; rotation?: number; fontWeight?: string | number };
  }> = [];
  return {
    labels,
    overlay: {
      clear: vi.fn(),
      addLabel: vi.fn(
        (
          text: string,
          x: number,
          y: number,
          options?: { anchor?: string; rotation?: number; fontWeight?: string | number }
        ) => {
          labels.push({ text, x, y, options });
          return createMockSpan(text);
        }
      ),
    },
  };
}

function makeYCtx(
  overlay: ReturnType<typeof createMockTextOverlay>['overlay'],
  container: HTMLElement,
  context: AxisLabelRenderContext,
  yAxisConfig = context.currentOptions.yAxes[0]!
): YAxisLabelRenderContext {
  const yScale =
    (context as { yScales?: Map<string, unknown> }).yScales?.values().next().value ??
    ({
      scale: (v: number) => -1 + (v / 100) * 2,
      invert: (c: number) => ((c + 1) / 2) * 100,
      getDomain: () => ({ min: 0, max: 100 }),
    } as any);
  return {
    axisLabelOverlay: overlay as any,
    overlayContainer: container,
    yAxisConfig,
    yScale: yScale as any,
    plotClipRect: context.plotClipRect,
    canvasCssWidth: (context.gpuContext.canvas as HTMLCanvasElement).clientWidth,
    canvasCssHeight: (context.gpuContext.canvas as HTMLCanvasElement).clientHeight,
    offsetX: 0,
    offsetY: 0,
    theme: context.currentOptions.theme,
  };
}

/** Mock canvas with the properties renderAxisLabels accesses. */
function createMockCanvas() {
  return {
    clientWidth: 800,
    clientHeight: 400,
    offsetLeft: 0,
    offsetTop: 0,
  } as unknown as HTMLCanvasElement;
}

function createMinimalContext(overrides: Partial<AxisLabelRenderContext> = {}): AxisLabelRenderContext {
  return {
    gpuContext: { canvas: createMockCanvas() },
    currentOptions: {
      series: [{ type: 'line', data: [], color: '#fff', visible: true }],
      xAxis: { type: 'value' },
      yAxes: [{ id: 'primary', type: 'value' }],
      theme: {
        fontSize: 12,
        textColor: '#ffffff',
        fontFamily: 'sans-serif',
        backgroundColor: '#000',
        gridLineColor: 'rgba(255,255,255,0.1)',
        colorPalette: ['#fff'],
      },
      grid: { left: 60, right: 20, top: 40, bottom: 40 },
      dataZoom: [],
    } as any,
    xScale: {
      scale: (v: number) => -1 + (v / 100) * 2, // maps 0-100 to -1..+1
      invert: (c: number) => ((c + 1) / 2) * 100,
      getDomain: () => ({ min: 0, max: 100 }),
    } as any,
    yScales: new Map([
      [
        'primary',
        {
          scale: (v: number) => -1 + (v / 100) * 2,
          invert: (c: number) => ((c + 1) / 2) * 100,
          getDomain: () => ({ min: 0, max: 100 }),
        } as any,
      ],
    ]),
    xTickValues: [0, 25, 50, 75, 100],
    plotClipRect: { left: -0.85, right: 0.95, top: 0.8, bottom: -0.8 },
    visibleXRangeMs: 0,
    ...overrides,
  };
}

describe('renderAxisLabels', () => {
  describe('x-axis tickFormatter', () => {
    it('uses custom tickFormatter for x-axis value labels', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement; // renderAxisLabels only null-checks this
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          xAxis: {
            type: 'value' as const,
            tickFormatter: (v: number) => `$${v}`,
          },
        } as any,
      });

      renderAxisLabels(overlay as any, container, context);

      const xLabels = labels.filter((l) => l.text.startsWith('$'));
      expect(xLabels.length).toBe(5);
      expect(xLabels[0]!.text).toBe('$0');
      expect(xLabels[2]!.text).toBe('$50');
    });

    it('suppresses x-axis labels when tickFormatter returns null', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          xAxis: {
            type: 'value' as const,
            tickFormatter: (v: number) => (v === 50 ? null : `X:${v}`),
          },
        } as any,
      });

      renderAxisLabels(overlay as any, container, context);

      // Filter to only x-axis labels (prefixed with "X:")
      const xLabelTexts = labels.map((l) => l.text).filter((t) => t.startsWith('X:'));
      expect(xLabelTexts).toEqual(['X:0', 'X:25', 'X:75', 'X:100']);
    });

    it('uses custom tickFormatter for time x-axis labels', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const ts = Date.UTC(2024, 0, 15, 12, 0); // 2024-01-15T12:00Z
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          xAxis: {
            type: 'time' as const,
            tickFormatter: (ms: number) => `T:${ms}`,
          },
        } as any,
        xTickValues: [ts],
      });

      renderAxisLabels(overlay as any, container, context);

      const timeLabels = labels.filter((l) => l.text.startsWith('T:'));
      expect(timeLabels.length).toBe(1);
      expect(timeLabels[0]!.text).toBe(`T:${ts}`);
    });
  });

  describe('y-axis tickFormatter', () => {
    it('uses custom tickFormatter for y-axis labels', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          yAxes: [
            {
              id: 'primary',
              type: 'value' as const,
              tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%`,
            },
          ],
        } as any,
      });

      renderYAxisLabels(makeYCtx(overlay, container, context));

      const yLabels = labels.filter((l) => l.text.endsWith('%'));
      expect(yLabels.length).toBeGreaterThan(0);
      expect(yLabels.length).toBe(5); // DEFAULT_TICK_COUNT
    });

    it('suppresses y-axis labels when tickFormatter returns null', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          yAxes: [
            {
              id: 'primary',
              type: 'value' as const,
              tickFormatter: () => null,
            },
          ],
        } as any,
      });

      renderYAxisLabels(makeYCtx(overlay, container, context));

      // No y-axis labels should be rendered (all suppressed)
      const allLabels = labels.map((l) => l.text);
      expect(allLabels.length).toBe(0); // only Y-labels tested here
    });
  });

  describe('y-axis header (top-rail unit label)', () => {
    it('renders a non-rotated header near the top of a right Y-axis rail', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          yAxes: [{ id: 'primary', type: 'value' as const, position: 'right', header: 'USDT' }],
        } as any,
      });

      renderYAxisLabels(makeYCtx(overlay, container, context));

      const header = labels.find((l) => l.text === 'USDT');
      expect(header).toBeDefined();
      // Non-rotated: no rotation option (or 0)
      expect(header!.options?.rotation).toBeUndefined();
      expect(header!.options?.anchor).toBe('start');
      expect(header!.options?.fontWeight).toBe('600');

      // Header Y is a full fontSize + padding above plot top
      // (plot top clip 0.8 → css y = ((1-0.8)/2)*400 = 40; fontSize 12)
      const plotTopCss = ((1 - 0.8) / 2) * 400;
      const fontSize = 12;
      const labelPadding = 4;
      expect(header!.y).toBe(plotTopCss - labelPadding - fontSize);

      // X aligns with right-side tick label column (past plot right)
      const plotRightCss = ((0.95 + 1) / 2) * 800;
      expect(header!.x).toBeGreaterThan(plotRightCss);
    });

    it('renders a left-rail header with end anchor and coexists with rotated name', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          yAxes: [
            {
              id: 'primary',
              type: 'value' as const,
              position: 'left',
              header: '  USD  ',
              name: 'Price',
            },
          ],
        } as any,
      });

      renderYAxisLabels(makeYCtx(overlay, container, context));

      const header = labels.find((l) => l.text === 'USD'); // trimmed
      expect(header).toBeDefined();
      expect(header!.options?.rotation).toBeUndefined();
      expect(header!.options?.anchor).toBe('end');

      const title = labels.find((l) => l.text === 'Price');
      expect(title).toBeDefined();
      expect(title!.options?.rotation).toBe(-90);
    });

    it('skips header when empty or whitespace-only', () => {
      const { overlay, labels } = createMockTextOverlay();
      const container = {} as HTMLElement;
      const context = createMinimalContext({
        currentOptions: {
          ...createMinimalContext().currentOptions,
          yAxes: [{ id: 'primary', type: 'value' as const, header: '   ' }],
        } as any,
      });

      renderYAxisLabels(makeYCtx(overlay, container, context));

      // Only numeric tick labels (no header / title)
      expect(labels.every((l) => l.options?.rotation === undefined)).toBe(true);
      expect(labels.some((l) => l.options?.fontWeight === '600')).toBe(false);
    });
  });
});
