import { ChartGPU, connectCharts } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint, TooltipParams } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const numberFmt = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 4,
});

const axisTooltipFormatter = (params: ReadonlyArray<TooltipParams>): string => {
  const first = params[0];
  if (!first) return '';

  const xMs = first.value[0];
  const header = dateFmt.format(new Date(xMs));

  const rows = params
    .map((p) => {
      const name = escapeHtml(p.seriesName);
      const y = p.value[1];
      const valueText = Number.isFinite(y) ? numberFmt.format(y) : '—';
      const color = p.color;

      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:220px;">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span style="width:10px;height:10px;border-radius:2px;background:${color};display:inline-block;flex:0 0 auto;"></span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
          </div>
          <div style="font-variant-numeric: tabular-nums; opacity:0.95;">${valueText}</div>
        </div>
      `.trim();
    })
    .join('');

  return `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font-weight:600; opacity:0.95;">${escapeHtml(header)}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">${rows}</div>
    </div>
  `.trim();
};

const createTimeSeries = (
  count: number,
  opts: Readonly<{
    startMs: number;
    stepMs: number;
    fn: (t: number) => number;
  }>
): ReadonlyArray<DataPoint> => {
  const n = Math.max(2, Math.floor(count));
  const out: DataPoint[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const x = opts.startMs + i * opts.stepMs;
    const y = opts.fn(i);
    out[i] = [x, y] as const;
  }

  return out;
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

const createOptions = (
  title: string,
  seriesA: ReadonlyArray<DataPoint>,
  seriesB: ReadonlyArray<DataPoint>,
  palette: readonly [string, string]
): ChartGPUOptions => {
  type DataPointTupleLocal = readonly [x: number, y: number, size?: number];
  const isTupleDataPoint = (p: DataPoint): p is DataPointTupleLocal => Array.isArray(p) && p.length >= 2;
  const getX = (p: DataPoint): number => (isTupleDataPoint(p) ? p[0] : p.x);
  const first = seriesA[0];
  const last = seriesA.length > 0 ? seriesA[seriesA.length - 1] : undefined;
  const xMin = first ? getX(first) : Date.now();
  const xMax = last ? getX(last) : xMin + 1;

  return {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'time', min: xMin, max: xMax, name: 'Time' },
    yAxis: { type: 'value', name: title },
    palette,
    tooltip: { trigger: 'axis', formatter: axisTooltipFormatter },
    series: [
      {
        type: 'line',
        name: `${title} A`,
        data: seriesA,
        color: palette[0],
        areaStyle: { opacity: 0.22 },
        lineStyle: { width: 2, opacity: 1 },
      },
      {
        type: 'line',
        name: `${title} B`,
        data: seriesB,
        color: palette[1],
        areaStyle: { opacity: 0.16 },
        lineStyle: { width: 2, opacity: 1 },
      },
    ],
  };
};

async function main(): Promise<void> {
  const containerTop = document.querySelector('#chart-top');
  const containerBottom = document.querySelector('#chart-bottom');
  if (!(containerTop instanceof HTMLElement) || !(containerBottom instanceof HTMLElement)) {
    throw new Error('Chart containers not found');
  }

  // Time-series data (epoch-ms), sorted increasing by construction.
  const now = Date.now();
  const startMs = now - 1000 * 60 * 60 * 24 * 14; // 14 days back
  const count = 800;
  const stepMs = 1000 * 60 * 30; // 30 minutes

  const topA = createTimeSeries(count, {
    startMs,
    stepMs,
    fn: (i) => {
      const t = i / (count - 1);
      const season = Math.sin(t * Math.PI * 8);
      const trend = t * 1.2;
      return 40 + 12 * season + 18 * trend;
    },
  });

  const topB = createTimeSeries(count, {
    startMs,
    stepMs,
    fn: (i) => {
      const t = i / (count - 1);
      const season = Math.cos(t * Math.PI * 6 + 0.7);
      const spikes = Math.max(0, Math.sin(t * Math.PI * 18)) * 10;
      return 30 + 10 * season + spikes + t * 10;
    },
  });

  const botA = createTimeSeries(count, {
    startMs,
    stepMs,
    fn: (i) => {
      const t = i / (count - 1);
      const wobble = Math.sin(t * Math.PI * 10) * Math.cos(t * Math.PI * 3);
      return 120 + 35 * wobble - t * 20;
    },
  });

  const botB = createTimeSeries(count, {
    startMs,
    stepMs,
    fn: (i) => {
      const t = i / (count - 1);
      const slow = Math.sin(t * Math.PI * 2.5 + 1.1);
      const accel = Math.pow(t, 2) * 25;
      return 95 + 22 * slow + accel;
    },
  });

  const chartTop = await ChartGPU.create(
    containerTop,
    createOptions('Top', topA, topB, ['#4a9eff', '#ff4ab0'])
  );
  const chartBottom = await ChartGPU.create(
    containerBottom,
    createOptions('Bottom', botA, botB, ['#40d17c', '#ffd166'])
  );

  chartTop.on('click', (payload) => console.log('[top click]', payload));
  chartBottom.on('click', (payload) => console.log('[bottom click]', payload));

  const disconnect = connectCharts([chartTop, chartBottom]);

  const ro = attachCoalescedResizeObserver([containerTop, containerBottom], [chartTop, chartBottom]);

  // Initial sizing/render.
  chartTop.resize();
  chartBottom.resize();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    ro.disconnect();
    disconnect();
    chartTop.dispose();
    chartBottom.dispose();
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

