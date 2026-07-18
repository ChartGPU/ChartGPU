/**
 * Log Y axis — multi-decade amplitude with native log projection.
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const N = 4000;

/** y = 10^(smooth envelope) with mild noise — spans ~1e-2 … 1e4 */
function generateMultiDecade(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = t * 10;
    // Envelope from 1e-2 to 1e4 in log space with a dip and rise
    const logY = -2 + t * 6 + 0.4 * Math.sin(t * Math.PI * 4) + (Math.random() - 0.5) * 0.08;
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
  const container = document.getElementById('chart');
  if (!container) throw new Error('Chart container not found');

  const data = generateMultiDecade(N);

  const options: ChartGPUOptions = {
    grid: { left: 72, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'value', name: 'Time (s)', min: 0, max: 10 },
    yAxis: { type: 'log', name: 'Amplitude', min: 0.01, max: 10000 },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    animation: { duration: 0 },
    series: [
      {
        type: 'line',
        name: 'Signal',
        data,
        color: '#4a9eff',
        lineStyle: { width: 2, opacity: 1 },
        sampling: 'lttb',
        samplingThreshold: 2500,
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);

  let scheduled = false;
  const ro = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      chart.resize();
    });
  });
  ro.observe(container);
  chart.resize();

  window.addEventListener('beforeunload', () => {
    ro.disconnect();
    chart.dispose();
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
