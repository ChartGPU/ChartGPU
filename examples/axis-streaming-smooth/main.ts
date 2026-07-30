/**
 * Streaming rising-Y demo with continuous auto-range + tick-aligned grid.
 * Goal WS3/WS4 visual: majors and grid roll as Y grows (not sticky freeze/jump).
 */
import { ChartGPU } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const setStats = (n: number): void => {
  const el = document.getElementById('stats');
  if (el) el.textContent = `points: ${n.toLocaleString()} · autoRange: continuous · growBy: 0.05`;
};

async function main(): Promise<void> {
  const container = document.getElementById('chart');
  if (!container) throw new Error('Chart container not found');

  const seed: DataPoint[] = [];
  for (let i = 0; i < 80; i++) {
    seed.push([i, 10 + Math.sin(i * 0.2) * 2]);
  }

  const options: ChartGPUOptions = {
    grid: { left: 64, right: 20, top: 20, bottom: 44 },
    gridLines: {
      show: true,
      horizontal: { show: true },
      vertical: { show: true },
    },
    xAxis: { type: 'value', name: 't' },
    yAxis: {
      type: 'value',
      name: 'amplitude',
      autoRange: 'continuous',
      growBy: 0.05,
      tickCount: 6,
    },
    autoScroll: true,
    dataZoom: [{ type: 'inside' }],
    animation: false,
    tooltip: { trigger: 'axis' },
    series: [
      {
        type: 'line',
        name: 'rising',
        data: seed,
        color: '#4a9eff',
        lineStyle: { width: 2 },
        sampling: 'none',
      },
    ],
  };

  let chart: ChartGPUInstance;
  try {
    chart = await ChartGPU.create(container, options);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return;
  }

  let t = seed.length;
  let baseY = 12;
  setStats(seed.length);

  const tick = (): void => {
    baseY += 0.35 + Math.random() * 0.25;
    const batch: DataPoint[] = [];
    for (let k = 0; k < 4; k++) {
      const x = t++;
      const y = baseY + Math.sin(x * 0.15) * (2 + baseY * 0.02) + (Math.random() - 0.5);
      batch.push([x, y]);
    }
    chart.appendData(0, batch);
    setStats(t);
  };

  const id = window.setInterval(tick, 50);

  window.addEventListener('beforeunload', () => {
    clearInterval(id);
    chart.dispose();
  });
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
