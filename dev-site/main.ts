/**
 * ChartGPU dev-site showcase — live WebGPU plates + example index.
 */
import { ChartGPU, createPipelineCache } from '../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  DataPoint,
  OHLCDataPoint,
  ScatterPointTuple,
} from '../src/index';
import chartgpuLogoUrl from '../docs/assets/chartgpu.png';
import webgpuComIconUrl from '../docs/assets/webgpu-com.png';

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

/**
 * Example URL under Vite base (`/` in dev, `/ChartGPU/` on Pages).
 * Dev serves demos from the source tree under `/examples/…`.
 * Production flattens demos to the site root (same layout as the prior Pages build).
 */
const examplePath = (id: string): string => {
  const base = import.meta.env.BASE_URL;
  if (import.meta.env.DEV) {
    return `${base}examples/${id}/index.html`;
  }
  return `${base}${id}/index.html`;
};

const examples: readonly Example[] = [
  {
    id: 'streaming-dashboard',
    title: 'Streaming Dashboard',
    desc: 'Five-chart APM dashboard with live latency percentiles, throughput, and real-time annotations',
    category: 'streaming',
    path: examplePath('streaming-dashboard'),
  },
  {
    id: 'candlestick-streaming',
    title: 'Candlestick Streaming',
    desc: 'Crypto trading terminal with live tick simulation and real-time candle aggregation',
    category: 'streaming',
    path: examplePath('candlestick-streaming'),
  },
  {
    id: 'scatter-density-1m',
    title: 'Scatter Density 1M',
    desc: 'One million points rendered as a GPU-binned density heatmap with colormap controls',
    category: 'performance',
    path: examplePath('scatter-density-1m'),
  },
  {
    id: 'heatmap-spectrogram',
    title: 'Uniform Heatmap / Spectrogram',
    desc: 'Data-grid heatmap (type: heatmap) with static peaks and a live spectrogram window — not scatter density',
    category: 'series',
    path: examplePath('heatmap-spectrogram'),
  },
  {
    id: 'band-range',
    title: 'Band / Range Series',
    desc: 'Fill between y and y1 (type: band) — confidence intervals, live min–max envelopes, threshold fills',
    category: 'series',
    path: examplePath('band-range'),
  },
  {
    id: '3d-showcase',
    title: '3D Showcase',
    desc: 'Labeled axes, contours, cloud FIFO + surface strip streaming, pick tooltips — cartesian3d product demo',
    category: 'series',
    path: examplePath('3d-showcase'),
  },
  {
    id: 'point-cloud-3d',
    title: '3D Point Cloud',
    desc: 'cartesian3d + pointCloud3d — world XYZ billboards with depth and orbit camera (not scatter density)',
    category: 'series',
    path: examplePath('point-cloud-3d'),
  },
  {
    id: 'surface-3d',
    title: '3D Surface',
    desc: 'surface3d uniform XZ height field with colormap, lighting, and optional point cloud overlay',
    category: 'series',
    path: examplePath('surface-3d'),
  },
  {
    id: 'basic-line',
    title: 'Basic Line',
    desc: 'Sine wave line chart with grid, axes, and tooltip interaction',
    category: 'series',
    path: examplePath('basic-line'),
  },
  {
    id: 'candlestick',
    title: 'Candlestick',
    desc: 'Financial OHLC chart with classic and hollow style toggle',
    category: 'series',
    path: examplePath('candlestick'),
  },
  {
    id: 'scatter',
    title: 'Scatter Plot',
    desc: 'Fixed size, per-point size, and dynamic size function variants',
    category: 'series',
    path: examplePath('scatter'),
  },
  {
    id: 'grouped-bar',
    title: 'Grouped & Stacked Bar',
    desc: 'Clustered bars with stacking, custom widths, and negative values',
    category: 'series',
    path: examplePath('grouped-bar'),
  },
  {
    id: 'pie',
    title: 'Pie & Donut',
    desc: 'Pie chart and donut chart with per-slice colors',
    category: 'series',
    path: examplePath('pie'),
  },
  {
    id: 'live-streaming',
    title: 'Live Streaming',
    desc: 'Streaming appendData with autoScroll toggle and dataZoom slider',
    category: 'streaming',
    path: examplePath('live-streaming'),
  },
  {
    id: 'million-points',
    title: 'Million Points',
    desc: '1M point benchmark with sampling toggle and FPS comparison',
    category: 'performance',
    path: examplePath('million-points'),
  },
  {
    id: 'ultimate-benchmark',
    title: 'Ultimate Benchmark',
    desc: 'Multi-series stress test with FPS, frame-time metrics, and streaming append',
    category: 'performance',
    path: examplePath('ultimate-benchmark'),
  },
  {
    id: 'sampling',
    title: 'Zoom-Aware Sampling',
    desc: 'Zoom in for detail, zoom out for performance with debounced re-sampling',
    category: 'performance',
    path: examplePath('sampling'),
  },
  {
    id: 'interactive',
    title: 'Interactive',
    desc: 'Synced crosshair and axis tooltip across two stacked charts with click logging',
    category: 'interaction',
    path: examplePath('interactive'),
  },
  {
    id: 'chart-sync',
    title: 'Chart Sync',
    desc: 'Two charts with synced crosshair position and axis tooltip values',
    category: 'interaction',
    path: examplePath('chart-sync'),
  },
  {
    id: 'annotation-authoring',
    title: 'Annotations',
    desc: 'Reference lines, point markers, text annotations with authoring and JSON export',
    category: 'interaction',
    path: examplePath('annotation-authoring'),
  },
  {
    id: 'exchange-gaps',
    title: 'Exchange Gaps',
    desc: 'Null gap entries for maintenance windows with connectNulls toggle',
    category: 'interaction',
    path: examplePath('exchange-gaps'),
  },
  {
    id: 'data-update-animation',
    title: 'Data Update Animation',
    desc: 'Animated transitions for y-values, scales, and pie slice angles',
    category: 'animation',
    path: examplePath('data-update-animation'),
  },
  {
    id: 'multi-series-animation',
    title: 'Multi-Series Animation',
    desc: 'Line, bar, scatter, and area series animating together on data update',
    category: 'animation',
    path: examplePath('multi-series-animation'),
  },
  {
    id: 'tick-formatter',
    title: 'Custom Tick Formatter',
    desc: 'Percentage, duration, locale time, and integer-only formatting',
    category: 'config',
    path: examplePath('tick-formatter'),
  },
  {
    id: 'external-render-mode',
    title: 'External Render Mode',
    desc: 'Application-controlled rendering with shared rAF loop and mode switching',
    category: 'config',
    path: examplePath('external-render-mode'),
  },
  {
    id: 'cartesian-data-formats',
    title: 'Data Formats',
    desc: 'XYArraysData, InterleavedXYData, and array-of-objects with 100k points',
    category: 'config',
    path: examplePath('cartesian-data-formats'),
  },
  {
    id: 'grid-test',
    title: 'Grid Renderer',
    desc: 'Configurable grid line counts for horizontal and vertical axes',
    category: 'config',
    path: examplePath('grid-test'),
  },
  {
    id: 'hello-world',
    title: 'Hello World',
    desc: 'Raw WebGPU clear color cycling through the color spectrum',
    category: 'config',
    path: examplePath('hello-world'),
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

/**
 * Smooth streaming pump — rAF + fixed timestep, max one sample per frame.
 * Replaces setInterval (which coalesces under load and looks stop-start).
 */
type StreamPump = { readonly stop: () => void };

const startStreamPump = (
  sample: (now: number, tick: number) => void,
  opts?: { readonly hz?: number; readonly reduced?: boolean }
): StreamPump => {
  const reduced =
    opts?.reduced ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return { stop: () => undefined };

  const sampleMs = 1000 / (opts?.hz ?? 48);
  let raf = 0;
  let cancelled = false;
  let lastSampleAt = performance.now();
  let tick = 0;

  const pump = (now: number): void => {
    if (cancelled) return;
    raf = requestAnimationFrame(pump);
    if (now - lastSampleAt < sampleMs) return;
    // Snap to now (no multi-step catch-up → no domain multi-jumps after a stall).
    lastSampleAt = now;
    tick += 1;
    sample(now, tick);
  };
  raf = requestAnimationFrame(pump);

  return {
    stop: () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
};

/** Per-series 1-point columnar buffers (identity-stable for pending append). */
const createAppendBufs = (count: number): ReadonlyArray<{ x: Float64Array; y: Float64Array }> =>
  Array.from({ length: count }, () => ({
    x: new Float64Array(1),
    y: new Float64Array(1),
  }));

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
  const seriesCount = 1000;
  // Dense enough for a continuous ribbon; ring stays modest so GPU stays light.
  const seedPoints = 160;
  const maxPoints = 420;
  // Smaller steps at higher sample rate → same wave speed, smoother autoScroll.
  const dt = 0.022;
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

  const appendBufs = createAppendBufs(seriesCount);
  const stream = startStreamPump(() => {
    if (chart.disposed) return;
    const t = tCursor;
    for (let s = 0; s < seriesCount; s++) {
      const buf = appendBufs[s]!;
      buf.x[0] = t;
      buf.y[0] = waveY(t, s, seriesCount);
      chart.appendData(s, buf, { maxPoints });
    }
    tCursor += dt;
  }, { hz: 48 });

  return {
    dispose: () => {
      stream.stop();
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
  // Match examples/scatter-density-1m: two tight Gaussian blobs + light noise.
  // Concentrated cores read as hot yellows on inferno; log norm lifts the purple halos.
  const rng = mulberry32(seed);
  const out: ScatterPointTuple[] = new Array(count);
  const chunk = 40_000;
  for (let base = 0; base < count; base += chunk) {
    const end = Math.min(count, base + chunk);
    for (let i = base; i < end; i++) {
      const t = rng();
      const blob = t < 0.6 ? 0 : 1;
      const cx = blob === 0 ? 0.35 : 0.7;
      const cy = blob === 0 ? 0.55 : 0.35;
      const sx = blob === 0 ? 0.08 : 0.05;
      const sy = blob === 0 ? 0.1 : 0.07;
      const u1 = Math.max(1e-12, rng());
      const u2 = rng();
      const r = Math.sqrt(-2.0 * Math.log(u1));
      const theta = 2.0 * Math.PI * u2;
      const x = cx + r * Math.cos(theta) * sx + (rng() - 0.5) * 0.03;
      const y = cy + r * Math.sin(theta) * sy + (rng() - 0.5) * 0.03;
      out[i] = [x, y];
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

async function mountDensity(container: HTMLElement): Promise<{ dispose: () => void }> {
  const n = 1_000_000;
  const points = await createDensityPoints(n, 1337);
  // No inside dataZoom — wheel scrolls the page past this plate, not zoom the chart.
  const options: ChartGPUOptions = {
    ...plateChrome(),
    grid: { left: 4, right: 4, top: 4, bottom: 4 },
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', tickFormatter: hideTicks },
    series: [
      {
        type: 'scatter',
        name: 'density',
        data: points,
        mode: 'density',
        // Same punch as scatter-density-1m defaults: fine bins + log curve.
        // Colormap stays inferno (site plate identity); only resolution/contrast change.
        binSize: 2,
        densityColormap: 'inferno',
        densityNormalization: 'log',
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

/**
 * Left diptych plate — streaming multi-series mountain (not candles; wall already has OHLC).
 * Overlapping area fills + continuous append: dense, animated proof of GPU throughput.
 */
async function mountMountain(container: HTMLElement): Promise<{ dispose: () => void }> {
  const seriesCount = 64;
  const seedPoints = 180;
  const maxPoints = 520;
  const dt = 0.028;
  let tCursor = 0;

  const series: LineSeries[] = [];
  for (let s = 0; s < seriesCount; s++) {
    const data: DataPoint[] = new Array(seedPoints);
    for (let i = 0; i < seedPoints; i++) {
      const t = i * dt;
      data[i] = [t, waveY(t, s, seriesCount)];
    }
    const fill = 0.1 + (s % 5) * 0.018;
    series.push({
      type: 'line',
      name: `m${s}`,
      data,
      color: seriesColor(s, seriesCount),
      lineStyle: { width: s % 11 === 0 ? 1.5 : 1, opacity: 0.92 },
      areaStyle: { opacity: fill },
      sampling: 'none',
    });
  }
  tCursor = seedPoints * dt;

  const options: ChartGPUOptions = {
    ...plateChrome(MIDNIGHT_THEME),
    autoScroll: true,
    xAxis: { type: 'value', tickFormatter: hideTicks },
    yAxis: { type: 'value', min: -4.2, max: 4.2, tickFormatter: hideTicks },
    palette: [...BRAND_PALETTE],
    series,
  };

  const chart = await ChartGPU.create(container, options);
  const ro = attachResize(container, chart);
  const appendBufs = createAppendBufs(seriesCount);

  const stream = startStreamPump(() => {
    if (chart.disposed) return;
    const t = tCursor;
    for (let s = 0; s < seriesCount; s++) {
      const buf = appendBufs[s]!;
      buf.x[0] = t;
      buf.y[0] = waveY(t, s, seriesCount);
      chart.appendData(s, buf, { maxPoints });
    }
    tCursor += dt;
  }, { hz: 48 });

  return {
    dispose: () => {
      stream.stop();
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

  // Morph stacks smoothly (~12 Hz, small phase steps) instead of 900ms jumps.
  let phase = 0;
  const stream = startStreamPump(() => {
    if (chart.disposed) return;
    phase += 0.05;
    chart.setOption({
      ...options,
      series: [
        { type: 'bar', name: 'a', data: mk(phase, 2.2, 1.5), stack: 's', color: GOLD },
        { type: 'bar', name: 'b', data: mk(phase + 1.2, 1.8, 0.8), stack: 's', color: BLUE },
        { type: 'bar', name: 'c', data: mk(phase + 2.1, 1.4, -0.6), stack: 's', color: ROSE },
        { type: 'bar', name: 'd', data: mk(phase + 0.7, 1.1, -1.2), stack: 's', color: CYAN },
      ],
    });
  }, { hz: 12 });

  return {
    dispose: () => {
      stream.stop();
      ro.disconnect();
      chart.dispose();
    },
  };
}

/**
 * Finale wall — substantial multi-series dashboard panels on one shared GPU.
 * Each panel is a complete use-case dataset (labels, annotations, dual axes),
 * not decorative empty sparklines. Top-left is APM (not a hero multi-line twin).
 */
async function mountWall(container: HTMLElement): Promise<{ dispose: () => void }> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const pipelineCache = createPipelineCache(device);
  const shared = { adapter, device, pipelineCache };

  const wallTheme: NonNullable<ChartGPUOptions['theme']> = {
    backgroundColor: '#0c0e14',
    textColor: '#C8CDD6',
    axisLineColor: 'rgba(226,229,235,0.18)',
    axisTickColor: 'rgba(226,229,235,0.32)',
    gridLineColor: 'rgba(255,255,255,0.05)',
    colorPalette: [...BRAND_PALETTE],
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: 10,
  };

  const softAnim: ChartGPUOptions['animation'] = { duration: 520, easing: 'cubicOut', delay: 0 };
  const noAnim: ChartGPUOptions['animation'] = false;

  type CellSpec = { id: string; className: string; title: string; meta: string };

  const cells: CellSpec[] = [
    { id: 'apm', className: 'wall-cell wall-cell--apm', title: 'API latency', meta: 'P50 · P95 · P99' },
    { id: 'trade', className: 'wall-cell wall-cell--trade', title: 'MEME / USD', meta: 'OHLC + volume' },
    { id: 'stack', className: 'wall-cell wall-cell--stack', title: 'Revenue by region', meta: 'Stacked · live' },
    { id: 'pool', className: 'wall-cell wall-cell--pool', title: 'Connection pool', meta: 'Active · waiting' },
    { id: 'scatter', className: 'wall-cell wall-cell--scatter', title: 'Latency vs size', meta: '3 cohorts' },
    { id: 'pie', className: 'wall-cell wall-cell--pie', title: 'GPU frame budget', meta: 'ms / pass' },
    { id: 'errors', className: 'wall-cell wall-cell--errors', title: 'Error rate', meta: '4xx · 5xx' },
    { id: 'combo', className: 'wall-cell wall-cell--combo', title: 'Throughput + errors', meta: 'Dual axis' },
  ];

  container.replaceChildren();
  const hosts = new Map<string, HTMLElement>();
  for (const c of cells) {
    const el = document.createElement('div');
    el.className = c.className;
    el.dataset.wallCell = c.id;

    const title = document.createElement('span');
    title.className = 'wall-cell__title';
    title.textContent = c.title;
    const meta = document.createElement('span');
    meta.className = 'wall-cell__meta';
    meta.textContent = c.meta;
    el.append(title, meta);

    container.appendChild(el);
    hosts.set(c.id, el);
  }

  const requireHost = (id: string): HTMLElement => {
    const h = hosts.get(id);
    if (!h) throw new Error(`wall cell missing: ${id}`);
    return h;
  };

  // ── Complete datasets (one coherent story per panel) ────────────────────
  const seedN = 90;
  const t0 = Date.now() - seedN * 1000;
  const timeAt = (i: number): number => t0 + i * 1000;

  /** APM: correlated latency percentiles from one service trace. */
  type ApmRow = { t: number; p50: number; p95: number; p99: number };
  const apmRows: ApmRow[] = [];
  for (let i = 0; i < seedN; i++) {
    const load = 0.55 + 0.35 * Math.sin(i * 0.11) + 0.12 * Math.sin(i * 0.37);
    const incident = i > 48 && i < 58 ? 1.8 : 1;
    const p50 = (18 + load * 22 + Math.sin(i * 0.2) * 3) * incident;
    const p95 = p50 * (2.1 + 0.15 * Math.sin(i * 0.09));
    const p99 = p95 * (1.45 + 0.1 * Math.sin(i * 0.07));
    apmRows.push({ t: timeAt(i), p50, p95, p99 });
  }
  const SLO_MS = 120;
  let apmCursor = seedN;

  /** Trade: OHLC + volume from one tape. */
  let tradeCandles = generateCandles(100, 148);
  const tradeVolume = (ohlc: OHLCDataPoint[]): DataPoint[] =>
    ohlc.map((c, i) => {
      const body = Math.abs(c[2] - c[1]);
      const vol = 40 + body * 28 + (i % 5) * 6 + Math.sin(i * 0.3) * 12;
      return [c[0], Math.max(4, vol)] as DataPoint;
    });
  let tradeVol = tradeVolume(tradeCandles);
  const tradeSupport = (() => {
    const prices = tradeCandles.map((c) => c[3]);
    return Math.min(...prices) + (Math.max(...prices) - Math.min(...prices)) * 0.22;
  })();

  /** Stacked revenue: 12 months × 4 regions. */
  const regions = [
    { name: 'NA', color: GOLD },
    { name: 'EU', color: BLUE },
    { name: 'APAC', color: CYAN },
    { name: 'LATAM', color: ROSE },
  ] as const;
  const months = 12;
  const monthLabel = (i: number): string => {
    const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    return names[i % 12] ?? String(i);
  };
  let stackPhase = 0;
  const buildStackSeries = (phase: number): NonNullable<ChartGPUOptions['series']> =>
    regions.map((r, ri) => {
      const data: DataPoint[] = new Array(months);
      for (let m = 0; m < months; m++) {
        // Even stack bands so all four regions read clearly
        const base =
          10 +
          ri * 7 +
          Math.sin(m * 0.55 + ri * 0.9 + phase) * 3.5 +
          Math.cos(m * 0.3 + ri) * 2;
        data[m] = [m, Math.max(4, base)];
      }
      return {
        type: 'bar' as const,
        name: r.name,
        data,
        stack: 'rev',
        color: r.color,
        barCategoryGap: 0.28,
      };
    });

  /** Pool: active + waiting — own sliding window (avoid area+append ring collapse). */
  type PoolRow = { t: number; active: number; waiting: number };
  const POOL_MAX = 200;
  const poolWindow = 80;
  const poolSample = (i: number): PoolRow => {
    // Stronger amplitude so dual areas read as real curves, not flat slabs
    const surge = i > 40 && i < 52 ? 48 : 0;
    const active = Math.min(
      POOL_MAX + 8,
      110 + Math.sin(i * 0.19) * 55 + Math.sin(i * 0.07) * 22 + surge
    );
    const waiting = Math.max(
      6,
      22 + Math.sin(i * 0.28 + 0.6) * 16 + Math.max(0, active - 150) * 0.9 + surge * 0.45
    );
    return { t: timeAt(i), active, waiting };
  };
  let poolCursor = seedN;
  let poolRows: PoolRow[] = Array.from({ length: poolWindow }, (_, i) =>
    poolSample(poolCursor - poolWindow + i)
  );
  const poolSeriesData = (
    rows: PoolRow[]
  ): { active: DataPoint[]; waiting: DataPoint[] } => ({
    active: rows.map((r) => [r.t, r.active] as DataPoint),
    waiting: rows.map((r) => [r.t, r.waiting] as DataPoint),
  });

  /** Scatter: three request cohorts (latency vs payload size). */
  const scatterCohorts = (() => {
    const rng = mulberry32(2026);
    const mk = (n: number, cx: number, cy: number, sx: number, sy: number): ScatterPointTuple[] => {
      const out: ScatterPointTuple[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const u1 = Math.max(1e-12, rng());
        const u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1));
        const th = 2 * Math.PI * u2;
        out[i] = [cx + r * Math.cos(th) * sx, cy + r * Math.sin(th) * sy];
      }
      return out;
    };
    return {
      cache: mk(420, 28, 18, 8, 5),
      origin: mk(380, 72, 48, 14, 12),
      heavy: mk(260, 140, 95, 22, 18),
    };
  })();

  /** GPU frame budget pie. */
  let pieSlices = [
    { name: 'Main pass', value: 42, color: CYAN },
    { name: 'Overlay', value: 22, color: BLUE },
    { name: 'Decimate', value: 16, color: VIOLET },
    { name: 'Upload', value: 12, color: GOLD },
    { name: 'Idle', value: 8, color: STEEL },
  ];

  /** Errors 4xx/5xx. */
  type ErrRow = { t: number; e4: number; e5: number };
  const errRows: ErrRow[] = [];
  for (let i = 0; i < seedN; i++) {
    const e5 = Math.max(0, 0.4 + Math.sin(i * 0.18) * 0.5 + (i > 50 && i < 62 ? 4.5 : 0));
    const e4 = 2.2 + Math.sin(i * 0.12 + 1) * 1.1 + Math.sin(i * 0.4) * 0.4;
    errRows.push({ t: timeAt(i), e4, e5 });
  }
  let errCursor = seedN;

  /** Combo: throughput (bars) + error % (line) dual axis from one traffic log. */
  type ComboRow = { x: number; rps: number; errPct: number };
  const comboRows: ComboRow[] = [];
  for (let i = 0; i < 36; i++) {
    const rps = 800 + Math.sin(i * 0.35) * 280 + Math.sin(i * 0.11) * 90 + (i % 4) * 20;
    const errPct = Math.max(0.05, 1.8 - rps / 1200 + Math.sin(i * 0.5) * 0.4);
    comboRows.push({ x: i, rps, errPct });
  }
  let comboPhase = 0;

  const fmtMs = (v: number): string => `${Math.round(v)}`;
  const fmtPct = (v: number): string => `${v.toFixed(1)}%`;
  const fmtInt = (v: number): string => `${Math.round(v)}`;

  const configs: { id: string; options: ChartGPUOptions }[] = [
    // 1 · APM latency — top-left is NOT a multi-line hero twin
    {
      id: 'apm',
      options: {
        theme: wallTheme,
        grid: { left: 44, right: 12, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 4 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: noAnim,
        autoScroll: true,
        xAxis: { type: 'time' },
        yAxis: { type: 'value', name: 'ms', min: 0 },
        annotations: [
          {
            type: 'lineY',
            y: SLO_MS,
            layer: 'aboveSeries',
            style: { color: ROSE, lineWidth: 1, lineDash: [5, 4], opacity: 0.85 },
            label: {
              text: `SLO ${SLO_MS}ms`,
              offset: [6, -10],
              anchor: 'start',
              background: { color: '#0c0e14', opacity: 0.85, padding: [2, 5, 2, 5], borderRadius: 3 },
            },
          },
          {
            type: 'bandX',
            from: timeAt(49),
            to: timeAt(57),
            layer: 'belowSeries',
            style: { color: ROSE, opacity: 0.12 },
            label: {
              text: 'Incident',
              offset: [4, 12],
              anchor: 'start',
            },
          },
        ],
        series: [
          {
            type: 'line',
            name: 'P50',
            data: apmRows.map((r) => [r.t, r.p50] as DataPoint),
            color: LIME,
            lineStyle: { width: 2 },
            sampling: 'none',
          },
          {
            type: 'line',
            name: 'P95',
            data: apmRows.map((r) => [r.t, r.p95] as DataPoint),
            color: GOLD,
            lineStyle: { width: 2 },
            sampling: 'none',
          },
          {
            type: 'line',
            name: 'P99',
            data: apmRows.map((r) => [r.t, r.p99] as DataPoint),
            color: ROSE,
            lineStyle: { width: 1.5, opacity: 0.9 },
            sampling: 'none',
          },
        ],
      },
    },
    // 2 · Trade: OHLC + volume dual-axis, price label, support annotation
    {
      id: 'trade',
      options: {
        theme: wallTheme,
        grid: { left: 48, right: 52, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 4 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: noAnim,
        autoScroll: true,
        xAxis: { type: 'time' },
        yAxis: { type: 'value', header: 'USD' },
        axes: {
          y: [
            { id: 'price', position: 'right', name: 'USD' },
            { id: 'vol', position: 'left', name: 'Vol', min: 0 },
          ],
        },
        annotations: [
          {
            type: 'lineY',
            y: tradeSupport,
            layer: 'aboveSeries',
            style: { color: CYAN, lineWidth: 1, lineDash: [4, 4], opacity: 0.7 },
            label: {
              text: 'Support',
              offset: [8, -10],
              anchor: 'start',
              background: { color: '#0c0e14', opacity: 0.8, padding: [2, 5, 2, 5], borderRadius: 3 },
            },
          },
        ],
        series: [
          {
            type: 'bar',
            name: 'Volume',
            data: tradeVol,
            color: BLUE,
            yAxis: 'vol',
            barCategoryGap: 0.15,
          },
          {
            type: 'candlestick',
            name: 'MEME',
            data: tradeCandles,
            yAxis: 'price',
            itemStyle: {
              upColor: LIME,
              downColor: ROSE,
              upBorderColor: LIME,
              downBorderColor: ROSE,
            },
            priceLabel: { intervalMs: 1000, nowMs: () => Date.now() },
          },
        ],
      },
    },
    // 3 · Stacked regional revenue
    {
      id: 'stack',
      options: {
        theme: wallTheme,
        grid: { left: 36, right: 10, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 3 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: softAnim,
        xAxis: {
          type: 'value',
          min: 0,
          max: months - 1,
          tickFormatter: (v) => monthLabel(Math.round(v)),
        },
        yAxis: { type: 'value', name: '$k', min: 0, tickFormatter: fmtInt },
        series: buildStackSeries(0),
      },
    },
    // 4 · Connection pool dual area + max annotation
    // Note: pure area + autoScroll + appendData ring storage was collapsing the mesh
    // into a right-edge strip / solid slab. Use line+areaStyle and setOption windows.
    {
      id: 'pool',
      options: {
        theme: wallTheme,
        grid: { left: 40, right: 12, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 4 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: noAnim,
        // Domain follows the sliding window we push via setOption (no autoScroll ring).
        autoScroll: false,
        xAxis: { type: 'time' },
        yAxis: { type: 'value', name: 'conns', min: 0, max: 240 },
        annotations: [
          {
            type: 'lineY',
            y: POOL_MAX,
            layer: 'aboveSeries',
            style: { color: ROSE, lineWidth: 1, lineDash: [4, 4], opacity: 0.8 },
            label: {
              text: `Max ${POOL_MAX}`,
              offset: [6, -10],
              anchor: 'start',
              background: { color: '#0c0e14', opacity: 0.85, padding: [2, 5, 2, 5], borderRadius: 3 },
            },
          },
        ],
        series: (() => {
          const d = poolSeriesData(poolRows);
          return [
            {
              type: 'line' as const,
              name: 'Active',
              data: d.active,
              color: CYAN,
              lineStyle: { width: 2 },
              areaStyle: { opacity: 0.32 },
              sampling: 'none' as const,
            },
            {
              type: 'line' as const,
              name: 'Waiting',
              data: d.waiting,
              color: ROSE,
              lineStyle: { width: 2 },
              areaStyle: { opacity: 0.22 },
              sampling: 'none' as const,
            },
          ];
        })(),
      },
    },
    // 5 · Scatter cohorts with point annotations
    {
      id: 'scatter',
      options: {
        theme: wallTheme,
        grid: { left: 40, right: 10, top: 28, bottom: 32 },
        gridLines: { show: true, horizontal: { show: true, count: 3 }, vertical: { show: true, count: 3 } },
        tooltip: { show: true, trigger: 'item' },
        legend: { show: true },
        animation: softAnim,
        xAxis: { type: 'value', name: 'Payload KB', min: 0 },
        yAxis: { type: 'value', name: 'ms', min: 0, tickFormatter: fmtMs },
        annotations: [
          {
            type: 'point',
            x: 28,
            y: 18,
            layer: 'aboveSeries',
            marker: { size: 8, style: { color: LIME } },
            label: { text: 'Cache hit', offset: [8, -8], anchor: 'start' },
          },
          {
            type: 'point',
            x: 140,
            y: 95,
            layer: 'aboveSeries',
            marker: { size: 8, style: { color: ROSE } },
            label: { text: 'Heavy', offset: [8, -8], anchor: 'start' },
          },
        ],
        series: [
          {
            type: 'scatter',
            name: 'Cache',
            data: scatterCohorts.cache,
            color: LIME,
            symbolSize: 4,
            sampling: 'none',
          },
          {
            type: 'scatter',
            name: 'Origin',
            data: scatterCohorts.origin,
            color: GOLD,
            symbolSize: 4,
            sampling: 'none',
          },
          {
            type: 'scatter',
            name: 'Heavy',
            data: scatterCohorts.heavy,
            color: VIOLET,
            symbolSize: 5,
            sampling: 'none',
          },
        ],
      },
    },
    // 6 · GPU budget pie — bottom-left, caption is top-right so this stays visible
    {
      id: 'pie',
      options: {
        theme: wallTheme,
        // Room for legend on the right; no cartesian chrome for a donut.
        grid: { left: 12, right: 96, top: 28, bottom: 12 },
        gridLines: { show: false },
        tooltip: { show: true, trigger: 'item' },
        legend: { show: true },
        animation: softAnim,
        // Axes are required by the coordinator but unused for pie — suppress all ticks.
        xAxis: { type: 'value', min: 0, max: 1, tickLength: 0, name: '', tickFormatter: hideTicks },
        yAxis: { type: 'value', min: 0, max: 1, tickLength: 0, name: '', tickFormatter: hideTicks },
        series: [
          {
            type: 'pie',
            name: 'Frame ms',
            data: pieSlices,
            radius: ['38%', '68%'],
            center: ['38%', '54%'],
          },
        ],
      },
    },
    // 7 · Error rates with budget annotation
    {
      id: 'errors',
      options: {
        theme: wallTheme,
        grid: { left: 36, right: 10, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 3 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: noAnim,
        autoScroll: true,
        xAxis: { type: 'time' },
        yAxis: { type: 'value', name: 'err/s', min: 0 },
        annotations: [
          {
            type: 'lineY',
            y: 3,
            layer: 'aboveSeries',
            style: { color: AMBER, lineWidth: 1, lineDash: [4, 3], opacity: 0.85 },
            label: {
              text: 'Budget',
              offset: [6, -10],
              anchor: 'start',
              background: { color: '#0c0e14', opacity: 0.85, padding: [2, 5, 2, 5], borderRadius: 3 },
            },
          },
        ],
        series: [
          {
            type: 'line',
            name: '5xx',
            data: errRows.map((r) => [r.t, r.e5] as DataPoint),
            color: ROSE,
            lineStyle: { width: 2 },
            sampling: 'none',
          },
          {
            type: 'line',
            name: '4xx',
            data: errRows.map((r) => [r.t, r.e4] as DataPoint),
            color: AMBER,
            lineStyle: { width: 1.5 },
            sampling: 'none',
          },
        ],
      },
    },
    // 8 · Throughput bars + error% line dual-axis
    {
      id: 'combo',
      options: {
        theme: wallTheme,
        grid: { left: 44, right: 40, top: 28, bottom: 28 },
        gridLines: { show: true, horizontal: { show: true, count: 3 }, vertical: { show: false } },
        tooltip: { show: true, trigger: 'axis' },
        legend: { show: true },
        animation: softAnim,
        xAxis: { type: 'value', name: 'Bucket', min: 0, max: 35 },
        yAxis: { type: 'value' },
        axes: {
          y: [
            { id: 'rps', position: 'left', name: 'req/s', min: 0 },
            { id: 'err', position: 'right', name: 'err %', min: 0, max: 5, tickFormatter: fmtPct },
          ],
        },
        series: [
          {
            type: 'bar',
            name: 'RPS',
            data: comboRows.map((r) => [r.x, r.rps] as DataPoint),
            color: BLUE,
            yAxis: 'rps',
            barCategoryGap: 0.2,
          },
          {
            type: 'line',
            name: 'Error %',
            data: comboRows.map((r) => [r.x, r.errPct] as DataPoint),
            color: ROSE,
            yAxis: 'err',
            lineStyle: { width: 2.5 },
            sampling: 'none',
          },
        ],
      },
    },
  ];

  const charts: ChartGPUInstance[] = [];
  const observers: ResizeObserver[] = [];
  const optionsById = new Map(configs.map((c) => [c.id, c.options]));

  for (const cfg of configs) {
    const host = requireHost(cfg.id);
    const chart = await ChartGPU.create(host, cfg.options, shared);
    charts.push(chart);
    observers.push(attachResize(host, chart));
  }

  const byId = (id: string): ChartGPUInstance | undefined => {
    const idx = configs.findIndex((c) => c.id === id);
    return idx >= 0 ? charts[idx] : undefined;
  };

  // Preallocated 1-pt buffers for autoScroll append panels (APM + errors).
  const apmBufs = createAppendBufs(3);
  const errBufs = createAppendBufs(2);

  // Single wall pump: high-rate append streams + throttled setOption panels.
  const stream = startStreamPump((_now, tick) => {
    // ── AutoScroll append streams (every sample @ 40 Hz) ──
    const apm = byId('apm');
    if (apm && !apm.disposed) {
      const i = apmCursor;
      const load = 0.55 + 0.35 * Math.sin(i * 0.11) + 0.12 * Math.sin(i * 0.37);
      const p50 = 18 + load * 22 + Math.sin(i * 0.2) * 3;
      const p95 = p50 * (2.1 + 0.15 * Math.sin(i * 0.09));
      const p99 = p95 * (1.45 + 0.1 * Math.sin(i * 0.07));
      const t = timeAt(i);
      const vals = [p50, p95, p99];
      for (let s = 0; s < 3; s++) {
        const buf = apmBufs[s]!;
        buf.x[0] = t;
        buf.y[0] = vals[s]!;
        apm.appendData(s, buf, { maxPoints: seedN });
      }
      apmCursor += 1;
    }

    const errors = byId('errors');
    if (errors && !errors.disposed) {
      const i = errCursor;
      const e5 = Math.max(0, 0.4 + Math.sin(i * 0.18) * 0.5);
      const e4 = 2.2 + Math.sin(i * 0.12 + 1) * 1.1 + Math.sin(i * 0.4) * 0.4;
      const t = timeAt(i);
      errBufs[0]!.x[0] = t;
      errBufs[0]!.y[0] = e5;
      errBufs[1]!.x[0] = t;
      errBufs[1]!.y[0] = e4;
      errors.appendData(0, errBufs[0]!, { maxPoints: seedN });
      errors.appendData(1, errBufs[1]!, { maxPoints: seedN });
      errCursor += 1;
    }

    // ── Pool sliding window (~20 Hz) ──
    if (tick % 2 === 0) {
      const pool = byId('pool');
      if (pool && !pool.disposed) {
        poolRows = [...poolRows.slice(1), poolSample(poolCursor)];
        poolCursor += 1;
        const d = poolSeriesData(poolRows);
        const base = optionsById.get('pool')!;
        pool.setOption({
          ...base,
          series: [
            {
              type: 'line',
              name: 'Active',
              data: d.active,
              color: CYAN,
              lineStyle: { width: 2 },
              areaStyle: { opacity: 0.32 },
              sampling: 'none',
            },
            {
              type: 'line',
              name: 'Waiting',
              data: d.waiting,
              color: ROSE,
              lineStyle: { width: 2 },
              areaStyle: { opacity: 0.22 },
              sampling: 'none',
            },
          ],
        });
      }
    }

    // ── Heavier setOption panels (~10 Hz) ──
    if (tick % 4 !== 0) return;

    const trade = byId('trade');
    if (trade && !trade.disposed) {
      const last = tradeCandles[tradeCandles.length - 1];
      if (last && Array.isArray(last)) {
        const open = last[2];
        const close = Math.max(1, open + (Math.random() - 0.48) * 2.0);
        const high = Math.max(open, close) + Math.random() * 0.6;
        const low = Math.min(open, close) - Math.random() * 0.6;
        const next: OHLCDataPoint = [last[0] + 1000, open, close, low, high];
        tradeCandles = [...tradeCandles.slice(-99), next];
        tradeVol = tradeVolume(tradeCandles);
        const base = optionsById.get('trade')!;
        trade.setOption({
          ...base,
          series: [
            {
              type: 'bar',
              name: 'Volume',
              data: tradeVol,
              color: BLUE,
              yAxis: 'vol',
              barCategoryGap: 0.15,
            },
            {
              type: 'candlestick',
              name: 'MEME',
              data: tradeCandles,
              yAxis: 'price',
              itemStyle: {
                upColor: LIME,
                downColor: ROSE,
                upBorderColor: LIME,
                downBorderColor: ROSE,
              },
              priceLabel: { intervalMs: 1000, nowMs: () => Date.now() },
            },
          ],
        });
      }
    }

    stackPhase += 0.09;
    const stack = byId('stack');
    if (stack && !stack.disposed) {
      stack.setOption({
        ...optionsById.get('stack')!,
        series: buildStackSeries(stackPhase),
      });
    }

    pieSlices = pieSlices.map((s, i) => ({
      ...s,
      value: Math.max(5, s.value + Math.sin(tick * 0.04 + i) * 0.35),
    }));
    const pie = byId('pie');
    if (pie && !pie.disposed) {
      pie.setOption({
        ...optionsById.get('pie')!,
        series: [
          {
            type: 'pie',
            name: 'Frame ms',
            data: pieSlices,
            radius: ['38%', '68%'],
            center: ['38%', '54%'],
          },
        ],
      });
    }

    comboPhase += 0.1;
    const combo = byId('combo');
    if (combo && !combo.disposed) {
      const rows: ComboRow[] = [];
      for (let i = 0; i < 36; i++) {
        const rps =
          800 +
          Math.sin(i * 0.35 + comboPhase) * 280 +
          Math.sin(i * 0.11 + comboPhase) * 90 +
          (i % 4) * 20;
        const errPct = Math.max(0.05, 1.8 - rps / 1200 + Math.sin(i * 0.5 + comboPhase) * 0.4);
        rows.push({ x: i, rps, errPct });
      }
      combo.setOption({
        ...optionsById.get('combo')!,
        series: [
          {
            type: 'bar',
            name: 'RPS',
            data: rows.map((r) => [r.x, r.rps] as DataPoint),
            color: BLUE,
            yAxis: 'rps',
            barCategoryGap: 0.2,
          },
          {
            type: 'line',
            name: 'Error %',
            data: rows.map((r) => [r.x, r.errPct] as DataPoint),
            color: ROSE,
            yAxis: 'err',
            lineStyle: { width: 2 },
            sampling: 'none',
          },
        ],
      });
    }
  }, { hz: 40 });

  return {
    dispose: () => {
      stream.stop();
      for (const ro of observers) ro.disconnect();
      for (const c of charts) {
        if (!c.disposed) c.dispose();
      }
      try {
        device.destroy();
      } catch {
        /* already destroyed */
      }
      container.replaceChildren();
    },
  };
}

// ── Lazy plate lifecycle ────────────────────────────────────────────────────

type DemoId = 'aurora' | 'density' | 'mountain' | 'bars' | 'wall';

const demoMount: Record<DemoId, (el: HTMLElement) => Promise<{ dispose: () => void }>> = {
  aurora: mountAurora,
  density: mountDensity,
  mountain: mountMountain,
  bars: mountBars,
  wall: mountWall,
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
  /** True while the example modal is open and we own a history entry for it. */
  let viewerOpen = false;
  /**
   * When Escape/UI closes the modal we call history.back(). That fires popstate;
   * ignore that single pop so we don't treat it as a second close path.
   */
  let ignoreNextPopstate = false;

  const isViewerHistoryState = (state: unknown): boolean =>
    typeof state === 'object' &&
    state !== null &&
    (state as { chartgpuViewer?: unknown }).chartgpuViewer === true;

  /**
   * Navigate the iframe without stacking joint-session history entries.
   * Assigning `iframe.src` pushes a history step in Chromium; `location.replace`
   * swaps the document in place so one Back always means "close modal".
   */
  const setIframeUrl = (url: string): void => {
    const abs = new URL(url, location.href).href;
    try {
      const win = viewerIframe.contentWindow;
      if (win && win.location) {
        win.location.replace(abs);
        return;
      }
    } catch {
      /* cross-origin or not ready */
    }
    viewerIframe.src = abs;
  };

  const unloadIframe = (): void => {
    try {
      viewerIframe.contentWindow?.location.replace('about:blank');
    } catch {
      try {
        viewerIframe.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
  };

  const dismissViewerUi = (): void => {
    viewerEl.classList.remove('active');
    viewerEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    // Unload after the close transition; replace (not src=) so we don't push history.
    window.setTimeout(() => unloadIframe(), 250);
  };

  const openViewer = (ex: Example): void => {
    if (viewerTitle) viewerTitle.textContent = ex.title;
    if (viewerCategory) viewerCategory.textContent = categoryLabels[ex.category] ?? ex.category;
    if (viewerNewTab) viewerNewTab.href = ex.path;

    viewerEl.classList.add('active');
    viewerEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // History first, then replace-load the frame so iframe nav doesn't stack a second entry.
    const nextState = { chartgpuViewer: true as const, exampleId: ex.id };
    if (!viewerOpen) {
      history.pushState(nextState, '', location.href);
      viewerOpen = true;
    } else {
      history.replaceState(nextState, '', location.href);
    }

    setIframeUrl(ex.path);
  };

  /**
   * Close the example modal (Escape, UI back, backdrop, or browser Back).
   * - fromPopstate: browser already moved history — only tear down UI.
   * - otherwise: tear down UI, then history.back() to drop our pushState entry.
   */
  const closeViewer = (opts?: { fromPopstate?: boolean }): void => {
    if (!viewerOpen && !viewerEl.classList.contains('active')) return;

    const shouldPopHistory =
      !opts?.fromPopstate && viewerOpen && isViewerHistoryState(history.state);

    viewerOpen = false;
    dismissViewerUi();

    if (shouldPopHistory) {
      ignoreNextPopstate = true;
      history.back();
    }
  };

  window.addEventListener('popstate', () => {
    if (ignoreNextPopstate) {
      ignoreNextPopstate = false;
      return;
    }
    // Browser Back/Forward while modal is up → same as Escape.
    if (viewerOpen || viewerEl.classList.contains('active')) {
      closeViewer({ fromPopstate: true });
    }
  });

  document.getElementById('viewerBack')?.addEventListener('click', () => closeViewer());
  document.getElementById('viewerBackdrop')?.addEventListener('click', () => closeViewer());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (viewerOpen || viewerEl.classList.contains('active'))) {
      closeViewer();
    }
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

const INSTALL_CMD = 'npm install @chartgpu/chartgpu';

function setupCopy(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.install-copy');
  buttons.forEach((copyBtn) => {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(INSTALL_CMD);
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

function wireStaticAssets(): void {
  const logo = document.getElementById('navLogo') as HTMLImageElement | null;
  if (logo) logo.src = chartgpuLogoUrl;
  const footLogo = document.getElementById('footLogo') as HTMLImageElement | null;
  if (footLogo) footLogo.src = chartgpuLogoUrl;
  const brand = document.getElementById('navBrand') as HTMLAnchorElement | null;
  if (brand) brand.href = import.meta.env.BASE_URL;
  const webgpuIcon = document.getElementById('webgpuComIcon') as HTMLImageElement | null;
  if (webgpuIcon) webgpuIcon.src = webgpuComIconUrl;
}

function main(): void {
  wireStaticAssets();
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
