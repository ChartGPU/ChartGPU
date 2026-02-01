import { ChartGPU } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from '../../src/index';
import { createAnnotationAuthoring } from '../../src/index';
import type { AnnotationAuthoringInstance } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

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

  const jsonOutput = document.getElementById('json-output');
  if (!jsonOutput) {
    throw new Error('JSON output element not found');
  }

  const data = createTimeSeries(600);

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
        name: 'signal',
        data,
        color: '#4a9eff',
        lineStyle: { width: 2, opacity: 1 },
      },
    ],
    annotations: [],
  };

  let chart: ChartGPUInstance | null = null;
  let ro: DisposableResizeObserver | null = null;
  let authoring: AnnotationAuthoringInstance | null = null;

  const updateJSONOutput = (): void => {
    if (!authoring) return;
    const annotations = authoring.getAnnotations();
    jsonOutput.textContent = JSON.stringify(annotations, null, 2);
  };

  const disposeAll = (): void => {
    authoring?.dispose();
    authoring = null;
    ro?.disconnect();
    ro = null;
    chart?.dispose();
    chart = null;
  };

  // Create chart
  chart = await ChartGPU.create(container, options);
  ro = attachCoalescedResizeObserver(container, chart);
  chart.resize();

  // Create annotation authoring helper
  authoring = createAnnotationAuthoring(container, chart, {
    showToolbar: true,
    enableContextMenu: true,
  });

  // Update JSON output initially
  updateJSONOutput();

  // Poll for annotation changes (simple approach for demo)
  const pollInterval = setInterval(() => {
    if (!authoring) {
      clearInterval(pollInterval);
      return;
    }
    updateJSONOutput();
  }, 500);

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pollInterval);
    window.removeEventListener('beforeunload', cleanup);
    disposeAll();
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
