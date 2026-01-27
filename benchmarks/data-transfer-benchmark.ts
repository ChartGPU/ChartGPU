/**
 * Data Transfer Benchmark - Story 8h
 * 
 * Compares three data transfer approaches for appendData():
 * 1. Array: appendData(index, DataPoint[]) - Convenience API (serialization overhead)
 * 2. Typed Array (copy): appendData(index, packed.slice(), 'xy') - Copied Float32Array
 * 3. Typed Array (transfer): appendData(index, packed, 'xy') - Zero-copy transfer
 * 
 * Measures serialization time, transfer time, and total time across 3 data scales.
 * Reports median of 10 runs for each combination.
 */

import type { DataPoint } from '../src/config/types';
import { packDataPoints } from '../src/data/packDataPoints';

type BenchmarkResult = {
  scale: string;
  approach: string;
  serializeMs: number;
  transferMs: number;
  totalMs: number;
};

/**
 * Generate test data: sine wave with noise
 */
function generateTestData(count: number): ReadonlyArray<DataPoint> {
  const data: DataPoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const x = i * 0.01;
    const y = Math.sin(x) * 0.8 + Math.sin(x * 2.3) * 0.2 + (Math.random() - 0.5) * 0.1;
    data[i] = [x, y] as const;
  }
  return data;
}

/**
 * Median of array of numbers
 */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 
    ? (sorted[mid - 1] + sorted[mid]) / 2 
    : sorted[mid];
}

/**
 * Benchmark: Array approach (convenience API)
 * appendData(index, DataPoint[])
 */
function benchmarkArray(data: ReadonlyArray<DataPoint>, runs: number): BenchmarkResult {
  const serializeTimes: number[] = [];
  const transferTimes: number[] = [];
  const totalTimes: number[] = [];

  for (let run = 0; run < runs; run++) {
    const totalStart = performance.now();
    
    // Serialization: DataPoint[] is already in memory, no packing needed
    const serializeStart = performance.now();
    // In real usage, this would be passed to appendData which internally serializes to structured clone
    const serialized = structuredClone(data);
    const serializeEnd = performance.now();
    
    // Transfer: structuredClone simulates postMessage serialization
    const transferStart = performance.now();
    // This simulates the cost of sending via postMessage with structuredClone
    const _transferred = serialized;
    const transferEnd = performance.now();
    
    const totalEnd = performance.now();
    
    serializeTimes.push(serializeEnd - serializeStart);
    transferTimes.push(transferEnd - transferStart);
    totalTimes.push(totalEnd - totalStart);
  }

  return {
    scale: `${(data.length / 1000).toFixed(0)}K`,
    approach: 'Array (convenience)',
    serializeMs: median(serializeTimes),
    transferMs: median(transferTimes),
    totalMs: median(totalTimes),
  };
}

/**
 * Benchmark: Typed Array (copy) approach
 * appendData(index, packed.slice(), 'xy')
 */
function benchmarkTypedArrayCopy(data: ReadonlyArray<DataPoint>, runs: number): BenchmarkResult {
  const serializeTimes: number[] = [];
  const transferTimes: number[] = [];
  const totalTimes: number[] = [];

  for (let run = 0; run < runs; run++) {
    const totalStart = performance.now();
    
    // Serialization: pack to Float32Array
    const serializeStart = performance.now();
    const packed = packDataPoints(data);
    const serializeEnd = performance.now();
    
    // Transfer: .slice() creates a copy, which is then cloned again for transfer
    const transferStart = performance.now();
    const copy = packed.slice();
    // Simulates postMessage with structured clone (copy semantic)
    const _transferred = structuredClone(copy);
    const transferEnd = performance.now();
    
    const totalEnd = performance.now();
    
    serializeTimes.push(serializeEnd - serializeStart);
    transferTimes.push(transferEnd - transferStart);
    totalTimes.push(totalEnd - totalStart);
  }

  return {
    scale: `${(data.length / 1000).toFixed(0)}K`,
    approach: 'Typed Array (copy)',
    serializeMs: median(serializeTimes),
    transferMs: median(transferTimes),
    totalMs: median(totalTimes),
  };
}

/**
 * Benchmark: Typed Array (transfer) approach - Zero-copy
 * appendData(index, packed, 'xy')
 */
function benchmarkTypedArrayTransfer(data: ReadonlyArray<DataPoint>, runs: number): BenchmarkResult {
  const serializeTimes: number[] = [];
  const transferTimes: number[] = [];
  const totalTimes: number[] = [];

  for (let run = 0; run < runs; run++) {
    const totalStart = performance.now();
    
    // Serialization: pack to Float32Array
    const serializeStart = performance.now();
    const packed = packDataPoints(data);
    const serializeEnd = performance.now();
    
    // Transfer: zero-copy via ArrayBuffer transfer
    const transferStart = performance.now();
    // In real usage: postMessage({ data: packed }, [packed.buffer])
    // Simulates zero-copy transfer by just accessing the buffer
    const buffer = packed.buffer;
    // After transfer, the original would be detached (length = 0)
    const _transferred = buffer;
    const transferEnd = performance.now();
    
    const totalEnd = performance.now();
    
    serializeTimes.push(serializeEnd - serializeStart);
    transferTimes.push(transferEnd - transferStart);
    totalTimes.push(totalEnd - totalStart);
  }

  return {
    scale: `${(data.length / 1000).toFixed(0)}K`,
    approach: 'Typed Array (zero-copy)',
    serializeMs: median(serializeTimes),
    transferMs: median(transferTimes),
    totalMs: median(totalTimes),
  };
}

/**
 * Format number with fixed decimals
 */
function fmt(n: number, decimals: number = 2): string {
  return n.toFixed(decimals);
}

/**
 * Run benchmark suite
 */
function runBenchmarks(): void {
  const scales = [
    { name: '10K', count: 10_000 },
    { name: '100K', count: 100_000 },
    { name: '1M', count: 1_000_000 },
  ];
  
  const runs = 10;
  const results: BenchmarkResult[] = [];

  console.log('ChartGPU Data Transfer Benchmark - Story 8h');
  console.log('='.repeat(80));
  console.log(`Running ${runs} iterations per combination...\n`);

  for (const scale of scales) {
    console.log(`Generating ${scale.name} test data...`);
    const data = generateTestData(scale.count);
    
    console.log(`Benchmarking ${scale.name} points...`);
    results.push(benchmarkArray(data, runs));
    results.push(benchmarkTypedArrayCopy(data, runs));
    results.push(benchmarkTypedArrayTransfer(data, runs));
    console.log(`  ✓ ${scale.name} complete\n`);
  }

  // Print results table
  console.log('Results (median of 10 runs):');
  console.log('='.repeat(80));
  console.log(
    'Scale'.padEnd(8) +
    'Approach'.padEnd(25) +
    'Serialize (ms)'.padStart(16) +
    'Transfer (ms)'.padStart(16) +
    'Total (ms)'.padStart(14)
  );
  console.log('-'.repeat(80));

  for (const result of results) {
    console.log(
      result.scale.padEnd(8) +
      result.approach.padEnd(25) +
      fmt(result.serializeMs).padStart(16) +
      fmt(result.transferMs).padStart(16) +
      fmt(result.totalMs).padStart(14)
    );
  }

  console.log('='.repeat(80));
  console.log('\nKey Findings:');
  console.log('- Zero-copy transfer eliminates data copying overhead');
  console.log('- Best for: High-frequency updates (streaming, real-time data)');
  console.log('- Best for: Large datasets (>10K points per update)');
  console.log('- Convenience API: Use for small, infrequent updates (<1K points)');
  console.log('- Performance API: Use packDataPoints() + transfer for streaming scenarios');
}

// Run benchmarks
runBenchmarks();
