import { ChartGPU, darkTheme } from '../../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  HeatmapColormap,
  HeatmapData,
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

const TIME_BINS = 256;
const FREQ_BINS = 128;
const DT = 0.02;
const DF = 8;

const fillStaticPeaks = (z: Float32Array, columns: number, rows: number): void => {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const u = i / Math.max(1, columns - 1);
      const v = j / Math.max(1, rows - 1);
      const g1 = Math.exp(-((u - 0.3) ** 2 + (v - 0.4) ** 2) / 0.02);
      const g2 = Math.exp(-((u - 0.7) ** 2 + (v - 0.65) ** 2) / 0.015);
      const ridge = Math.exp(-((u - v) ** 2) / 0.01) * 0.5;
      const amp = Math.min(1, g1 + g2 + ridge);
      z[j * columns + i] = -100 + amp * 100;
    }
  }
};

/** Fill one spectrum column (length === rows) for updateHeatmap appendColumns. */
const fillSpectrogramColumnInto = (column: Float32Array, t: number): void => {
  const rows = column.length;
  for (let j = 0; j < rows; j++) {
    const fNorm = j / Math.max(1, rows - 1);
    const chirp = 0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.7));
    const main = Math.exp(-((fNorm - chirp) ** 2) / 0.0015);
    const harm = 0.45 * Math.exp(-((fNorm - chirp * 0.55) ** 2) / 0.002);
    const noise = 0.04 * Math.random();
    const amp = Math.min(1, main + harm + noise);
    column[j] = -100 + amp * 100;
  }
};

type Controls = {
  mode: 'static' | 'live';
  colormap: HeatmapColormap;
  opacity: number;
  zMin: number;
  zMax: number;
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const modeEl = document.getElementById('mode') as HTMLSelectElement;
  const colormapEl = document.getElementById('colormap') as HTMLSelectElement;
  const opacityEl = document.getElementById('opacity') as HTMLInputElement;
  const opacityVal = document.getElementById('opacityVal') as HTMLSpanElement;
  const zMinEl = document.getElementById('zMin') as HTMLInputElement;
  const zMaxEl = document.getElementById('zMax') as HTMLInputElement;

  const readControls = (): Controls => ({
    mode: modeEl.value === 'static' ? 'static' : 'live',
    colormap: colormapEl.value as HeatmapColormap,
    opacity: Number(opacityEl.value),
    zMin: Number(zMinEl.value),
    zMax: Number(zMaxEl.value),
  });

  const z = new Float32Array(TIME_BINS * FREQ_BINS);
  fillStaticPeaks(z, TIME_BINS, FREQ_BINS);

  /** Reused column-major strip buffer for appendColumns (length === rows). */
  const spectrumColumn = new Float32Array(FREQ_BINS);
  let liveT = 0;
  let live = true;

  /**
   * Stable data object identity for live style setOption (colormap/opacity/zMin/zMax)
   * so shouldClearHeatmapStream keeps the scrolled stream.
   */
  let liveData: HeatmapData = {
    xStart: 0,
    xStep: DT,
    yStart: 20,
    yStep: DF,
    columns: TIME_BINS,
    rows: FREQ_BINS,
    z,
  };

  const buildOptions = (ctrl: Controls, data: HeatmapData): ChartGPUOptions => ({
    grid: { left: 64, right: 24, top: 28, bottom: 48 },
    xAxis: {
      type: 'value',
      name: ctrl.mode === 'live' ? 'Time (s)' : 'X',
    },
    yAxis: {
      type: 'value',
      name: ctrl.mode === 'live' ? 'Frequency (Hz)' : 'Y',
    },
    tooltip: { show: true, trigger: 'item' },
    theme,
    animation: { duration: 0 },
    series: [
      {
        type: 'heatmap',
        name: ctrl.mode === 'live' ? 'Spectrogram' : 'Peaks',
        data,
        colormap: ctrl.colormap,
        zMin: Number.isFinite(ctrl.zMin) ? ctrl.zMin : -100,
        zMax: Number.isFinite(ctrl.zMax) ? ctrl.zMax : 0,
        opacity: ctrl.opacity,
        cellAnchor: 'corner',
        nullHandling: 'transparent',
      },
    ],
  });

  let ctrl = readControls();
  if (ctrl.mode === 'static') {
    fillStaticPeaks(z, TIME_BINS, FREQ_BINS);
    live = false;
  } else {
    z.fill(-100);
    live = true;
    liveT = 0;
  }

  const chart: ChartGPUInstance = await ChartGPU.create(chartEl, buildOptions(ctrl, liveData));

  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(chartEl);
  chart.resize();

  const applyControls = async (): Promise<void> => {
    ctrl = readControls();
    opacityVal.textContent = ctrl.opacity.toFixed(2);
    const wasLive = live;
    live = ctrl.mode === 'live';

    if (ctrl.mode === 'static') {
      fillStaticPeaks(z, TIME_BINS, FREQ_BINS);
      // New data identity clears any live stream.
      liveData = {
        xStart: 0,
        xStep: DT,
        yStart: 20,
        yStep: DF,
        columns: TIME_BINS,
        rows: FREQ_BINS,
        z,
      };
      await chart.setOption(buildOptions(ctrl, liveData));
      return;
    }

    if (!wasLive) {
      // Entering live: clear field and new data identity for a clean stream seed.
      z.fill(-100);
      liveT = 0;
      liveData = {
        xStart: 0,
        xStep: DT,
        yStart: 20,
        yStep: DF,
        columns: TIME_BINS,
        rows: FREQ_BINS,
        z,
      };
      await chart.setOption(buildOptions(ctrl, liveData));
      return;
    }

    // Style-only while live: same data ref → stream kept (scrolled xStart preserved).
    await chart.setOption(buildOptions(ctrl, liveData));
  };

  for (const el of [modeEl, colormapEl, opacityEl, zMinEl, zMaxEl]) {
    el.addEventListener('change', () => {
      void applyControls();
    });
    el.addEventListener('input', () => {
      if (el === opacityEl) opacityVal.textContent = Number(opacityEl.value).toFixed(2);
    });
  }

  let raf = 0;
  let lastT = performance.now();
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    if (!live) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const steps = Math.max(1, Math.round(dt / DT));
    for (let s = 0; s < steps; s++) {
      fillSpectrogramColumnInto(spectrumColumn, liveT);
      liveT += DT;
      chart.updateHeatmap?.(0, {
        mode: 'appendColumns',
        columns: 1,
        z: spectrumColumn,
        scrollX: true,
      });
    }
  };
  raf = requestAnimationFrame(tick);

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    chart.dispose();
  };
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
  // Vite HMR: dispose RAF + WebGPU so reloads do not leak devices/frames.
  import.meta.hot?.dispose(cleanup);
}

main().catch((err: unknown) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});
