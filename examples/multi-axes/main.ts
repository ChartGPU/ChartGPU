/**
 * Multi-Axis Chart Example
 *
 * Demonstrates two independent Y-axes:
 *   - y1 (left):  Temperature in °C  — range roughly −5 → 40
 *   - y2 (right): Humidity % and Wind speed km/h — range 0 → 100
 *
 * Series are bound to their axis via the `yAxis` property.
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

// ─── helpers ────────────────────────────────────────────────────────────────

const days = 90; // 3 months of daily readings

/** Smooth pseudo-random walk within [lo, hi]. */
function generateWalk(
  n: number,
  start: number,
  lo: number,
  hi: number,
  step = 1.5,
): ReadonlyArray<DataPoint> {
  const pts: DataPoint[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * step * 2;
    v = Math.max(lo, Math.min(hi, v));
    pts.push([i, v]);
  }
  return pts;
}

/** Smooth sine-modulated seasonal curve. */
function generateSeasonal(
  n: number,
  baseMin: number,
  baseMax: number,
  noise = 1,
): ReadonlyArray<DataPoint> {
  const pts: DataPoint[] = [];
  const mid = (baseMax + baseMin) / 2;
  const amp = (baseMax - baseMin) / 2;
  for (let i = 0; i < n; i++) {
    const seasonal = Math.sin((i / n) * Math.PI * 2 - Math.PI / 2) * amp;
    const jitter = (Math.random() - 0.5) * noise * 2;
    pts.push([i, mid + seasonal + jitter]);
  }
  return pts;
}

// ─── data ───────────────────────────────────────────────────────────────────

const temperatureData = generateSeasonal(days, 2, 34, 2);   // °C, seasonal arc
const humidityData    = generateWalk(days, 65, 30, 95, 3);  // %, random walk
const windData        = generateWalk(days, 20, 5, 80, 4);   // km/h, random walk

// ─── chart ──────────────────────────────────────────────────────────────────

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

async function main() {
  const container = document.getElementById('chart');
  if (!container) throw new Error('Chart container not found');

  const options: ChartGPUOptions = {
    // Extra right margin for the right-side Y-axis labels
    grid: { left: 70, right: 70, top: 28, bottom: 52 },

    xAxis: {
      type: 'value',
      min: 0,
      max: days - 1,
      name: 'Day',
    },

    // Multi-axis configuration: two independent Y-axes
    axes: {
      y: [
        {
          id: 'y1',
          position: 'left',
          name: 'Temperature (°C)',
          min: -5,
          max: 40,
        },
        {
          id: 'y2',
          position: 'right',
          name: 'Humidity / Wind',
          min: 0,
          max: 100,
        },
      ],
    },

    animation: { duration: 700, easing: 'cubicOut', delay: 0 },

    series: [
      {
        type: 'line',
        name: 'Temperature (°C)',
        data: temperatureData,
        color: '#4a9eff',
        yAxis: 'y1',           // ← bound to left axis
        lineStyle: { width: 2.5, opacity: 1 },
        areaStyle: { opacity: 0.12 },
      },
      {
        type: 'line',
        name: 'Humidity (%)',
        data: humidityData,
        color: '#ff9f40',
        yAxis: 'y2',           // ← bound to right axis
        lineStyle: { width: 2, opacity: 1 },
        areaStyle: { opacity: 0.08 },
      },
      {
        type: 'line',
        name: 'Wind speed (km/h)',
        data: windData,
        color: '#9b59b6',
        yAxis: 'y2',           // ← also bound to right axis
        lineStyle: { width: 2, opacity: 0.9 },
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);

  // ── resize handling ─────────────────────────────────────────────────────
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

  // ── demonstrate setOption with updated data after 4 s ──────────────────
  setTimeout(() => {
    const newTemp     = generateSeasonal(days, 5, 38, 3);
    const newHumidity = generateWalk(days, 50, 20, 98, 4);
    const newWind     = generateWalk(days, 30, 3, 90, 5);

    chart.setOption({
      ...options,
      series: [
        { ...options.series![0], data: newTemp },
        { ...options.series![1], data: newHumidity },
        { ...options.series![2], data: newWind },
      ],
    });
  }, 4000);

  window.addEventListener('beforeunload', () => {
    ro.disconnect();
    chart.dispose();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () =>
    main().catch((err) => {
      console.error(err);
      showError(err instanceof Error ? err.message : String(err));
    }),
  );
} else {
  main().catch((err) => {
    console.error(err);
    showError(err instanceof Error ? err.message : String(err));
  });
}
