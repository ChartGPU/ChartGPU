/**
 * Scatter draw policy for dense const-radius series (group 2 residual).
 *
 * Upload is already dual-buffer; at high point density the bottleneck is
 * fill-rate from 1M AA quads. This policy shrinks the *drawn* radius toward
 * ~1 device pixel when points-per-pixel is high — discrete markers remain
 * (not LTTB / sampling cheats). Low density (≤100k suite rows) stays standard.
 *
 * @module scatterDrawPolicy
 * @internal
 */

export type ScatterDrawPolicy = 'standard' | 'denseCompact';

export type ScatterDrawPolicyInput = Readonly<{
  /** Const-radius path only — variable radius always standard. */
  readonly constRadius: boolean;
  readonly pointCount: number;
  /** Plot area in device pixels (scissor / grid). */
  readonly plotWidthDevicePx: number;
  readonly plotHeightDevicePx: number;
  /** Nominal const radius in device pixels (symbolSize × dpr). */
  readonly radiusDevicePx: number;
  /**
   * When true (`performance.lod: 'strict'`), keep configured marker radius —
   * never compact toward 1 device px.
   */
  readonly forceStandard?: boolean;
}>;

export type ScatterDrawPolicyResult = Readonly<{
  readonly policy: ScatterDrawPolicy;
  /** Radius used for VS expansion this frame. */
  readonly effectiveRadiusDevicePx: number;
}>;

/** Below this density (points per plot pixel) keep full marker size. */
export const DENSE_SCATTER_DENSITY_LO = 0.5;
/**
 * At/above this density, clamp markers to {@link DENSE_SCATTER_MIN_RADIUS_DEVICE_PX}.
 * Tuned so suite group 2 @ 1M (~3 pts/px on typical plot) is fully compact
 * while ≤100k (~0.3 pts/px) stays standard.
 */
export const DENSE_SCATTER_DENSITY_HI = 3.0;
/** Minimum drawn radius in device pixels under denseCompact. */
export const DENSE_SCATTER_MIN_RADIUS_DEVICE_PX = 1.0;

/**
 * Resolve draw policy + effective radius for a const-radius scatter prepare.
 *
 * Does **not** change uploaded instance data or sampling — draw-only LOD.
 */
export function resolveScatterDrawPolicy(input: ScatterDrawPolicyInput): ScatterDrawPolicyResult {
  const radius = Number.isFinite(input.radiusDevicePx) && input.radiusDevicePx > 0 ? input.radiusDevicePx : 0;
  if (!input.constRadius || input.pointCount <= 0 || radius <= 0) {
    return { policy: 'standard', effectiveRadiusDevicePx: radius };
  }
  // Strict LOD: honor configured marker size at any density.
  if (input.forceStandard === true) {
    return { policy: 'standard', effectiveRadiusDevicePx: radius };
  }

  const w = Math.max(1, input.plotWidthDevicePx | 0);
  const h = Math.max(1, input.plotHeightDevicePx | 0);
  const density = input.pointCount / (w * h);

  if (density < DENSE_SCATTER_DENSITY_LO) {
    return { policy: 'standard', effectiveRadiusDevicePx: radius };
  }

  const span = Math.max(1e-6, DENSE_SCATTER_DENSITY_HI - DENSE_SCATTER_DENSITY_LO);
  const t = Math.min(1, Math.max(0, (density - DENSE_SCATTER_DENSITY_LO) / span));
  // Floor is min(radius, MIN) so intentional sub-MIN radii are never thickened.
  const floor = Math.min(radius, DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);
  const effective = radius * (1 - t) + floor * t;
  return {
    policy: t > 0.05 ? 'denseCompact' : 'standard',
    effectiveRadiusDevicePx: effective,
  };
}
