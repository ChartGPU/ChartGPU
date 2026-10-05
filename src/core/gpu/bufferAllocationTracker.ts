/**
 * GPU buffer memory accounting for `getPerformanceMetrics().memory`.
 *
 * ChartGPU used to report hardcoded zeros for `MemoryStats`
 * (used / peak / allocated). This module counts the GPU buffer bytes the
 * library itself allocates, keyed by `GPUDevice` (`WeakMap`, so a destroyed
 * or garbage-collected device never leaks tracker state).
 *
 * Scope, deliberately narrow (report what is actually accounted, never a
 * fabricated total):
 * - Every buffer registered with {@link trackBuffer} is counted, and
 *   {@link untrackBuffer} decrements the running total when it is destroyed.
 *   ChartGPU routes its uniform buffers
 *   (`rendererUtils.createUniformBuffer`), DataStore series / y-channel
 *   buffers and the submitBatcher deferred-destroy path through those two
 *   functions, so the dominant allocations a chart makes are covered.
 * - Buffers a renderer creates directly with `device.createBuffer(...)` and
 *   destroys directly are not counted. Textures are not counted. The numbers
 *   are therefore a lower bound of true GPU memory use.
 *
 * @module bufferAllocationTracker
 * @internal
 */

/** Per-device cumulative buffer accounting. */
interface DeviceBufferStats {
  /** Sum of currently-live tracked buffer bytes. */
  used: number;
  /** High-water mark of `used` over the device's observed lifetime. */
  peak: number;
  /** Sum of bytes of every tracked allocation, including destroyed ones. */
  allocated: number;
}

const statsByDevice = new WeakMap<GPUDevice, DeviceBufferStats>();
/** Tracked buffer -> the device it was accounted against (idempotency). */
const trackedDeviceByBuffer = new WeakMap<GPUBuffer, GPUDevice>();
/** Tracked buffer -> its recorded size in bytes (destroy sites don't know it). */
const trackedSizeByBuffer = new WeakMap<GPUBuffer, number>();

const statsFor = (device: GPUDevice): DeviceBufferStats => {
  let stats = statsByDevice.get(device);
  if (!stats) {
    stats = { used: 0, peak: 0, allocated: 0 };
    statsByDevice.set(device, stats);
  }
  return stats;
};

/**
 * Account `buffer` (of `size` bytes) as a live allocation on `device`.
 * Idempotent per buffer: tracking the same buffer object twice is a no-op.
 */
export function trackBuffer(device: GPUDevice, buffer: GPUBuffer, size: number): void {
  if (trackedDeviceByBuffer.has(buffer)) return;
  trackedDeviceByBuffer.set(buffer, device);
  trackedSizeByBuffer.set(buffer, size);

  const stats = statsFor(device);
  stats.used += size;
  stats.allocated += size;
  if (stats.used > stats.peak) {
    stats.peak = stats.used;
  }
}

/**
 * Mark a previously tracked buffer as destroyed (its bytes leave `used`).
 * Unknown buffers (never tracked, or already destroyed) are ignored rather
 * than double-decremented. `allocated` keeps the lifetime total.
 */
export function untrackBuffer(device: GPUDevice, buffer: GPUBuffer): void {
  if (trackedDeviceByBuffer.get(buffer) !== device) return;
  trackedDeviceByBuffer.delete(buffer);
  const size = trackedSizeByBuffer.get(buffer) ?? 0;
  trackedSizeByBuffer.delete(buffer);

  const stats = statsByDevice.get(device);
  if (!stats) return;
  stats.used = Math.max(0, stats.used - size);
}

/** Snapshot of the accounting for one device (zeros when nothing is tracked). */
export function getBufferMemoryStats(device: GPUDevice): DeviceBufferStats {
  const stats = statsByDevice.get(device);
  if (!stats) return { used: 0, peak: 0, allocated: 0 };
  return { used: stats.used, peak: stats.peak, allocated: stats.allocated };
}
