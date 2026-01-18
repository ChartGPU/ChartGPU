import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, PieDataItem, ThemeConfig } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const attachCoalescedResizeObserver = (
  containers: ReadonlyArray<HTMLElement>,
  charts: ReadonlyArray<ChartGPUInstance>
): ResizeObserver => {
  let rafId: number | null = null;

  const schedule = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      for (const chart of charts) chart.resize();
    });
  };

  const ro = new ResizeObserver(() => schedule());
  for (const el of containers) ro.observe(el);
  return ro;
};

const theme: ThemeConfig = {
  ...darkTheme,
  // Match the example shell background so the canvas blends in.
  backgroundColor: '#0f0f14',
  // Keep cartesian chrome subtle since we're rendering a non-cartesian series.
  gridLineColor: 'rgba(255,255,255,0.06)',
  axisLineColor: 'rgba(224,224,224,0.14)',
  axisTickColor: 'rgba(224,224,224,0.22)',
  textColor: 'rgba(224,224,224,0.78)',
};

const slices: ReadonlyArray<PieDataItem> = [
  { name: 'Compute', value: 42, color: '#00E5FF' },
  { name: 'Memory', value: 30, color: '#FF2D95' },
  { name: 'Raster', value: 18, color: '#B026FF' },
  { name: 'Upload', value: 12, color: '#00F5A0' },
  { name: 'Sync', value: 9, color: '#FFD300' },
  { name: 'Other', value: 6, color: '#FF6B00' },
];

const createOptions = (
  title: string,
  radius: ChartGPUOptions['series'] extends ReadonlyArray<infer S>
    ? S extends { type: 'pie'; radius?: infer R }
      ? R
      : never
    : never
): ChartGPUOptions => {
  return {
    // Leave room on the right for the built-in legend overlay.
    grid: { left: 24, right: 120, top: 24, bottom: 24 },
    // These axes are unused for pie rendering, but the ChartGPU coordinator always has an axis config.
    // Keep them minimal/subtle.
    xAxis: { type: 'value', min: 0, max: 1, tickLength: 0, name: '' },
    yAxis: { type: 'value', min: 0, max: 1, tickLength: 0, name: '' },
    tooltip: { show: false },
    theme,
    series: [
      {
        type: 'pie',
        name: title,
        // Used as a fallback when a slice doesn't specify a color.
        color: '#00E5FF',
        radius,
        center: ['50%', '50%'],
        startAngle: 90,
        data: slices,
      },
    ],
  };
};

async function main(): Promise<void> {
  const pieEl = document.getElementById('chart-pie');
  const donutEl = document.getElementById('chart-donut');
  if (!(pieEl instanceof HTMLElement) || !(donutEl instanceof HTMLElement)) {
    throw new Error('Chart containers not found');
  }

  const pie = await ChartGPU.create(pieEl, createOptions('Pie (inner = 0)', [0, '72%']));
  const donut = await ChartGPU.create(donutEl, createOptions('Donut (inner > 0)', ['40%', '72%']));

  const ro = attachCoalescedResizeObserver([pieEl, donutEl], [pie, donut]);

  // Initial sizing/render.
  pie.resize();
  donut.resize();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    ro.disconnect();
    pie.dispose();
    donut.dispose();
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

