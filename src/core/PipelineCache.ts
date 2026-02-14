/**
 * CGPU-PIPELINE-CACHE
 *
 * Dedupes immutable WebGPU objects across charts:
 * - GPUShaderModule (keyed by WGSL source)
 * - GPURenderPipeline (keyed by identity-defining pipeline state)
 *
 * Notes:
 * - Cache is bound to a single GPUDevice.
 * - Cache auto-clears on device loss (`device.lost`) and resets stats.
 * - This cache does NOT store per-chart buffers/uniforms/bind groups.
 */

export type PipelineCacheStats = Readonly<{
  readonly shaderModules: Readonly<{
    readonly total: number;
    readonly hits: number;
    readonly misses: number;
    readonly entries: number;
  }>;
  readonly renderPipelines: Readonly<{
    readonly total: number;
    readonly hits: number;
    readonly misses: number;
    readonly entries: number;
  }>;
}>;

export interface PipelineCache {
  readonly device: GPUDevice;

  /**
   * Returns an immutable snapshot of totals/hits/misses.
   */
  getStats(): PipelineCacheStats;

  /**
   * Clears all cached entries and resets stats.
   * Automatically invoked on `device.lost`.
   */
  clear(): void;

  /**
   * Shader module dedupe keyed by WGSL source string.
   */
  getOrCreateShaderModule(code: string, label?: string): GPUShaderModule;

  /**
   * Render pipeline dedupe keyed by identity-defining fields.
   */
  getOrCreateRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
}

const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

const fnv1a64Hex = (s: string): string => {
  // Deterministic hash over UTF-16 code units.
  let h = FNV1A_64_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV1A_64_PRIME) & U64_MASK;
  }
  return h.toString(16).padStart(16, '0');
};

// Fast, deterministic render pipeline key generation.
//
// Performance goals:
// - Avoid building large normalized objects + generic stable stringify
// - Minimize allocations in hot paths (pipeline creation during renderer init)
//
// Correctness goals:
// - Deterministic keys for equivalent descriptors
// - Normalize default values so `{}` and `undefined` fields key identically
// - Preserve existing semantics for nullable/undefined array entries (filtering)
const DEFAULT_WRITE_MASK_ALL = 0xF;

const pushTag = (parts: string[], tag: string): void => {
  parts.push(tag, '|');
};

const pushStr = (parts: string[], s: string): void => {
  // Length-prefix prevents delimiter collisions without JSON escaping overhead.
  parts.push('s', String(s.length), ':', s, '|');
};

const pushNum = (parts: string[], n: number): void => {
  parts.push('n', String(n), '|');
};

const pushBool = (parts: string[], b: boolean): void => {
  parts.push(b ? 't|' : 'f|');
};

const pushNull = (parts: string[]): void => {
  parts.push('0|');
};

const pushConstants = (parts: string[], constants: Record<string, GPUPipelineConstantValue> | undefined): void => {
  if (!constants) {
    pushTag(parts, 'C0');
    return;
  }
  const keys = Object.keys(constants);
  if (keys.length === 0) {
    pushTag(parts, 'C0');
    return;
  }
  keys.sort();
  pushTag(parts, 'C1');
  pushNum(parts, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    pushStr(parts, k);
    // GPUPipelineConstantValue is numeric; encode deterministically.
    const v = constants[k] as unknown as number;
    pushNum(parts, v);
  }
};

const cmpString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pushVertexBuffers = (parts: string[], buffers: readonly (GPUVertexBufferLayout | null | undefined)[] | undefined): void => {
  if (!buffers || buffers.length === 0) {
    pushTag(parts, 'B0');
    return;
  }

  // Preserve existing key semantics: filter falsey entries (even though this can shift slots).
  let count = 0;
  for (let i = 0; i < buffers.length; i++) {
    if (buffers[i]) count++;
  }
  if (count === 0) {
    pushTag(parts, 'B0');
    return;
  }

  pushTag(parts, 'B1');
  pushNum(parts, count);

  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    if (!b) continue;

    pushNum(parts, b.arrayStride);
    pushStr(parts, (b.stepMode ?? 'vertex') as string);

    const attrs = Array.from(b.attributes ?? []);
    if (attrs.length === 0) {
      pushTag(parts, 'A0');
      continue;
    }
    attrs.sort((a: GPUVertexAttribute, c: GPUVertexAttribute) => {
      if (a.shaderLocation !== c.shaderLocation) return a.shaderLocation - c.shaderLocation;
      if (a.offset !== c.offset) return a.offset - c.offset;
      return cmpString(a.format as unknown as string, c.format as unknown as string);
    });

    pushTag(parts, 'A1');
    pushNum(parts, attrs.length);
    for (let j = 0; j < attrs.length; j++) {
      const a = attrs[j]!;
      pushNum(parts, a.shaderLocation);
      pushNum(parts, a.offset);
      pushStr(parts, a.format as unknown as string);
    }
  }
};

const pushBlend = (parts: string[], blend: GPUBlendState | undefined): void => {
  if (!blend) {
    pushTag(parts, 'BL0');
    return;
  }
  pushTag(parts, 'BL1');
  pushStr(parts, blend.color.operation as unknown as string);
  pushStr(parts, blend.color.srcFactor as unknown as string);
  pushStr(parts, blend.color.dstFactor as unknown as string);
  pushStr(parts, blend.alpha.operation as unknown as string);
  pushStr(parts, blend.alpha.srcFactor as unknown as string);
  pushStr(parts, blend.alpha.dstFactor as unknown as string);
};

const pushTargets = (parts: string[], targets: readonly (GPUColorTargetState | null | undefined)[] | undefined): void => {
  if (!targets || targets.length === 0) {
    pushTag(parts, 'T0');
    return;
  }
  pushTag(parts, 'T1');
  pushNum(parts, targets.length);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t) {
      pushNull(parts);
      continue;
    }
    pushStr(parts, t.format as unknown as string);
    pushBlend(parts, t.blend);
    const writeMask = (t.writeMask as unknown as number | undefined) ?? DEFAULT_WRITE_MASK_ALL;
    pushNum(parts, writeMask);
  }
};

const pushPrimitive = (parts: string[], p: GPUPrimitiveState | undefined): void => {
  const topology = (p?.topology ?? 'triangle-list') as string;
  const stripIndexFormat = (p?.stripIndexFormat ?? null) as unknown as string | null;
  const frontFace = (p?.frontFace ?? 'ccw') as string;
  const cullMode = (p?.cullMode ?? 'none') as string;
  const unclippedDepth = p?.unclippedDepth ?? false;

  pushStr(parts, topology);
  if (stripIndexFormat == null) pushNull(parts);
  else pushStr(parts, stripIndexFormat);
  pushStr(parts, frontFace);
  pushStr(parts, cullMode);
  pushBool(parts, unclippedDepth);
};

const pushMultisample = (parts: string[], m: GPUMultisampleState | undefined): void => {
  const count = m?.count ?? 1;
  const mask = (m?.mask as unknown as number | undefined) ?? 0xffffffff;
  const alphaToCoverageEnabled = m?.alphaToCoverageEnabled ?? false;
  pushNum(parts, count);
  pushNum(parts, mask);
  pushBool(parts, alphaToCoverageEnabled);
};

const pushStencilFace = (parts: string[], face: GPUStencilFaceState | undefined): void => {
  if (!face) {
    pushTag(parts, 'SF0');
    return;
  }
  pushTag(parts, 'SF1');
  pushStr(parts, face.compare as unknown as string);
  pushStr(parts, face.failOp as unknown as string);
  pushStr(parts, face.depthFailOp as unknown as string);
  pushStr(parts, face.passOp as unknown as string);
};

const pushDepthStencil = (parts: string[], d: GPUDepthStencilState | undefined): void => {
  if (!d) {
    pushTag(parts, 'DS0');
    return;
  }
  pushTag(parts, 'DS1');
  pushStr(parts, d.format as unknown as string);
  pushBool(parts, d.depthWriteEnabled ?? false);
  pushStr(parts, (d.depthCompare ?? 'always') as unknown as string);
  pushStencilFace(parts, d.stencilFront);
  pushStencilFace(parts, d.stencilBack);
  pushNum(parts, (d.stencilReadMask as unknown as number | undefined) ?? 0xffffffff);
  pushNum(parts, (d.stencilWriteMask as unknown as number | undefined) ?? 0xffffffff);
  pushNum(parts, d.depthBias ?? 0);
  pushNum(parts, d.depthBiasSlopeScale ?? 0);
  pushNum(parts, d.depthBiasClamp ?? 0);
};

export function createPipelineCache(device: GPUDevice): PipelineCache {
  const shaderModuleByWgsl = new Map<string, GPUShaderModule>();
  const renderPipelineByKey = new Map<string, GPURenderPipeline>();

  let shaderTotal = 0;
  let shaderHits = 0;
  let shaderMisses = 0;

  let pipeTotal = 0;
  let pipeHits = 0;
  let pipeMisses = 0;

  // Weak identity maps for keying.
  let moduleIdByModule = new WeakMap<GPUShaderModule, string>();
  let layoutIdByLayout = new WeakMap<GPUPipelineLayout, string>();
  let nextExternalModuleId = 0;
  let nextLayoutId = 0;

  const getOrAssignModuleId = (module: GPUShaderModule): string => {
    const existing = moduleIdByModule.get(module);
    if (existing) return existing;
    const id = `ext:${++nextExternalModuleId}`;
    moduleIdByModule.set(module, id);
    return id;
  };

  const getOrAssignLayoutId = (layout: GPUPipelineLayout): string => {
    const existing = layoutIdByLayout.get(layout);
    if (existing) return existing;
    const id = `layout:${++nextLayoutId}`;
    layoutIdByLayout.set(layout, id);
    return id;
  };

  const clear = (): void => {
    shaderModuleByWgsl.clear();
    renderPipelineByKey.clear();

    shaderTotal = 0;
    shaderHits = 0;
    shaderMisses = 0;

    pipeTotal = 0;
    pipeHits = 0;
    pipeMisses = 0;

    moduleIdByModule = new WeakMap();
    layoutIdByLayout = new WeakMap();
    nextExternalModuleId = 0;
    nextLayoutId = 0;
  };

  // Auto-clear on device loss (best-effort).
  // Some test mocks may not provide a proper device.lost promise; handle gracefully.
  try {
    void device.lost
      .then(() => {
        clear();
      })
      .catch((err) => {
        // Device loss promise rejection is unusual; log for debugging.
        // Suppress in test environments where mocks may behave differently.
        if (typeof err === 'object' && err !== null && 'message' in err) {
          console.warn('PipelineCache: device.lost promise rejected:', err);
        }
        clear();
      });
  } catch (err) {
    // Some mocks may not expose device.lost at all; this is acceptable.
    // Real GPUDevice instances always have device.lost, so this catch is primarily for tests.
  }

  const getOrCreateShaderModule = (code: string, label?: string): GPUShaderModule => {
    shaderTotal++;
    const cached = shaderModuleByWgsl.get(code);
    if (cached) {
      shaderHits++;
      return cached;
    }
    shaderMisses++;
    const module = device.createShaderModule({ code, label });
    shaderModuleByWgsl.set(code, module);
    // Prefer stable id derived from WGSL (shorter than embedding source into pipeline keys).
    const stableId = `wgsl:${fnv1a64Hex(code)}:${code.length}`;
    moduleIdByModule.set(module, stableId);
    return module;
  };

  const getOrCreateRenderPipeline = (descriptor: GPURenderPipelineDescriptor): GPURenderPipeline => {
    pipeTotal++;

    const layout = (descriptor.layout ?? 'auto') as GPUPipelineLayout | 'auto';
    const layoutKey = layout === 'auto' ? 'auto' : getOrAssignLayoutId(layout);

    const vertex = descriptor.vertex;
    const fragment = descriptor.fragment;

    const parts: string[] = [];
    // Version prefix allows evolving the key format without ambiguity.
    pushTag(parts, 'rp1');

    pushTag(parts, 'L');
    pushStr(parts, layoutKey);

    pushTag(parts, 'V');
    pushStr(parts, getOrAssignModuleId(vertex.module));
    pushStr(parts, vertex.entryPoint ?? '');
    pushConstants(parts, vertex.constants);
    pushVertexBuffers(parts, vertex.buffers as unknown as readonly (GPUVertexBufferLayout | null | undefined)[]);

    pushTag(parts, 'F');
    if (!fragment) {
      pushTag(parts, 'F0');
    } else {
      pushTag(parts, 'F1');
      pushStr(parts, getOrAssignModuleId(fragment.module));
      pushStr(parts, fragment.entryPoint ?? '');
      pushConstants(parts, fragment.constants);
      pushTargets(parts, fragment.targets as unknown as readonly (GPUColorTargetState | null | undefined)[]);
    }

    pushTag(parts, 'P');
    pushPrimitive(parts, descriptor.primitive);

    pushDepthStencil(parts, descriptor.depthStencil);

    pushTag(parts, 'M');
    pushMultisample(parts, descriptor.multisample);

    const cacheKey = parts.join('');
    const cached = renderPipelineByKey.get(cacheKey);
    if (cached) {
      pipeHits++;
      return cached;
    }

    pipeMisses++;
    const pipeline = device.createRenderPipeline(descriptor);
    renderPipelineByKey.set(cacheKey, pipeline);
    return pipeline;
  };

  const getStats = (): PipelineCacheStats => ({
    shaderModules: {
      total: shaderTotal,
      hits: shaderHits,
      misses: shaderMisses,
      entries: shaderModuleByWgsl.size,
    },
    renderPipelines: {
      total: pipeTotal,
      hits: pipeHits,
      misses: pipeMisses,
      entries: renderPipelineByKey.size,
    },
  });

  return {
    device,
    getStats,
    clear,
    getOrCreateShaderModule,
    getOrCreateRenderPipeline,
  };
}
