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
      // Two Gaussians + a diagonal ridge
      const g1 = Math.exp(-((u - 0.3) ** 2 + (v - 0.4) ** 2) / 0.02);
      const g2 = Math.exp(-((u - 0.7) ** 2 + (v - 0.65) ** 2) / 0.015);
      const ridge = Math.exp(-((u - v) ** 2) / 0.01) * 0.5;
      // Map to dB-like range for the example color scale
      const amp = Math.min(1, g1 + g2 + ridge);
      z[j * columns + i] = -100 + amp * 100;
    }
  }
};

const fillSpectrogramColumn = (
  z: Float32Array,
  columns: number,
  rows: number,
  col: number,
  t: number
): void => {
  // Chirp + harmonics in frequency bins
  for (let j = 0; j < rows; j++) {
    const fNorm = j / Math.max(1, rows - 1);
    const chirp = 0.15 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.7));
    const main = Math.exp(-((fNorm - chirp) ** 2) / 0.0015);
    const harm = 0.45 * Math.exp(-((fNorm - chirp * 0.55) ** 2) / 0.002);
    const noise = 0.04 * Math.random();
    const amp = Math.min(1, main + harm + noise);
    z[j * columns + col] = -100 + amp * 100;
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

  let windowT0 = 0;
  let writeCol = 0;
  let live = true;

  const buildData = (ctrl: Controls): HeatmapData => ({
    xStart: ctrl.mode === 'live' ? windowT0 : 0,
    xStep: DT,
    yStart: 20,
    yStep: DF,
    columns: TIME_BINS,
    rows: FREQ_BINS,
    z,
  });

  const buildOptions = (ctrl: Controls): ChartGPUOptions => ({
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
        data: buildData(ctrl),
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
  }

  const chart: ChartGPUInstance = await ChartGPU.create(chartEl, buildOptions(ctrl));

  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(chartEl);
  chart.resize();

  const applyControls = async (): Promise<void> => {
    ctrl = readControls();
    opacityVal.textContent = ctrl.opacity.toFixed(2);
    live = ctrl.mode === 'live';
    if (ctrl.mode === 'static') {
      fillStaticPeaks(z, TIME_BINS, FREQ_BINS);
    }
    await chart.setOption(buildOptions(ctrl));
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
    // Advance ~1 column per ~16ms at 60fps
    const steps = Math.max(1, Math.round(dt / DT));
    for (let s = 0; s < steps; s++) {
      const t = windowT0 + writeCol * DT;
      fillSpectrogramColumn(z, TIME_BINS, FREQ_BINS, writeCol, t);
      writeCol += 1;
      if (writeCol >= TIME_BINS) {
        writeCol = 0;
        windowT0 += TIME_BINS * DT;
      }
    }
    // New series element each frame so dirty gate uploads mutated z buffer.
    void chart.setOption(buildOptions(readControls()));
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
