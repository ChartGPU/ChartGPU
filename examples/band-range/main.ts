/**
 * Band / range series example:
 * - Static: confidence band + mean line
 * - Live: streaming min/max envelope via appendData
 * - Threshold: constant y vs series y1
 *
 * Live zoom UX: autoScroll follows the newest samples, but user wheel/pan/pinch
 * pauses follow so zoom-out works. Re-enable with the Auto-scroll checkbox.
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  ChartGPUZoomRangeChangePayload,
  ThemeConfig,
} from '../../src/index';

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

const N = 200;
/** FIFO window for live mode. */
const LIVE_MAX_POINTS = 300;
/**
 * Minimum zoom span (% of domain). Dataset-aware default for 300 pts is ~0.33%
 * (≈ one sample) which looks "stuck" after a single deep zoom-in. Floor at 2%.
 */
const LIVE_MIN_SPAN = 2;

function makeStaticCI(): {
  x: Float64Array;
  mean: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
} {
  const x = new Float64Array(N);
  const mean = new Float64Array(N);
  const lo = new Float64Array(N);
  const hi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    x[i] = t * 10;
    const m = Math.sin(t * Math.PI * 2) * 2 + Math.sin(t * Math.PI * 6) * 0.4;
    const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const n = (noise < 0 ? noise + 1 : noise) - 0.5;
    mean[i] = m + n * 0.35;
    const sigma = 0.6 + 0.25 * Math.abs(Math.cos(t * Math.PI * 2));
    lo[i] = mean[i] - sigma;
    hi[i] = mean[i] + sigma;
  }
  return { x, mean, lo, hi };
}

type Controls = {
  mode: 'static' | 'live' | 'threshold';
  opacity: number;
  strokeY: boolean;
  strokeY1: boolean;
  autoScroll: boolean;
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const modeEl = document.getElementById('mode') as HTMLSelectElement;
  const opacityEl = document.getElementById('opacity') as HTMLInputElement;
  const opacityVal = document.getElementById('opacityVal') as HTMLSpanElement;
  const strokeYEl = document.getElementById('strokeY') as HTMLInputElement;
  const strokeY1El = document.getElementById('strokeY1') as HTMLInputElement;
  const autoScrollEl = document.getElementById('autoScroll') as HTMLInputElement | null;
  const resetZoomEl = document.getElementById('resetZoom') as HTMLButtonElement | null;
  const liveHintEl = document.getElementById('liveHint');

  const controls: Controls = {
    mode: 'static',
    opacity: 0.25,
    strokeY: true,
    strokeY1: true,
    autoScroll: true,
  };

  const staticCI = makeStaticCI();
  let chart: ChartGPUInstance | null = null;
  let liveRaf = 0;
  let liveT = 0;
  /** CPU mirror of the live series (kept in sync with appendData + maxPoints). */
  const liveX: number[] = [];
  const liveMin: number[] = [];
  const liveMaxArr: number[] = [];
  let zoomListenerBound = false;
  /** Avoid re-entrant setOption from zoomRangeChange while applying options. */
  let applyingOptions = false;

  const strokeStyle = (enabled: boolean, color: string) =>
    enabled ? { width: 1.5, color, opacity: 0.9 } : { width: 0, color, opacity: 0 };

  const setLiveControlsVisible = (visible: boolean): void => {
    const row = document.getElementById('liveControls');
    if (row) row.style.display = visible ? 'flex' : 'none';
    if (liveHintEl) liveHintEl.style.display = visible ? 'block' : 'none';
  };

  const syncAutoScrollCheckbox = (): void => {
    if (autoScrollEl) autoScrollEl.checked = controls.autoScroll;
  };

  const buildStaticOptions = (): ChartGPUOptions => ({
    theme,
    grid: { left: 56, right: 24, top: 24, bottom: 48 },
    xAxis: { type: 'value', name: 't' },
    yAxis: { type: 'value', name: 'Value' },
    animation: false,
    autoScroll: false,
    tooltip: { show: true, trigger: 'axis' },
    legend: { show: true },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    series: [
      {
        type: 'band',
        name: '±1σ band',
        data: { x: staticCI.x, y: staticCI.lo, y1: staticCI.hi },
        areaStyle: { color: '#38bdf8', opacity: controls.opacity },
        lineStyle: strokeStyle(controls.strokeY, '#38bdf8'),
        lineStyleY1: controls.strokeY1
          ? { width: 1.5, color: '#f472b6', opacity: 0.9 }
          : undefined,
        sampling: 'none',
      },
      {
        type: 'line',
        name: 'Mean',
        data: { x: staticCI.x, y: staticCI.mean },
        lineStyle: { width: 2, color: '#f8fafc' },
        sampling: 'none',
      },
    ],
  });

  const buildThresholdOptions = (): ChartGPUOptions => {
    const target = 0.5;
    const yConst = new Float64Array(N);
    yConst.fill(target);
    return {
      theme,
      grid: { left: 56, right: 24, top: 24, bottom: 48 },
      xAxis: { type: 'value', name: 't' },
      yAxis: { type: 'value', name: 'Value' },
      animation: false,
      autoScroll: false,
      tooltip: { show: true, trigger: 'axis' },
      legend: { show: true },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      series: [
        {
          type: 'band',
          name: 'Above target',
          data: { x: staticCI.x, y: yConst, y1: staticCI.mean },
          areaStyle: { color: '#ef4444', opacity: controls.opacity },
          lineStyle: strokeStyle(controls.strokeY, '#ef4444'),
          lineStyleY1: controls.strokeY1
            ? { width: 2, color: '#f8fafc', opacity: 1 }
            : undefined,
          sampling: 'none',
        },
      ],
    };
  };

  const buildLiveOptions = (): ChartGPUOptions => ({
    theme,
    grid: { left: 56, right: 24, top: 24, bottom: 48 },
    xAxis: { type: 'value', name: 't' },
    yAxis: { type: 'value', name: 'Envelope' },
    animation: false,
    // Follow newest samples only while the user has not taken over the viewport.
    autoScroll: controls.autoScroll,
    tooltip: { show: true, trigger: 'axis' },
    legend: { show: true },
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100,
        minSpan: LIVE_MIN_SPAN,
      },
    ],
    series: [
      {
        type: 'band',
        name: 'Min–max',
        data: { x: liveX, y: liveMin, y1: liveMaxArr },
        areaStyle: { color: '#a78bfa', opacity: controls.opacity },
        lineStyle: strokeStyle(controls.strokeY, '#a78bfa'),
        lineStyleY1: controls.strokeY1
          ? { width: 1.5, color: '#c4b5fd', opacity: 0.9 }
          : undefined,
        sampling: 'none',
      },
    ],
  });

  const stopLive = (): void => {
    if (liveRaf) {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
    }
  };

  /** Keep CPU mirror aligned with FIFO so style-only setOption does not wipe the stream. */
  const pushLiveSample = (t: number, lo: number, hi: number): void => {
    liveX.push(t);
    liveMin.push(lo);
    liveMaxArr.push(hi);
    const overflow = liveX.length - LIVE_MAX_POINTS;
    if (overflow > 0) {
      liveX.splice(0, overflow);
      liveMin.splice(0, overflow);
      liveMaxArr.splice(0, overflow);
    }
  };

  const startLive = (): void => {
    stopLive();
    liveX.length = 0;
    liveMin.length = 0;
    liveMaxArr.length = 0;
    liveT = 0;
    // Seed a few points into both CPU mirror and chart (via setOption seed).
    for (let i = 0; i < 40; i++) {
      liveT += 0.05;
      const base = Math.sin(liveT) * 2;
      pushLiveSample(liveT, base - 0.8 - 0.2 * Math.random(), base + 0.8 + 0.2 * Math.random());
    }

    const tick = (): void => {
      if (!chart) return;
      liveT += 0.05;
      const base = Math.sin(liveT) * 2 + Math.sin(liveT * 0.3) * 0.5;
      const lo = base - 0.8 - 0.25 * Math.random();
      const hi = base + 0.8 + 0.25 * Math.random();
      pushLiveSample(liveT, lo, hi);
      chart.appendData(
        0,
        {
          x: [liveT],
          y: [lo],
          y1: [hi],
        },
        { maxPoints: LIVE_MAX_POINTS }
      );
      liveRaf = requestAnimationFrame(tick);
    };
    liveRaf = requestAnimationFrame(tick);
  };

  /**
   * Live setOption helpers.
   *
   * ChartGPU `setOption` **replaces** the full options object (not deep-merge).
   * Passing only `{ autoScroll: false }` drops series/theme/dataZoom and empties
   * the plot — that was the zoom-disappears-band regression.
   *
   * - Auto-scroll toggles: spread the current user options and only flip the flag
   *   (preserves series identity → no runtime re-seed race with appendData).
   * - Style updates: full `buildLiveOptions()` so opacity/strokes re-resolve while
   *   CPU mirrors (liveX/min/max) keep the stream intact.
   * dataZoom start/end stay 0–100 in options; the coordinator preserves the
   * interactive zoom range when those option values are unchanged.
   */
  const applyLiveAutoScroll = (): void => {
    if (!chart || controls.mode !== 'live') return;
    chart.setOption({
      ...chart.options,
      autoScroll: controls.autoScroll,
    });
  };

  const applyLiveStyles = (): void => {
    if (!chart || controls.mode !== 'live') return;
    chart.setOption(buildLiveOptions());
  };

  const onZoomRangeChange = (payload: ChartGPUZoomRangeChangePayload): void => {
    if (applyingOptions) return;
    if (controls.mode !== 'live') return;
    // Only pause on real interaction. auto-scroll + programmatic setZoomRange must not
    // immediately flip the toggle off when re-enabling follow.
    if (payload.sourceKind === 'auto-scroll' || payload.sourceKind === 'api') return;
    // User wheel/pan/pinch (sourceKind 'user' or unclassified) took over the viewport:
    // pause follow so zoom-out is not fighting a 60fps pin-to-end append loop.
    if (!controls.autoScroll) return;
    controls.autoScroll = false;
    syncAutoScrollCheckbox();
    queueMicrotask(() => {
      if (!chart || chart.disposed || controls.mode !== 'live') return;
      // Never setOption({ autoScroll }) alone (replace semantics wipe series).
      applyLiveAutoScroll();
    });
  };

  const bindZoomListener = (): void => {
    if (!chart || zoomListenerBound) return;
    chart.on('zoomRangeChange', onZoomRangeChange);
    zoomListenerBound = true;
  };

  const apply = async (): Promise<void> => {
    applyingOptions = true;
    try {
      stopLive();
      const options =
        controls.mode === 'static'
          ? buildStaticOptions()
          : controls.mode === 'threshold'
            ? buildThresholdOptions()
            : buildLiveOptions();

      if (!chart) {
        chart = await ChartGPU.create(chartEl, options);
        bindZoomListener();
      } else {
        chart.setOption(options);
      }

      setLiveControlsVisible(controls.mode === 'live');
      if (controls.mode === 'live') {
        // Live mode starts following the head unless the user already turned it off.
        startLive();
      }
    } finally {
      applyingOptions = false;
    }
  };

  const syncControls = (): void => {
    controls.mode = modeEl.value as Controls['mode'];
    controls.opacity = Number(opacityEl.value);
    opacityVal.textContent = controls.opacity.toFixed(2);
    controls.strokeY = strokeYEl.checked;
    controls.strokeY1 = strokeY1El.checked;
    if (autoScrollEl) controls.autoScroll = autoScrollEl.checked === true;
  };

  modeEl.addEventListener('change', () => {
    syncControls();
    // Fresh live session always re-enables follow.
    if (controls.mode === 'live') {
      controls.autoScroll = true;
      syncAutoScrollCheckbox();
    }
    void apply().catch((e) => showError(String(e)));
  });

  const onStyleChange = (): void => {
    syncControls();
    if (controls.mode === 'live' && chart && liveRaf) {
      // Keep the stream + current zoom; restyle via full live options.
      applyLiveStyles();
      return;
    }
    void apply().catch((e) => showError(String(e)));
  };

  opacityEl.addEventListener('input', onStyleChange);
  strokeYEl.addEventListener('change', onStyleChange);
  strokeY1El.addEventListener('change', onStyleChange);

  autoScrollEl?.addEventListener('change', () => {
    syncControls();
    if (controls.mode !== 'live' || !chart) return;
    // Preserve series identity; only flip autoScroll (replace semantics).
    applyLiveAutoScroll();
    // Re-enabling follow: jump to full trailing window so the user is not left
    // in a deep zoom while new points keep arriving at the end.
    if (controls.autoScroll) {
      chart.setZoomRange(0, 100);
    }
  });

  resetZoomEl?.addEventListener('click', () => {
    if (!chart) return;
    chart.setZoomRange(0, 100);
    if (controls.mode === 'live' && !controls.autoScroll) {
      // Optional: leave autoScroll off so they can re-zoom; follow stays paused.
    }
  });

  try {
    syncControls();
    await apply();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }

  window.addEventListener('beforeunload', () => {
    stopLive();
    if (chart && zoomListenerBound) {
      try {
        chart.off('zoomRangeChange', onZoomRangeChange);
      } catch {
        /* best-effort */
      }
    }
    chart?.dispose();
  });
}

void main();
