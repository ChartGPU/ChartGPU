import type { OHLCDataPoint } from '../../src/index';

export interface GeneratorConfig {
  symbol: string;
  startPrice: number;
  volatility: number; // daily volatility (e.g., 0.03 = 3%)
  candleCount: number; // total historical candles
  intervalMs: number; // candle interval (e.g., 60000 = 1 minute)
}

// Deterministic PRNG for reproducible data
function xorshift32(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

export function generateHistoricalData(config: GeneratorConfig): OHLCDataPoint[] {
  const { startPrice, volatility, candleCount, intervalMs } = config;
  const rand = xorshift32(42); // Fixed seed for reproducibility

  const data: OHLCDataPoint[] = [];
  let price = startPrice;
  const now = Date.now();
  const startTime = now - candleCount * intervalMs;

  // Add some realistic patterns: trends, consolidation, breakouts
  let trendBias = 0;
  let trendDuration = 0;

  for (let i = 0; i < candleCount; i++) {
    // Occasional trend changes
    if (trendDuration <= 0) {
      trendBias = (rand() - 0.5) * 0.002; // Slight directional bias
      trendDuration = Math.floor(rand() * 100) + 20;
    }
    trendDuration--;

    const timestamp = startTime + i * intervalMs;
    const candleVolatility = volatility * (0.5 + rand()); // Variable volatility

    // Generate realistic OHLC
    const open = price;
    const change = (rand() - 0.5 + trendBias) * candleVolatility * price;
    const close = price + change;

    // Wicks extend beyond body
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const wickExtension = rand() * candleVolatility * price * 0.5;
    const high = bodyHigh + wickExtension * rand();
    const low = bodyLow - wickExtension * rand();

    data.push([timestamp, open, close, low, high]);
    price = close;

    // Prevent price from going negative or too extreme
    price = Math.max(price, startPrice * 0.1);
    price = Math.min(price, startPrice * 10);
  }

  return data;
}
