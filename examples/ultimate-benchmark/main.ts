/**
 * ChartGPU Ultimate Benchmark (main-thread only)
 *
 * A high-signal benchmark example for ChartGPU that focuses on:
 * - Large datasets (millions+ points)
 * - Exact FPS + frame-time metrics via ChartGPU performance API
 * - Streaming appendData stress testing
 *
 * Note: Worker mode was removed from ChartGPU, so this example intentionally
 * benchmarks the main-thread rendering path only.
 */

import { ChartGPU } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint, OHLCDataPoint, PerformanceMetrics } from '../../src/index';

// ============================================================================
// Constants
// ============================================================================

const FRAME_BUFFER_SIZE = 120; // Last 120 frames (2 seconds at 60fps)
const EXPECTED_FRAME_TIME_MS = 1000 / 60; // 16.67ms at 60fps
const FRAME_TIME_SLOW_THRESHOLD = 33; // Yellow warning threshold
const FPS_SMOOTH_THRESHOLD = 55; // Green = >55fps
const FPS_MEDIUM_THRESHOLD = 30; // Orange = 30-55fps

// ============================================================================
// Types
// ============================================================================

type DataType = 'line' | 'scatter' | 'bar' | 'candlestick';

interface BenchmarkState {
  chart: ChartGPUInstance | null;
  dataType: DataType;
  streaming: boolean;
  streamingIntervalId: number | null;
  totalPointsGenerated: number;
  performanceUnsubscribe: (() => void) | null;
}

// ============================================================================
// Global state
// ============================================================================

const state: BenchmarkState = {
  chart: null,
  dataType: 'line',
  streaming: false,
  streamingIntervalId: null,
  totalPointsGenerated: 0,
  performanceUnsubscribe: null,
};

// ============================================================================
// Frame Time Graph
// ============================================================================

class FrameTimeGraph {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameTimes: number[] = [];
  private maxFrameTime = 50; // ms, for scale

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for frame graph');
    this.ctx = ctx;
  }

  addFrame(frameTime: number): void {
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > FRAME_BUFFER_SIZE) this.frameTimes.shift();
    this.render();
  }

  clear(): void {
    this.frameTimes = [];
    this.render();
  }

  private render(): void {
    const { ctx, canvas, frameTimes } = this;
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);
    if (frameTimes.length === 0) return;

    // Draw 60fps target line
    const targetY = height - (EXPECTED_FRAME_TIME_MS / this.maxFrameTime) * height;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(width, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    const barWidth = width / FRAME_BUFFER_SIZE;
    for (let i = 0; i < frameTimes.length; i++) {
      const frameTime = frameTimes[i]!;
      const x = i * barWidth;
      const barHeight = Math.min(1, frameTime / this.maxFrameTime) * height;
      const y = height - barHeight;

      let color: string;
      if (frameTime <= EXPECTED_FRAME_TIME_MS) color = '#10b981';
      else if (frameTime <= FRAME_TIME_SLOW_THRESHOLD) color = '#f59e0b';
      else color = '#ef4444';

      ctx.fillStyle = color;
      ctx.fillRect(x, y, Math.max(0, barWidth - 1), barHeight);
    }
  }
}

let frameGraph: FrameTimeGraph | null = null;

// ============================================================================
// UI utilities
// ============================================================================

function setElementText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showStatus(message: string, type: 'success' | 'warning' | 'error' = 'success'): void {
  const el = document.getElementById('statusMessage');
  if (!el) return;
  el.textContent = message;
  el.className = `status-message show ${type}`;
  window.setTimeout(() => el.classList.remove('show'), 5000);
}

function showWarningToast(message: string, duration = 5000): void {
  const toast = document.getElementById('warningToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), duration);
}

const formatNumber = (() => {
  const nf = new Intl.NumberFormat(undefined);
  return (n: number): string => nf.format(Math.max(0, Math.floor(n)));
})();

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatAbbreviatedNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

let lastDisplayUpdate = 0;
const DISPLAY_UPDATE_THROTTLE_MS = 100;

function updateTotalPointsDisplay(actualCount?: number): void {
  const now = performance.now();
  if (actualCount !== undefined && now - lastDisplayUpdate < DISPLAY_UPDATE_THROTTLE_MS) return;
  lastDisplayUpdate = now;

  const pointCount = parseInt((document.getElementById('pointCount') as HTMLInputElement | null)?.value ?? '0', 10) || 0;
  const seriesCount = parseInt((document.getElementById('seriesCount') as HTMLInputElement | null)?.value ?? '0', 10) || 0;

  const totalPoints = actualCount !== undefined ? actualCount : pointCount * seriesCount;

  const valueEl = document.getElementById('totalPointsValue');
  const hintEl = document.getElementById('totalPointsHint');
  if (!valueEl || !hintEl) return;

  valueEl.textContent = formatNumber(totalPoints);
  hintEl.textContent = `${formatAbbreviatedNumber(totalPoints)} points`;

  if (totalPoints > 1_000_000_000) valueEl.setAttribute('data-warning', 'extreme');
  else if (totalPoints > 100_000_000) valueEl.setAttribute('data-warning', 'true');
  else valueEl.setAttribute('data-warning', 'false');
}

// ============================================================================
// Data generation
// ============================================================================

function makeRng(seed: number) {
  let state = seed | 0;
  const rand01 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return rand01;
}

function generateCartesianChunk(startIndex: number, count: number, seriesIndex: number): DataPoint[] {
  const data: DataPoint[] = new Array(count);
  const rand01 = makeRng((0x12345678 ^ (seriesIndex * 0x9e3779b9)) | 0);

  const freq = 0.012 + seriesIndex * 0.00035;
  const lowFreq = 0.0017 + seriesIndex * 0.00007;
  const noiseAmp = 0.35;
  const seriesBias = (seriesIndex - 1) * 0.1;

  for (let i = 0; i < count; i++) {
    const x = startIndex + i;
    const y =
      Math.sin(x * freq) * 0.95 +
      Math.sin(x * lowFreq + 1.1) * 0.6 +
      (rand01() - 0.5) * noiseAmp +
      seriesBias;
    data[i] = [x, y] as const;
  }
  return data;
}

function generateCandlestickChunk(startIndex: number, count: number, seriesIndex: number): OHLCDataPoint[] {
  const rand01 = makeRng((0x31415926 ^ (seriesIndex * 0x9e3779b9)) | 0);
  const data: OHLCDataPoint[] = new Array(count);

  let lastClose = 100 + seriesIndex * 10;
  for (let i = 0; i < count; i++) {
    const t = startIndex + i;
    const drift = (rand01() - 0.5) * 0.8;
    const open = lastClose;
    const close = open + drift;
    const wick = 0.2 + rand01() * 0.8;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    data[i] = [t, open, close, low, high] as const;
    lastClose = close;
  }
  return data;
}

async function generateSeriesData(
  pointsPerSeries: number,
  seriesCount: number,
  dataType: DataType,
  onProgress?: (progress: number) => void
): Promise<Array<DataPoint[] | OHLCDataPoint[]>> {
  const chunkSize = 100_000;
  const out: Array<DataPoint[] | OHLCDataPoint[]> = new Array(seriesCount);
  const totalWork = pointsPerSeries * seriesCount;
  let done = 0;

  for (let s = 0; s < seriesCount; s++) {
    const chunks: Array<DataPoint[] | OHLCDataPoint[]> = [];
    for (let i = 0; i < pointsPerSeries; i += chunkSize) {
      const n = Math.min(chunkSize, pointsPerSeries - i);
      if (dataType === 'candlestick') chunks.push(generateCandlestickChunk(i, n, s));
      else chunks.push(generateCartesianChunk(i, n, s));

      done += n;
      if (onProgress) onProgress(done / Math.max(1, totalWork));
      if (i + chunkSize < pointsPerSeries) await new Promise((r) => setTimeout(r, 0));
    }

    out[s] = chunks.flat() as DataPoint[] | OHLCDataPoint[];
    await new Promise((r) => setTimeout(r, 0));
  }

  return out;
}

// ============================================================================
// Chart creation / disposal
// ============================================================================

function disposeChart(): void {
  if (state.performanceUnsubscribe) {
    state.performanceUnsubscribe();
    state.performanceUnsubscribe = null;
  }
  if (state.chart) {
    state.chart.dispose();
    state.chart = null;
  }
}

async function createChart(dataType: DataType, seriesData: Array<DataPoint[] | OHLCDataPoint[]>): Promise<ChartGPUInstance> {
  const container = document.getElementById('chart');
  if (!container) throw new Error('Missing #chart container');

  const palette = [
    '#06b6d4',
    '#6366f1',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#a78bfa',
    '#22c55e',
    '#eab308',
    '#fb7185',
    '#38bdf8',
  ];

  const baseSeries = seriesData.map((data, i) => {
    if (dataType === 'candlestick') {
      return {
        type: 'candlestick',
        name: `S${i}`,
        data: data as OHLCDataPoint[],
      } as const;
    }

    if (dataType === 'scatter') {
      return {
        type: 'scatter',
        name: `S${i}`,
        data: data as DataPoint[],
        symbolSize: 2,
      } as const;
    }

    if (dataType === 'bar') {
      return {
        type: 'bar',
        name: `S${i}`,
        data: data as DataPoint[],
        barWidth: 2,
      } as const;
    }

    return {
      type: 'line',
      name: `S${i}`,
      data: data as DataPoint[],
      lineStyle: { width: 1 },
    } as const;
  });

  const options: ChartGPUOptions = {
    theme: 'dark',
    palette,
    animation: false,
    xAxis: { type: 'value' },
    yAxis: { type: 'value' },
    tooltip: { show: true },
    dataZoom: [{ type: 'inside' }, { type: 'slider' }],
    series: baseSeries as unknown as ChartGPUOptions['series'],
  };

  return await ChartGPU.create(container, options);
}

// ============================================================================
// Performance metrics UI
// ============================================================================

function initializeMetricsDisplay(): void {
  const graphCanvas = document.getElementById('frameGraph') as HTMLCanvasElement | null;
  if (graphCanvas) frameGraph = new FrameTimeGraph(graphCanvas);
  clearMetricsDisplay();
}

function updateMetricsDisplay(metrics: Readonly<PerformanceMetrics>): void {
  // FPS
  const fps = metrics.fps;
  if (Number.isFinite(fps)) {
    setElementText('fpsDisplay', fps.toFixed(1));
    const fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) {
      if (fps > FPS_SMOOTH_THRESHOLD) fpsEl.setAttribute('data-quality', 'smooth');
      else if (fps > FPS_MEDIUM_THRESHOLD) fpsEl.setAttribute('data-quality', 'medium');
      else fpsEl.setAttribute('data-quality', 'choppy');
    }
  }

  // Frame time stats
  const ft = metrics.frameTimeStats;
  setElementText(
    'frameTimeDisplay',
    `${ft.min.toFixed(1)} / ${ft.avg.toFixed(1)} / ${ft.max.toFixed(1)} / ${ft.p95.toFixed(1)} / ${ft.p99.toFixed(1)} ms`
  );

  // Memory
  if (metrics.memory.used > 0) {
    setElementText('memoryDisplay', `${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.peak)}`);
  } else {
    setElementText('memoryDisplay', 'N/A');
  }

  // Frame drops
  setElementText('frameDropsDisplay', `${metrics.frameDrops.totalDrops} / ${metrics.frameDrops.consecutiveDrops}`);

  // Total frames
  setElementText('totalFramesDisplay', formatNumber(metrics.totalFrames));

  // Elapsed
  setElementText('elapsedDisplay', formatDuration(metrics.elapsedTime));

  // Graph
  frameGraph?.addFrame(ft.avg);
}

function clearMetricsDisplay(): void {
  setElementText('fpsDisplay', '--');
  setElementText('frameTimeDisplay', '--');
  setElementText('memoryDisplay', '--');
  setElementText('frameDropsDisplay', '--');
  setElementText('totalFramesDisplay', '--');
  setElementText('elapsedDisplay', '--');
  frameGraph?.clear();

  const fpsEl = document.getElementById('fpsDisplay');
  if (fpsEl) fpsEl.setAttribute('data-quality', 'smooth');
}

// ============================================================================
// Main benchmark logic
// ============================================================================

function disableAllButtons(): void {
  const ids = ['btnGenerate', 'btnStream', 'btnClear'];
  ids.forEach((id) => {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
  });
}

function enableAllButtons(): void {
  const ids = ['btnGenerate', 'btnStream', 'btnClear'];
  ids.forEach((id) => {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
  });
}

function stopStreaming(): void {
  state.streaming = false;
  if (state.streamingIntervalId !== null) {
    clearInterval(state.streamingIntervalId);
    state.streamingIntervalId = null;
  }
  if (state.totalPointsGenerated > 0) updateTotalPointsDisplay(state.totalPointsGenerated);
}

async function handleGenerate(): Promise<void> {
  const pointCount = parseInt((document.getElementById('pointCount') as HTMLInputElement).value, 10);
  const seriesCount = parseInt((document.getElementById('seriesCount') as HTMLInputElement).value, 10);
  const dataType = (document.getElementById('dataType') as HTMLSelectElement).value as DataType;

  if (!Number.isFinite(pointCount) || pointCount < 1) {
    showStatus('Invalid point count', 'error');
    return;
  }
  if (!Number.isFinite(seriesCount) || seriesCount < 1) {
    showStatus('Invalid series count', 'error');
    return;
  }

  const totalPointsPlanned = pointCount * seriesCount;
  if (pointCount > 100_000_000) {
    showWarningToast(`Generating ${formatNumber(totalPointsPlanned)} points may take a while and consume significant memory.`, 10000);
  }
  if (pointCount > 1_000_000_000) {
    showWarningToast('BILLION+ points is extreme. Your system might struggle. Emergency stop is available.', 15000);
  }

  disableAllButtons();
  showStatus('Generating data...', 'warning');

  try {
    stopStreaming();
    disposeChart();
    clearMetricsDisplay();

    const startTime = performance.now();
    const seriesData = await generateSeriesData(pointCount, seriesCount, dataType, (progress) => {
      showStatus(`Generating data... ${(progress * 100).toFixed(0)}%`, 'warning');
    });
    const genTime = performance.now() - startTime;

    showStatus(`Generated ${formatNumber(totalPointsPlanned)} points in ${formatDuration(genTime)}`, 'success');

    state.dataType = dataType;
    state.chart = await createChart(dataType, seriesData);

    // Subscribe to performance updates
    state.performanceUnsubscribe = state.chart.onPerformanceUpdate((metrics) => updateMetricsDisplay(metrics));
    const initial = state.chart.getPerformanceMetrics();
    if (initial) updateMetricsDisplay(initial);

    state.chart.resize();

    state.totalPointsGenerated = totalPointsPlanned;
    updateTotalPointsDisplay(state.totalPointsGenerated);

    showStatus('Chart ready! Rendering on main thread.', 'success');
  } catch (error) {
    console.error('Generation failed:', error);
    showStatus(error instanceof Error ? error.message : 'Generation failed', 'error');
  } finally {
    enableAllButtons();
  }
}

async function handleStartStreaming(): Promise<void> {
  if (state.streaming) {
    showStatus('Already streaming', 'warning');
    return;
  }

  const streamRate = parseInt((document.getElementById('streamRate') as HTMLInputElement).value, 10);
  const streamDuration = parseInt((document.getElementById('streamDuration') as HTMLInputElement).value, 10);
  const dataType = (document.getElementById('dataType') as HTMLSelectElement).value as DataType;

  if (!state.chart) {
    showStatus('Generate data first', 'warning');
    return;
  }

  if (!Number.isFinite(streamRate) || streamRate < 1) {
    showStatus('Invalid stream rate', 'error');
    return;
  }
  if (!Number.isFinite(streamDuration) || streamDuration < 1) {
    showStatus('Invalid stream duration', 'error');
    return;
  }

  state.streaming = true;
  let frameCount = 0;
  let nextX = state.totalPointsGenerated > 0 ? Math.floor(state.totalPointsGenerated / Math.max(1, getSeriesCount())) : 0;

  const streamFrame = (): void => {
    if (!state.streaming || !state.chart || frameCount >= streamDuration) {
      stopStreaming();
      showStatus('Streaming complete', 'success');
      return;
    }

    frameCount++;

    const batch = (() => {
      if (dataType === 'candlestick') return generateCandlestickChunk(nextX, streamRate, 0);
      return generateCartesianChunk(nextX, streamRate, 0);
    })();
    nextX += streamRate;

    state.chart.appendData(0, batch as unknown as DataPoint[] | OHLCDataPoint[]);

    state.totalPointsGenerated += streamRate;
    updateTotalPointsDisplay(state.totalPointsGenerated);

    showStatus(
      `Streaming... ${frameCount}/${streamDuration} frames (${formatNumber(state.totalPointsGenerated)} points total)`,
      'warning'
    );
  };

  state.streamingIntervalId = window.setInterval(streamFrame, 16);
  showStatus('Streaming started', 'success');
}

function getSeriesCount(): number {
  const seriesCount = parseInt((document.getElementById('seriesCount') as HTMLInputElement | null)?.value ?? '1', 10);
  return Number.isFinite(seriesCount) && seriesCount > 0 ? seriesCount : 1;
}

function handleClear(): void {
  stopStreaming();
  disposeChart();
  clearMetricsDisplay();
  state.totalPointsGenerated = 0;
  updateTotalPointsDisplay();
  showStatus('Cleared', 'success');
}

function handleEmergencyStop(): void {
  stopStreaming();
  disposeChart();
  clearMetricsDisplay();
  state.totalPointsGenerated = 0;
  updateTotalPointsDisplay();
  showStatus('Emergency stop activated', 'error');
  showWarningToast('Emergency stop: All operations terminated', 3000);
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  initializeMetricsDisplay();
  updateTotalPointsDisplay();

  document.getElementById('btnGenerate')?.addEventListener('click', handleGenerate);
  document.getElementById('btnStream')?.addEventListener('click', () => void handleStartStreaming());
  document.getElementById('btnClear')?.addEventListener('click', handleClear);
  document.getElementById('btnEmergency')?.addEventListener('click', handleEmergencyStop);

  document.getElementById('pointCount')?.addEventListener('input', () => updateTotalPointsDisplay());
  document.getElementById('seriesCount')?.addEventListener('input', () => updateTotalPointsDisplay());

  // Resize handling
  let resizeScheduled = false;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeScheduled || !state.chart) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      state.chart?.resize();
    });
  });

  const container = document.getElementById('chart');
  if (container) resizeObserver.observe(container);

  window.addEventListener('beforeunload', () => {
    stopStreaming();
    disposeChart();
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      stopStreaming();
      disposeChart();
      resizeObserver.disconnect();
    });
  }

  showStatus('Ready. Configure and generate your benchmark.', 'success');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

