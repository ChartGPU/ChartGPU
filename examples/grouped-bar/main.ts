import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const makeSeries = (
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>
): ReadonlyArray<DataPoint> => xs.map((x, i) => [x, ys[i] ?? 0] as const);

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  // Story 4.5 acceptance harness:
  // - Series A + B share a stack id so they render STACKED (not side-by-side)
  // - Series C is unstacked, so it renders as a separate clustered bar
  // - includes negative y values to validate downward stacking behavior
  // - uses barWidth / barGap / barCategoryGap to validate spacing controls
  const xs = [0, 1, 2, 3, 4, 5];

  const dataA = makeSeries(xs, [8, 6, -3, 5, 2, -2]);
  const dataB = makeSeries(xs, [5, -1, -2, 3, -4, 1]);
  const dataC = makeSeries(xs, [2, 3, 1, -2, 6, -5]);

  const options: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'value', min: -0.75, max: 5.75, name: 'Category (x)' },
    yAxis: { type: 'value', min: -6, max: 10, name: 'Value (y)' },
    palette: ['#4a9eff', '#ff4ab0', '#40d17c'],
    tooltip: { show: true, trigger: 'axis' },
    series: [
      {
        type: 'bar',
        name: 'Series A',
        data: dataA,
        color: '#4a9eff',
        stack: 's1',
        barWidth: '70%',
        barGap: 0.25,
        barCategoryGap: 0.35,
      },
      {
        type: 'bar',
        name: 'Series B',
        data: dataB,
        color: '#ff4ab0',
        stack: 's1',
      },
      {
        type: 'bar',
        name: 'Series C',
        data: dataC,
        color: '#40d17c',
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);

  // Keep the canvas crisp as the container resizes.
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

  // Initial sizing/render.
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

