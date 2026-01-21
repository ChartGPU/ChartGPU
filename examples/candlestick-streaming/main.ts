import { createChart, type ChartGPUInstance, type OHLCDataPoint } from '../../src/index';
import { generateHistoricalData } from './generateHistoricalData';
import { createTickSimulator, createCandleAggregator, type Tick } from './tickSimulator';

// Configuration
const CONFIG = {
  symbol: 'BTC/USD',
  historicalCandles: 10_000, // 10K candles of history
  candleIntervalMs: 60_000, // 1-minute candles
  ticksPerSecond: 75, // High-frequency ticks
  tickVolatility: 0.0003, // Per-tick volatility
  maxCandles: 15_000, // Memory bound
  startPrice: 67_500, // Starting BTC price
};

// State
let chart: ChartGPUInstance;
let data: OHLCDataPoint[] = [];
let tickSimulator: ReturnType<typeof createTickSimulator>;
let candleAggregator: ReturnType<typeof createCandleAggregator>;
let isStreaming = false;

// Stats
let frameCount = 0;
let lastFpsTime = performance.now();
let fps = 0;
let ticksPerSec = 0;
let lastTickCount = 0;
let lastTickTime = performance.now();

const isTupleOHLCDataPoint = (
  p: OHLCDataPoint
): p is readonly [timestamp: number, open: number, close: number, low: number, high: number] => Array.isArray(p);

const getTimestamp = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[0] : p.timestamp);
const getClose = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[2] : p.close);

async function init() {
  const container = document.getElementById('chart')!;

  // Generate impressive historical data
  console.log(`Generating ${CONFIG.historicalCandles.toLocaleString()} historical candles...`);
  const startGen = performance.now();

  data = generateHistoricalData({
    symbol: CONFIG.symbol,
    startPrice: CONFIG.startPrice,
    volatility: 0.025,
    candleCount: CONFIG.historicalCandles,
    intervalMs: CONFIG.candleIntervalMs,
  });

  console.log(`Generated in ${(performance.now() - startGen).toFixed(0)}ms`);

  // Get last price for tick simulator
  const lastCandle = data[data.length - 1];
  const lastPrice = getClose(lastCandle); // close price

  // Create chart
  chart = await createChart(container, {
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
    dataZoom: [{ type: 'inside' }, { type: 'slider', start: 95, end: 100 }], // Start zoomed to recent
    tooltip: { trigger: 'item' },
    animation: false, // Critical for streaming performance
    autoScroll: true,
  });

  // Setup tick simulator
  candleAggregator = createCandleAggregator(CONFIG.candleIntervalMs);

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
  // Drive the candle aggregator from raw ticks.
  candleAggregator.processTick(tick);

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
      if (data.length > CONFIG.maxCandles) {
        data = data.slice(data.length - CONFIG.maxCandles);
        chart.setOption({
          series: [{ type: 'candlestick', name: CONFIG.symbol, data }],
        });
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

  // Update just the last candle efficiently (replace series data)
  const lastIdx = data.length - 1;
  if (lastIdx >= 0) {
    chart.setOption({
      series: [
        {
          type: 'candlestick',
          name: CONFIG.symbol,
          data,
        },
      ],
    });
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

function setupControls() {
  document.getElementById('toggle-btn')!.addEventListener('click', toggleStreaming);

  // Style toggle
  let isHollow = false;
  document.getElementById('style-btn')!.addEventListener('click', () => {
    isHollow = !isHollow;
    chart.setOption({
      series: [
        {
          type: 'candlestick',
          name: CONFIG.symbol,
          data,
          style: isHollow ? 'hollow' : 'classic',
        },
      ],
    });
    document.getElementById('style-btn')!.textContent = isHollow ? 'Style: Hollow' : 'Style: Classic';
  });

  // Timeframe buttons (simulated - UI only)
  document.querySelectorAll('.timeframe-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tf = (e.target as HTMLElement).dataset.tf;
      document.querySelectorAll('.timeframe-btn').forEach((b) => b.classList.remove('active'));
      (e.target as HTMLElement).classList.add('active');
      // In a real app, this would switch data sources
      console.log(`Switched to ${tf} timeframe`);
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
