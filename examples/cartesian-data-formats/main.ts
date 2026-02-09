/**
 * Cartesian Data Formats Example
 * 
 * Demonstrates three input formats for CartesianSeriesData:
 * 1. XYArraysData: { x: ArrayLike<number>; y: ArrayLike<number>; size?: ArrayLike<number> }
 *    - Uses Float64Array for x and Float32Array for y to showcase ArrayLike support
 * 2. InterleavedXYData: Float32Array laid out as [x0, y0, x1, y1, ...]
 *    - Uses subarray() to demonstrate byteOffset safety
 * 3. Traditional: ReadonlyArray<DataPoint> (array of objects)
 * 
 * Features:
 * - Two series on the same chart (100k points each)
 * - Interactive format toggle for series 1 (XYArraysData, InterleavedXYData, Array)
 * - Series 2 always uses InterleavedXYData with subarray view for comparison
 * - Distinct colors and legend to identify each series
 * - Deterministic data generation for consistent rendering
 */

import { ChartGPU } from '../../src/index';
import type { ChartGPUOptions, CartesianSeriesData, DataPoint, XYArraysData, InterleavedXYData } from '../../src/index';

const POINT_COUNT = 100_000;

/**
 * Generate sine wave data in XYArraysData format.
 * Uses Float64Array for x and Float32Array for y to demonstrate ArrayLike support.
 */
const generateXYArraysData = (
  count: number,
  opts: Readonly<{ phase?: number; amplitude?: number; frequency?: number }> = {}
): XYArraysData => {
  const phase = opts.phase ?? 0;
  const amplitude = opts.amplitude ?? 1;
  const frequency = opts.frequency ?? 1;

  const x = new Float64Array(count);
  const y = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    x[i] = t * Math.PI * 2 * frequency;
    y[i] = Math.sin(x[i] + phase) * amplitude;
  }

  return { x, y };
};

/**
 * Generate sine wave data in InterleavedXYData format.
 * Returns a Float32Array with [x0, y0, x1, y1, ...] layout.
 * If withSubarray is true, returns a subarray view to demonstrate byteOffset safety.
 */
const generateInterleavedXYData = (
  count: number,
  opts: Readonly<{ phase?: number; amplitude?: number; frequency?: number; withSubarray?: boolean }> = {}
): InterleavedXYData => {
  const phase = opts.phase ?? 0;
  const amplitude = opts.amplitude ?? 1;
  const frequency = opts.frequency ?? 1;
  const withSubarray = opts.withSubarray ?? false;

  // If withSubarray is true, create a larger buffer and return a subarray view
  // This demonstrates byteOffset safety for CPU-side paths
  const extraElements = withSubarray ? 4 : 0; // Add 4 extra elements (2 points) at the start
  const totalElements = count * 2 + extraElements;
  const buffer = new Float32Array(totalElements);

  // Write data starting at the offset
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = t * Math.PI * 2 * frequency;
    const y = Math.sin(x + phase) * amplitude;
    
    const idx = extraElements + i * 2;
    buffer[idx] = x;
    buffer[idx + 1] = y;
  }

  // Return subarray view if requested, otherwise return the full array
  return withSubarray ? buffer.subarray(extraElements, extraElements + count * 2) : buffer;
};

/**
 * Generate sine wave data in traditional array-of-objects format.
 */
const generateArrayOfObjects = (
  count: number,
  opts: Readonly<{ phase?: number; amplitude?: number; frequency?: number }> = {}
): ReadonlyArray<DataPoint> => {
  const phase = opts.phase ?? 0;
  const amplitude = opts.amplitude ?? 1;
  const frequency = opts.frequency ?? 1;

  const data: DataPoint[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = t * Math.PI * 2 * frequency;
    const y = Math.sin(x + phase) * amplitude;
    data[i] = { x, y };
  }

  return data;
};

// Pre-generate all data formats for series 1 (sine wave)
const series1XYArrays = generateXYArraysData(POINT_COUNT, { phase: 0, amplitude: 1, frequency: 3 });
const series1Interleaved = generateInterleavedXYData(POINT_COUNT, { phase: 0, amplitude: 1, frequency: 3 });
const series1Array = generateArrayOfObjects(POINT_COUNT, { phase: 0, amplitude: 1, frequency: 3 });

console.log(series1XYArrays);
console.log(series1Interleaved);
console.log('SERIES 1 ARRAY', series1Array);
// Series 2 always uses InterleavedXYData with subarray view (cosine wave)
const series2Data = generateInterleavedXYData(POINT_COUNT, { 
  phase: Math.PI / 2, 
  amplitude: 0.8, 
  frequency: 2,
  withSubarray: true // Demonstrate byteOffset safety
});

const showError = (message: string): void => {
  const el = document.getElementById('error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

async function main() {
  const container = document.getElementById('chart');
  if (!container) {
    throw new Error('Chart container not found');
  }

  // Current format for series 1
  let series1Format: 'xyarrays' | 'interleaved' | 'array' = 'xyarrays';

  const getSeries1Data = (): CartesianSeriesData => {
    switch (series1Format) {
      case 'xyarrays':
        return series1XYArrays;
      case 'interleaved':
        return series1Interleaved;
      case 'array':
        return series1Array;
    }
  };

  const getFormatLabel = (format: typeof series1Format): string => {
    switch (format) {
      case 'xyarrays':
        return 'XYArraysData (Float64Array x, Float32Array y)';
      case 'interleaved':
        return 'InterleavedXYData (Float32Array)';
      case 'array':
        return 'Array<{x, y}>';
    }
  };

  const options: ChartGPUOptions = {
    grid: { left: 70, right: 24, top: 24, bottom: 56 },
    xAxis: { type: 'value', min: 0, max: Math.PI * 2 * 3, name: 'x' },
    yAxis: { type: 'value', min: -1.2, max: 1.2, name: 'y' },
    palette: ['#4a9eff', '#ff4ab0'],
    animation: { duration: 300, easing: 'cubicOut' },
    legend: { show: true, position: 'top' },
    tooltip: { show: true, trigger: 'axis' },
    series: [
      {
        type: 'line',
        name: `Series 1: ${getFormatLabel(series1Format)}`,
        data: getSeries1Data(),
        color: '#4a9eff',
        lineStyle: { width: 2, opacity: 0.9 },
        sampling: 'lttb', // Enable sampling for smooth 60 FPS
        samplingThreshold: 5000,
      },
      {
        type: 'line',
        name: 'Series 2: InterleavedXYData (with subarray)',
        data: series2Data,
        color: '#ff4ab0',
        lineStyle: { width: 2, opacity: 0.9 },
        sampling: 'lttb',
        samplingThreshold: 5000,
      },
    ],
  };

  const chart = await ChartGPU.create(container, options);

  // Setup format toggle listeners
  const radioButtons = document.querySelectorAll<HTMLInputElement>('input[name="series1-format"]');
  radioButtons.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      
      const newFormat = radio.value as typeof series1Format;
      if (newFormat === series1Format) return;
      
      series1Format = newFormat;
      
      // Update chart with new data format
      chart.setOption({
        series: [
          {
            type: 'line',
            name: `Series 1: ${getFormatLabel(series1Format)}`,
            data: getSeries1Data(),
            color: '#4a9eff',
            lineStyle: { width: 2, opacity: 0.9 },
            sampling: 'lttb',
            samplingThreshold: 5000,
          },
          {
            type: 'line',
            name: 'Series 2: InterleavedXYData (with subarray)',
            data: series2Data,
            color: '#ff4ab0',
            lineStyle: { width: 2, opacity: 0.9 },
            sampling: 'lttb',
            samplingThreshold: 5000,
          },
        ],
      });
    });
  });

  // Handle window resize
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

  // Initial sizing
  chart.resize();

  // Cleanup on page unload
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
