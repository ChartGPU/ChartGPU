import type { OHLCDataPoint } from '../../src/index';

export interface Tick {
  timestamp: number;
  price: number;
  volume: number;
}

export interface TickSimulatorConfig {
  initialPrice: number;
  ticksPerSecond: number; // 50-100 for realistic feel
  volatility: number; // per-tick volatility
  onTick: (tick: Tick) => void;
}

export interface TickSimulator {
  start(): void;
  stop(): void;
  getTickCount(): number;
}

export function createTickSimulator(config: TickSimulatorConfig): TickSimulator {
  const { initialPrice, ticksPerSecond, volatility, onTick } = config;

  let price = initialPrice;
  let running = false;
  let tickCount = 0;
  let intervalId: number | null = null;

  // Use high-resolution timer for smooth ticks
  const tickIntervalMs = 1000 / ticksPerSecond;

  function generateTick() {
    const change = (Math.random() - 0.5) * 2 * volatility * price;
    price += change;
    price = Math.max(price, initialPrice * 0.01); // Floor

    const tick: Tick = {
      timestamp: Date.now(),
      price,
      volume: Math.random() * 1000 + 100,
    };

    tickCount++;
    onTick(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      intervalId = window.setInterval(generateTick, tickIntervalMs);
    },

    stop() {
      if (!running) return;
      running = false;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    getTickCount() {
      return tickCount;
    },
  };
}

// Aggregates ticks into candles
export interface CandleAggregator {
  processTick(tick: Tick): OHLCDataPoint | null; // Returns completed candle
  getCurrentCandle(): OHLCDataPoint | null;
}

export function createCandleAggregator(intervalMs: number): CandleAggregator {
  let currentCandle: OHLCDataPoint | null = null;
  let candleStartTime = 0;

  return {
    processTick(tick: Tick): OHLCDataPoint | null {
      const candleTime = Math.floor(tick.timestamp / intervalMs) * intervalMs;

      if (currentCandle === null || candleTime > candleStartTime) {
        // New candle period
        const completedCandle = currentCandle;
        candleStartTime = candleTime;
        currentCandle = [
          candleTime,
          tick.price, // open
          tick.price, // close
          tick.price, // low
          tick.price, // high
        ];
        return completedCandle;
      }

      // Update current candle
      const [time, open, , low, high] = currentCandle;
      currentCandle = [
        time,
        open,
        tick.price, // close = latest price
        Math.min(low, tick.price), // low
        Math.max(high, tick.price), // high
      ];

      return null;
    },

    getCurrentCandle() {
      return currentCandle;
    },
  };
}
