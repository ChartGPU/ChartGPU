/**
 * 3D Showcase — stable inspect-first demo of labeled axes, pick, contours;
 * optional slow cloud FIFO + surface strip (camera can follow scroll).
 * Profile with production dist (build + preview), not Vite dev.
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  PointCloud3DData,
  Surface3DGridData,
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
  textColor: 'rgba(224,224,224,0.9)',
  axisLineColor: 'rgba(224,224,224,0.4)',
  gridLineColor: 'rgba(255,255,255,0.12)',
};

const COLS = 96;
const ROWS = 64;

/** Cloud seed size for first paint (inspect mode) — not the FIFO cap. */
const SEED_CLOUD = 12_000;

/** Cloud FIFO: modest rate (append cost is higher than strip). */
const CLOUD_BATCH = 100;
const CLOUD_INTERVAL_MS = 150;
/**
 * Strip scroll must run near display refresh. A 150ms interval made the
 * animation itself ~6.7 FPS (stop-motion), which felt "one frame at a time"
 * even when each pack was cheap. Target ~60 column steps/s via rAF.
 */
const SURFACE_INTERVAL_MS = 0;
/** Phase advance per column step — tuned for ~60 Hz strip cadence. */
const SURFACE_T_STEP = 0.006;

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

/** Sample peaks as a small cloud seed; optional FIFO grows later. */
const makeSeedCloud = (
  n: number,
  yField: Float32Array,
  columns: number,
  rows: number,
  xStart: number,
  xStep: number,
  zStart: number,
  zStep: number
): { x: Float32Array; y: Float32Array; z: Float32Array; value: Float32Array } => {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ii = Math.floor(Math.random() * columns);
    const jj = Math.floor(Math.random() * rows);
    const wx = xStart + ii * xStep;
    const wz = zStart + jj * zStep;
    const h = yField[jj * columns + ii]! + (Math.random() - 0.5) * 0.08;
    x[i] = wx + (Math.random() - 0.5) * 0.04;
    y[i] = h + 0.05;
    z[i] = wz + (Math.random() - 0.5) * 0.04;
    value[i] = h;
  }
  return { x, y, z, value };
};

/** Comfortable orbit start so the ridge is framed (not auto-fit from behind). */
const applyComfortCamera = (chart: ChartGPUInstance): void => {
  chart.setCamera?.({
    type: 'perspective',
    eye: [2.4, 1.6, 2.2],
    target: [0, 0.15, 0],
    up: [0, 1, 0],
    fovY: Math.PI / 4,
  });
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const cloudSizeEl = document.getElementById('cloudSize') as HTMLSelectElement;
  const streamCloudEl = document.getElementById('streamCloud') as HTMLInputElement;
  const streamSurfaceEl = document.getElementById('streamSurface') as HTMLInputElement;
  const followScrollEl = document.getElementById('followScroll') as HTMLInputElement;
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
  let cloudArrays = makeSeedCloud(
    SEED_CLOUD,
    yField,
    COLS,
    ROWS,
    surfaceData.xStart,
    surfaceData.xStep,
    surfaceData.zStart,
    surfaceData.zStep
  );
  const cloudData: {
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    value: Float32Array;
  } = cloudArrays;

  let streamT = 0;
  let surfaceXStart = -1;
  let rafStream: number | null = null;
  let lastCloudMs = 0;
  let lastSurfaceMs = 0;
  let lastStatus = 0;
  /** Accumulated world X shift from strip scroll (for camera follow). */
  let scrollOffsetX = 0;

  const maxCloud = (): number => Number(cloudSizeEl.value);

  const syncCloudDataRef = (): void => {
    cloudData.x = cloudArrays.x;
    cloudData.y = cloudArrays.y;
    cloudData.z = cloudArrays.z;
    cloudData.value = cloudArrays.value;
  };

  const updateStatus = (mode: 'inspect' | 'streaming'): void => {
    if (mode === 'inspect') {
      statusEl.textContent = `inspect · seed ${SEED_CLOUD.toLocaleString()} · maxCloud=${maxCloud().toLocaleString()} · streams off`;
      return;
    }
    const parts: string[] = [];
    if (streamCloudEl.checked) parts.push('cloud FIFO');
    if (streamSurfaceEl.checked) parts.push('strip');
    statusEl.textContent = `stream ${parts.join('+') || '—'} · t=${streamT.toFixed(2)} · maxCloud=${maxCloud().toLocaleString()}`;
  };

  const buildOptions = (): ChartGPUOptions => ({
    coordinateSystem: 'cartesian3d',
    theme,
    legend: { show: true, position: 'right' },
    tooltip: { show: true },
    camera: {
      type: camEl.value === 'orthographic' ? 'orthographic' : 'perspective',
      eye: [2.4, 1.6, 2.2],
      target: [0, 0.15, 0],
      up: [0, 1, 0],
      fovY: Math.PI / 4,
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
    (surfaceData as { y: Float32Array }).y = yField;
    // Reset scroll pose on surfaceData so resolver seed matches world
    (surfaceData as { xStart: number }).xStart = -1;
    surfaceXStart = -1;
    scrollOffsetX = 0;
    streamT = 0;
    lastCloudMs = 0;
    lastSurfaceMs = 0;
    cloudArrays = makeSeedCloud(
      SEED_CLOUD,
      yField,
      COLS,
      ROWS,
      -1,
      surfaceData.xStep,
      surfaceData.zStart,
      surfaceData.zStep
    );
    syncCloudDataRef();
    try {
      chart = await ChartGPU.create(chartEl, buildOptions());
      // Ensure comfort framing even if create path re-fits
      applyComfortCamera(chart);
      if (camEl.value === 'orthographic') {
        chart.setCamera?.({ type: 'orthographic', orthoSize: 2.2 });
      }
      chart.on?.('click', (p) => {
        console.log('3d click', p);
      });
      updateStatus('inspect');
      // Start only if user already enabled streams (defaults are off)
      startStream();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  const appendCloudBatch = (): void => {
    if (!chart || !streamCloudEl.checked) return;
    const batch = CLOUD_BATCH;
    const x = new Float32Array(batch);
    const y = new Float32Array(batch);
    const z = new Float32Array(batch);
    const value = new Float32Array(batch);
    for (let i = 0; i < batch; i++) {
      const ii = Math.floor(Math.random() * COLS);
      const jj = Math.floor(Math.random() * ROWS);
      const wx = surfaceXStart + ii * surfaceData.xStep + (Math.random() - 0.5) * 0.05;
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
    streamT += SURFACE_T_STEP;
    // Column-major strip payload (length === rows) — library scrolls + packs once.
    const col = new Float32Array(ROWS);
    const nextI = COLS;
    const uEdge = -1 + (nextI / Math.max(1, COLS - 1)) * 2 + streamT * 0.08;
    for (let r = 0; r < ROWS; r++) {
      const v = (r / Math.max(1, ROWS - 1)) * 2 - 1;
      col[r] = heightAt(uEdge, v, streamT);
    }
    // Mirror height field for cloud sampling only (row-major shift via copyWithin).
    // Do not re-implement strip logic for the chart — updateSurface3D owns GPU state.
    for (let r = 0; r < ROWS; r++) {
      const row = r * COLS;
      yField.copyWithin(row, row + 1, row + COLS);
      yField[row + COLS - 1] = col[r]!;
    }
    const dx = surfaceData.xStep;
    surfaceXStart += dx;
    scrollOffsetX += dx;

    chart.updateSurface3D?.(0, {
      mode: 'appendColumns',
      columns: 1,
      y: col,
      scrollX: true,
    });

    // Keep the ridge framed so the example does not "run away" from the mouse.
    if (followScrollEl.checked) {
      const cam = chart.getCamera?.();
      if (cam?.eye && cam.target) {
        chart.setCamera?.({
          eye: [cam.eye[0]! + dx, cam.eye[1]!, cam.eye[2]!],
          target: [cam.target[0]! + dx, cam.target[1]!, cam.target[2]!],
        });
      }
    }
  };

  const tickStream = (now: number): void => {
    if (streamCloudEl.checked && now - lastCloudMs >= CLOUD_INTERVAL_MS) {
      lastCloudMs = now;
      appendCloudBatch();
    }
    // SURFACE_INTERVAL_MS === 0 → one column per animation frame (smooth scroll).
    if (
      streamSurfaceEl.checked &&
      (SURFACE_INTERVAL_MS <= 0 || now - lastSurfaceMs >= SURFACE_INTERVAL_MS)
    ) {
      lastSurfaceMs = now;
      scrollSurface();
    }
    if (now - lastStatus > 400) {
      lastStatus = now;
      updateStatus('streaming');
    }
    rafStream = requestAnimationFrame(tickStream);
  };

  const startStream = (): void => {
    stopStream();
    if (!streamCloudEl.checked && !streamSurfaceEl.checked) {
      updateStatus('inspect');
      return;
    }
    const now = performance.now();
    lastCloudMs = now;
    lastSurfaceMs = now;
    rafStream = requestAnimationFrame(tickStream);
    updateStatus('streaming');
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
  followScrollEl.addEventListener('change', () => {
    /* applied on next strip tick */
  });
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
    if (!chart) return;
    // Frame the current surface window center (scroll may have advanced xStart).
    const cx = surfaceXStart + (COLS * surfaceData.xStep) / 2;
    const cz = surfaceData.zStart + (ROWS * surfaceData.zStep) / 2;
    if (camEl.value === 'orthographic') {
      chart.setCamera?.({
        type: 'orthographic',
        eye: [cx + 2.4, 1.6, cz + 2.2],
        target: [cx, 0.15, cz],
        orthoSize: 2.2,
      });
    } else {
      chart.setCamera?.({
        type: 'perspective',
        eye: [cx + 2.4, 1.6, cz + 2.2],
        target: [cx, 0.15, cz],
        up: [0, 1, 0],
        fovY: Math.PI / 4,
      });
    }
  });
  resetBtn.addEventListener('click', () => {
    if (!chart) return;
    // Reset to comfort view on the *current* surface window center
    const cx = surfaceXStart + (COLS * surfaceData.xStep) / 2;
    const cz = surfaceData.zStart + (ROWS * surfaceData.zStep) / 2;
    if (camEl.value === 'orthographic') {
      chart.setCamera?.({
        type: 'orthographic',
        eye: [cx + 2.4, 1.6, cz + 2.2],
        target: [cx, 0.15, cz],
        orthoSize: 2.2,
      });
    } else {
      chart.setCamera?.({
        type: 'perspective',
        eye: [cx + 2.4, 1.6, cz + 2.2],
        target: [cx, 0.15, cz],
        up: [0, 1, 0],
        fovY: Math.PI / 4,
      });
    }
  });

  await recreate();
}

void main();
