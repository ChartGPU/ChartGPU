import { createChart, type ChartGPUInstance, type OHLCDataPoint } from '../../src/index';
import { generateHistoricalData } from './generateHistoricalData';
import { createTickSimulator, createCandleAggregator, type Tick } from './tickSimulator';

// Timeframe intervals in milliseconds
const TIMEFRAME_INTERVALS: Record<string, number> = {
  '1s': 1_000,
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '4h': 4 * 60 * 60 * 1_000,
  '1d': 24 * 60 * 60 * 1_000,
};

// TimeScale multipliers per interval (faster for longer intervals so candles form in reasonable demo time)
const TIMEFRAME_TIMESCALES: Record<string, number> = {
  '1s': 1, // Real-time for 1s candles
  '5m': 30, // 30x speed: 5m candle closes every 10s
  '15m': 60, // 60x speed: 15m candle closes every 15s
  '1h': 120, // 120x speed: 1h candle closes every 30s
  '4h': 240, // 240x speed: 4h candle closes every 60s
  '1d': 720, // 720x speed: 1d candle closes every 120s
};

// Configuration (base values - some are mutable for user control)
const CONFIG = {
  symbol: 'MEME/USD',
  ticksPerSecond: 20, // Moderate tick rate for visible updates
  tickVolatility: 0.008, // Per-tick volatility (visible but not wild)
  startPrice: 100, // Nice round starting price
};

// Mutable candle count (user-configurable)
let currentCandleCount = 60;

// Mutable timeframe state (updated when user switches intervals)
let currentTimeframe = '1s';
let candleIntervalMs = TIMEFRAME_INTERVALS[currentTimeframe];
let timeScale = TIMEFRAME_TIMESCALES[currentTimeframe];

// State
let chart: ChartGPUInstance;
let data: OHLCDataPoint[] = [];
let tickSimulator: ReturnType<typeof createTickSimulator>;
let candleAggregator: ReturnType<typeof createCandleAggregator>;
let isStreaming = false;
let autoScrollEnabled = true;
// Cache the full chart options to avoid resetting fields on partial setOption calls
let fullChartOptions: Parameters<ChartGPUInstance['setOption']>[0];

// Stats
let frameCount = 0;
let lastFpsTime = performance.now();
let fps = 0;
let ticksPerSec = 0;
let lastTickCount = 0;
let lastTickTime = performance.now();

// Simulated time for candle aggregation (accelerated vs real time).
let simulatedTimeMs = Date.now();
let lastSimPerfNow = performance.now();

const isTupleOHLCDataPoint = (
  p: OHLCDataPoint
): p is readonly [timestamp: number, open: number, close: number, low: number, high: number] => Array.isArray(p);

const getTimestamp = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[0] : p.timestamp);
const getClose = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[2] : p.close);

// Get appropriate dataZoom config based on candle count
function getDataZoomConfig(candleCount: number) {
  if (candleCount <= 200) {
    // Few candles: just inside zoom, show all data
    return [{ type: 'inside' }];
  } else {
    // Many candles: add slider and zoom to recent data
    const showPercent = Math.min(100, Math.max(5, 500 / candleCount * 100));
    return [
      { type: 'inside' },
      { type: 'slider', start: 100 - showPercent, end: 100 },
    ];
  }
}

// Get max candles based on current count (allow some growth for streaming)
function getMaxCandles(candleCount: number): number {
  return Math.max(candleCount + 1000, candleCount * 1.5);
}

async function init() {
  const container = document.getElementById('chart')!;

  // Generate impressive historical data
  console.log(`Generating ${currentCandleCount.toLocaleString()} historical candles...`);
  const startGen = performance.now();

  data = generateHistoricalData({
    symbol: CONFIG.symbol,
    startPrice: CONFIG.startPrice,
    volatility: 0.03, // 3% volatility like static example for nice candle sizes
    candleCount: currentCandleCount,
    intervalMs: candleIntervalMs,
  });

  console.log(`Generated in ${(performance.now() - startGen).toFixed(0)}ms`);

  // Get last price for tick simulator
  const lastCandle = data[data.length - 1];
  const lastPrice = getClose(lastCandle); // close price

  // Seed simulated time from the most recent historical candle so the first live candle
  // continues smoothly after history (instead of starting far in the past/future).
  simulatedTimeMs = getTimestamp(lastCandle) + candleIntervalMs;
  lastSimPerfNow = performance.now();

  // Create chart
  fullChartOptions = {
    xAxis: { type: 'time', name: 'Time' },
    yAxis: { type: 'value', name: `${CONFIG.symbol}` },
    series: [
      {
        type: 'candlestick',
        name: CONFIG.symbol,
        data,
        style: 'classic',
        itemStyle: {
          upColor: '#22c55e',
          downColor: '#ef4444',
          upBorderColor: '#16a34a',
          downBorderColor: '#dc2626',
        },
        sampling: 'ohlc',
        samplingThreshold: 2000,
      },
    ],
    dataZoom: getDataZoomConfig(currentCandleCount),
    tooltip: { trigger: 'item' },
    animation: false, // Critical for streaming performance
    autoScroll: true,
  };
  chart = await createChart(container, fullChartOptions);

  // Setup tick simulator
  candleAggregator = createCandleAggregator(candleIntervalMs);

  tickSimulator = createTickSimulator({
    initialPrice: lastPrice,
    ticksPerSecond: CONFIG.ticksPerSecond,
    volatility: CONFIG.tickVolatility,
    onTick: handleTick,
  });

  // UI bindings
  setupControls();
  startStatsLoop();

  // Auto-start streaming
  toggleStreaming();

  updateStats();
}

function handleTick(tick: Tick) {
  // Advance simulated time (so we can close candles faster than real time).
  const now = performance.now();
  const dtRealMs = Math.max(0, now - lastSimPerfNow);
  lastSimPerfNow = now;
  simulatedTimeMs += dtRealMs * timeScale;

  // Drive the candle aggregator from ticks, but using simulated time.
  candleAggregator.processTick({ ...tick, timestamp: Math.floor(simulatedTimeMs) });

  // Update the current (forming) candle in real-time.
  const currentCandle = candleAggregator.getCurrentCandle();
  if (currentCandle) {
    const isSameCandle = data.length > 0 && getTimestamp(data[data.length - 1]) === getTimestamp(currentCandle);

    if (isSameCandle) {
      // Update existing (forming) candle
      data[data.length - 1] = currentCandle;

      // Throttled update for current candle (every ~100ms)
      throttledUpdateCurrentCandle();
    } else {
      // New candle period started — append the new candle once, then update it as it forms.
      data.push(currentCandle);

      // Memory management: trim old candles
      const maxCandles = getMaxCandles(currentCandleCount);
      if (data.length > maxCandles) {
        data = data.slice(data.length - maxCandles);
        // Preserve full options when trimming data
        const series0 = fullChartOptions.series?.[0];
        if (series0 && series0.type === 'candlestick') {
          fullChartOptions = {
            ...fullChartOptions,
            series: [
              {
                ...series0,
                data,
              },
            ],
          };
          chart.setOption(fullChartOptions);
        }
      } else {
        // Efficient append (candlesticks supported)
        chart.appendData(0, [currentCandle]);
      }
    }
  }

  updatePrice(tick.price);
}

// Throttle current candle updates to avoid overwhelming the GPU
let lastCurrentCandleUpdate = 0;
function throttledUpdateCurrentCandle() {
  const now = performance.now();
  if (now - lastCurrentCandleUpdate < 100) return;
  lastCurrentCandleUpdate = now;

  // Update just the last candle efficiently by updating the full options with new data
  const lastIdx = data.length - 1;
  const series0 = fullChartOptions.series?.[0];
  if (lastIdx >= 0 && series0 && series0.type === 'candlestick') {
    // Preserve full series config and only update data
    fullChartOptions = {
      ...fullChartOptions,
      series: [
        {
          ...series0,
          data,
        },
      ],
    };
    chart.setOption(fullChartOptions);
  }
}

function toggleStreaming() {
  isStreaming = !isStreaming;
  if (isStreaming) {
    tickSimulator.start();
    document.getElementById('toggle-btn')!.textContent = '⏸ Pause';
    document.getElementById('toggle-btn')!.classList.add('active');
  } else {
    tickSimulator.stop();
    document.getElementById('toggle-btn')!.textContent = '▶ Start';
    document.getElementById('toggle-btn')!.classList.remove('active');
  }
}

function toggleAutoScroll() {
  autoScrollEnabled = !autoScrollEnabled;
  chart.setOption({ autoScroll: autoScrollEnabled });
  const btn = document.getElementById('autoscroll-btn')!;
  btn.textContent = autoScrollEnabled ? '📍 Auto-Scroll: ON' : '📍 Auto-Scroll: OFF';
  btn.classList.toggle('toggle-active', autoScrollEnabled);
}

/**
 * Switch to a different candlestick timeframe.
 * Regenerates historical data and recreates the candle aggregator.
 */
function switchTimeframe(tf: string) {
  if (!TIMEFRAME_INTERVALS[tf]) {
    console.warn(`Unknown timeframe: ${tf}`);
    return;
  }

  // Skip if already on this timeframe
  if (tf === currentTimeframe) {
    return;
  }

  // Remember if we were streaming
  const wasStreaming = isStreaming;

  // Stop streaming while we regenerate
  if (isStreaming) {
    tickSimulator.stop();
  }

  // Update timeframe state
  currentTimeframe = tf;
  candleIntervalMs = TIMEFRAME_INTERVALS[tf];
  timeScale = TIMEFRAME_TIMESCALES[tf];

  console.log(`Switching to ${tf} timeframe (${candleIntervalMs}ms interval, ${timeScale}x speed)`);

  // Regenerate historical data with new interval
  const startGen = performance.now();
  data = generateHistoricalData({
    symbol: CONFIG.symbol,
    startPrice: CONFIG.startPrice,
    volatility: 0.03, // 3% volatility like static example for nice candle sizes
    candleCount: currentCandleCount,
    intervalMs: candleIntervalMs,
  });
  console.log(`Regenerated ${data.length.toLocaleString()} candles in ${(performance.now() - startGen).toFixed(0)}ms`);

  // Get last price for tick simulator
  const lastCandle = data[data.length - 1];
  const lastPrice = getClose(lastCandle);

  // Reset simulated time based on new data
  simulatedTimeMs = getTimestamp(lastCandle) + candleIntervalMs;
  lastSimPerfNow = performance.now();

  // Recreate candle aggregator with new interval
  candleAggregator = createCandleAggregator(candleIntervalMs);

  // Recreate tick simulator with current price
  tickSimulator = createTickSimulator({
    initialPrice: lastPrice,
    ticksPerSecond: CONFIG.ticksPerSecond,
    volatility: CONFIG.tickVolatility,
    onTick: handleTick,
  });

  // Update chart with new data (full replacement)
  const series0 = fullChartOptions.series?.[0];
  if (series0 && series0.type === 'candlestick') {
    fullChartOptions = {
      ...fullChartOptions,
      series: [
        {
          ...series0,
          data,
        },
      ],
    };
    chart.setOption(fullChartOptions);
  }

  // Reset tick count stats
  lastTickCount = 0;
  ticksPerSec = 0;

  // Resume streaming if it was running
  if (wasStreaming) {
    tickSimulator.start();
  }

  updateStats();
}

/**
 * Switch to a different candle count.
 * Regenerates historical data and recreates the chart view.
 */
function switchCandleCount(count: number) {
  // Skip if already at this count
  if (count === currentCandleCount) {
    return;
  }

  // Remember if we were streaming
  const wasStreaming = isStreaming;

  // Stop streaming while we regenerate
  if (isStreaming) {
    tickSimulator.stop();
  }

  // Update candle count
  currentCandleCount = count;

  console.log(`Switching to ${count.toLocaleString()} candles`);

  // Regenerate historical data with new count
  const startGen = performance.now();
  data = generateHistoricalData({
    symbol: CONFIG.symbol,
    startPrice: CONFIG.startPrice,
    volatility: 0.03,
    candleCount: currentCandleCount,
    intervalMs: candleIntervalMs,
  });
  console.log(`Regenerated ${data.length.toLocaleString()} candles in ${(performance.now() - startGen).toFixed(0)}ms`);

  // Get last price for tick simulator
  const lastCandle = data[data.length - 1];
  const lastPrice = getClose(lastCandle);

  // Reset simulated time based on new data
  simulatedTimeMs = getTimestamp(lastCandle) + candleIntervalMs;
  lastSimPerfNow = performance.now();

  // Recreate candle aggregator
  candleAggregator = createCandleAggregator(candleIntervalMs);

  // Recreate tick simulator with current price
  tickSimulator = createTickSimulator({
    initialPrice: lastPrice,
    ticksPerSecond: CONFIG.ticksPerSecond,
    volatility: CONFIG.tickVolatility,
    onTick: handleTick,
  });

  // Update chart with new data and appropriate dataZoom config
  const series0 = fullChartOptions.series?.[0];
  if (series0 && series0.type === 'candlestick') {
    fullChartOptions = {
      ...fullChartOptions,
      dataZoom: getDataZoomConfig(currentCandleCount),
      series: [
        {
          ...series0,
          data,
        },
      ],
    };
    chart.setOption(fullChartOptions);
  }

  // Reset tick count stats
  lastTickCount = 0;
  ticksPerSec = 0;

  // Resume streaming if it was running
  if (wasStreaming) {
    tickSimulator.start();
  }

  updateStats();
}

function setupControls() {
  document.getElementById('toggle-btn')!.addEventListener('click', toggleStreaming);
  document.getElementById('autoscroll-btn')!.addEventListener('click', toggleAutoScroll);

  // Style toggle
  let isHollow = false;
  document.getElementById('style-btn')!.addEventListener('click', () => {
    isHollow = !isHollow;
    // Preserve full options when changing style
    const series0 = fullChartOptions.series?.[0];
    if (series0 && series0.type === 'candlestick') {
      fullChartOptions = {
        ...fullChartOptions,
        series: [
          {
            ...series0,
            style: isHollow ? 'hollow' : 'classic',
            data,
          },
        ],
      };
      chart.setOption(fullChartOptions);
    }
    document.getElementById('style-btn')!.textContent = isHollow ? 'Style: Hollow' : 'Style: Classic';
  });

  // Timeframe buttons - actually switch intervals
  document.querySelectorAll('.timeframe-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tf = (e.target as HTMLElement).dataset.tf;
      if (!tf) return;

      // Update active button state
      document.querySelectorAll('.timeframe-btn').forEach((b) => b.classList.remove('active'));
      (e.target as HTMLElement).classList.add('active');

      // Switch to the new timeframe
      switchTimeframe(tf);
    });
  });

  // Candle count preset buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const count = parseInt((e.target as HTMLElement).dataset.count || '60', 10);

      // Update active button state
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      (e.target as HTMLElement).classList.add('active');

      // Switch to the new candle count
      switchCandleCount(count);
    });
  });

  window.addEventListener('resize', () => chart.resize());
}

function updatePrice(price: number) {
  const priceEl = document.getElementById('current-price')!;
  const prevPrice = parseFloat(priceEl.dataset.price || '0');

  priceEl.textContent = `$${price.toFixed(2)}`;
  priceEl.dataset.price = price.toString();

  // Flash color on change
  priceEl.classList.remove('price-up', 'price-down');
  if (price > prevPrice) {
    priceEl.classList.add('price-up');
  } else if (price < prevPrice) {
    priceEl.classList.add('price-down');
  }
}

function startStatsLoop() {
  function updateLoop() {
    frameCount++;
    const now = performance.now();

    // FPS calculation (every 500ms)
    if (now - lastFpsTime >= 500) {
      fps = Math.round(frameCount / ((now - lastFpsTime) / 1000));
      frameCount = 0;
      lastFpsTime = now;
    }

    // Ticks/sec calculation
    if (now - lastTickTime >= 1000) {
      const currentTicks = tickSimulator.getTickCount();
      ticksPerSec = currentTicks - lastTickCount;
      lastTickCount = currentTicks;
      lastTickTime = now;
    }

    updateStats();
    requestAnimationFrame(updateLoop);
  }
  requestAnimationFrame(updateLoop);
}

function updateStats() {
  document.getElementById('stat-fps')!.textContent = `${fps}`;
  document.getElementById('stat-candles')!.textContent = data.length.toLocaleString();
  document.getElementById('stat-ticks')!.textContent = `${ticksPerSec}/s`;
  document.getElementById('stat-total-ticks')!.textContent = tickSimulator.getTickCount().toLocaleString();
}

init().catch(console.error);
