/**
 * Log + linear dual Y — Mollier-inspired layout (pressure log, temperature linear).
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const N = 500;

function generatePressure(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const h = 100 + t * 400; // enthalpy-like x
    // Pressure drops exponentially along path: 100 bar → 0.1 bar
    const p = 100 * 10 ** (-3 * t) * (1 + 0.05 * Math.sin(t * 12));
    out[i] = [h, Math.max(0.05, p)];
  }
  return out;
}

function generateTemperature(n: number): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const h = 100 + t * 400;
    const temp = 20 + t * 280 + 8 * Math.sin(t * 6);
    out[i] = [h, temp];
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

  const pressure = generatePressure(N);
  const temperature = generateTemperature(N);

  const options: ChartGPUOptions = {
    grid: { left: 72, right: 72, top: 28, bottom: 56 },
    xAxis: { type: 'value', name: 'Enthalpy (kJ/kg)', min: 100, max: 500 },
    axes: {
      y: [
        { id: 'p', type: 'log', position: 'left', name: 'P (bar)', min: 0.05, max: 200 },
        { id: 't', type: 'value', position: 'right', name: 'T (°C)', min: 0, max: 350 },
      ],
    },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    animation: { duration: 0 },
    palette: ['#4a9eff', '#ff9f43'],
    series: [
      {
        type: 'line',
        name: 'Pressure',
        yAxis: 'p',
        data: pressure,
        color: '#4a9eff',
        lineStyle: { width: 2 },
      },
      {
        type: 'line',
        name: 'Temperature',
        yAxis: 't',
        data: temperature,
        color: '#ff9f43',
        lineStyle: { width: 2 },
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
