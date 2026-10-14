import { ChartGPU } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const setText = (id: string, text: string): void => {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
};

const formatInt = (n: number): string => new Intl.NumberFormat(undefined).format(Math.max(0, Math.floor(n)));

const formatZoom = (z: { start: number; end: number } | null): string => {
  if (!z) return '—';
  return `${z.start.toFixed(1)}% → ${z.end.toFixed(1)}%`;
};

type StreamConfig = Readonly<{
  pointsPerTick: number;
  tickMs: number;
  maxPoints: number;
}>;

const DEFAULT_STREAM: StreamConfig = {
  pointsPerTick: 12,
  tickMs: 60,
  maxPoints: 25_000,
};

const createBaseOptions = (data: ReadonlyArray<DataPoint>, autoScroll: boolean): ChartGPUOptions => ({
  // Note: when `dataZoom` includes `{ type: 'slider' }`, ChartGPU reserves additional bottom
  // space internally for the slider UI, so this value only needs to cover axis labels/title.
  grid: { left: 70, right: 24, top: 24, bottom: 44 },
  xAxis: { type: 'value', name: 't' },
  yAxis: { type: 'value', name: 'value' },
  tooltip: { trigger: 'item' },
  autoScroll,
  dataZoom: [{ type: 'inside' }, { type: 'slider', start: 70, end: 100 }],
  palette: ['#4a9eff'],
  animation: false,
  series: [
    {
      type: 'line',
      name: 'stream',
      data,
      color: '#4a9eff',
      lineStyle: { width: 2, opacity: 1 },
      // For streaming performance: sampling='none' enables incremental GPU append (fast-path).
      // With sampling enabled (e.g., 'lttb'), the entire buffer is re-uploaded every frame,
      // causing ~1000x more GPU bandwidth usage. See docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md
      sampling: 'none',
    },
  ],
});

const attachCoalescedResizeObserver = (container: HTMLElement, chart: ChartGPUInstance): ResizeObserver => {
  let rafId: number | null = null;
  const ro = new ResizeObserver(() => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      chart.resize();
    });
  });
  ro.observe(container);
  return ro;
};

const createSeedData = (count: number): DataPoint[] => {
  const n = Math.max(2, Math.floor(count));
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * 0.02;
    const y = Math.sin(x) * 0.8 + Math.sin(x * 0.23 + 1.2) * 0.25;
    out[i] = [x, y] as const;
  }
  return out;
};

async function main(): Promise<void> {
  const container = document.getElementById('chart');
  const autoScrollEl = document.getElementById('autoScroll');
  const resetEl = document.getElementById('reset');

  if (!(container instanceof HTMLElement)) throw new Error('Chart container not found');
  if (!(autoScrollEl instanceof HTMLInputElement)) throw new Error('autoScroll control not found');
  if (!(resetEl instanceof HTMLButtonElement)) throw new Error('reset control not found');

  let streamCfg: StreamConfig = DEFAULT_STREAM;

  let rawData: DataPoint[] = createSeedData(800);
  let nextX = (() => {
    const last = rawData[rawData.length - 1] as DataPoint | undefined;
    if (!last) return 0;
    const x = Array.isArray(last) ? last[0] : last.x;
    return Number.isFinite(x) ? x : 0;
  })();

  let autoScroll = true;
  autoScrollEl.checked = autoScroll;

  let options: ChartGPUOptions = createBaseOptions(rawData, autoScroll);
  const chart = await ChartGPU.create(container, options);
  const ro = attachCoalescedResizeObserver(container, chart);

  chart.resize();

  const applyOptions = (): void => {
    // When toggling autoScroll, keep the currently accumulated CPU-side data.
    options = createBaseOptions(rawData, autoScroll);
    chart.setOption(options);
  };

  autoScrollEl.addEventListener('change', () => {
    autoScroll = autoScrollEl.checked === true;
    applyOptions();
  });

  const reset = (): void => {
    rawData = createSeedData(800);
    const last = rawData[rawData.length - 1] as DataPoint | undefined;
    const lastX = last ? (Array.isArray(last) ? last[0] : last.x) : 0;
    nextX = Number.isFinite(lastX) ? lastX : 0;
    applyOptions();
  };

  resetEl.addEventListener('click', reset);

  // Streaming loop: append small batches frequently.
  let intervalId: number | null = null;
  const startStreaming = (): void => {
    if (intervalId !== null) return;
    intervalId = window.setInterval(() => {
      const batch: DataPoint[] = new Array(streamCfg.pointsPerTick);
      for (let i = 0; i < streamCfg.pointsPerTick; i++) {
        nextX += 0.02;
        const y =
          Math.sin(nextX) * 0.8 +
          Math.sin(nextX * 0.23 + 1.2) * 0.25 +
          Math.sin(nextX * 2.1) * 0.08 +
          (Math.random() - 0.5) * 0.04;
        batch[i] = [nextX, y] as const;
      }

      chart.appendData(0, batch);
      rawData.push(...batch);

      // Keep the example bounded: periodically re-seed the chart with a sliding window.
      // This keeps memory stable while still exercising streaming + autoScroll behavior.
      if (rawData.length > streamCfg.maxPoints) {
        rawData = rawData.slice(rawData.length - streamCfg.maxPoints);
        applyOptions();
      }
    }, streamCfg.tickMs);
  };

  const stopStreaming = (): void => {
    if (intervalId === null) return;
    window.clearInterval(intervalId);
    intervalId = null;
  };

  startStreaming();

  // Keep readouts in sync with slider updates.
  let rafId: number | null = null;
  let lastKey = '';
  const tick = (): void => {
    const z = chart.getZoomRange();
    const key = `${rawData.length}:${z ? `${z.start.toFixed(2)}:${z.end.toFixed(2)}` : 'null'}`;
    if (key !== lastKey) {
      lastKey = key;
      setText('pointCount', formatInt(rawData.length));
      setText('zoomRange', formatZoom(z));
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopStreaming();
    if (rafId !== null) cancelAnimationFrame(rafId);
    ro.disconnect();
    chart.dispose();
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

