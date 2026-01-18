import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, ScatterPointTuple } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const createPoints = (
  count: number,
  seed: number,
  opts: Readonly<{
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    includeSize?: boolean;
    sizeMin?: number;
    sizeMax?: number;
  }>
): ReadonlyArray<ScatterPointTuple> => {
  const n = Math.max(0, Math.floor(count));
  const rng = mulberry32(seed);
  const out: ScatterPointTuple[] = new Array(n);

  const xSpan = opts.xMax - opts.xMin;
  const ySpan = opts.yMax - opts.yMin;
  const sizeMin = opts.sizeMin ?? 1;
  const sizeMax = opts.sizeMax ?? 8;
  const sizeSpan = sizeMax - sizeMin;

  for (let i = 0; i < n; i++) {
    const x = opts.xMin + rng() * xSpan;
    const y = opts.yMin + rng() * ySpan;

    if (opts.includeSize) {
      const size = sizeMin + rng() * sizeSpan;
      out[i] = [x, y, size] as const;
    } else {
      out[i] = [x, y] as const;
    }
  }

  // Interaction utilities assume increasing-x order for efficient lookups.
  out.sort((a, b) => a[0] - b[0]);
  return out;
};

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  const xMin = 0;
  const xMax = 100;
  const yMin = 0;
  const yMax = 100;

  // Total points: ~10k (split across series).
  const fixed = createPoints(4500, 1, { xMin, xMax, yMin, yMax });
  const perPointSize = createPoints(4500, 2, {
    xMin,
    xMax,
    yMin,
    yMax,
    includeSize: true,
    sizeMin: 1.25,
    sizeMax: 7.5,
  });
  const functionSize = createPoints(1000, 3, { xMin, xMax, yMin, yMax });

  const options: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'value', min: xMin, max: xMax, name: 'X' },
    yAxis: { type: 'value', min: yMin, max: yMax, name: 'Y' },
    palette: ['#4a9eff', '#ff4ab0', '#40d17c'],
    series: [
      {
        type: 'scatter',
        name: 'fixed symbolSize (3)',
        data: fixed,
        symbolSize: 3,
        color: '#4a9eff',
      },
      {
        type: 'scatter',
        name: 'per-point size ([x,y,size])',
        data: perPointSize,
        // This is a fallback; per-point `size` takes precedence when present.
        symbolSize: 2,
        color: '#ff4ab0',
      },
      {
        type: 'scatter',
        name: 'symbolSize function',
        data: functionSize,
        symbolSize: ([x]) => 1.5 + 4 * Math.abs(Math.sin(x * 0.12)),
        color: '#40d17c',
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);

  let scheduled = false;
  const ro = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      chart.resize();
    });
  });
  ro.observe(container);

  // Initial sizing/render.
  chart.resize();

  window.addEventListener('beforeunload', () => {
    ro.disconnect();
    chart.dispose();
  });
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

