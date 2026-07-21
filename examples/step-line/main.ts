/**
 * Step / digital line + mountain example.
 * Toggle step mode (after / before / middle / off) and mountain fill.
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, StepMode, ThemeConfig } from '../../src/index';

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

/** Discrete GPIO-like levels over sample index. */
function makeLevels(): { x: Float64Array; y: Float64Array } {
  const levels = [0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1];
  const n = levels.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = i;
    y[i] = levels[i]! * 3 + 0.5;
  }
  return { x, y };
}

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const stepModeEl = document.getElementById('stepMode') as HTMLSelectElement;
  const showMountainEl = document.getElementById('showMountain') as HTMLInputElement;
  const showLinearEl = document.getElementById('showLinear') as HTMLInputElement;
  const data = makeLevels();

  let chart: ChartGPUInstance | null = null;

  const buildOptions = (): ChartGPUOptions => {
    const modeRaw = stepModeEl.value;
    const step: boolean | StepMode | undefined =
      modeRaw === 'off' ? undefined : (modeRaw as StepMode);
    const mountain = showMountainEl.checked;
    const showLinear = showLinearEl.checked;

    const series: ChartGPUOptions['series'] = [];

    if (showLinear) {
      series.push({
        type: 'line',
        name: 'Linear (ref)',
        data: { x: data.x, y: data.y },
        color: '#64748b',
        lineStyle: { width: 1, opacity: 0.7 },
        sampling: 'none',
      });
    }

    series.push({
      type: 'line',
      name: step ? `Digital (${String(step)})` : 'Line (linear)',
      data: { x: data.x, y: data.y },
      color: '#ec4899',
      lineStyle: { width: 2.5 },
      ...(mountain ? { areaStyle: { opacity: 0.28, color: '#38bdf8' } } : {}),
      ...(step != null ? { step } : {}),
      sampling: 'none',
    });

    return {
      grid: { left: 56, right: 20, top: 24, bottom: 48 },
      xAxis: { type: 'value', name: 'Sample', min: -0.5, max: data.x.length - 0.5 },
      yAxis: { type: 'value', name: 'Level', min: 0, max: 4.2 },
      theme,
      animation: { duration: 0 },
      tooltip: { show: true },
      legend: { show: true },
      series,
    };
  };

  const rebuild = async (): Promise<void> => {
    if (chart) {
      chart.dispose();
      chart = null;
    }
    try {
      chart = await ChartGPU.create(chartEl, buildOptions());
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  };

  stepModeEl.addEventListener('change', () => void rebuild());
  showMountainEl.addEventListener('change', () => void rebuild());
  showLinearEl.addEventListener('change', () => void rebuild());

  await rebuild();
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
