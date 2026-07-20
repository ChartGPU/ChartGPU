import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, ThemeConfig } from '../../src/index';

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

/** Helix + noise cloud with radial value channel. */
const makeCloud = (n: number): { x: Float32Array; y: Float32Array; z: Float32Array; value: Float32Array } => {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const ang = t * Math.PI * 8;
    const r = 0.3 + t * 1.2;
    const nx = (Math.random() - 0.5) * 0.15;
    const ny = (Math.random() - 0.5) * 0.15;
    const nz = (Math.random() - 0.5) * 0.15;
    x[i] = Math.cos(ang) * r + nx;
    y[i] = (t - 0.5) * 2.5 + ny;
    z[i] = Math.sin(ang) * r + nz;
    value[i] = Math.hypot(x[i]!, z[i]!);
  }
  return { x, y, z, value };
};

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const countEl = document.getElementById('count') as HTMLSelectElement;
  const colorEl = document.getElementById('colorMode') as HTMLSelectElement;
  const camEl = document.getElementById('camType') as HTMLSelectElement;
  const resetBtn = document.getElementById('resetCam') as HTMLButtonElement;

  let chart: ChartGPUInstance | null = null;
  let cloud = makeCloud(Number(countEl.value));

  const buildOptions = (): ChartGPUOptions => {
    const useValue = colorEl.value === 'value';
    return {
      coordinateSystem: 'cartesian3d',
      theme,
      legend: { show: true },
      tooltip: { show: true },
      camera: {
        type: camEl.value === 'orthographic' ? 'orthographic' : 'perspective',
      },
      axes3d: { showBox: true, x: { name: 'X' }, y: { name: 'Y' }, z: { name: 'Z' } },
      series: [
        {
          type: 'pointCloud3d',
          name: 'Samples',
          data: { x: cloud.x, y: cloud.y, z: cloud.z, value: cloud.value },
          pointStyle: { size: 3, color: '#38bdf8', opacity: 0.9 },
          ...(useValue
            ? {
                colorBy: {
                  colormap: 'viridis' as const,
                  min: 0,
                  max: 1.8,
                },
              }
            : {}),
        },
      ],
    };
  };

  const recreate = async (): Promise<void> => {
    chart?.dispose();
    chart = null;
    try {
      chart = await ChartGPU.create(chartEl, buildOptions());
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  countEl.addEventListener('change', async () => {
    cloud = makeCloud(Number(countEl.value));
    await recreate();
  });
  colorEl.addEventListener('change', async () => {
    chart?.setOption(buildOptions());
  });
  camEl.addEventListener('change', async () => {
    chart?.setCamera?.({
      type: camEl.value === 'orthographic' ? 'orthographic' : 'perspective',
    });
  });
  resetBtn.addEventListener('click', () => chart?.resetCamera?.());

  await recreate();
  window.addEventListener('resize', () => chart?.resize());
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
