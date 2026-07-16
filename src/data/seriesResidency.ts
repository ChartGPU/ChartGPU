/**
 * Series residency + upload policy (issue 3.4).
 *
 * Thin shared vocabulary for how series data lives on CPU staging / GPU and
 * which upload action the next prepare should take. Line (DataStore + optional
 * decimation), scatter (private instance + identity skip), and candlestick
 * (domain instances + identity skip) converge on this layer without rewriting
 * shaders or the coordinator options tree.
 *
 * @module seriesResidency
 * @internal
 */

/** Where the authoritative packed floats live for a series. */
export type SeriesResidencyKind =
  | 'dataStore' // interleaved vec2f in DataStore (line / density raw)
  | 'privateInstance' // scatter / candle / bar private instance buffer
  | 'privateStorage' // area private storage when not sharing line
  | 'sharedStorage'; // area bound to line / decimation output

/**
 * Next upload action for a series prepare. Callers map renderer-specific
 * cache hits onto these verbs so policy can be logged/tested uniformly.
 */
export type UploadPolicy =
  | 'skip' // geometry identity hit — uniforms only
  | 'rangedAppend' // O(k) writeBuffer of new points
  | 'fullRewrite' // pack + full writeBuffer of N
  | 'growWithGpuCopy' // capacity growth: copyBufferToBuffer retained + ranged new
  | 'yOnlyRewrite'; // equal-N x-stable: pack/write y channel only (scatter dual-buffer)

export type SeriesResidency = {
  readonly kind: SeriesResidencyKind;
  /** GPU buffer currently bound for draw/compute (when known). */
  readonly gpuBuffer: GPUBuffer | null;
  /** Logical point / instance count. */
  readonly pointCount: number;
  /** DataStore FNV stamp or renderer-local content version. */
  readonly contentVersion: number;
  /** Last consumer data ref used for identity skip (may be null). */
  readonly lastRef: unknown | null;
};

/**
 * Decide upload policy from residency + frame inputs.
 * Pure helper — renderers may inline equivalent logic; this is the shared
 * contract for tests and future convergence.
 */
export function resolveUploadPolicy(input: {
  readonly residency: SeriesResidency;
  readonly dataRef: unknown | null;
  readonly geometryCacheHit: boolean;
  readonly appendedThisFrame: boolean;
  readonly needsGrowth: boolean;
  /** Equal-N x-stable y rewrite (scatter dual-buffer / partial GPU). */
  readonly yOnlyRewrite?: boolean;
}): UploadPolicy {
  if (input.appendedThisFrame) return 'rangedAppend';
  if (input.needsGrowth) return 'growWithGpuCopy';
  if (input.geometryCacheHit && input.residency.lastRef === input.dataRef) {
    return 'skip';
  }
  if (input.yOnlyRewrite) return 'yOnlyRewrite';
  return 'fullRewrite';
}
