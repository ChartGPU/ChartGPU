/**
 * Log X axis — Bode-style frequency sweep (log frequency, linear magnitude dB).
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const N = 2000;
const F_MIN = 1;
const F_MAX = 1e5;

/** Smooth low-pass-like magnitude (dB) over log-spaced frequency. */
function generateBodeMagnitude(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  const logMin = Math.log10(F_MIN);
  const logMax = Math.log10(F_MAX);
  const f0 = 1e3; // corner frequency
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = 10 ** (logMin + t * (logMax - logMin));
    // First-order low-pass |H| in dB
    const mag = -10 * Math.log10(1 + (f / f0) ** 2);
    out[i] = [f, mag];
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

  const data = generateBodeMagnitude(N);

  const options: ChartGPUOptions = {
    grid: { left: 72, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'log', name: 'Frequency (Hz)', min: F_MIN, max: F_MAX },
    yAxis: { type: 'value', name: 'Magnitude (dB)', min: -80, max: 5 },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    animation: { duration: 0 },
    series: [
      {
        type: 'line',
        name: 'H(f)',
        data,
        color: '#40d17c',
        lineStyle: { width: 2, opacity: 1 },
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
