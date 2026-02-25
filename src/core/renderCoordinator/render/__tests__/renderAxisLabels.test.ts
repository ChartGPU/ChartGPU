import { describe, it, expect, vi } from 'vitest';
import { renderAxisLabels, type AxisLabelRenderContext } from '../renderAxisLabels';

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
    getBoundingClientRect: () => ({ width: 40, height: 14, top: 0, left: 0, right: 40, bottom: 14, x: 0, y: 0, toJSON: () => ({}) }),
  } as unknown as HTMLSpanElement;
}

/**
 * Minimal mock for TextOverlay.
 * Tracks addLabel calls and returns a stub span.
 */
function createMockTextOverlay() {
  const labels: Array<{ text: string; x: number; y: number }> = [];
  return {
    labels,
    overlay: {
      clear: vi.fn(),
      addLabel: vi.fn((text: string, x: number, y: number) => {
        labels.push({ text, x, y });
        return createMockSpan(text);
      }),
    },
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
      yAxis: { type: 'value' },
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
    } as any,
    yScale: {
      scale: (v: number) => -1 + (v / 100) * 2,
      invert: (c: number) => ((c + 1) / 2) * 100,
    } as any,
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
          yAxis: {
            type: 'value' as const,
            tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%`,
          },
        } as any,
      });

      renderAxisLabels(overlay as any, container, context);

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
          yAxis: {
            type: 'value' as const,
            tickFormatter: () => null,
          },
        } as any,
      });

      renderAxisLabels(overlay as any, container, context);

      // No y-axis labels should be rendered (all suppressed)
      // x-axis labels still render (5 ticks), plus no y-axis labels
      const allLabels = labels.map((l) => l.text);
      // Y-labels would normally be 5 ticks of values 0-100 range
      // With null formatter, none should appear
      // Only x-axis labels should be present
      expect(allLabels.length).toBe(5); // only x-axis labels
    });
  });
});
