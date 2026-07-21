/**
 * Stacked mountain example — multi-series composition over time.
 * Same `stack` id → layers compose (bar-compatible semantics).
 * Toggle clears stack so layers overlay independently (unstacked mountain).
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, ThemeConfig } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const theme: ThemeConfig = {
  ...darkTheme,
  backgroundColor: '#0f0f14',
  gridLineColor: 'rgba(255,255,255,0.06)',
  axisLineColor: 'rgba(224,224,224,0.14)',
  axisTickColor: 'rgba(224,224,224,0.22)',
  textColor: 'rgba(224,224,224,0.78)',
};

const N = 120;

function makeTraffic(): {
  t: Float64Array;
  organic: Float64Array;
  paid: Float64Array;
  referral: Float64Array;
  target: Float64Array;
} {
  const t = new Float64Array(N);
  const organic = new Float64Array(N);
  const paid = new Float64Array(N);
  const referral = new Float64Array(N);
  const target = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = i;
    t[i] = x;
    const wave = 0.15 * Math.sin(i / 9) + 0.08 * Math.sin(i / 3.7);
    organic[i] = 28 + 6 * Math.sin(i / 14) + wave * 10 + (i % 17) * 0.15;
    paid[i] = 18 + 8 * Math.sin(i / 11 + 1.2) + wave * 6 + (i % 11) * 0.12;
    referral[i] = 10 + 4 * Math.cos(i / 13) + wave * 4 + (i % 7) * 0.08;
    target[i] = 70 + 4 * Math.sin(i / 20);
  }
  return { t, organic, paid, referral, target };
}

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const enableStackEl = document.getElementById('enableStack') as HTMLInputElement;
  const showTargetEl = document.getElementById('showTarget') as HTMLInputElement;
  const data = makeTraffic();

  let chart: ChartGPUInstance | null = null;

  const buildOptions = (): ChartGPUOptions => {
    const stackOn = enableStackEl.checked;
    const stack = stackOn ? 'traffic' : undefined;
    const series: ChartGPUOptions['series'] = [
      {
        type: 'line',
        name: 'Organic',
        stack,
        data: { x: data.t, y: data.organic },
        color: '#38bdf8',
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.85 },
        sampling: 'none',
      },
      {
        type: 'line',
        name: 'Paid',
        stack,
        data: { x: data.t, y: data.paid },
        color: '#a78bfa',
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.85 },
        sampling: 'none',
      },
      {
        type: 'line',
        name: 'Referral',
        stack,
        data: { x: data.t, y: data.referral },
        color: '#34d399',
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.85 },
        sampling: 'none',
      },
    ];
    if (showTargetEl.checked) {
      series.push({
        type: 'line',
        name: 'Target',
        data: { x: data.t, y: data.target },
        color: '#f472b6',
        lineStyle: { width: 2, color: '#f472b6' },
        sampling: 'none',
        // no areaStyle → stroke-only guide on top of the stack
      });
    }
    return {
      theme,
      grid: { left: 64, right: 24, top: 28, bottom: 48 },
      xAxis: { type: 'value', name: 'Time' },
      yAxis: { type: 'value', name: 'Users' },
      legend: { show: true },
      tooltip: { show: true, trigger: 'item' },
      animation: false,
      series,
    };
  };

  try {
    chart = await ChartGPU.create(chartEl, buildOptions());
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }

  const reapply = (): void => {
    if (!chart) return;
    chart.setOption(buildOptions());
  };

  enableStackEl.addEventListener('change', reapply);
  showTargetEl.addEventListener('change', reapply);

  let scheduled = false;
  const ro = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      chart?.resize();
    });
  });
  ro.observe(chartEl);
}

main().catch((err) => {
  showError(err instanceof Error ? err.stack ?? err.message : String(err));
});
