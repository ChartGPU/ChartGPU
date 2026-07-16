/**
 * Multi-chart submit coalescing: N encode finishes → one queue.submit.
 * Deferred buffer destroy preserves coalescing while avoiding use-after-destroy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueueDeviceSubmit,
  flushDeviceSubmit,
  destroyBufferAfterSubmit,
  getPendingSubmitCountForTests,
  getDeferredDestroyCountForTests,
} from '../submitBatcher';

function mockDevice(): GPUDevice {
  return {
    queue: {
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

function mockBuffer(id: number): GPUCommandBuffer {
  return { __id: id } as unknown as GPUCommandBuffer;
}

function mockGpuBuffer(): GPUBuffer {
  return {
    destroy: vi.fn(),
  } as unknown as GPUBuffer;
}

describe('submitBatcher', () => {
  beforeEach(() => {
    // Ensure microtasks from prior tests have drained.
  });

  it('coalesces multiple enqueueDeviceSubmit on same device into one submit', async () => {
    const device = mockDevice();
    const b0 = mockBuffer(0);
    const b1 = mockBuffer(1);
    const b2 = mockBuffer(2);

    enqueueDeviceSubmit(device, b0);
    enqueueDeviceSubmit(device, b1);
    enqueueDeviceSubmit(device, b2);
    expect(getPendingSubmitCountForTests(device)).toBe(3);
    expect(device.queue.submit).not.toHaveBeenCalled();

    await Promise.resolve(); // flush microtask

    expect(device.queue.submit).toHaveBeenCalledTimes(1);
    expect(device.queue.submit).toHaveBeenCalledWith([b0, b1, b2]);
    expect(getPendingSubmitCountForTests(device)).toBe(0);
  });

  it('does not batch across different devices', async () => {
    const d0 = mockDevice();
    const d1 = mockDevice();
    const b0 = mockBuffer(0);
    const b1 = mockBuffer(1);

    enqueueDeviceSubmit(d0, b0);
    enqueueDeviceSubmit(d1, b1);

    await Promise.resolve();

    expect(d0.queue.submit).toHaveBeenCalledWith([b0]);
    expect(d1.queue.submit).toHaveBeenCalledWith([b1]);
  });

  it('flushDeviceSubmit submits immediately without waiting for microtask', () => {
    const device = mockDevice();
    const b0 = mockBuffer(0);
    enqueueDeviceSubmit(device, b0);
    expect(device.queue.submit).not.toHaveBeenCalled();

    flushDeviceSubmit(device);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
    expect(device.queue.submit).toHaveBeenCalledWith([b0]);
    expect(getPendingSubmitCountForTests(device)).toBe(0);
  });

  it('second turn after flush schedules a new batch', async () => {
    const device = mockDevice();
    enqueueDeviceSubmit(device, mockBuffer(0));
    await Promise.resolve();
    expect(device.queue.submit).toHaveBeenCalledTimes(1);

    enqueueDeviceSubmit(device, mockBuffer(1));
    enqueueDeviceSubmit(device, mockBuffer(2));
    await Promise.resolve();
    expect(device.queue.submit).toHaveBeenCalledTimes(2);
    expect(device.queue.submit).toHaveBeenLastCalledWith([
      expect.objectContaining({ __id: 1 }),
      expect.objectContaining({ __id: 2 }),
    ]);
  });

  it('enqueue → flush (dispose pattern) drains sync and microtask does not re-submit', async () => {
    const device = mockDevice();
    const b0 = mockBuffer(0);
    enqueueDeviceSubmit(device, b0);
    expect(getPendingSubmitCountForTests(device)).toBe(1);

    // dispose() path: flush before destroying textures
    flushDeviceSubmit(device);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
    expect(device.queue.submit).toHaveBeenCalledWith([b0]);
    expect(getPendingSubmitCountForTests(device)).toBe(0);

    await Promise.resolve(); // original microtask must no-op (epoch bump)
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
  });

  it('flush then enqueue schedules a fresh microtask batch', async () => {
    const device = mockDevice();
    enqueueDeviceSubmit(device, mockBuffer(0));
    flushDeviceSubmit(device);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);

    const b1 = mockBuffer(1);
    enqueueDeviceSubmit(device, b1);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(device.queue.submit).toHaveBeenCalledTimes(2);
    expect(device.queue.submit).toHaveBeenLastCalledWith([b1]);
  });

  describe('destroyBufferAfterSubmit', () => {
    it('destroys immediately when no pending submit', () => {
      const device = mockDevice();
      const gpuBuf = mockGpuBuffer();

      destroyBufferAfterSubmit(device, gpuBuf);

      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
      expect(getDeferredDestroyCountForTests(device)).toBe(0);
      expect(device.queue.submit).not.toHaveBeenCalled();
    });

    it('defers destroy while a command buffer is pending until flushDeviceSubmit', () => {
      const device = mockDevice();
      const cb = mockBuffer(0);
      const gpuBuf = mockGpuBuffer();

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, gpuBuf);

      expect(gpuBuf.destroy).not.toHaveBeenCalled();
      expect(getDeferredDestroyCountForTests(device)).toBe(1);
      // Must NOT force an immediate submit (preserves multi-chart coalescing).
      expect(device.queue.submit).not.toHaveBeenCalled();

      flushDeviceSubmit(device);

      expect(device.queue.submit).toHaveBeenCalledTimes(1);
      expect(device.queue.submit).toHaveBeenCalledWith([cb]);
      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
      expect(getDeferredDestroyCountForTests(device)).toBe(0);
    });

    it('flushDeviceSubmit submits CBs then destroys deferred buffers (order)', () => {
      const device = mockDevice();
      const cb = mockBuffer(0);
      const gpuBuf = mockGpuBuffer();
      const callOrder: string[] = [];

      (device.queue.submit as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('submit');
      });
      (gpuBuf.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('destroy');
      });

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, gpuBuf);
      flushDeviceSubmit(device);

      expect(callOrder).toEqual(['submit', 'destroy']);
    });

    it('microtask drain submits then destroys deferred buffers', async () => {
      const device = mockDevice();
      const cb = mockBuffer(0);
      const gpuBuf = mockGpuBuffer();
      const callOrder: string[] = [];

      (device.queue.submit as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('submit');
      });
      (gpuBuf.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('destroy');
      });

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, gpuBuf);
      expect(gpuBuf.destroy).not.toHaveBeenCalled();

      await Promise.resolve();

      expect(device.queue.submit).toHaveBeenCalledWith([cb]);
      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['submit', 'destroy']);
      expect(getDeferredDestroyCountForTests(device)).toBe(0);
    });

    it('drains multiple deferred buffers on flush', () => {
      const device = mockDevice();
      const cb = mockBuffer(0);
      const bufA = mockGpuBuffer();
      const bufB = mockGpuBuffer();
      const bufC = mockGpuBuffer();

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, bufA);
      destroyBufferAfterSubmit(device, bufB);
      destroyBufferAfterSubmit(device, bufC);

      expect(getDeferredDestroyCountForTests(device)).toBe(3);
      expect(bufA.destroy).not.toHaveBeenCalled();

      flushDeviceSubmit(device);

      expect(bufA.destroy).toHaveBeenCalledTimes(1);
      expect(bufB.destroy).toHaveBeenCalledTimes(1);
      expect(bufC.destroy).toHaveBeenCalledTimes(1);
      expect(getDeferredDestroyCountForTests(device)).toBe(0);
    });

    it('destroys a deferred buffer only once when deferred multiple times', () => {
      const device = mockDevice();
      const cb = mockBuffer(0);
      const gpuBuf = mockGpuBuffer();

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, gpuBuf);
      destroyBufferAfterSubmit(device, gpuBuf);
      expect(getDeferredDestroyCountForTests(device)).toBe(2);

      flushDeviceSubmit(device);
      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
    });

    it('flushDeviceSubmit with empty pending still drains deferred destroys', () => {
      // If submit throws after pending is cleared, deferred buffers remain while
      // pending count is 0. A subsequent flush must still drain them (no CB submit).
      const device = mockDevice();
      const cb = mockBuffer(0);
      const gpuBuf = mockGpuBuffer();

      enqueueDeviceSubmit(device, cb);
      destroyBufferAfterSubmit(device, gpuBuf);

      (device.queue.submit as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('submit failed');
      });

      expect(() => flushDeviceSubmit(device)).toThrow('submit failed');
      expect(getPendingSubmitCountForTests(device)).toBe(0);
      expect(getDeferredDestroyCountForTests(device)).toBe(1);
      expect(gpuBuf.destroy).not.toHaveBeenCalled();

      // Empty-pending flush: no second submit, but deferred destroys drain.
      flushDeviceSubmit(device);
      expect(device.queue.submit).toHaveBeenCalledTimes(1);
      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
      expect(getDeferredDestroyCountForTests(device)).toBe(0);
    });

    it('does not call queue.submit when destroying with empty pending', () => {
      const device = mockDevice();
      const gpuBuf = mockGpuBuffer();

      destroyBufferAfterSubmit(device, gpuBuf);

      expect(device.queue.submit).not.toHaveBeenCalled();
      expect(gpuBuf.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
