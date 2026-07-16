/// <reference types="@webgpu/types" />

/**
 * Unit tests for `createDecimationCompute` — the Stretch-S1 GPU compute-shader
 * decimation module.
 *
 * Tests run against a mocked `GPUDevice` (matching the pattern used by
 * `rendererPool.test.ts` and `GPUContext.test.ts`). That means we verify
 * *structural* behavior — buffer sizing + growth, dirty-gating, per-algorithm
 * dispatch topology, bind-group caching, disposal — but we do NOT run the
 * shader itself. End-to-end numerical correctness of the three WGSL entry
 * points is exercised by `examples/acceptance/gpu-decimation.ts` against a
 * live WebGPU device.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  vi,
  type Mock,
} from "vitest";

beforeAll(() => {
  // @ts-ignore
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  // @ts-ignore
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
});

import { createDecimationCompute } from "../createDecimationCompute";

type MockBuffer = GPUBuffer & { __destroyed: boolean; __size: number };

function createMockBuffer(desc?: GPUBufferDescriptor): MockBuffer {
  const size = desc?.size ?? 0;
  const buf = {
    size,
    label: desc?.label ?? "",
    __destroyed: false,
    __size: size,
    destroy: vi.fn(function (this: MockBuffer) {
      this.__destroyed = true;
    }),
    mapAsync: vi.fn(async () => {}),
    getMappedRange: vi.fn(() => new ArrayBuffer(size)),
    unmap: vi.fn(),
  } as unknown as MockBuffer;
  return buf;
}

interface MockComputePass {
  setPipeline: Mock;
  setBindGroup: Mock;
  dispatchWorkgroups: Mock;
  end: Mock;
}

interface MockEncoder {
  beginComputePass: (
    desc?: GPUComputePassDescriptor,
  ) => MockComputePass & GPUComputePassEncoder;
  finish: Mock;
  // for introspection in tests
  __passes: MockComputePass[];
}

function createMockEncoder(): MockEncoder {
  const passes: MockComputePass[] = [];
  const encoder: MockEncoder = {
    __passes: passes,
    beginComputePass: vi.fn(() => {
      const pass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      };
      passes.push(pass);
      return pass as unknown as MockComputePass & GPUComputePassEncoder;
    }) as MockEncoder["beginComputePass"],
    finish: vi.fn(() => ({})),
  };
  return encoder;
}

function createMockDevice() {
  const created = {
    buffers: [] as MockBuffer[],
    computePipelines: [] as Array<GPUComputePipelineDescriptor>,
    bindGroups: [] as Array<GPUBindGroupDescriptor>,
  };

  const device = {
    label: "mockDevice",
    limits: {
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
    },
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
    createBuffer: vi.fn((desc?: GPUBufferDescriptor) => {
      const b = createMockBuffer(desc);
      created.buffers.push(b);
      return b;
    }),
    createBindGroupLayout: vi.fn(() => ({ __layout: true })),
    createBindGroup: vi.fn((desc: GPUBindGroupDescriptor) => {
      const bg = { __bindGroup: true, desc };
      created.bindGroups.push(desc);
      return bg;
    }),
    createPipelineLayout: vi.fn(() => ({ __pipelineLayout: true })),
    createShaderModule: vi.fn(() => ({
      __shaderModule: true,
      getCompilationInfo: vi.fn(async () => ({ messages: [] })),
    })),
    createComputePipeline: vi.fn((desc: GPUComputePipelineDescriptor) => {
      created.computePipelines.push(desc);
      return { __computePipeline: true, desc };
    }),
    createRenderPipeline: vi.fn(() => ({ __renderPipeline: true })),
  } as unknown as GPUDevice & { __created: typeof created };

  (device as any).__created = created;
  return device as GPUDevice & { __created: typeof created };
}

describe("createDecimationCompute", () => {
  let device: ReturnType<typeof createMockDevice>;

  beforeEach(() => {
    device = createMockDevice();
    vi.clearAllMocks();
  });

  describe("pipeline creation", () => {
    it("creates three compute pipelines (min/max + averages + lttb)", () => {
      createDecimationCompute(device);

      const entryPoints = device.__created.computePipelines.map(
        (p) => (p.compute as GPUProgrammableStage).entryPoint,
      );
      expect(entryPoints).toEqual([
        "minMaxDecimate",
        "computeBucketAverages",
        "parallelLttbDecimate",
      ]);
    });

    it("creates one bind-group layout with 4 entries (uniform + raw + output + averages)", () => {
      const createBindGroupLayout = device.createBindGroupLayout as Mock;
      createDecimationCompute(device);

      expect(createBindGroupLayout).toHaveBeenCalledTimes(1);
      const desc = createBindGroupLayout.mock
        .calls[0]![0] as GPUBindGroupLayoutDescriptor;
      expect(Array.from(desc.entries)).toHaveLength(4);
    });
  });

  describe("prepare() output sizing + return value", () => {
    it("returns the target bucket count clamped to a minimum of 2", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      expect(
        d.prepare({
          algorithm: "lttb",
          rawBuffer,
          rawPointCount: 100_000,
          visibleStart: 0,
          visibleEnd: 100_000,
          targetBuckets: 4000,
        }),
      ).toBe(4000);

      expect(
        d.prepare({
          algorithm: "min",
          rawBuffer,
          rawPointCount: 10,
          visibleStart: 0,
          visibleEnd: 10,
          targetBuckets: 1, // below minimum
        }),
      ).toBe(2);
    });

    it("grows the output buffer geometrically when targetBuckets increases", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 8_000_000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 1_000_000,
        visibleStart: 0,
        visibleEnd: 1_000_000,
        targetBuckets: 64,
      });
      const firstOutputBufferBefore = d.getOutputBuffer();
      const firstSize = (firstOutputBufferBefore as MockBuffer).__size;

      // Growing past capacity → new buffers. Geometric growth means we should
      // see at most a handful of buffer allocations even across many growths.
      const smallBufferCount = device.__created.buffers.length;
      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 1_000_000,
        visibleStart: 0,
        visibleEnd: 1_000_000,
        targetBuckets: 1024,
      });
      const afterGrow = d.getOutputBuffer();
      const secondSize = (afterGrow as MockBuffer).__size;
      expect(secondSize).toBeGreaterThan(firstSize);
      // Buffer identity should have changed so the caller rebuilds its bind
      // group (matching the line renderer's `boundDataBuffer` pattern).
      expect(afterGrow).not.toBe(firstOutputBufferBefore);
      // New output + new averages buffer = 2 new buffers total.
      expect(device.__created.buffers.length - smallBufferCount).toBe(2);

      // Same target again should NOT reallocate.
      const afterCount = device.__created.buffers.length;
      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 1_000_000,
        visibleStart: 0,
        visibleEnd: 1_000_000,
        targetBuckets: 1024,
      });
      expect(device.__created.buffers.length).toBe(afterCount);
    });
  });

  describe("encodeCompute() dispatch topology", () => {
    it("dispatches a single min/max pipeline with `max(buckets - 2, 1)` workgroups", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      d.prepare({
        algorithm: "min",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 1024,
      });

      const encoder = createMockEncoder();
      d.encodeCompute(encoder as unknown as GPUCommandEncoder);

      expect(encoder.__passes).toHaveLength(1);
      const pass = encoder.__passes[0]!;
      // One pipeline set (minMaxDecimate).
      expect(pass.setPipeline).toHaveBeenCalledTimes(1);
      expect(pass.dispatchWorkgroups).toHaveBeenCalledTimes(1);
      // `max(targetBuckets - 2, 1)` interior-bucket workgroups.
      expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1022);
      expect(pass.end).toHaveBeenCalledTimes(1);
    });

    it("dispatches two pipelines for LTTB (averages then decimate), each with `targetBuckets` workgroups", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 8_000_000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 1_000_000,
        visibleStart: 0,
        visibleEnd: 1_000_000,
        targetBuckets: 2048,
      });

      const encoder = createMockEncoder();
      d.encodeCompute(encoder as unknown as GPUCommandEncoder);

      expect(encoder.__passes).toHaveLength(1);
      const pass = encoder.__passes[0]!;
      // averages + lttb.
      expect(pass.setPipeline).toHaveBeenCalledTimes(2);
      expect(pass.dispatchWorkgroups).toHaveBeenCalledTimes(2);
      expect(pass.dispatchWorkgroups).toHaveBeenNthCalledWith(1, 2048);
      expect(pass.dispatchWorkgroups).toHaveBeenNthCalledWith(2, 2048);
    });

    it("short-circuits encodeCompute when inputs have not changed (dirty-gating)", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      const params = {
        algorithm: "lttb" as const,
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 512,
        contentVersion: 1,
      };
      d.prepare(params);

      const enc1 = createMockEncoder();
      d.encodeCompute(enc1 as unknown as GPUCommandEncoder);
      expect(enc1.__passes).toHaveLength(1); // first encode runs

      // Second prepare with identical params — no dirty flag set.
      d.prepare(params);
      const enc2 = createMockEncoder();
      d.encodeCompute(enc2 as unknown as GPUCommandEncoder);
      expect(enc2.__passes).toHaveLength(0); // no compute pass encoded

      // A change in visible window re-marks dirty.
      d.prepare({ ...params, visibleStart: 100, visibleEnd: 90_000 });
      const enc3 = createMockEncoder();
      d.encodeCompute(enc3 as unknown as GPUCommandEncoder);
      expect(enc3.__passes).toHaveLength(1);
    });

    it("WG-P0-2: same buffer + same N + changed contentVersion re-dispatches compute", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      const base = {
        algorithm: "lttb" as const,
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 512,
      };

      d.prepare({ ...base, contentVersion: 0x1111 });
      const enc1 = createMockEncoder();
      d.encodeCompute(enc1 as unknown as GPUCommandEncoder);
      expect(enc1.__passes).toHaveLength(1);

      // Same buffer identity, same point count, same window — only payload version changes
      // (models DataStore.setSeries rewriting floats into the same GPUBuffer).
      d.prepare({ ...base, contentVersion: 0x2222 });
      const enc2 = createMockEncoder();
      d.encodeCompute(enc2 as unknown as GPUCommandEncoder);
      expect(enc2.__passes).toHaveLength(1);

      // Identical contentVersion again must skip (pure pan / unchanged frame).
      d.prepare({ ...base, contentVersion: 0x2222 });
      const enc3 = createMockEncoder();
      d.encodeCompute(enc3 as unknown as GPUCommandEncoder);
      expect(enc3.__passes).toHaveLength(0);
    });

    it("WG-P0-2: unchanged contentVersion with unchanged window still skips", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });
      const params = {
        algorithm: "min" as const,
        rawBuffer,
        rawPointCount: 50_000,
        visibleStart: 0,
        visibleEnd: 50_000,
        targetBuckets: 256,
        contentVersion: 42,
      };
      d.prepare(params);
      d.encodeCompute(createMockEncoder() as unknown as GPUCommandEncoder);

      d.prepare(params);
      const enc = createMockEncoder();
      d.encodeCompute(enc as unknown as GPUCommandEncoder);
      expect(enc.__passes).toHaveLength(0);
    });

    it("dirties when ringStart/ringCapacity change (modular FIFO wrap)", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });
      const base = {
        algorithm: "lttb" as const,
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 512,
        contentVersion: 1,
        ringStart: 0,
        ringCapacity: 1000,
      };
      d.prepare(base);
      d.encodeCompute(createMockEncoder() as unknown as GPUCommandEncoder);

      // Same everything except ringStart (wrap) must re-dispatch.
      d.prepare({ ...base, ringStart: 10 });
      const enc = createMockEncoder();
      d.encodeCompute(enc as unknown as GPUCommandEncoder);
      expect(enc.__passes).toHaveLength(1);

      // Identical ring signature skips.
      d.prepare({ ...base, ringStart: 10 });
      const enc2 = createMockEncoder();
      d.encodeCompute(enc2 as unknown as GPUCommandEncoder);
      expect(enc2.__passes).toHaveLength(0);

      // Capacity change also dirties.
      d.prepare({ ...base, ringStart: 10, ringCapacity: 2000 });
      const enc3 = createMockEncoder();
      d.encodeCompute(enc3 as unknown as GPUCommandEncoder);
      expect(enc3.__passes).toHaveLength(1);
    });

    it("writes ringStart/ringCapacity into uniform slots 5–6", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 8000 });
      d.prepare({
        algorithm: "min",
        rawBuffer,
        rawPointCount: 100,
        visibleStart: 0,
        visibleEnd: 100,
        targetBuckets: 16,
        ringStart: 7,
        ringCapacity: 64,
      });
      const writeBuffer = device.queue.writeBuffer as Mock;
      expect(writeBuffer).toHaveBeenCalled();
      // Last writeBuffer on prepare is the uniform upload.
      const last = writeBuffer.mock.calls[writeBuffer.mock.calls.length - 1]!;
      const data = last[2] as ArrayBuffer | ArrayBufferView;
      const u32 =
        data instanceof ArrayBuffer
          ? new Uint32Array(data)
          : new Uint32Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              8,
            );
      expect(u32[5]).toBe(7);
      expect(u32[6]).toBe(64);
    });

    it("is a no-op before any prepare() is called", () => {
      const d = createDecimationCompute(device);
      const encoder = createMockEncoder();
      d.encodeCompute(encoder as unknown as GPUCommandEncoder);
      expect(encoder.__passes).toHaveLength(0);
    });

    it("handles a degenerate visible window without throwing or dispatching", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 8000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 1000,
        visibleStart: 500,
        visibleEnd: 500, // empty
        targetBuckets: 64,
      });

      const encoder = createMockEncoder();
      expect(() =>
        d.encodeCompute(encoder as unknown as GPUCommandEncoder),
      ).not.toThrow();
      // encodeCompute opens a pass then returns without dispatching.
      // (Current implementation exits before beginComputePass when span <= 0.)
      expect(encoder.__passes).toHaveLength(0);
    });

    it("needsEncode is true after prepare when dirty; false after encode and when clean", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      expect(d.needsEncode()).toBe(false);

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 512,
      });
      expect(d.needsEncode()).toBe(true);

      d.encodeCompute(createMockEncoder() as unknown as GPUCommandEncoder);
      expect(d.needsEncode()).toBe(false);

      // Identical prepare clears dirty → still false.
      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 512,
      });
      expect(d.needsEncode()).toBe(false);

      // Dirty window change → true again.
      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 10,
        visibleEnd: 90_000,
        targetBuckets: 512,
      });
      expect(d.needsEncode()).toBe(true);
    });

    it("needsEncode is false for empty visible span after prepare", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 8000 });
      d.prepare({
        algorithm: "min",
        rawBuffer,
        rawPointCount: 100,
        visibleStart: 50,
        visibleEnd: 50,
        targetBuckets: 16,
      });
      expect(d.needsEncode()).toBe(false);
    });

    it("encodeCompute(encoder, intoPass) dispatches without ending the shared pass", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });
      d.prepare({
        algorithm: "min",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 256,
      });

      const sharedPass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn(),
        end: vi.fn(),
      };
      const encoder = createMockEncoder();
      d.encodeCompute(
        encoder as unknown as GPUCommandEncoder,
        sharedPass as unknown as GPUComputePassEncoder,
      );

      // Caller-owned pass: no beginComputePass, no end().
      expect(encoder.beginComputePass).not.toHaveBeenCalled();
      expect(sharedPass.end).not.toHaveBeenCalled();
      expect(sharedPass.setBindGroup).toHaveBeenCalledTimes(1);
      expect(sharedPass.setPipeline).toHaveBeenCalledTimes(1);
      expect(sharedPass.dispatchWorkgroups).toHaveBeenCalledWith(254);
      expect(d.needsEncode()).toBe(false);
    });

    it("batches N dirty series into one shared pass (caller end once)", () => {
      const a = createDecimationCompute(device);
      const b = createDecimationCompute(device);
      const rawA = createMockBuffer({ size: 800000 });
      const rawB = createMockBuffer({ size: 800000 });
      a.prepare({
        algorithm: "lttb",
        rawBuffer: rawA,
        rawPointCount: 50_000,
        visibleStart: 0,
        visibleEnd: 50_000,
        targetBuckets: 128,
      });
      b.prepare({
        algorithm: "min",
        rawBuffer: rawB,
        rawPointCount: 40_000,
        visibleStart: 0,
        visibleEnd: 40_000,
        targetBuckets: 64,
      });
      expect(a.needsEncode()).toBe(true);
      expect(b.needsEncode()).toBe(true);

      const encoder = createMockEncoder();
      const pass = encoder.beginComputePass({
        label: "decimationCompute/batchPass",
      });
      a.encodeCompute(encoder as unknown as GPUCommandEncoder, pass);
      b.encodeCompute(encoder as unknown as GPUCommandEncoder, pass);
      pass.end();

      expect(encoder.beginComputePass).toHaveBeenCalledTimes(1);
      expect(pass.setBindGroup).toHaveBeenCalledTimes(2);
      // LTTB: 2 pipeline sets; min/max: 1 → total 3.
      expect(pass.setPipeline).toHaveBeenCalledTimes(3);
      expect(pass.end).toHaveBeenCalledTimes(1);
      expect(a.needsEncode()).toBe(false);
      expect(b.needsEncode()).toBe(false);
    });
  });

  describe("bind-group caching", () => {
    it("reuses the bind group across prepare calls with the same raw buffer", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 256,
      });
      const callsAfterFirst = (device.createBindGroup as Mock).mock.calls
        .length;

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 100,
        visibleEnd: 90_000,
        targetBuckets: 256,
      });
      const callsAfterSecond = (device.createBindGroup as Mock).mock.calls
        .length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it("rebuilds the bind group when the raw buffer identity changes", () => {
      const d = createDecimationCompute(device);
      const rawBuffer1 = createMockBuffer({ size: 800000 });
      const rawBuffer2 = createMockBuffer({ size: 800000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer: rawBuffer1,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 256,
      });
      const callsAfterFirst = (device.createBindGroup as Mock).mock.calls
        .length;

      d.prepare({
        algorithm: "lttb",
        rawBuffer: rawBuffer2,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 256,
      });

      expect((device.createBindGroup as Mock).mock.calls.length).toBe(
        callsAfterFirst + 1,
      );
    });
  });

  describe("disposal", () => {
    it("destroys owned uniform + output + averages buffers on dispose()", () => {
      const d = createDecimationCompute(device);
      const rawBuffer = createMockBuffer({ size: 800000 });

      d.prepare({
        algorithm: "lttb",
        rawBuffer,
        rawPointCount: 100_000,
        visibleStart: 0,
        visibleEnd: 100_000,
        targetBuckets: 256,
      });

      // Own buffers = uniform + output + averages (3 total by this point).
      const ownedBuffers = device.__created.buffers.filter(
        (b) => b !== rawBuffer,
      );
      expect(ownedBuffers.length).toBeGreaterThanOrEqual(3);

      d.dispose();
      for (const b of ownedBuffers) {
        expect(b.__destroyed).toBe(true);
      }
      // Raw buffer is caller-owned — dispose must NOT destroy it.
      expect(rawBuffer.__destroyed).toBe(false);
    });

    it("throws after dispose on subsequent prepare calls", () => {
      const d = createDecimationCompute(device);
      d.dispose();

      const rawBuffer = createMockBuffer({ size: 800000 });
      expect(() =>
        d.prepare({
          algorithm: "lttb",
          rawBuffer,
          rawPointCount: 100_000,
          visibleStart: 0,
          visibleEnd: 100_000,
          targetBuckets: 256,
        }),
      ).toThrow(/disposed/);
    });
  });
});
