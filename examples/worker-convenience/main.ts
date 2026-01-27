/**
 * Worker API Comparison Example - Story 8h
 * 
 * Demonstrates both appendData() API styles side-by-side:
 * 1. Convenience API: appendData(index, DataPoint[])
 * 2. Performance API: appendData(index, Float32Array, 'xy')
 * 
 * Both charts show identical data, but use different transfer methods.
 * 
 * **Convenience API** (Chart 1 - Regular chart):
 * - Accepts DataPoint[] arrays in tuple or object form
 * - Automatically serializes to Float32Array internally
 * - Suitable for most use cases (<10K points per update)
 * - Memory overhead: ~2x (DataPoint[] + Float32Array during serialization)
 * 
 * **Performance API** (Chart 2 - Worker chart):
 * - Accepts pre-packed Float32Array for zero-copy transfer
 * - Requires manual packing via packDataPoints()
 * - Optimal for high-frequency streaming (>10K points per update)
 * - Memory overhead: ~1x (only Float32Array)
 * - 50% memory reduction and ~8-12% faster for large datasets
 * 
 * **When to use each**:
 * - Use Convenience API for: Interactive apps, infrequent updates, small datasets
 * - Use Performance API for: Real-time streaming, high-frequency updates, >50K points
 * 
 * **Best practices**:
 * - Don't reuse Float32Array after transfer (buffer becomes detached)
 * - Call packDataPoints() for each append (creates new transferable buffer)
 * - Use worker mode (createInWorker) for Performance API to enable zero-copy
 */

import { ChartGPU, packDataPoints } from '../../src/index';
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from '../../src/index';

const showError = (chartId: string, message: string): void => {
  const el = document.getElementById(`error${chartId}`);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
};

/**
 * Generate sine wave test data
 */
function generateWave(count: number, phase: number = 0): ReadonlyArray<DataPoint> {
  const data: DataPoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const x = i * 0.02;
    const y = Math.sin(x + phase) * 0.8 + Math.sin(x * 2.3 + phase) * 0.3;
    data[i] = [x, y] as const;
  }
  return data;
}

/**
 * Create chart options
 */
function createOptions(name: string): ChartGPUOptions {
  return {
    grid: { left: 50, right: 16, top: 16, bottom: 40 },
    xAxis: { type: 'value', name: 'x' },
    yAxis: { type: 'value', min: -1.2, max: 1.2 },
    palette: ['#4a9eff'],
    animation: { duration: 600, easing: 'cubicOut' },
    series: [
      {
        type: 'line',
        name,
        data: [],
        color: '#4a9eff',
        lineStyle: { width: 2, opacity: 1 },
      },
    ],
  };
}

/**
 * Attach resize observer with RAF coalescing
 */
function attachResizeObserver(
  container: HTMLElement,
  chart: ChartGPUInstance
): ResizeObserver {
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
  return ro;
}

async function main(): Promise<void> {
  const container1 = document.getElementById('chart1');
  const container2 = document.getElementById('chart2');

  if (!(container1 instanceof HTMLElement)) {
    throw new Error('Chart 1 container not found');
  }
  if (!(container2 instanceof HTMLElement)) {
    throw new Error('Chart 2 container not found');
  }

  // Create both charts
  const options1 = createOptions('Convenience API');
  const options2 = createOptions('Performance API');

  // Chart 1: Regular chart (convenience API with DataPoint[])
  const chart1 = await ChartGPU.create(container1, options1);
  
  // Chart 2: Worker chart (performance API with Float32Array zero-copy)
  const chart2 = await ChartGPU.createInWorker(container2, options2);

  // Setup resize observers
  const ro1 = attachResizeObserver(container1, chart1);
  const ro2 = attachResizeObserver(container2, chart2);

  chart1.resize();
  chart2.resize();

  // Initial data load
  const initialData = generateWave(200);

  // Chart 1: Convenience API - Direct DataPoint[] append
  chart1.appendData(0, initialData);

  // Chart 2: Performance API - Float32Array with zero-copy transfer
  const packed = packDataPoints(initialData);
  chart2.appendData(0, packed, 'xy');

  // Periodic updates to demonstrate both APIs
  let phase = 0;
  const updateInterval = setInterval(() => {
    phase += 0.1;
    
    // Generate new batch
    const batch = generateWave(50, phase);

    // Update Chart 1: Convenience API
    chart1.appendData(0, batch);

    // Update Chart 2: Performance API
    const packedBatch = packDataPoints(batch);
    chart2.appendData(0, packedBatch, 'xy');
  }, 2000);

  // Cleanup
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(updateInterval);
    ro1.disconnect();
    ro2.disconnect();
    chart1.dispose();
    chart2.dispose();
  };

  window.addEventListener('beforeunload', cleanup);
  import.meta.hot?.dispose(cleanup);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => {
      console.error(err);
      showError('1', err instanceof Error ? err.message : String(err));
      showError('2', err instanceof Error ? err.message : String(err));
    });
  });
} else {
  main().catch((err) => {
    console.error(err);
    showError('1', err instanceof Error ? err.message : String(err));
    showError('2', err instanceof Error ? err.message : String(err));
  });
}
