/**
 * Linear vs log comparison — same data, two ChartGPU instances.
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const N = 3000;

function generateMultiDecade(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = t * 10;
    const logY = -2 + t * 6 + 0.35 * Math.sin(t * Math.PI * 5);
    out[i] = [x, 10 ** logY];
  }
  return out;
}

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

async function main() {
  const linearEl = document.getElementById('chart-linear');
  const logEl = document.getElementById('chart-log');
  if (!linearEl || !logEl) throw new Error('Chart containers not found');

  const data = generateMultiDecade(N);

  const base: Omit<ChartGPUOptions, 'yAxis'> = {
    grid: { left: 72, right: 20, top: 16, bottom: 40 },
    xAxis: { type: 'value', name: 'x', min: 0, max: 10 },
    animation: { duration: 0 },
    series: [
      {
        type: 'line',
        name: 'Signal',
        data,
        color: '#4a9eff',
        lineStyle: { width: 2 },
        sampling: 'lttb',
        samplingThreshold: 2000,
      },
    ],
  };

  const linearChart = await ChartGPU.create(linearEl, {
    ...base,
    yAxis: { type: 'value', name: 'Amplitude (linear)', min: 0, max: 12000 },
  });

  const logChart = await ChartGPU.create(logEl, {
    ...base,
    yAxis: { type: 'log', name: 'Amplitude (log)', min: 0.01, max: 10000 },
  });

  let scheduled = false;
  const ro = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      linearChart.resize();
      logChart.resize();
    });
  });
  ro.observe(linearEl);
  ro.observe(logEl);
  linearChart.resize();
  logChart.resize();

  window.addEventListener('beforeunload', () => {
    ro.disconnect();
    linearChart.dispose();
    logChart.dispose();
  });
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
