/**
 * GPU compute-shader decimation for line-series data.
 *
 * Replaces CPU-side LTTB / min / max sampling with a compute pipeline that reads
 * raw series points from a storage buffer (owned by `DataStore`) and writes the
 * decimated point set into its own output storage buffer. The renderer consumes
 * the output buffer directly — no readback to CPU, no repacking per frame.
 *
 * Wired identically to scatter-density: the caller invokes {@link prepare} to
 * update uniforms and dirty-gate, then {@link encodeCompute} from the render
 * loop just before `beginRenderPass()` (see `encodeScatterDensityCompute` in
 * `renderCoordinator/render/renderSeries.ts` for the sibling pattern).
 *
 * Supported `sampling` modes (match the existing CPU API 1:1):
 *   - `'min'` / `'max'` — per-bucket argmin/argmax on y. One kernel dispatch.
 *   - `'lttb'` / `'auto'` — two-phase parallel LTTB (per-bucket averages, then
 *     triangle-area maximization against the neighboring bucket averages).
 *
 * All entry points live in `src/shaders/decimation.wgsl` — that file documents
 * the per-bucket indexing convention and the output layout contract.
 */

import decimationWgsl from "../shaders/decimation.wgsl?raw";
import type { PipelineCache } from "../core/PipelineCache";
import {
  createComputePipeline,
  createShaderModule,
  createUniformBuffer,
  writeUniformBuffer,
} from "./rendererUtils";

/**
 * Algorithm selected by the caller. Mirrors the CPU `SeriesSampling` values
 * that this module can accelerate. The coordinator is responsible for mapping
 * `'auto'` to `'lttb'` before calling in (we do not re-encode that decision
 * here so the module stays policy-free).
 */
export type DecimationAlgorithm = "lttb" | "min" | "max";

export interface DecimationComputePrepareParams {
  readonly algorithm: DecimationAlgorithm;
  /**
   * Raw (unsampled) series data on the GPU. Must be a storage buffer of
   * interleaved `vec2<f32>` points, identical to the buffer `DataStore`
   * maintains for line/area renderers.
   */
  readonly rawBuffer: GPUBuffer;
  /**
   * Total number of raw points in {@link rawBuffer}. The compute shader only
   * indexes `[0, rawPointCount)` regardless of the buffer's byte capacity.
   */
  readonly rawPointCount: number;
  /**
   * Inclusive-start, exclusive-end raw-index window to decimate. The caller
   * normally derives this from a binary search over the raw x-column keyed on
   * the visible x-domain (identical to what `findVisibleRangeIndicesByX` does
   * for scatter-density).
   */
  readonly visibleStart: number;
  readonly visibleEnd: number;
  /**
   * Desired output point count. Typically `plotWidthPx * samplingDensity` in
   * the same spirit as the CPU `samplingThreshold` logic.
   */
  readonly targetBuckets: number;
  /**
   * Monotonic or content-derived version of the packed raw payload (WG-P0-2).
   * DataStore's FNV-1a `hash32` is the usual source. Same buffer identity +
   * same point count + rewritten floats must change this so compute re-runs.
   * Omit (or keep stable) when content is known unchanged so pure pan/window
   * skips still work via the other signature fields.
   */
  readonly contentVersion?: number;
  /**
   * Fixed-capacity ring FIFO layout for `rawBuffer`. When `ringCapacity` is
   * 0/omitted, storage is linear chronological. When set, logical index `i`
   * maps to physical `(ringStart + i) % ringCapacity` in WGSL.
   */
  readonly ringStart?: number;
  readonly ringCapacity?: number;
}

export interface DecimationCompute {
  /**
   * Updates uniforms + dirty-gating for the next call to {@link encodeCompute}.
   *
   * Safe to call on every frame; compute work is only dispatched when the
   * input signature actually changes.
   *
   * @returns The number of points that will be written to {@link getOutputBuffer}
   * by the next compute dispatch — useful so the renderer can immediately set
   * its draw-count without waiting for the GPU.
   */
  prepare(params: DecimationComputePrepareParams): number;

  /**
   * True when the next {@link encodeCompute} will dispatch work (prepared + dirty).
   * Used by the coordinator to open a shared compute pass only when needed.
   */
  needsEncode(): boolean;

  /**
   * Encodes the compute pass(es) onto {@link encoder}. No-op if no eligible
   * `prepare()` has been called, or if the dirty flag is clear (no inputs
   * changed this frame).
   *
   * When `intoPass` is provided, dispatches into that shared pass (caller owns
   * begin/end). Used by the coordinator to batch all series decimation into one
   * compute pass instead of 5× beginComputePass per frame.
   */
  encodeCompute(
    encoder: GPUCommandEncoder,
    intoPass?: GPUComputePassEncoder,
  ): void;

  /**
   * GPU storage buffer holding the decimated `vec2<f32>` points. Stable across
   * frames except when the target bucket count grows past capacity (geometric
   * growth). Renderers should cache their bind group by buffer identity.
   */
  getOutputBuffer(): GPUBuffer;

  /**
   * Number of points actually written to {@link getOutputBuffer} by the most
   * recent {@link prepare} call. Returns `0` until the first prepare.
   */
  getOutputPointCount(): number;

  dispose(): void;
}

export interface DecimationComputeOptions {
  readonly pipelineCache?: PipelineCache;
}

const MIN_OUTPUT_CAPACITY = 64;

const nextPow2 = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const n = Math.ceil(v);
  return 2 ** Math.ceil(Math.log2(n));
};

// Uniforms struct in decimation.wgsl: 8 × u32 = 32 bytes. Round up to the 16-byte
// alignment required for uniform buffers. 32 bytes already meets that bound.
const DECIMATION_UNIFORM_BYTES = 32;

// Mode bits consumed by `minMaxDecimate` (bit 0: 0 = min, 1 = max).
const MODE_MIN = 0;
const MODE_MAX = 1;

export function createDecimationCompute(
  device: GPUDevice,
  options?: DecimationComputeOptions,
): DecimationCompute {
  let disposed = false;
  const pipelineCache = options?.pipelineCache;

  const bindGroupLayout = device.createBindGroupLayout({
    label: "decimationCompute/bindGroupLayout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });

  const module = createShaderModule(
    device,
    decimationWgsl,
    "decimation.wgsl",
    pipelineCache,
  );
  // Surface WGSL compile errors at creation time. WebGPU's downstream validation
  // only reports "previous error" on pipeline creation; the actual messages live
  // in the shader module's compilation info. Fire-and-forget so we don't block
  // pipeline creation in the common (error-free) case.
  if (typeof module.getCompilationInfo === "function") {
    module.getCompilationInfo().then((info) => {
      for (const msg of info.messages) {
        if (msg.type === "error") {
          console.error(
            `[decimation.wgsl:${msg.lineNum}:${msg.linePos}] ${msg.message}`,
          );
        } else if (msg.type === "warning") {
          console.warn(
            `[decimation.wgsl:${msg.lineNum}:${msg.linePos}] ${msg.message}`,
          );
        }
      }
    });
  }

  // Best-effort: surface WGSL compile errors with line-level precision. Without
  // this, Chrome's pipeline-creation error message is just "ShaderModule
  // invalid due to a previous error" — which makes even a one-line typo in the
  // shader hard to diagnose.
  const getCompilationInfo = module.getCompilationInfo?.bind(module);
  if (getCompilationInfo) {
    getCompilationInfo()
      .then((info) => {
        const errors = info.messages.filter((m) => m.type === "error");
        if (errors.length > 0) {
          const formatted = errors
            .map((m) => `  ${m.lineNum ?? 0}:${m.linePos ?? 0} ${m.message}`)
            .join("\n");
          // eslint-disable-next-line no-console
          console.error(
            `[decimation.wgsl] compile errors:\n${formatted}`,
          );
        }
      })
      .catch(() => {
        // Ignore — best effort only.
      });
  }
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const minMaxPipeline = createComputePipeline(
    device,
    {
      label: "decimationCompute/minMaxPipeline",
      layout: pipelineLayout,
      compute: { module, entryPoint: "minMaxDecimate" },
    },
    pipelineCache,
  );
  const averagesPipeline = createComputePipeline(
    device,
    {
      label: "decimationCompute/averagesPipeline",
      layout: pipelineLayout,
      compute: { module, entryPoint: "computeBucketAverages" },
    },
    pipelineCache,
  );
  const lttbPipeline = createComputePipeline(
    device,
    {
      label: "decimationCompute/lttbPipeline",
      layout: pipelineLayout,
      compute: { module, entryPoint: "parallelLttbDecimate" },
    },
    pipelineCache,
  );

  const uniformBuffer = createUniformBuffer(device, DECIMATION_UNIFORM_BYTES, {
    label: "decimationCompute/uniforms",
  });
  const uniformScratch = new ArrayBuffer(DECIMATION_UNIFORM_BYTES);
  const uniformScratchU32 = new Uint32Array(uniformScratch);

  // Output + averages buffers. Grown geometrically (power-of-two) to match the
  // DataStore buffer-growth policy (see `createDataStore.ts` -> `nextPow2`).
  let outputBuffer: GPUBuffer | null = null;
  let averagesBuffer: GPUBuffer | null = null;
  let bufferCapacityPoints = 0; // counts `vec2<f32>` elements, not bytes
  let bindGroup: GPUBindGroup | null = null;
  let boundRawBuffer: GPUBuffer | null = null;

  // Per-frame cached signature: dirty flag is set when any of these change so
  // zoom/pan frames that don't move the visible window skip the compute pass
  // entirely.
  let hasPrepared = false;
  let dirty = false;
  let lastAlgorithm: DecimationAlgorithm | null = null;
  let lastRawBuffer: GPUBuffer | null = null;
  let lastRawPointCount = -1;
  let lastVisibleStart = -1;
  let lastVisibleEnd = -1;
  let lastTargetBuckets = -1;
  /** `undefined` means "not yet prepared with a version" (first frame always dirties via other fields). */
  let lastContentVersion: number | undefined = undefined;
  let lastRingStart = 0;
  let lastRingCapacity = 0;
  let lastOutputPointCount = 0;

  const ensureBuffers = (capacityPoints: number): void => {
    const required = Math.max(MIN_OUTPUT_CAPACITY, capacityPoints);
    if (outputBuffer && averagesBuffer && required <= bufferCapacityPoints) {
      return;
    }

    bufferCapacityPoints = Math.max(
      bufferCapacityPoints,
      Math.max(MIN_OUTPUT_CAPACITY, nextPow2(required)),
    );
    const byteSize = bufferCapacityPoints * 2 * 4; // vec2<f32> = 8 bytes

    if (outputBuffer) {
      try {
        outputBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (averagesBuffer) {
      try {
        averagesBuffer.destroy();
      } catch {
        // best-effort
      }
    }

    outputBuffer = device.createBuffer({
      label: "decimationCompute/outputBuffer",
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    averagesBuffer = device.createBuffer({
      label: "decimationCompute/averagesBuffer",
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Buffer identity changed → rebuild bind group on the next encode.
    bindGroup = null;
  };

  const ensureBindGroup = (rawBuffer: GPUBuffer): void => {
    if (bindGroup && boundRawBuffer === rawBuffer) return;
    if (!outputBuffer || !averagesBuffer) return;

    bindGroup = device.createBindGroup({
      label: "decimationCompute/bindGroup",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: rawBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: averagesBuffer } },
      ],
    });
    boundRawBuffer = rawBuffer;
  };

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error("DecimationCompute is disposed.");
  };

  const prepare: DecimationCompute["prepare"] = (params) => {
    assertNotDisposed();

    const {
      algorithm,
      rawBuffer,
      rawPointCount,
      visibleStart,
      visibleEnd,
      targetBuckets,
      contentVersion,
      ringStart: ringStartIn,
      ringCapacity: ringCapacityIn,
    } = params;

    const rawCount = Math.max(0, rawPointCount | 0);
    const vs = Math.min(rawCount, Math.max(0, visibleStart | 0));
    const ve = Math.min(rawCount, Math.max(vs, visibleEnd | 0));
    // `targetBuckets` must leave room for both anchors, so require at least 2.
    const buckets = Math.max(2, targetBuckets | 0);
    // Treat omitted contentVersion as "unknown / force dirty once" only when it
    // transitions; stable undefined keeps skip behavior for tests that omit it.
    const version = contentVersion;
    const ringCap = Math.max(0, (ringCapacityIn ?? 0) | 0);
    const ringStart =
      ringCap > 0 ? Math.max(0, (ringStartIn ?? 0) | 0) % ringCap : 0;

    ensureBuffers(buckets);
    ensureBindGroup(rawBuffer);

    // Detect signature changes to decide whether to re-dispatch the compute.
    // contentVersion covers same-buffer same-N payload rewrites (WG-P0-2).
    // ringStart/capacity cover modular FIFO wrap without a full buffer rewrite.
    if (
      lastAlgorithm !== algorithm ||
      lastRawBuffer !== rawBuffer ||
      lastRawPointCount !== rawCount ||
      lastVisibleStart !== vs ||
      lastVisibleEnd !== ve ||
      lastTargetBuckets !== buckets ||
      lastContentVersion !== version ||
      lastRingStart !== ringStart ||
      lastRingCapacity !== ringCap
    ) {
      dirty = true;
      lastAlgorithm = algorithm;
      lastRawBuffer = rawBuffer;
      lastRawPointCount = rawCount;
      lastVisibleStart = vs;
      lastVisibleEnd = ve;
      lastTargetBuckets = buckets;
      lastContentVersion = version;
      lastRingStart = ringStart;
      lastRingCapacity = ringCap;
    }

    // Pack uniforms. Layout must match the `DecimationUniforms` struct in WGSL.
    uniformScratchU32[0] = rawCount >>> 0;
    uniformScratchU32[1] = vs >>> 0;
    uniformScratchU32[2] = ve >>> 0;
    uniformScratchU32[3] = buckets >>> 0;
    uniformScratchU32[4] =
      algorithm === "max" ? MODE_MAX : algorithm === "min" ? MODE_MIN : 0;
    uniformScratchU32[5] = ringStart >>> 0;
    uniformScratchU32[6] = ringCap >>> 0;
    uniformScratchU32[7] = 0;

    // Always upload uniforms on prepare — cheap and keeps the dirty path simple.
    // (The `dirty` flag governs whether a compute pass is encoded, not the write.)
    writeUniformBuffer(device, uniformBuffer, uniformScratch);

    hasPrepared = true;
    lastOutputPointCount = buckets;
    return buckets;
  };

  const needsEncode: DecimationCompute["needsEncode"] = () => {
    if (disposed || !hasPrepared || !dirty || !bindGroup) return false;
    const buckets = lastTargetBuckets;
    const span = lastVisibleEnd - lastVisibleStart;
    return buckets >= 2 && span > 0;
  };

  const encodeCompute: DecimationCompute["encodeCompute"] = (
    encoder,
    intoPass,
  ) => {
    assertNotDisposed();
    if (!hasPrepared) return;
    if (!dirty) return;
    if (!bindGroup) return;

    const buckets = lastTargetBuckets;
    const span = lastVisibleEnd - lastVisibleStart;

    if (buckets < 2 || span <= 0) {
      dirty = false;
      return;
    }

    const ownsPass = intoPass == null;
    const pass =
      intoPass ??
      encoder.beginComputePass({
        label: "decimationCompute/computePass",
      });
    pass.setBindGroup(0, bindGroup);

    if (lastAlgorithm === "min" || lastAlgorithm === "max") {
      // `minMaxDecimate` dispatches `max(buckets - 2, 1)` workgroups. Workgroup
      // 0 is responsible for both fixed anchors (first + last) via tid 0, so a
      // lone bucket still runs a single workgroup.
      pass.setPipeline(minMaxPipeline);
      const dispatch = Math.max(1, buckets - 2);
      pass.dispatchWorkgroups(dispatch);
    } else {
      // Parallel LTTB: two dispatches. Phase A writes averages, phase B reads
      // averages + raw points and writes the final decimated output.
      pass.setPipeline(averagesPipeline);
      pass.dispatchWorkgroups(buckets);

      pass.setPipeline(lttbPipeline);
      pass.dispatchWorkgroups(buckets);
    }

    if (ownsPass) {
      pass.end();
    }
    dirty = false;
  };

  const getOutputBuffer: DecimationCompute["getOutputBuffer"] = () => {
    if (!outputBuffer) {
      // First call before ensureBuffers runs: allocate the minimum so the
      // renderer has a real buffer identity to cache its bind group against.
      ensureBuffers(MIN_OUTPUT_CAPACITY);
    }
    return outputBuffer!;
  };

  const getOutputPointCount: DecimationCompute["getOutputPointCount"] = () =>
    lastOutputPointCount;

  const dispose: DecimationCompute["dispose"] = () => {
    if (disposed) return;
    disposed = true;

    try {
      uniformBuffer.destroy();
    } catch {
      // best-effort
    }
    if (outputBuffer) {
      try {
        outputBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    if (averagesBuffer) {
      try {
        averagesBuffer.destroy();
      } catch {
        // best-effort
      }
    }
    outputBuffer = null;
    averagesBuffer = null;
    bindGroup = null;
    boundRawBuffer = null;
    bufferCapacityPoints = 0;
    hasPrepared = false;
    dirty = false;
  };

  return {
    prepare,
    needsEncode,
    encodeCompute,
    getOutputBuffer,
    getOutputPointCount,
    dispose,
  };
}
