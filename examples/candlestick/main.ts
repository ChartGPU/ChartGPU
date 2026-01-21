import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, OHLCDataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message; 
  el.style.display = 'block';
};

/**
 * Generate synthetic OHLC data for demonstration.
 * Simulates a stock price with random walk and candles at 1-second intervals.
 */
function generateOHLCData(numCandles: number, startPrice: number = 100): ReadonlyArray<OHLCDataPoint> {
  const data: OHLCDataPoint[] = [];
  const msPerSecond = 1000;
  const startTimestamp = Date.now() - numCandles * msPerSecond;

  let currentPrice = startPrice;

  for (let i = 0; i < numCandles; i++) {
    const timestamp = startTimestamp + i * msPerSecond;

    // Random walk with trend
    const openPrice = currentPrice;
    const volatility = 0.03; // 3% volatility per interval
    const trend = (Math.random() - 0.48) * 0.02; // Slight upward bias
    const change = openPrice * (trend + (Math.random() - 0.5) * volatility);
    const closePrice = openPrice + change;

    // Generate high/low with some randomness
    const highPrice = Math.max(openPrice, closePrice) * (1 + Math.random() * 0.015);
    const lowPrice = Math.min(openPrice, closePrice) * (1 - Math.random() * 0.015);

    // Use tuple format: [timestamp, open, close, low, high]
    data.push([timestamp, openPrice, closePrice, lowPrice, highPrice]);

    currentPrice = closePrice;
  }

  return data;
}

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  // Generate 60 candles (60 seconds of data at 1-second intervals)
  const ohlcData = generateOHLCData(60);

  // Extract min/max for axis bounds
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;

  for (const candle of ohlcData) {
    const [timestamp, , , low, high] = candle as [number, number, number, number, number];
    minTimestamp = Math.min(minTimestamp, timestamp);
    maxTimestamp = Math.max(maxTimestamp, timestamp);
    minPrice = Math.min(minPrice, low);
    maxPrice = Math.max(maxPrice, high);
  }

  // Add 5% padding to price range for better visibility
  const priceRange = maxPrice - minPrice;
  const pricePadding = priceRange * 0.05;

  // Add padding to timestamp range (1 second on each side)
  const msPerSecond = 1000;
  const timestampPadding = msPerSecond;

  const initialOptions: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: {
      type: 'value',
      min: minTimestamp - timestampPadding,
      max: maxTimestamp + timestampPadding,
      name: 'Time',
    },
    yAxis: {
      type: 'value',
      min: minPrice - pricePadding,
      max: maxPrice + pricePadding,
      name: 'Price ($)',
    },
    tooltip: { show: true, trigger: 'axis' },
    animation: { duration: 600, easing: 'cubicOut', delay: 0 },
    series: [
      {
        type: 'candlestick',
        name: 'Stock Price',
        data: ohlcData,
        style: 'classic',
        itemStyle: {
          upColor: '#26a69a',
          downColor: '#ef5350',
          upBorderColor: '#26a69a',
          downBorderColor: '#ef5350',
          borderWidth: 1,
        },
        barWidth: '80%',
        barMinWidth: 2,
        barMaxWidth: 40,
      },
    ],
  };

  const chart = await ChartGPU.create(container, initialOptions);
  // IMPORTANT: `setOption(...)` replaces options (no merging). Preserve full options
  // when updating just the candlestick series styling.
  let currentOptions: ChartGPUOptions = initialOptions;

  // Keep the canvas crisp as the container resizes.
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

  // Wire up controls
  const styleSelect = document.getElementById('style-select') as HTMLSelectElement | null;
  const upColorInput = document.getElementById('up-color') as HTMLInputElement | null;
  const downColorInput = document.getElementById('down-color') as HTMLInputElement | null;
  const borderWidthInput = document.getElementById('border-width') as HTMLInputElement | null;

  const updateChart = () => {
    const style = styleSelect?.value === 'hollow' ? 'hollow' : 'classic';
    const upColor = upColorInput?.value ?? '#26a69a';
    const downColor = downColorInput?.value ?? '#ef5350';
    const borderWidth = borderWidthInput ? parseFloat(borderWidthInput.value) : 1;

    const series0 = currentOptions.series?.[0];
    if (!series0 || series0.type !== 'candlestick') return;

    currentOptions = {
      ...currentOptions,
      series: [
        {
          ...series0,
          data: ohlcData,
          style,
          itemStyle: {
            ...series0.itemStyle,
            upColor,
            downColor,
            upBorderColor: upColor,
            downBorderColor: downColor,
            borderWidth,
          },
        },
      ],
    };
    chart.setOption(currentOptions);
  };

  styleSelect?.addEventListener('change', updateChart);
  upColorInput?.addEventListener('input', updateChart);
  downColorInput?.addEventListener('input', updateChart);
  borderWidthInput?.addEventListener('input', updateChart);

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
