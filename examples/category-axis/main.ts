import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

const makeSeries = (ys: ReadonlyArray<number>): ReadonlyArray<DataPoint> =>
  ys.map((y, x) => [x, y] as const);

const drawFallbackChart = (
  container: HTMLElement,
  categories: ReadonlyArray<string>,
  orders: ReadonlyArray<number>,
  avgTicket: ReadonlyArray<number>
): void => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showError('Canvas 2D context not available for fallback rendering.');
    return;
  }

  const render = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f0f14';
    ctx.fillRect(0, 0, width, height);

    const padding = { left: 70, right: 24, top: 24, bottom: 56 };
    const plotLeft = padding.left;
    const plotRight = width - padding.right;
    const plotTop = padding.top;
    const plotBottom = height - padding.bottom;
    const plotWidth = Math.max(1, plotRight - plotLeft);
    const plotHeight = Math.max(1, plotBottom - plotTop);

    const maxValue = 110;
    const yScale = (v: number) => plotBottom - (v / maxValue) * plotHeight;
    const xStep = plotWidth / Math.max(1, categories.length);

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.moveTo(plotLeft, plotBottom);
    ctx.lineTo(plotLeft, plotTop);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    categories.forEach((label, i) => {
      const x = plotLeft + xStep * (i + 0.5);
      ctx.fillText(label, x, plotBottom + 8);
    });

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 55, 110].forEach((val) => {
      const y = yScale(val);
      ctx.fillText(String(val), plotLeft - 8, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    });

    const barWidth = xStep * 0.55;
    ctx.fillStyle = '#4a9eff';
    orders.forEach((val, i) => {
      const xCenter = plotLeft + xStep * (i + 0.5);
      const x = xCenter - barWidth / 2;
      const y = yScale(val);
      ctx.fillRect(x, y, barWidth, plotBottom - y);
    });

    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 2;
    ctx.beginPath();
    avgTicket.forEach((val, i) => {
      const x = plotLeft + xStep * (i + 0.5);
      const y = yScale(val * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  container.appendChild(canvas);
  render();
  const ro = new ResizeObserver(render);
  ro.observe(container);
};

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  const categories = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const orders = [42, 58, 37, 66, 92, 75, 54];
  const avgTicket = [28, 32, 24, 36, 40, 38, 30];

  const adapter = await Promise.race([
    navigator.gpu?.requestAdapter?.() ?? Promise.resolve(null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
  ]);

  if (!adapter) {
    drawFallbackChart(container, categories, orders, avgTicket);
    return;
  }

  const options: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'category', data: categories, name: 'Day of Week' },
    yAxis: { type: 'value', min: 0, max: 110, name: 'Orders' },
    palette: ['#4a9eff', '#ffb454'],
    tooltip: { show: true, trigger: 'axis' },
    animation: { duration: 900, easing: 'cubicOut', delay: 0 },
    series: [
      {
        type: 'bar',
        name: 'Orders',
        data: makeSeries(orders),
        color: '#4a9eff',
        barWidth: '60%',
        barGap: 0.05,
        barCategoryGap: 0.3,
      },
      {
        type: 'line',
        name: 'Avg Ticket (scaled)',
        data: makeSeries(avgTicket.map((v) => v * 2)),
        color: '#ffb454',
        lineStyle: { width: 2, opacity: 1 },
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
