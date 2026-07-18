/**
 * Log axes scatter — power-law cloud with log Y (all coordinates > 0).
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const N = 50_000;

function generatePowerLawCloud(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Log-uniform X and power-law-ish Y with noise
    const x = 10 ** (Math.random() * 3); // 1 … 1000
    const y = (x ** -0.7) * 10 ** (Math.random() * 0.5) * 100;
    out[i] = [x, Math.max(1e-3, y)];
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

  const data = generatePowerLawCloud(N);

  const options: ChartGPUOptions = {
    grid: { left: 72, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'log', name: 'X', min: 1, max: 1000 },
    yAxis: { type: 'log', name: 'Y', min: 0.01, max: 1000 },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    animation: { duration: 0 },
    series: [
      {
        type: 'scatter',
        name: 'Cloud',
        data,
        color: '#ff4ab0',
        symbolSize: 3,
        symbol: 'circle',
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
