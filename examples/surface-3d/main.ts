import { ChartGPU, darkTheme } from '../../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  HeatmapColormap,
  SeriesConfig,
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
  textColor: 'rgba(224,224,224,0.85)',
  axisLineColor: 'rgba(224,224,224,0.35)',
};

const fillPeaks = (y: Float32Array, columns: number, rows: number): void => {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const u = (i / Math.max(1, columns - 1)) * 2 - 1;
      const v = (j / Math.max(1, rows - 1)) * 2 - 1;
      const r2 = u * u + v * v;
      const g1 = Math.exp(-((u - 0.3) ** 2 + (v + 0.2) ** 2) / 0.08);
      const g2 = 0.7 * Math.exp(-((u + 0.4) ** 2 + (v - 0.35) ** 2) / 0.06);
      const bowl = 0.15 * Math.sin(u * 6) * Math.cos(v * 5);
      y[j * columns + i] = g1 + g2 + bowl - 0.25 * r2;
    }
  }
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const resEl = document.getElementById('res') as HTMLSelectElement;
  const colormapEl = document.getElementById('colormap') as HTMLSelectElement;
  const lightingEl = document.getElementById('lighting') as HTMLInputElement;
  const lightingVal = document.getElementById('lightingVal') as HTMLSpanElement;
  const wireEl = document.getElementById('wire') as HTMLInputElement;
  const withCloudEl = document.getElementById('withCloud') as HTMLInputElement;
  const resetBtn = document.getElementById('resetCam') as HTMLButtonElement;

  let chart: ChartGPUInstance | null = null;
  let yField = new Float32Array(128 * 128);
  fillPeaks(yField, 128, 128);

  const buildSeries = (): SeriesConfig[] => {
    const n = Number(resEl.value);
    if (yField.length !== n * n) {
      yField = new Float32Array(n * n);
      fillPeaks(yField, n, n);
    }
    const surface: SeriesConfig = {
      type: 'surface3d',
      name: 'Elevation',
      data: {
        xStart: -1,
        xStep: 2 / Math.max(1, n - 1),
        zStart: -1,
        zStep: 2 / Math.max(1, n - 1),
        columns: n,
        rows: n,
        y: yField,
      },
      colormap: colormapEl.value as HeatmapColormap,
      wireframe: wireEl.checked,
      lighting: Number(lightingEl.value),
      opacity: 1,
    };
    const series: SeriesConfig[] = [surface];
    if (withCloudEl.checked) {
      const m = 2000;
      const x = new Float32Array(m);
      const y = new Float32Array(m);
      const z = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        x[i] = (Math.random() * 2 - 1) * 0.9;
        z[i] = (Math.random() * 2 - 1) * 0.9;
        // sample height roughly from field
        const ci = Math.min(n - 1, Math.max(0, Math.floor(((x[i]! + 1) / 2) * (n - 1))));
        const cj = Math.min(n - 1, Math.max(0, Math.floor(((z[i]! + 1) / 2) * (n - 1))));
        y[i] = yField[cj * n + ci]! + 0.05 + Math.random() * 0.05;
      }
      series.push({
        type: 'pointCloud3d',
        name: 'Sensors',
        data: { x, y, z },
        pointStyle: { size: 4, color: '#f472b6', opacity: 0.95 },
      });
    }
    return series;
  };

  const buildOptions = (): ChartGPUOptions => ({
    coordinateSystem: 'cartesian3d',
    theme,
    legend: { show: true },
    tooltip: { show: true },
    axes3d: { showBox: true },
    series: buildSeries(),
  });

  const recreate = async (): Promise<void> => {
    chart?.dispose();
    chart = null;
    try {
      chart = await ChartGPU.create(chartEl, buildOptions());
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const applySetOption = (): void => {
    chart?.setOption(buildOptions());
  };

  resEl.addEventListener('change', () => recreate());
  colormapEl.addEventListener('change', applySetOption);
  lightingEl.addEventListener('input', () => {
    lightingVal.textContent = Number(lightingEl.value).toFixed(2);
    applySetOption();
  });
  wireEl.addEventListener('change', applySetOption);
  withCloudEl.addEventListener('change', applySetOption);
  resetBtn.addEventListener('click', () => chart?.resetCamera?.());

  await recreate();
  window.addEventListener('resize', () => chart?.resize());
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
