/**
 * ChartGPU dev-site showcase — live WebGPU plates + example index.
 */
import { ChartGPU } from '../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  DataPoint,
  OHLCDataPoint,
  ScatterPointTuple,
} from '../src/index';

// ── Brand palette (matches tokens.css / site identity) ──────────────────────
const GOLD = '#D4A520';
const BLUE = '#3B7DD8';
const CYAN = '#3ECFCF';
const ROSE = '#E05A8C';
const LIME = '#6BCB77';
const VIOLET = '#8B7CFF';
const AMBER = '#F0A202';
const STEEL = '#7A8494';

const BRAND_PALETTE = [GOLD, BLUE, CYAN, ROSE, LIME, VIOLET, AMBER, STEEL] as const;

// ── Example catalog (preserved from prior landing) ──────────────────────────
type Example = Readonly<{
  id: string;
  title: string;
  desc: string;
  category: string;
  path: string;
}>;

const examples: readonly Example[] = [
  {
    id: 'streaming-dashboard',
    title: 'Streaming Dashboard',
    desc: 'Five-chart APM dashboard with live latency percentiles, throughput, and real-time annotations',
    category: 'streaming',
    path: '/examples/streaming-dashboard/index.html',
  },
  {
    id: 'candlestick-streaming',
    title: 'Candlestick Streaming',
    desc: 'Crypto trading terminal with live tick simulation and real-time candle aggregation',
    category: 'streaming',
    path: '/examples/candlestick-streaming/index.html',
  },
  {
    id: 'scatter-density-1m',
    title: 'Scatter Density 1M',
    desc: 'One million points rendered as a GPU-binned density heatmap with colormap controls',
    category: 'performance',
    path: '/examples/scatter-density-1m/index.html',
  },
  {
    id: 'basic-line',
    title: 'Basic Line',
    desc: 'Sine wave line chart with grid, axes, and tooltip interaction',
    category: 'series',
    path: '/examples/basic-line/index.html',
  },
  {
    id: 'candlestick',
    title: 'Candlestick',
    desc: 'Financial OHLC chart with classic and hollow style toggle',
    category: 'series',
    path: '/examples/candlestick/index.html',
  },
  {
    id: 'scatter',
    title: 'Scatter Plot',
    desc: 'Fixed size, per-point size, and dynamic size function variants',
    category: 'series',
    path: '/examples/scatter/index.html',
  },
  {
    id: 'grouped-bar',
    title: 'Grouped & Stacked Bar',
    desc: 'Clustered bars with stacking, custom widths, and negative values',
    category: 'series',
    path: '/examples/grouped-bar/index.html',
  },
  {
    id: 'pie',
    title: 'Pie & Donut',
    desc: 'Pie chart and donut chart with per-slice colors',
    category: 'series',
    path: '/examples/pie/index.html',
  },
  {
    id: 'live-streaming',
    title: 'Live Streaming',
    desc: 'Streaming appendData with autoScroll toggle and dataZoom slider',
    category: 'streaming',
    path: '/examples/live-streaming/index.html',
  },
  {
    id: 'million-points',
    title: 'Million Points',
    desc: '1M point benchmark with sampling toggle and FPS comparison',
    category: 'performance',
    path: '/examples/million-points/index.html',
  },
  {
    id: 'ultimate-benchmark',
    title: 'Ultimate Benchmark',
    desc: 'Multi-series stress test with FPS, frame-time metrics, and streaming append',
    category: 'performance',
    path: '/examples/ultimate-benchmark/index.html',
  },
  {
    id: 'sampling',
    title: 'Zoom-Aware Sampling',
    desc: 'Zoom in for detail, zoom out for performance with debounced re-sampling',
    category: 'performance',
    path: '/examples/sampling/index.html',
  },
  {
    id: 'interactive',
    title: 'Interactive',
    desc: 'Synced crosshair and axis tooltip across two stacked charts with click logging',
    category: 'interaction',
    path: '/examples/interactive/index.html',
  },
  {
    id: 'chart-sync',
    title: 'Chart Sync',
    desc: 'Two charts with synced crosshair position and axis tooltip values',
    category: 'interaction',
    path: '/examples/chart-sync/index.html',
  },
  {
    id: 'annotation-authoring',
    title: 'Annotations',
    desc: 'Reference lines, point markers, text annotations with authoring and JSON export',
    category: 'interaction',
    path: '/examples/annotation-authoring/index.html',
  },
  {
    id: 'exchange-gaps',
    title: 'Exchange Gaps',
    desc: 'Null gap entries for maintenance windows with connectNulls toggle',
    category: 'interaction',
    path: '/examples/exchange-gaps/index.html',
  },
  {
    id: 'data-update-animation',
    title: 'Data Update Animation',
    desc: 'Animated transitions for y-values, scales, and pie slice angles',
    category: 'animation',
    path: '/examples/data-update-animation/index.html',
  },
  {
    id: 'multi-series-animation',
    title: 'Multi-Series Animation',
    desc: 'Line, bar, scatter, and area series animating together on data update',
    category: 'animation',
    path: '/examples/multi-series-animation/index.html',
  },
  {
    id: 'tick-formatter',
    title: 'Custom Tick Formatter',
    desc: 'Percentage, duration, locale time, and integer-only formatting',
    category: 'config',
    path: '/examples/tick-formatter/index.html',
  },
  {
    id: 'external-render-mode',
    title: 'External Render Mode',
    desc: 'Application-controlled rendering with shared rAF loop and mode switching',
    category: 'config',
    path: '/examples/external-render-mode/index.html',
  },
  {
    id: 'cartesian-data-formats',
    title: 'Data Formats',
    desc: 'XYArraysData, InterleavedXYData, and array-of-objects with 100k points',
    category: 'config',
    path: '/examples/cartesian-data-formats/index.html',
  },
  {
    id: 'grid-test',
    title: 'Grid Renderer',
    desc: 'Configurable grid line counts for horizontal and vertical axes',
    category: 'config',
    path: '/examples/grid-test/index.html',
  },
  {
    id: 'hello-world',
    title: 'Hello World',
    desc: 'Raw WebGPU clear color cycling through the color spectrum',
    category: 'config',
    path: '/examples/hello-world/index.html',
  },
];

const categories = [
  { id: 'all', label: 'All' },
  { id: 'series', label: 'Series' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'performance', label: 'Performance' },
  { id: 'interaction', label: 'Interaction' },
  { id: 'animation', label: 'Animation' },
  { id: 'config', label: 'Configuration' },
] as const;

const categoryLabels: Record<string, string> = {
  series: 'Series',
  streaming: 'Streaming',
  performance: 'Performance',
  interaction: 'Interaction',
  animation: 'Animation',
  config: 'Configuration',
};

// ── Shared chrome for plates (minimal so the chart speaks) ──────────────────
const hideTicks = (): string | null => null;

/** Near-black midnight — darker than built-in `dark` (`#1a1a2e`). */
const MIDNIGHT_THEME: NonNullable<ChartGPUOptions['theme']> = {
  backgroundColor: '#05060A',
  textColor: '#E2E5EB',
  axisLineColor: 'rgba(226,229,235,0.18)',
  axisTickColor: 'rgba(226,229,235,0.28)',
  gridLineColor: 'rgba(255,255,255,0.04)',
  colorPalette: [...BRAND_PALETTE],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 12,
};

const plateChrome = (theme: ChartGPUOptions['theme'] = 'dark'): Pick<
  ChartGPUOptions,
  'theme' | 'grid' | 'gridLines' | 'tooltip' | 'animation' | 'legend'
> => ({
  theme,
  grid: { left: 4, right: 4, top: 8, bottom: 8 },
  gridLines: { show: false },
  tooltip: { show: false },
  animation: false,
  legend: { show: false },
});

const attachResize = (el: HTMLElement, chart: ChartGPUInstance): ResizeObserver => {
  let raf: number | null = null;
  const ro = new ResizeObserver(() => {
    if (raf !== null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (!chart.disposed) chart.resize();
    });
  });
  ro.observe(el);
  return ro;
};

// ── Demo builders ───────────────────────────────────────────────────────────

type LineSeries = Extract<NonNullable<ChartGPUOptions['series']>[number], { type: 'line' }>;

/**
 * Spectrum colors across N series (gold → cyan → blue → violet → rose).
 * ChartGPU only parses hex / comma-rgb — not modern `hsl()` syntax.
 */
const seriesColor = (index: number, total: number): string => {
  const t = total <= 1 ? 0 : index / (total - 1);
  const h = (42 + t * 280) / 360;
  const s = (62 + Math.sin(t * Math.PI) * 18) / 100;
  const l = (52 + Math.sin(t * Math.PI * 2) * 8) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.min(1, Math.max(0, c)));
  };
  const r = channel(0);
  const g = channel(8);
  const b = channel(4);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

const waveY = (t: number, s: number, seriesCount: number): number => {
  const phase = (s / seriesCount) * Math.PI * 2;
  const freq = 0.42 + (s % 17) * 0.09 + (s % 7) * 0.03;
  const amp = 0.55 + (s % 11) * 0.07;
  const drift = Math.sin(s * 0.37) * 0.85 + Math.cos(s * 0.19) * 0.4;
  return (
    Math.sin(t * freq + phase) * amp +
    Math.sin(t * freq * 2.15 + phase * 1.4) * 0.28 +
    Math.sin(t * 0.09 + s * 0.11) * 0.45 +
    drift
  );
};

const buildWaveSeries = (
  seriesCount: number,
  points: number,
  t0: number
): { series: LineSeries[]; nextT: number } => {
  const series: LineSeries[] = [];
  const dt = 0.04;
  for (let s = 0; s < seriesCount; s++) {
    const data: DataPoint[] = new Array(points);
    for (let i = 0; i < points; i++) {
      const t = t0 + i * dt;
      data[i] = [t, waveY(t, s, seriesCount)];
    }
    series.push({
      type: 'line',
      name: `w${s}`,
      data,
      color: seriesColor(s, seriesCount),
      // Hairlines for density; a few slightly thicker accents.
      lineStyle: { width: s % 19 === 0 ? 1.6 : 1, opacity: 0.88 },
      sampling: 'none',
    });
  }
  return { series, nextT: t0 + points * dt };
};

async function mountAurora(container: HTMLElement): Promise<{ dispose: () => void }> {
  const seriesCount = 500;
  // Keep seed + ring modest — 500 × N still fills the viewport; stream carries motion.
  const seedPoints = 160;
  const maxPoints = 480;
  const dt = 0.04;
  let tCursor = 0;
  const built = buildWaveSeries(seriesCount, seedPoints, tCursor);
  tCursor = built.nextT;

  // No inside dataZoom on the hero — wheel must scroll the page, not zoom the chart.
  const options: ChartGPUOptions = {
    ...plateChrome(MIDNIGHT_THEME),
    autoScroll: true,
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', min: -3.2, max: 3.2, tickFormatter: hideTicks },
    palette: [...BRAND_PALETTE],
    series: built.series,
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);

  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduced) {
    // 500 series: 1 pt / series @ ~16 Hz — live without choking the main thread.
    timer = setInterval(() => {
      if (cancelled || chart.disposed) return;
      const step = 1;
      for (let s = 0; s < seriesCount; s++) {
        const pts: DataPoint[] = new Array(step);
        for (let i = 0; i < step; i++) {
          const t = tCursor + i * dt;
          pts[i] = [t, waveY(t, s, seriesCount)];
        }
        chart.appendData(s, pts, { maxPoints });
      }
      tCursor += step * dt;
    }, 64);
  }

  return {
    dispose: () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      ro.disconnect();
      chart.dispose();
    },
  };
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

async function createDensityPoints(count: number, seed: number): Promise<ScatterPointTuple[]> {
  const rng = mulberry32(seed);
  const out: ScatterPointTuple[] = new Array(count);
  const chunk = 40_000;
  for (let base = 0; base < count; base += chunk) {
    const end = Math.min(count, base + chunk);
    for (let i = base; i < end; i++) {
      const t = rng();
      const blob = t < 0.55 ? 0 : t < 0.85 ? 1 : 2;
      const cx = blob === 0 ? 0.32 : blob === 1 ? 0.68 : 0.5;
      const cy = blob === 0 ? 0.58 : blob === 1 ? 0.38 : 0.72;
      const sx = blob === 2 ? 0.14 : 0.07;
      const sy = blob === 2 ? 0.1 : 0.09;
      const u1 = Math.max(1e-12, rng());
      const u2 = rng();
      const r = Math.sqrt(-2.0 * Math.log(u1));
      const theta = 2.0 * Math.PI * u2;
      const x = cx + r * Math.cos(theta) * sx + (rng() - 0.5) * 0.02;
      const y = cy + r * Math.sin(theta) * sy + (rng() - 0.5) * 0.02;
      out[i] = [x, y];
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

async function mountDensity(container: HTMLElement): Promise<{ dispose: () => void }> {
  const n = 500_000;
  const points = await createDensityPoints(n, 2026);
  const options: ChartGPUOptions = {
    ...plateChrome(),
    grid: { left: 4, right: 4, top: 4, bottom: 4 },
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', tickFormatter: hideTicks },
    dataZoom: [{ type: 'inside' }],
    series: [
      {
        type: 'scatter',
        name: 'density',
        data: points,
        mode: 'density',
        binSize: 6,
        densityColormap: 'inferno',
        densityNormalization: 'linear',
        sampling: 'none',
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);
  return {
    dispose: () => {
      ro.disconnect();
      chart.dispose();
    },
  };
}

function generateCandles(count: number, startPrice: number): OHLCDataPoint[] {
  const out: OHLCDataPoint[] = new Array(count);
  let price = startPrice;
  let t = Date.now() - count * 1000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = (Math.sin(i * 0.07) + Math.cos(i * 0.03)) * 0.4;
    const shock = (Math.random() - 0.48) * 1.8;
    const close = Math.max(1, open + drift + shock);
    const high = Math.max(open, close) + Math.random() * 0.9;
    const low = Math.min(open, close) - Math.random() * 0.9;
    out[i] = [t, open, close, low, high];
    price = close;
    t += 1000;
  }
  return out;
}

async function mountCandles(container: HTMLElement): Promise<{ dispose: () => void }> {
  let data = generateCandles(120, 100);
  const candleSeries = {
    type: 'candlestick' as const,
    name: 'MEME',
    data,
    itemStyle: {
      upColor: LIME,
      downColor: ROSE,
      upBorderColor: LIME,
      downBorderColor: ROSE,
    },
  };

  const options: ChartGPUOptions = {
    ...plateChrome(),
    grid: { left: 4, right: 4, top: 16, bottom: 8 },
    autoScroll: true,
    dataZoom: [{ type: 'inside', start: 40, end: 100 }],
    xAxis: { type: 'time', tickFormatter: hideTicks },
    yAxis: { type: 'value', tickFormatter: hideTicks },
    series: [candleSeries],
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);

  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduced) {
    timer = setInterval(() => {
      if (cancelled || chart.disposed) return;
      const last = data[data.length - 1];
      if (!last || !Array.isArray(last)) return;
      const [, , prevClose] = last;
      const open = prevClose;
      const close = Math.max(1, open + (Math.random() - 0.48) * 2.2);
      const high = Math.max(open, close) + Math.random() * 0.7;
      const low = Math.min(open, close) - Math.random() * 0.7;
      const next: OHLCDataPoint = [last[0] + 1000, open, close, low, high];
      data = [...data.slice(-199), next];
      chart.setOption({
        ...options,
        series: [{ ...candleSeries, data }],
      });
    }, 280);
  }

  return {
    dispose: () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      ro.disconnect();
      chart.dispose();
    },
  };
}

async function mountBars(container: HTMLElement): Promise<{ dispose: () => void }> {
  const n = 48;
  const mk = (phase: number, amp: number, bias: number): DataPoint[] => {
    const out: DataPoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [i, Math.sin(i * 0.35 + phase) * amp + bias + (i % 5) * 0.15];
    }
    return out;
  };

  const options: ChartGPUOptions = {
    ...plateChrome(),
    grid: { left: 8, right: 8, top: 16, bottom: 8 },
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', tickFormatter: hideTicks },
    palette: [GOLD, BLUE, CYAN, ROSE],
    series: [
      { type: 'bar', name: 'a', data: mk(0, 2.2, 1.5), stack: 's', color: GOLD },
      { type: 'bar', name: 'b', data: mk(1.2, 1.8, 0.8), stack: 's', color: BLUE },
      { type: 'bar', name: 'c', data: mk(2.1, 1.4, -0.6), stack: 's', color: ROSE },
      { type: 'bar', name: 'd', data: mk(0.7, 1.1, -1.2), stack: 's', color: CYAN },
    ],
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);

  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tick = 0;

  if (!reduced) {
    timer = setInterval(() => {
      if (cancelled || chart.disposed) return;
      tick += 0.18;
      chart.setOption({
        ...options,
        series: [
          { type: 'bar', name: 'a', data: mk(tick, 2.2, 1.5), stack: 's', color: GOLD },
          { type: 'bar', name: 'b', data: mk(tick + 1.2, 1.8, 0.8), stack: 's', color: BLUE },
          { type: 'bar', name: 'c', data: mk(tick + 2.1, 1.4, -0.6), stack: 's', color: ROSE },
          { type: 'bar', name: 'd', data: mk(tick + 0.7, 1.1, -1.2), stack: 's', color: CYAN },
        ],
      });
    }, 900);
  }

  return {
    dispose: () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      ro.disconnect();
      chart.dispose();
    },
  };
}

async function mountStorm(container: HTMLElement): Promise<{ dispose: () => void }> {
  const seriesCount = 16;
  const points = 8_000;
  const series: LineSeries[] = [];

  for (let s = 0; s < seriesCount; s++) {
    const data: DataPoint[] = new Array(points);
    const phase = s * 0.41;
    const freq = 0.012 + s * 0.0017;
    for (let i = 0; i < points; i++) {
      const x = i;
      const y =
        Math.sin(i * freq + phase) * (0.6 + (s % 4) * 0.08) +
        Math.sin(i * freq * 3.1 + phase * 2) * 0.18 +
        s * 0.35;
      data[i] = [x, y];
    }
    series.push({
      type: 'line',
      name: `s${s}`,
      data,
      color: BRAND_PALETTE[s % BRAND_PALETTE.length],
      lineStyle: { width: 1, opacity: 0.85 },
      sampling: 'lttb',
      samplingThreshold: 2_500,
    });
  }

  const options: ChartGPUOptions = {
    ...plateChrome(),
    grid: { left: 4, right: 4, top: 8, bottom: 8 },
    dataZoom: [{ type: 'inside' }],
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', tickFormatter: hideTicks },
    palette: [...BRAND_PALETTE],
    series,
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);
  return {
    dispose: () => {
      ro.disconnect();
      chart.dispose();
    },
  };
}

// ── Lazy plate lifecycle ────────────────────────────────────────────────────

type DemoId = 'aurora' | 'density' | 'candles' | 'bars' | 'storm';

const demoMount: Record<DemoId, (el: HTMLElement) => Promise<{ dispose: () => void }>> = {
  aurora: mountAurora,
  density: mountDensity,
  candles: mountCandles,
  bars: mountBars,
  storm: mountStorm,
};

const active = new Map<string, { dispose: () => void }>();

async function ensureDemo(root: HTMLElement): Promise<void> {
  const id = root.dataset.demo as DemoId | undefined;
  if (!id || !demoMount[id] || active.has(id)) return;

  const canvas = root.querySelector<HTMLElement>('[data-canvas]');
  const status = root.querySelector<HTMLElement>('[data-status]');
  if (!canvas) return;

  try {
    if (status) status.textContent = 'Uploading to GPU…';
    const handle = await demoMount[id](canvas);
    active.set(id, handle);
    root.classList.add('is-ready');
    root.classList.remove('is-error');
  } catch (err) {
    root.classList.add('is-error');
    if (status) {
      status.textContent = err instanceof Error ? err.message : 'Failed to create chart';
    }
    console.error(`[dev-site] demo ${id}`, err);
  }
}

function observePlates(): void {
  const nodes = document.querySelectorAll<HTMLElement>('[data-demo]');
  if (!('IntersectionObserver' in window)) {
    nodes.forEach((n) => void ensureDemo(n));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target instanceof HTMLElement) {
          void ensureDemo(entry.target);
        }
      }
    },
    { rootMargin: '120px 0px', threshold: 0.05 }
  );

  nodes.forEach((n) => io.observe(n));
}

// ── Example index + viewer ──────────────────────────────────────────────────

function setupGallery(): void {
  const filtersEl = document.getElementById('filters');
  const galleryEl = document.getElementById('gallery');
  const indexCount = document.getElementById('indexCount');
  const viewerEl = document.getElementById('viewer');
  const viewerIframe = document.getElementById('viewerIframe') as HTMLIFrameElement | null;
  const viewerTitle = document.getElementById('viewerTitle');
  const viewerCategory = document.getElementById('viewerCategory');
  const viewerNewTab = document.getElementById('viewerNewTab') as HTMLAnchorElement | null;

  if (!filtersEl || !galleryEl || !viewerEl || !viewerIframe) return;

  let activeCategory = 'all';

  const openViewer = (ex: Example): void => {
    if (viewerTitle) viewerTitle.textContent = ex.title;
    if (viewerCategory) viewerCategory.textContent = categoryLabels[ex.category] ?? ex.category;
    if (viewerNewTab) viewerNewTab.href = ex.path;
    viewerIframe.src = ex.path;
    viewerEl.classList.add('active');
    viewerEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  const closeViewer = (): void => {
    viewerEl.classList.remove('active');
    viewerEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setTimeout(() => {
      viewerIframe.src = 'about:blank';
    }, 250);
  };

  document.getElementById('viewerBack')?.addEventListener('click', closeViewer);
  document.getElementById('viewerBackdrop')?.addEventListener('click', closeViewer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && viewerEl.classList.contains('active')) closeViewer();
  });

  const renderGallery = (): void => {
    const filtered =
      activeCategory === 'all' ? examples : examples.filter((e) => e.category === activeCategory);
    if (indexCount) {
      indexCount.textContent =
        activeCategory === 'all'
          ? `${examples.length} demos`
          : `${filtered.length} · ${categoryLabels[activeCategory] ?? activeCategory}`;
    }
    galleryEl.innerHTML = '';
    for (const ex of filtered) {
      const card = document.createElement('a');
      card.href = ex.path;
      card.className = 'card';
      card.dataset.id = ex.id;
      card.innerHTML = `
        <span class="card-category">${categoryLabels[ex.category] ?? ex.category}</span>
        <h3 class="card-title">${ex.title}</h3>
        <p class="card-desc">${ex.desc}</p>
      `;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        openViewer(ex);
      });
      galleryEl.appendChild(card);
    }
  };

  for (const cat of categories) {
    const count = cat.id === 'all' ? examples.length : examples.filter((e) => e.category === cat.id).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-tab' + (cat.id === 'all' ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', cat.id === 'all' ? 'true' : 'false');
    btn.dataset.category = cat.id;
    btn.innerHTML = `${cat.label}<span class="filter-count">${count}</span>`;
    btn.addEventListener('click', () => {
      activeCategory = cat.id;
      filtersEl.querySelectorAll('.filter-tab').forEach((tab) => {
        const el = tab as HTMLElement;
        const isActive = el.dataset.category === cat.id;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      renderGallery();
    });
    filtersEl.appendChild(btn);
  }

  renderGallery();

  // Plate "Open full demo" links use the viewer when possible
  document.querySelectorAll<HTMLAnchorElement>('[data-open-example]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.dataset.openExample;
      const ex = examples.find((x) => x.id === id);
      if (!ex) return;
      e.preventDefault();
      openViewer(ex);
    });
  });
}

function setupCopy(): void {
  const copyBtn = document.getElementById('copyBtn');
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('npm install @chartgpu/chartgpu');
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('is-copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('is-copied');
      }, 2000);
    } catch {
      copyBtn.textContent = 'Failed';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    }
  });
}

function checkWebGPU(): boolean {
  const ok = typeof navigator !== 'undefined' && 'gpu' in navigator;
  if (!ok) {
    document.getElementById('gpuBanner')?.classList.add('is-visible');
  }
  return ok;
}

// ── Boot ────────────────────────────────────────────────────────────────────

function main(): void {
  setupGallery();
  setupCopy();
  const gpu = checkWebGPU();
  if (gpu) observePlates();
  else {
    document.querySelectorAll<HTMLElement>('[data-demo]').forEach((el) => {
      el.classList.add('is-error');
      const status = el.querySelector<HTMLElement>('[data-status]');
      if (status) status.textContent = 'WebGPU unavailable';
    });
  }

  window.addEventListener('pagehide', () => {
    for (const h of active.values()) h.dispose();
    active.clear();
  });
}

main();
