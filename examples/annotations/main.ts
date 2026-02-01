import { ChartGPU } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

// Type guard for the tuple form of DataPoint. We define this explicitly because `Array.isArray(...)`
// narrows to `any[]`, which does not reliably narrow `readonly [...]` tuples in strict TS configs.
const isTuplePoint = (p: DataPoint): p is readonly [x: number, y: number, size?: number] => Array.isArray(p);

type DisposableResizeObserver = Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'>;

const attachCoalescedResizeObserver = (container: HTMLElement, chart: ChartGPUInstance): DisposableResizeObserver => {
  let rafId: number | null = null;
  const ro = new ResizeObserver(() => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      chart.resize();
    });
  });
  ro.observe(container);

  return {
    observe: ro.observe.bind(ro),
    unobserve: ro.unobserve.bind(ro),
    disconnect: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      ro.disconnect();
    },
  };
};


type Extrema = Readonly<{
  maxIndex: number;
  maxY: number;
  minIndex: number;
  minY: number;
}>;

const findExtrema = (data: ReadonlyArray<DataPoint>): Extrema => {
  let maxIndex = 0;
  let minIndex = 0;
  let maxY = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;

  for (let i = 0; i < data.length; i++) {
    const p = data[i]!;
    const y = isTuplePoint(p) ? p[1] : p.y;
    if (y > maxY) {
      maxY = y;
      maxIndex = i;
    }
    if (y < minY) {
      minY = y;
      minIndex = i;
    }
  }

  return { maxIndex, maxY, minIndex, minY };
};

const createTimeSeries = (count: number): ReadonlyArray<DataPoint> => {
  const n = Math.max(2, Math.floor(count));
  const out: DataPoint[] = new Array(n);

  // Fixed epoch (ms) so the options are fully structured-cloneable (no Date instances).
  const startTs = 1704067200000; // 2024-01-01T00:00:00.000Z
  const stepMs = 60_000; // 1 minute

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = startTs + i * stepMs;

    const trend = (t - 0.5) * 1.25;
    const slow = Math.sin(i * 0.06) * 0.9;
    const hf = Math.sin(i * 0.28 + 0.7) * 0.18;
    const noise = (Math.random() - 0.5) * 0.08;
    const y = trend + slow + hf + noise;

    out[i] = [x, y] as const;
  }

  return out;
};

async function main(): Promise<void> {
  const container = document.getElementById('chart');
  if (!(container instanceof HTMLElement)) {
    throw new Error('Chart container not found');
  }

  const data = createTimeSeries(900);
  const { maxIndex, maxY, minIndex, minY } = findExtrema(data);

  const maxP = data[maxIndex]!;
  const maxX = isTuplePoint(maxP) ? maxP[0] : maxP.x;

  const minP = data[minIndex]!;
  const minX = isTuplePoint(minP) ? minP[0] : minP.x;

  const vLineIndex = Math.floor(data.length * 0.6);
  const vLinePoint = data[vLineIndex]!;
  const vLineX = isTuplePoint(vLinePoint) ? vLinePoint[0] : vLinePoint.x;

  const referenceY = Math.round((maxY * 0.35 + minY * 0.65) * 1000) / 1000;

  const options: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 44 },
    xAxis: { type: 'time', name: 'Time (ms)' },
    yAxis: { type: 'value', name: 'Value' },
    tooltip: { trigger: 'axis' },
    dataZoom: [{ type: 'inside' }],
    palette: ['#4a9eff'],
    animation: false,
    series: [
      {
        type: 'line',
        name: 'synthetic',
        data,
        color: '#4a9eff',
        lineStyle: { width: 2, opacity: 1 },
      },
    ],
    annotations: [
      // Horizontal reference line (type: 'lineY') with dashed style + template label + decimals.
      {
        id: 'ref-y',
        type: 'lineY',
        y: referenceY,
        layer: 'belowSeries',
        style: { color: '#ffd166', lineWidth: 2, lineDash: [8, 6], opacity: 0.95 },
        label: {
          template: 'ref y={y}',
          decimals: 3,
          offset: [8, -8],
          anchor: 'start',
          background: { color: '#000000', opacity: 0.55, padding: [2, 6, 2, 6], borderRadius: 6 },
        },
      },

      // Vertical reference line (type: 'lineX') with solid style + label.
      {
        id: 'ref-x',
        type: 'lineX',
        x: vLineX,
        layer: 'belowSeries',
        style: { color: '#40d17c', lineWidth: 2, opacity: 0.85 },
        label: {
          text: 'milestone',
          offset: [8, 10],
          anchor: 'start',
          background: { color: '#000000', opacity: 0.55, padding: [2, 6, 2, 6], borderRadius: 6 },
        },
      },

      // Point annotation (type: 'point') with marker styling + label background.
      {
        id: 'peak-point',
        type: 'point',
        x: maxX,
        y: maxY,
        layer: 'aboveSeries',
        marker: { symbol: 'circle', size: 8, style: { color: '#ff4ab0', opacity: 1 } },
        label: {
          template: 'peak={y}',
          decimals: 2,
          offset: [10, -10],
          anchor: 'start',
          background: { color: '#000000', opacity: 0.7, padding: [2, 6, 2, 6], borderRadius: 6 },
        },
      },

      // Text annotation in plot space (stays pinned to the plot HUD position).
      {
        id: 'hud-text',
        type: 'text',
        layer: 'aboveSeries',
        position: { space: 'plot', x: 0.04, y: 0.08 },
        text: 'plot-space text (pinned)',
        style: { color: '#e0e0e0', opacity: 0.95 },
      },

      // Optional: text annotation in data space (tracks with pan/zoom).
      {
        id: 'data-text',
        type: 'text',
        layer: 'aboveSeries',
        position: { space: 'data', x: minX, y: minY },
        text: 'data-space text (tracks)',
        style: { color: '#9b5cff', opacity: 0.95 },
      },
    ],
  };

  let chart: ChartGPUInstance | null = null;
  let ro: DisposableResizeObserver | null = null;

  const disposeChart = (): void => {
    ro?.disconnect();
    ro = null;
    chart?.dispose();
    chart = null;
  };

  // Create chart in main-thread mode
  chart = await ChartGPU.create(container, options);
  ro = attachCoalescedResizeObserver(container, chart);
  chart.resize();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    window.removeEventListener('beforeunload', cleanup);
    disposeChart();
  };

  window.addEventListener('beforeunload', cleanup);
  import.meta.hot?.dispose(cleanup);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => {
      console.error(err);
      showError(err instanceof Error ? err.message : String(err));
    });
  });
} else {
  main().catch((err) => {
    console.error(err);
    showError(err instanceof Error ? err.message : String(err));
  });
}

