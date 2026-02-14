import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint, ThemeConfig } from '../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const setStatus = (message: string): void => {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = message;
};

/**
 * Small deterministic RNG (LCG) for repeatable "random" transitions.
 */
const createRng = (seed: number): (() => number) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

// ---------------------------------------------------------------------------
// Theme — matches data-update-animation grid style exactly
// ---------------------------------------------------------------------------

const theme: ThemeConfig = {
  ...darkTheme,
  backgroundColor: '#0f0f14',
  gridLineColor: 'rgba(255,255,255,0.06)',
  axisLineColor: 'rgba(224,224,224,0.14)',
  axisTickColor: 'rgba(224,224,224,0.22)',
  textColor: 'rgba(224,224,224,0.78)',
};

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

interface MultiSeriesData {
  readonly bars: ReadonlyArray<DataPoint>;
  readonly line: ReadonlyArray<DataPoint>;
  readonly area: ReadonlyArray<DataPoint>;
  readonly scatter: ReadonlyArray<DataPoint>;
}

const makeMultiSeriesData = (
  count: number,
  rng: () => number,
  params: Readonly<{ phase: number; amplitude: number; offset: number }>,
): MultiSeriesData => {
  const n = Math.max(8, Math.floor(count));
  const bars: DataPoint[] = new Array(n);
  const line: DataPoint[] = new Array(n);
  const area: DataPoint[] = new Array(n);
  const scatter: DataPoint[] = [];

  const twoPi = Math.PI * 2;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = i;
    const noise = (rng() - 0.5) * 0.18;

    // Line — sine-based with noise
    const yLine = params.offset + Math.sin(t * twoPi + params.phase) * params.amplitude + noise;
    line[i] = [x, yLine] as const;

    // Bar — cosine-based with noise
    const yBar =
      params.offset * 0.4 +
      Math.cos(t * twoPi * 0.75 + params.phase * 0.6) * (params.amplitude * 0.9) +
      (rng() - 0.5) * 0.35;
    bars[i] = [x, yBar] as const;

    // Area — gentler sine wave, different phase, lower amplitude
    const yArea =
      params.offset * 0.6 +
      Math.sin(t * twoPi * 0.5 + params.phase * 1.3) * (params.amplitude * 0.55) +
      (rng() - 0.5) * 0.12;
    area[i] = [x, yArea] as const;

    // Scatter — clustered points around line trend with jitter
    // Emit ~1.5 scatter points per index on average for visual density
    const scatterCount = rng() < 0.5 ? 1 : 2;
    for (let s = 0; s < scatterCount; s++) {
      const sx = x + (rng() - 0.5) * 0.8;
      const sy = yLine + (rng() - 0.5) * params.amplitude * 0.7;
      scatter.push([sx, sy] as const);
    }
  }

  return { bars, line, area, scatter };
};

// ---------------------------------------------------------------------------
// Animation config
// ---------------------------------------------------------------------------

const createAnimationConfig = (enabled: boolean): ChartGPUOptions['animation'] => {
  if (!enabled) return false;
  return { duration: 700, easing: 'cubicInOut', delay: 0 };
};

// ---------------------------------------------------------------------------
// Chart options factory
// ---------------------------------------------------------------------------

const createOptions = (
  data: MultiSeriesData,
  animation: ChartGPUOptions['animation'],
  lineWidth: number,
): ChartGPUOptions => {
  const n = data.line.length;
  return {
    grid: { left: 70, right: 120, top: 24, bottom: 56 },
    xAxis: { type: 'value', min: 0, max: Math.max(1, n - 1), name: 'Index (match-by-index)' },
    yAxis: { type: 'value', name: 'Value (auto domain)' },
    theme,
    tooltip: { show: true, trigger: 'axis' },
    animation,
    series: [
      // Area first (back layer)
      {
        type: 'area',
        name: 'Area Trend',
        data: data.area,
        color: '#6bff4a',
        areaStyle: { opacity: 0.18 },
      },
      // Bars next
      {
        type: 'bar',
        name: 'Bars',
        data: data.bars,
        color: '#4a9eff',
        barWidth: '60%',
        barGap: 0.2,
        barCategoryGap: 0.25,
      },
      // Line on top of bars
      {
        type: 'line',
        name: 'Line',
        data: data.line,
        color: '#ff4ab0',
        lineStyle: { width: lineWidth, opacity: 1 },
      },
      // Scatter on top
      {
        type: 'scatter',
        name: 'Scatter',
        data: data.scatter,
        color: '#FFD300',
        symbolSize: 4,
      },
    ],
  };
};

// ---------------------------------------------------------------------------
// Resize observer (coalesced via rAF)
// ---------------------------------------------------------------------------

const attachCoalescedResizeObserver = (
  container: HTMLElement,
  chart: ChartGPUInstance,
): ResizeObserver => {
  let rafId: number | null = null;

  const schedule = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      chart.resize();
    });
  };

  const ro = new ResizeObserver(() => schedule());
  ro.observe(container);
  return ro;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart-main');
  if (!(chartEl instanceof HTMLElement)) {
    throw new Error('Chart container not found');
  }

  const btnUpdate = document.getElementById('btn-update');
  const toggleAnimate = document.getElementById('toggle-animate');
  const toggleAuto = document.getElementById('toggle-auto');
  const lineWidthSlider = document.getElementById('line-width');
  const lineWidthDisplay = document.getElementById('line-width-value');

  if (!(btnUpdate instanceof HTMLButtonElement)) throw new Error('Update button not found');
  if (!(toggleAnimate instanceof HTMLInputElement)) throw new Error('Animate toggle not found');
  if (!(toggleAuto instanceof HTMLInputElement)) throw new Error('Auto toggle not found');
  if (!(lineWidthSlider instanceof HTMLInputElement)) throw new Error('Line-width slider not found');

  const getLineWidth = (): number => parseFloat(lineWidthSlider.value) || 2;

  // Keep track of the latest data so the line-width slider can re-apply without regenerating.
  let latestData: MultiSeriesData;

  // ---- Initial render (animation off) ----
  const initialRng = createRng(1);
  latestData = makeMultiSeriesData(64, initialRng, { phase: 0, amplitude: 1.2, offset: 0.0 });

  const chart = await ChartGPU.create(
    chartEl,
    createOptions(latestData, /* animation */ false, getLineWidth()),
  );

  const ro = attachCoalescedResizeObserver(chartEl, chart);
  chart.resize();

  // ---- Update logic ----
  let step = 0;

  const updateChart = (source: 'auto' | 'manual'): void => {
    step++;
    const rng = createRng(1000 + step * 97);

    const phase = step * 0.7;
    const amplitude = 0.9 + (step % 4) * 0.65; // 0.9 .. 2.85
    const offset = (step % 2 === 0 ? -0.35 : 0.55) + (rng() - 0.5) * 0.15;

    latestData = makeMultiSeriesData(64, rng, { phase, amplitude, offset });
    const animation = createAnimationConfig(toggleAnimate.checked);

    chart.setOption(createOptions(latestData, animation, getLineWidth()));

    const label = toggleAnimate.checked ? 'animated' : 'instant';
    setStatus(
      `Updated (${source}, ${label}) · step ${step} · amp ${amplitude.toFixed(2)} · offset ${clamp(offset, -5, 5).toFixed(2)}`,
    );
  };

  // ---- Controls ----
  btnUpdate.addEventListener('click', () => updateChart('manual'));

  toggleAnimate.addEventListener('change', () => {
    setStatus(toggleAnimate.checked ? 'Animations enabled (next update).' : 'Animations disabled (next update).');
  });

  // Line-width slider: live-update the chart without regenerating data.
  lineWidthSlider.addEventListener('input', () => {
    const lw = getLineWidth();
    if (lineWidthDisplay) lineWidthDisplay.textContent = String(lw);
    // Re-apply current data with new line width (animate briefly so the transition is visible).
    chart.setOption(createOptions(latestData, { duration: 200, easing: 'cubicOut', delay: 0 }, lw));
  });

  // ---- Auto-update ----
  setStatus('Initial render (animation off).');
  if (toggleAuto.checked) {
    setStatus('Initial render (animation off). Auto update scheduled…');
    window.setTimeout(() => updateChart('auto'), 1000);
  }

  // ---- Cleanup ----
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    ro.disconnect();
    chart.dispose();
  };

  window.addEventListener('beforeunload', cleanup);
  import.meta.hot?.dispose(cleanup);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

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
