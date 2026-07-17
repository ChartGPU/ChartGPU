/**
 * Coalesce `device.queue.submit` across ChartGPU instances that share one
 * GPUDevice (multi-chart dashboards sharing one device).
 *
 * Without batching, N charts → N queue.submit calls per frame. WebGPU drivers
 * pay non-trivial validation / fence cost per submit; a single microtask-batched
 * submit([cb0..cbN]) amortizes multi-surface present cost.
 *
 * **Submit is deferred** to a `queueMicrotask` after `renderFrame()` / `render()`
 * returns. Callers that need GPU work on the queue before
 * `device.queue.onSubmittedWorkDone()` must either:
 * - `await Promise.resolve()` once after the last `renderFrame()` in the turn, or
 * - call {@link flushDeviceSubmit}(device) explicitly.
 *
 * Order is preserved: buffers are submitted FIFO in the order charts finished
 * encoding. DataStore self-submits (buffer growth copies) remain independent and
 * still happen before render encodes, so queue order stays correct.
 *
 * Dispose **must** {@link flushDeviceSubmit} before destroying GPU resources so a
 * pending microtask cannot submit command buffers that reference freed textures.
 *
 * Series buffer growth uses {@link destroyBufferAfterSubmit} so replacing a buffer
 * does not force an immediate multi-chart submit flush — destroy waits until after
 * any pending batched command buffers that may still reference the old buffer.
 *
 * Lives under `src/core/gpu/` (neutral layer) so both DataStore and
 * RenderCoordinator can depend on it without inverting data → renderCoordinator.
 *
 * @module submitBatcher
 * @internal
 */

const pendingByDevice = new WeakMap<GPUDevice, GPUCommandBuffer[]>();
const scheduledByDevice = new WeakMap<GPUDevice, boolean>();
/** Bumped on flush so in-flight microtasks no-op after a synchronous drain. */
const epochByDevice = new WeakMap<GPUDevice, number>();
/** GPUBuffers awaiting destroy until after the next batched submit on this device. */
const deferredDestroyByDevice = new WeakMap<GPUDevice, GPUBuffer[]>();

/**
 * Destroy all buffers queued via {@link destroyBufferAfterSubmit} for this device.
 * Safe to call with an empty/missing list. Destroy is best-effort (try/catch);
 * duplicate entries are destroyed only once.
 */
function drainDeferredDestroys(device: GPUDevice): void {
  const list = deferredDestroyByDevice.get(device);
  if (!list || list.length === 0) return;
  deferredDestroyByDevice.delete(device);
  // Dedup: same buffer may be deferred more than once on rapid growth paths.
  const unique = new Set(list);
  for (const buffer of unique) {
    try {
      buffer.destroy();
    } catch {
      // best-effort — already destroyed or mock device
    }
  }
}

/**
 * Enqueue a finished command buffer for the next batched submit on this device.
 * Flushes via `queueMicrotask` so all `renderFrame()` calls in the same JS turn
 * (multi-chart harness phase-2 loop) collapse into one `queue.submit`.
 */
export function enqueueDeviceSubmit(device: GPUDevice, commandBuffer: GPUCommandBuffer): void {
  let pending = pendingByDevice.get(device);
  if (!pending) {
    pending = [];
    pendingByDevice.set(device, pending);
  }
  pending.push(commandBuffer);

  if (scheduledByDevice.get(device)) return;
  scheduledByDevice.set(device, true);
  const epoch = epochByDevice.get(device) ?? 0;

  queueMicrotask(() => {
    // A dispose/flush after enqueue invalidates this scheduled drain.
    if ((epochByDevice.get(device) ?? 0) !== epoch) return;
    scheduledByDevice.set(device, false);
    const buffers = pendingByDevice.get(device);
    if (!buffers || buffers.length === 0) {
      // No CBs left (unlikely if epoch matched); still release any deferred buffers.
      drainDeferredDestroys(device);
      return;
    }
    // Swap out before submit so concurrent encodes can start a new batch.
    pendingByDevice.set(device, []);
    device.queue.submit(buffers);
    drainDeferredDestroys(device);
  });
}

/**
 * Immediately submit any pending buffers for the device and cancel the pending
 * microtask drain (via epoch bump). Also destroys any buffers queued via
 * {@link destroyBufferAfterSubmit}, even when no command buffers are pending.
 *
 * Required on chart dispose before destroying textures/buffers, and for callers
 * that need synchronous queue visibility after encode.
 */
export function flushDeviceSubmit(device: GPUDevice): void {
  epochByDevice.set(device, (epochByDevice.get(device) ?? 0) + 1);
  scheduledByDevice.set(device, false);
  const buffers = pendingByDevice.get(device);
  if (buffers && buffers.length > 0) {
    pendingByDevice.set(device, []);
    device.queue.submit(buffers);
  }
  // Always drain deferred destroys — may exist even if CBs were already empty.
  drainDeferredDestroys(device);
}

/**
 * Destroy `buffer` immediately if no command buffers are pending submit for
 * this device; otherwise queue destroy until after the next batched submit
 * (or flushDeviceSubmit). Preserves multi-chart submit coalescing while
 * avoiding use-after-destroy on pending CBs.
 */
export function destroyBufferAfterSubmit(device: GPUDevice, buffer: GPUBuffer): void {
  const pending = pendingByDevice.get(device);
  if (!pending || pending.length === 0) {
    try {
      buffer.destroy();
    } catch {
      // best-effort — already destroyed or mock device
    }
    return;
  }
  let list = deferredDestroyByDevice.get(device);
  if (!list) {
    list = [];
    deferredDestroyByDevice.set(device, list);
  }
  list.push(buffer);
}

/** Test helper: pending command-buffer count for a device (0 if none). */
export function getPendingSubmitCountForTests(device: GPUDevice): number {
  return pendingByDevice.get(device)?.length ?? 0;
}

/** Test helper: number of buffers deferred for destroy on this device. */
export function getDeferredDestroyCountForTests(device: GPUDevice): number {
  return deferredDestroyByDevice.get(device)?.length ?? 0;
}
