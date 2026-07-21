/**
 * Impulse / stem series example — SciChart FastImpulseRenderableSeries spirit.
 */
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
  gridLineColor: 'rgba(255,255,255,0.06)',
  axisLineColor: 'rgba(224,224,224,0.14)',
  axisTickColor: 'rgba(224,224,224,0.22)',
  textColor: 'rgba(224,224,224,0.78)',
};

function makeEvents(): { x: Float64Array; y: Float64Array } {
  const n = 36;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = i;
    // Mix of positive / negative amplitudes (signed impulse train)
    const envelope = 1.2 + 0.6 * Math.sin(i / 5);
    y[i] = envelope * Math.sin(i * 0.7) * (i % 5 === 0 ? 1.8 : 1);
  }
  return { x, y };
}

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const showMarkerEl = document.getElementById('showMarker') as HTMLInputElement;
  const baselineEl = document.getElementById('baseline') as HTMLInputElement;
  const baselineVal = document.getElementById('baselineVal')!;
  const stemWidthEl = document.getElementById('stemWidth') as HTMLInputElement;
  const stemWidthVal = document.getElementById('stemWidthVal')!;
  const data = makeEvents();

  let chart: ChartGPUInstance | null = null;

  const buildOptions = (): ChartGPUOptions => {
    const baseline = Number(baselineEl.value);
    const stemWidth = Number(stemWidthEl.value);
    baselineVal.textContent = String(baseline);
    stemWidthVal.textContent = String(stemWidth);

    return {
      grid: { left: 56, right: 20, top: 24, bottom: 48 },
      xAxis: { type: 'value', name: 'Event index', min: -1, max: data.x.length },
      yAxis: { type: 'value', name: 'Amplitude' },
      theme,
      animation: { duration: 0 },
      tooltip: { show: true },
      legend: { show: true },
      series: [
        {
          type: 'impulse',
          name: 'Events',
          data: { x: data.x, y: data.y },
          color: '#a78bfa',
          baseline,
          lineStyle: { width: stemWidth, color: '#a78bfa' },
          showMarker: showMarkerEl.checked,
          symbolSize: 6,
          sampling: 'none',
        },
      ],
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

  showMarkerEl.addEventListener('change', () => void rebuild());
  baselineEl.addEventListener('input', () => void rebuild());
  stemWidthEl.addEventListener('input', () => void rebuild());

  await rebuild();
}

main().catch((e) => showError(e instanceof Error ? e.message : String(e)));
