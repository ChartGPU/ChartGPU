import { ChartGPU, connectCharts, createPipelineCache } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions } from '../../src/index';
import { generateTick, getPhase } from './dataGenerator';
import { createAnnotationManager } from './annotations';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

async function main(): Promise<void> {
  // Request shared GPU resources with high performance
  const adapter = await navigator.gpu?.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error(
      'WebGPU not supported. Requires Chrome 113+, Edge 113+, or Safari 18+.',
    );
  }

  const device = await adapter.requestDevice();
  const pipelineCache = createPipelineCache(device);
  const sharedContext = { adapter, device, pipelineCache };

  // Query chart container elements
  const containerIds = [
    'chart-latency',
    'chart-throughput',
    'chart-resources',
    'chart-errors',
    'chart-connections',
  ] as const;

  const containers = containerIds.map((id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Container #${id} not found`);
    return el;
  });

  // Chart configurations
  const chartConfigs: ChartGPUOptions[] = [
    // Chart 0 — Response Latency (P50 / P95 / P99)
    {
      grid: { left: 60, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'ms' },
      tooltip: { trigger: 'axis' },
      autoScroll: true,
      dataZoom: [{ type: 'inside' }],
      animation: false,
      series: [
        { type: 'line', name: 'P50', data: [], color: '#22c55e', lineStyle: { width: 2 }, sampling: 'none' },
        { type: 'line', name: 'P95', data: [], color: '#eab308', lineStyle: { width: 2 }, sampling: 'none' },
        { type: 'line', name: 'P99', data: [], color: '#ef4444', lineStyle: { width: 2 }, sampling: 'none' },
      ],
    },
    // Chart 1 — Request Throughput
    {
      grid: { left: 70, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'req/s' },
      tooltip: { trigger: 'axis' },
      autoScroll: true,
      dataZoom: [{ type: 'inside' }],
      animation: false,
      series: [
        { type: 'area', name: 'Throughput', data: [], color: '#3b82f6', areaStyle: { opacity: 0.3 }, sampling: 'none' },
      ],
    },
    // Chart 2 — CPU & Memory
    {
      grid: { left: 60, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: '%', min: 0, max: 100 },
      tooltip: { trigger: 'axis' },
      autoScroll: true,
      dataZoom: [{ type: 'inside' }],
      animation: false,
      series: [
        { type: 'line', name: 'Memory', data: [], color: '#a855f7', lineStyle: { width: 2 }, sampling: 'none' },
        { type: 'line', name: 'CPU', data: [], color: '#f97316', lineStyle: { width: 2 }, sampling: 'none' },
      ],
    },
    // Chart 3 — Error Rate
    {
      grid: { left: 60, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'err/s' },
      tooltip: { trigger: 'axis' },
      autoScroll: true,
      dataZoom: [{ type: 'inside' }],
      animation: false,
      series: [
        { type: 'line', name: '5xx', data: [], color: '#ef4444', lineStyle: { width: 2 }, sampling: 'none' },
        { type: 'line', name: '4xx', data: [], color: '#eab308', lineStyle: { width: 1 }, sampling: 'none' },
      ],
    },
    // Chart 4 — Connection Pool
    {
      grid: { left: 60, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: 'conns', min: 0, max: 220 },
      tooltip: { trigger: 'axis' },
      autoScroll: true,
      dataZoom: [{ type: 'inside' }],
      animation: false,
      series: [
        { type: 'area', name: 'Active', data: [], color: '#06b6d4', areaStyle: { opacity: 0.3 }, sampling: 'none' },
        { type: 'area', name: 'Waiting', data: [], color: '#ec4899', areaStyle: { opacity: 0.3 }, sampling: 'none' },
      ],
      // Static annotation: Pool Max line at 200
      annotations: [
        {
          type: 'lineY' as const,
          y: 200,
          layer: 'belowSeries' as const,
          style: { color: '#ef4444', lineWidth: 1, lineDash: [4, 4], opacity: 0.6 },
          label: {
            text: 'Pool Max: 200',
            offset: [8, -8] as const,
            anchor: 'start' as const,
            background: { color: '#000000', opacity: 0.7, padding: [2, 6, 2, 6] as const, borderRadius: 4 },
          },
        },
      ],
    },
  ];

  // Create all charts with shared device and pipeline cache (third parameter)
  const charts: ChartGPUInstance[] = [];
  for (let i = 0; i < chartConfigs.length; i++) {
    const chart = await ChartGPU.create(containers[i], chartConfigs[i], sharedContext);
    charts.push(chart);
  }

  // Synchronize charts (crosshair + zoom)
  const disconnect = connectCharts(charts, {
    syncCrosshair: true,
    syncZoom: true,
  });

  // Initialize annotation manager
  const annotationManager = createAnnotationManager(charts);

  // Status header elements
  const phaseNameEl = document.getElementById('phase-name');
  const elapsedTimeEl = document.getElementById('elapsed-time');

  // Phase color map: green for steady/recovery, yellow for onset, orange for degradation, red for incident
  const phaseColors: Record<number, string> = {
    1: '#22c55e',
    2: '#eab308',
    3: '#f97316',
    4: '#ef4444',
    5: '#22c55e',
  };

  // Streaming loop
  const startTime = Date.now();
  let intervalId: number | null = null;

  const streamTick = (): void => {
    const elapsedS = (Date.now() - startTime) / 1000;
    const metrics = generateTick(elapsedS);

    // Append data to all series
    // Chart 0 — Latency (3 series: P50, P95, P99)
    charts[0].appendData(0, [[metrics.timestamp, metrics.p50]]);
    charts[0].appendData(1, [[metrics.timestamp, metrics.p95]]);
    charts[0].appendData(2, [[metrics.timestamp, metrics.p99]]);

    // Chart 1 — Throughput (1 series)
    charts[1].appendData(0, [[metrics.timestamp, metrics.throughput]]);

    // Chart 2 — Resources (2 series: Memory, CPU)
    charts[2].appendData(0, [[metrics.timestamp, metrics.memory]]);
    charts[2].appendData(1, [[metrics.timestamp, metrics.cpu]]);

    // Chart 3 — Errors (2 series: 5xx, 4xx)
    charts[3].appendData(0, [[metrics.timestamp, metrics.errors5xx]]);
    charts[3].appendData(1, [[metrics.timestamp, metrics.errors4xx]]);

    // Chart 4 — Connections (2 series: Active, Waiting)
    charts[4].appendData(0, [[metrics.timestamp, metrics.activeConnections]]);
    charts[4].appendData(1, [[metrics.timestamp, metrics.waitingQueue]]);

    // Process annotation triggers
    annotationManager.processTick(metrics);

    // Update status header
    const phase = getPhase(elapsedS);
    if (phaseNameEl) {
      phaseNameEl.textContent = phase.name;
      phaseNameEl.style.color = phaseColors[phase.phase] ?? '#e0e0e0';
    }
    if (elapsedTimeEl) {
      elapsedTimeEl.textContent = `${Math.floor(elapsedS)}s`;
    }
  };

  intervalId = window.setInterval(streamTick, 200); // 5 Hz

  // ResizeObserver with rAF debounce
  const observers = containers.map((container, i) => {
    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        charts[i].resize();
        rafId = null;
      });
    });
    observer.observe(container);
    return observer;
  });

  // Cleanup function following cookbook order
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;

    // 1. Stop streaming interval
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }

    // 2. Disconnect chart sync
    disconnect();

    // 3. Disconnect all ResizeObservers
    observers.forEach((obs) => obs.disconnect());

    // 4. Dispose all charts
    charts.forEach((chart) => chart.dispose());

    // 5. Destroy shared device
    device.destroy();
  };

  window.addEventListener('beforeunload', cleanup);
  import.meta.hot?.dispose(cleanup);
}

// Entry point
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => {
      console.error('Dashboard initialization failed:', err);
      showError(err instanceof Error ? err.message : String(err));
    });
  });
} else {
  main().catch((err) => {
    console.error('Dashboard initialization failed:', err);
    showError(err instanceof Error ? err.message : String(err));
  });
}
