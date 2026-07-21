import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, OHLCDataPoint } from '../../src/index';

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

/**
 * Generate synthetic OHLC with a clear trend + occasional wide range days
 * so stems and open/close ticks read as classic bars (not a solid stripe wall).
 * Tuple order: [timestamp, open, close, low, high] (ECharts).
 */
function generateOHLCData(numBars: number, startPrice: number = 100): ReadonlyArray<OHLCDataPoint> {
  const data: OHLCDataPoint[] = [];
  const msPerBar = 60_000; // 1-minute bars
  const startTimestamp = Date.now() - numBars * msPerBar;

  let currentPrice = startPrice;

  for (let i = 0; i < numBars; i++) {
    const timestamp = startTimestamp + i * msPerBar;
    const openPrice = currentPrice;
    // Mild trend with occasional larger moves so high/low stems are visible.
    const volatility = i % 11 === 0 ? 0.035 : 0.012;
    const trend = 0.0008 + (Math.random() - 0.45) * 0.01;
    const change = openPrice * (trend + (Math.random() - 0.5) * volatility);
    const closePrice = openPrice + change;
    const bodyHi = Math.max(openPrice, closePrice);
    const bodyLo = Math.min(openPrice, closePrice);
    const wickUp = bodyHi * (0.002 + Math.random() * 0.01);
    const wickDown = bodyLo * (0.002 + Math.random() * 0.01);
    const highPrice = bodyHi + wickUp;
    const lowPrice = Math.max(0.01, bodyLo - wickDown);
    data.push([timestamp, openPrice, closePrice, lowPrice, highPrice]);
    currentPrice = closePrice;
  }

  return data;
}

type SeriesKind = 'ohlc' | 'candlestick';

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  // Fewer bars → clearer tick geometry; dense N still works via barMaxWidth.
  const ohlcData = generateOHLCData(48);

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;

  for (const bar of ohlcData) {
    const [timestamp, , , low, high] = bar as [number, number, number, number, number];
    minTimestamp = Math.min(minTimestamp, timestamp);
    maxTimestamp = Math.max(maxTimestamp, timestamp);
    minPrice = Math.min(minPrice, low);
    maxPrice = Math.max(maxPrice, high);
  }

  const priceRange = maxPrice - minPrice;
  const pricePadding = Math.max(priceRange * 0.12, 0.5);
  const timestampPadding = 60_000;

  let seriesKind: SeriesKind = 'ohlc';
  let upColor = '#26a69a';
  let downColor = '#ef5350';

  const buildOptions = (): ChartGPUOptions => {
    const sharedStyle = {
      upColor,
      downColor,
      upBorderColor: upColor,
      downBorderColor: downColor,
      borderWidth: 1,
    };

    const series =
      seriesKind === 'ohlc'
        ? [
            {
              type: 'ohlc' as const,
              name: 'AAPL',
              data: ohlcData,
              itemStyle: sharedStyle,
              // Narrower than candle bodies so stems + open/close ticks read clearly.
              barWidth: '55%',
              barMinWidth: 4,
              barMaxWidth: 28,
              stemWidth: 1.5,
              tickLength: '50%',
            },
          ]
        : [
            {
              type: 'candlestick' as const,
              name: 'AAPL',
              data: ohlcData,
              style: 'classic' as const,
              itemStyle: sharedStyle,
              barWidth: '70%',
              barMinWidth: 2,
              barMaxWidth: 40,
            },
          ];

    return {
      grid: { top: 24, bottom: 56 },
      xAxis: {
        type: 'time',
        min: minTimestamp - timestampPadding,
        max: maxTimestamp + timestampPadding,
        name: 'Time',
      },
      yAxis: {
        type: 'value',
        min: minPrice - pricePadding,
        max: maxPrice + pricePadding,
        header: 'USD',
      },
      // Item trigger: hover the stem/body for that bar (axis mode also works).
      tooltip: { show: true, trigger: 'item' },
      legend: { show: true },
      series,
    };
  };

  let currentOptions = buildOptions();
  const chart = await ChartGPU.create(container, currentOptions);

  const apply = (): void => {
    currentOptions = buildOptions();
    chart.setOption(currentOptions);
  };

  const typeSelect = document.getElementById('series-type') as HTMLSelectElement | null;
  const upInput = document.getElementById('up-color') as HTMLInputElement | null;
  const downInput = document.getElementById('down-color') as HTMLInputElement | null;

  typeSelect?.addEventListener('change', () => {
    seriesKind = typeSelect.value === 'candlestick' ? 'candlestick' : 'ohlc';
    apply();
  });
  upInput?.addEventListener('input', () => {
    upColor = upInput.value;
    apply();
  });
  downInput?.addEventListener('input', () => {
    downColor = downInput.value;
    apply();
  });

  window.addEventListener('resize', () => {
    chart.resize();
  });
}

main().catch((err) => {
  console.error(err);
  showError(err instanceof Error ? err.message : String(err));
});
