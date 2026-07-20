/**
 * 3D Showcase — labeled axes, surface + contours, cloud FIFO stream, surface strip scroll, pick.
 * Profile with production dist (build + preview), not Vite dev.
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, PointCloud3DData, Surface3DGridData, ThemeConfig } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const theme: ThemeConfig = {
  ...darkTheme,
  backgroundColor: '#0f0f14',
  textColor: 'rgba(224,224,224,0.9)',
  axisLineColor: 'rgba(224,224,224,0.4)',
  gridLineColor: 'rgba(255,255,255,0.12)',
};

const COLS = 96;
const ROWS = 64;

const heightAt = (u: number, v: number, t: number): number => {
  const g1 = Math.exp(-((u - 0.25) ** 2 + (v + 0.15) ** 2) / 0.12);
  const g2 = 0.65 * Math.exp(-((u + 0.35) ** 2 + (v - 0.3) ** 2) / 0.09);
  const ridge = 0.2 * Math.sin((u + t) * 5) * Math.cos(v * 4);
  return g1 + g2 + ridge - 0.15 * (u * u + v * v);
};

const fillTerrain = (y: Float32Array, columns: number, rows: number, t = 0): void => {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const u = (i / Math.max(1, columns - 1)) * 2 - 1;
      const v = (j / Math.max(1, rows - 1)) * 2 - 1;
      y[j * columns + i] = heightAt(u, v, t);
    }
  }
};

/** Sample peaks as a small cloud seed, then grow via FIFO stream. */
const makeSeedCloud = (
  n: number,
  yField: Float32Array,
  columns: number,
  rows: number
): { x: Float32Array; y: Float32Array; z: Float32Array; value: Float32Array } => {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ii = Math.floor(Math.random() * columns);
    const jj = Math.floor(Math.random() * rows);
    const wx = -1 + (ii / Math.max(1, columns - 1)) * 2;
    const wz = -1 + (jj / Math.max(1, rows - 1)) * 2;
    const h = yField[jj * columns + ii]! + (Math.random() - 0.5) * 0.08;
    x[i] = wx + (Math.random() - 0.5) * 0.04;
    y[i] = h + 0.05;
    z[i] = wz + (Math.random() - 0.5) * 0.04;
    value[i] = h;
  }
  return { x, y, z, value };
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const cloudSizeEl = document.getElementById('cloudSize') as HTMLSelectElement;
  const streamCloudEl = document.getElementById('streamCloud') as HTMLInputElement;
  const streamSurfaceEl = document.getElementById('streamSurface') as HTMLInputElement;
  const showContoursEl = document.getElementById('showContours') as HTMLInputElement;
  const camEl = document.getElementById('camType') as HTMLSelectElement;
  const resetBtn = document.getElementById('resetCam') as HTMLButtonElement;
  const statusEl = document.getElementById('status') as HTMLSpanElement;

  let chart: ChartGPUInstance | null = null;
  // Stable series data object identities — style setOption must reuse these so
  // cloud FIFO pack + surface stream survive contour toggles.
  let yField = new Float32Array(COLS * ROWS);
  fillTerrain(yField, COLS, ROWS, 0);
  const surfaceData: Surface3DGridData = {
    xStart: -1,
    xStep: 2 / Math.max(1, COLS - 1),
    zStart: -1,
    zStep: 2 / Math.max(1, ROWS - 1),
    columns: COLS,
    rows: ROWS,
    y: yField,
  };
  let cloudArrays = makeSeedCloud(Math.min(20_000, Number(cloudSizeEl.value)), yField, COLS, ROWS);
  // Stable cloud data object (arrays may grow via appendData pack path; seed ref identity).
  const cloudData: {
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    value: Float32Array;
  } = cloudArrays;
  let streamT = 0;
  let surfaceXStart = -1;
  let rafStream: number | null = null;
  let lastStatus = 0;

  const maxCloud = (): number => Number(cloudSizeEl.value);

  const syncCloudDataRef = (): void => {
    cloudData.x = cloudArrays.x;
    cloudData.y = cloudArrays.y;
    cloudData.z = cloudArrays.z;
    cloudData.value = cloudArrays.value;
  };

  const buildOptions = (): ChartGPUOptions => ({
    coordinateSystem: 'cartesian3d',
    theme,
    legend: { show: true, position: 'right' },
    tooltip: { show: true },
    camera: {
      type: camEl.value === 'orthographic' ? 'orthographic' : 'perspective',
    },
    axes3d: {
      showBox: true,
      showGrid: true,
      labelMode: 'auto',
      x: { name: 'X (m)', tickCount: 5 },
      y: { name: 'Height (m)', tickCount: 5 },
      z: { name: 'Y (m)', tickCount: 5 },
    },
    series: [
      {
        type: 'surface3d',
        name: 'Terrain',
        data: surfaceData,
        colormap: 'viridis',
        lighting: 0.7,
        opacity: 1,
        contours: {
          show: showContoursEl.checked,
          levels: 10,
          color: '#e2e8f0',
          width: 1.5,
          opacity: 0.85,
        },
      },
      {
        type: 'pointCloud3d',
        name: 'LiDAR',
        data: cloudData as PointCloud3DData,
        pointStyle: { size: 2.5, color: '#38bdf8', opacity: 0.92 },
        colorBy: { colormap: 'plasma', min: -0.2, max: 1.2 },
      },
    ],
  });

  const recreate = async (): Promise<void> => {
    stopStream();
    chart?.dispose();
    chart = null;
    fillTerrain(yField, COLS, ROWS, 0);
    // Keep surfaceData object identity; only y contents change
    (surfaceData as { y: Float32Array }).y = yField;
    surfaceXStart = -1;
    streamT = 0;
    cloudArrays = makeSeedCloud(Math.min(20_000, maxCloud()), yField, COLS, ROWS);
    syncCloudDataRef();
    try {
      chart = await ChartGPU.create(chartEl, buildOptions());
      chart.on?.('click', (p) => {
        console.log('3d click', p);
      });
      startStream();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const appendCloudBatch = (): void => {
    if (!chart || !streamCloudEl.checked) return;
    const batch = 800;
    const x = new Float32Array(batch);
    const y = new Float32Array(batch);
    const z = new Float32Array(batch);
    const value = new Float32Array(batch);
    for (let i = 0; i < batch; i++) {
      const ii = Math.floor(Math.random() * COLS);
      const jj = Math.floor(Math.random() * ROWS);
      // Sample from live yField (kept in sync with surface scroll)
      const wx =
        surfaceXStart + ii * surfaceData.xStep + (Math.random() - 0.5) * 0.05;
      const wz = surfaceData.zStart + jj * surfaceData.zStep + (Math.random() - 0.5) * 0.05;
      const h = yField[jj * COLS + ii]! + 0.04 + Math.random() * 0.06;
      x[i] = wx;
      y[i] = h;
      z[i] = wz;
      value[i] = h;
    }
    chart.appendData(1, { x, y, z, value }, { maxPoints: maxCloud() });
  };

  const scrollSurface = (): void => {
    if (!chart || !streamSurfaceEl.checked) return;
    streamT += 0.04;
    const col = new Float32Array(ROWS);
    // Next column world u at the +X edge after scroll (spectrogram-style)
    const nextI = COLS; // virtual column index along the infinite strip
    const uEdge = -1 + (nextI / Math.max(1, COLS - 1)) * 2 + streamT * 0.15;
    for (let r = 0; r < ROWS; r++) {
      const v = (r / Math.max(1, ROWS - 1)) * 2 - 1;
      col[r] = heightAt(uEdge, v, streamT);
    }
    // Keep local yField mirror in sync with scroll (shift + append) for cloud sampling
    const keep = COLS - 1;
    for (let i = 0; i < keep; i++) {
      for (let r = 0; r < ROWS; r++) {
        yField[r * COLS + i] = yField[r * COLS + i + 1]!;
      }
    }
    for (let r = 0; r < ROWS; r++) {
      yField[r * COLS + (COLS - 1)] = col[r]!;
    }
    surfaceXStart += surfaceData.xStep;

    chart.updateSurface3D?.(0, {
      mode: 'appendColumns',
      columns: 1,
      y: col,
      scrollX: true,
    });
  };

  const tickStream = (): void => {
    appendCloudBatch();
    scrollSurface();
    const now = performance.now();
    if (now - lastStatus > 500) {
      lastStatus = now;
      statusEl.textContent = `stream t=${streamT.toFixed(1)} · maxCloud=${maxCloud().toLocaleString()}`;
    }
    rafStream = requestAnimationFrame(tickStream);
  };

  const startStream = (): void => {
    stopStream();
    if (streamCloudEl.checked || streamSurfaceEl.checked) {
      rafStream = requestAnimationFrame(tickStream);
    }
  };

  const stopStream = (): void => {
    if (rafStream != null) {
      cancelAnimationFrame(rafStream);
      rafStream = null;
    }
  };

  cloudSizeEl.addEventListener('change', () => {
    void recreate();
  });
  streamCloudEl.addEventListener('change', () => startStream());
  streamSurfaceEl.addEventListener('change', () => startStream());
  // Contour toggle: reuse same surfaceData + cloudData identities so FIFO/stream survive.
  showContoursEl.addEventListener('change', () => {
    chart?.setOption({
      series: [
        {
          type: 'surface3d',
          name: 'Terrain',
          data: surfaceData,
          colormap: 'viridis',
          lighting: 0.7,
          contours: {
            show: showContoursEl.checked,
            levels: 10,
            color: '#e2e8f0',
            opacity: 0.85,
          },
        },
        {
          type: 'pointCloud3d',
          name: 'LiDAR',
          data: cloudData as PointCloud3DData,
          pointStyle: { size: 2.5, color: '#38bdf8', opacity: 0.92 },
          colorBy: { colormap: 'plasma', min: -0.2, max: 1.2 },
        },
      ],
    });
  });
  camEl.addEventListener('change', () => {
    chart?.setCamera?.({
      type: camEl.value === 'orthographic' ? 'orthographic' : 'perspective',
    });
  });
  resetBtn.addEventListener('click', () => chart?.resetCamera?.());

  await recreate();
}

void main();
