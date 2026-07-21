/**
 * Error bars example — science dose–response with SEM whiskers.
 * Dual-series pattern: errorBar under line through centers.
 *
 * Vertical: x = dose, y = response, high/low = response ± SEM.
 * Horizontal: remaps so y = dose (category), x/high/low = response extents
 * (SciChart EErrorDirection.Horizontal contract).
 */
import { ChartGPU, darkTheme } from '../../src/index';
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  ErrorBarDirection,
  ErrorBarMode,
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

const COLOR = '#38bdf8';

/** Synthetic assay: dose (mg) vs mean response ± SEM. */
function makeAssay(): {
  x: Float64Array;
  y: Float64Array;
  high: Float64Array;
  low: Float64Array;
} {
  const doses = [0, 0.5, 1, 2, 4, 8, 16, 32];
  const n = doses.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = doses[i]!;
    x[i] = d;
    // Logistic-ish response
    const mean = 1.2 + 4.5 / (1 + Math.exp(-(Math.log(d + 0.15) - 1.2) * 1.8));
    const sem = 0.18 + 0.08 * Math.sin(i * 1.3) + 0.04 * (i / n);
    y[i] = mean;
    high[i] = mean + sem;
    low[i] = mean - sem;
  }
  return { x, y, high, low };
}

/**
 * Map vertical assay HLC → horizontal SciChart layout:
 * - category (dose) on Y
 * - response center on X, high/low as absolute X whiskers
 */
function toHorizontalHlc(assay: ReturnType<typeof makeAssay>): {
  x: Float64Array;
  y: Float64Array;
  high: Float64Array;
  low: Float64Array;
} {
  const n = assay.x.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = assay.x[i]!; // dose → category Y
    x[i] = assay.y[i]!; // mean response → center X
    high[i] = assay.high[i]!;
    low[i] = assay.low[i]!;
  }
  return { x, y, high, low };
}

type Controls = {
  errorMode: ErrorBarMode;
  direction: ErrorBarDirection;
  capWidth: number | string;
  showCenter: boolean;
  drawWhiskers: boolean;
  drawConnector: boolean;
  showLine: boolean;
};

function parseCapWidth(raw: string): number | string {
  if (raw.endsWith('%')) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : '40%';
}

async function main(): Promise<void> {
  const chartEl = document.getElementById('chart');
  if (!(chartEl instanceof HTMLElement)) throw new Error('Chart container not found');

  const errorModeEl = document.getElementById('errorMode') as HTMLSelectElement;
  const directionEl = document.getElementById('direction') as HTMLSelectElement;
  const capWidthEl = document.getElementById('capWidth') as HTMLSelectElement;
  const showCenterEl = document.getElementById('showCenter') as HTMLInputElement;
  const drawWhiskersEl = document.getElementById('drawWhiskers') as HTMLInputElement;
  const drawConnectorEl = document.getElementById('drawConnector') as HTMLInputElement;
  const showLineEl = document.getElementById('showLine') as HTMLInputElement;

  const assay = makeAssay();
  let chart: ChartGPUInstance | null = null;

  const readControls = (): Controls => ({
    errorMode: errorModeEl.value as ErrorBarMode,
    direction: directionEl.value as ErrorBarDirection,
    capWidth: parseCapWidth(capWidthEl.value),
    showCenter: showCenterEl.checked,
    drawWhiskers: drawWhiskersEl.checked,
    drawConnector: drawConnectorEl.checked,
    showLine: showLineEl.checked,
  });

  const buildOptions = (c: Controls): ChartGPUOptions => {
    const hlc = c.direction === 'horizontal' ? toHorizontalHlc(assay) : assay;
    const series: ChartGPUOptions['series'] = [
      {
        type: 'errorBar',
        name: 'Assay ±SEM',
        data: {
          x: hlc.x,
          y: hlc.y,
          high: hlc.high,
          low: hlc.low,
        },
        itemStyle: { color: COLOR, borderWidth: 2 },
        capWidth: c.capWidth,
        errorMode: c.errorMode,
        direction: c.direction,
        drawWhiskers: c.drawWhiskers,
        drawConnector: c.drawConnector,
        showCenter: c.showCenter,
        symbolSize: 8,
      },
    ];
    if (c.showLine) {
      series.push({
        type: 'line',
        name: 'Mean',
        data: { x: hlc.x, y: hlc.y },
        lineStyle: { width: 2, color: COLOR },
        sampling: 'none',
      });
    }
    return {
      theme,
      animation: false,
      legend: { show: true, position: 'top' },
      tooltip: { show: true, trigger: 'item' },
      grid: { left: 56, right: 24, top: 48, bottom: 48 },
      xAxis: {
        type: 'value',
        name: c.direction === 'horizontal' ? 'Response' : 'Dose (mg)',
      },
      yAxis: {
        type: 'value',
        name: c.direction === 'horizontal' ? 'Dose (mg)' : 'Response',
      },
      series,
    };
  };

  const apply = async (): Promise<void> => {
    const opts = buildOptions(readControls());
    if (!chart) {
      chart = await ChartGPU.create(chartEl, opts);
    } else {
      chart.setOption(opts);
    }
  };

  try {
    await apply();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return;
  }

  const onChange = (): void => {
    void apply().catch((e) => showError(e instanceof Error ? e.message : String(e)));
  };

  errorModeEl.addEventListener('change', onChange);
  directionEl.addEventListener('change', onChange);
  capWidthEl.addEventListener('change', onChange);
  showCenterEl.addEventListener('change', onChange);
  drawWhiskersEl.addEventListener('change', onChange);
  drawConnectorEl.addEventListener('change', onChange);
  showLineEl.addEventListener('change', onChange);
}

void main();
