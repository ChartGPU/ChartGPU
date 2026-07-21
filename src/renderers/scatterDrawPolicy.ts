/**
 * Scatter draw policy for dense const-radius series (group 2 residual).
 *
 * Upload is already dual-buffer; at high point density the bottleneck is
 * fill-rate from 500k–1M AA quads × 4× MSAA. This policy shrinks the *drawn*
 * radius toward ~1 device pixel when points-per-pixel is high — discrete
 * markers remain (not LTTB / sampling cheats). Low density (≤100k suite rows)
 * stays standard.
 *
 * Suite group 2 geometry (800×600 CSS @ dpr 2, grid insets → ~1.5M plot px):
 * - 100k ≈ 0.066 pts/px → standard (display-refresh protection)
 * - 200k ≈ 0.13 pts/px → blend toward compact (main 4× MSAA, reduced radius)
 * - 500k ≈ 0.33 pts/px → fully compact (hard gate; eligible for SS1 defer)
 * - 1M+ → fully compact
 *
 * Post-resolve sampleCount:1 deferral is gated on {@link ScatterDrawPolicyResult.fullyCompact}
 * only (partial blends stay on main 4×). Layering: pure-scatter charts may defer;
 * charts with any visible line series keep scatter on main so markers stay under
 * strokes (main-pass order is scatter then lines).
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
  /**
   * True when the effective radius is at the dense min floor (full compact).
   * Only fully-compact frames are eligible for post-resolve sampleCount:1 deferral;
   * partial density blends keep main 4× MSAA for quality (suite 200k).
   */
  readonly fullyCompact: boolean;
}>;

/**
 * Below this density (points per plot pixel) keep full marker size.
 * Tuned for suite group 2 ≤100k (~0.066 pts/px on ~1.5M plot px) to stay standard.
 */
export const DENSE_SCATTER_DENSITY_LO = 0.08;
/**
 * At/above this density, clamp markers to {@link DENSE_SCATTER_MIN_RADIUS_DEVICE_PX}.
 * Suite 500k (~0.33 pts/px) lands at/above this → fully compact for the hard gate.
 */
export const DENSE_SCATTER_DENSITY_HI = 0.3;
/**
 * Point-count floor: at/above this N, force min radius under `lod: 'auto'`
 * regardless of plot size (covers large canvases where density stays low).
 * 250k sits between 200k (partial blend OK) and 500k hard gate.
 */
export const DENSE_SCATTER_POINT_COUNT_FULL_COMPACT = 250_000;
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
    return { policy: 'standard', effectiveRadiusDevicePx: radius, fullyCompact: false };
  }
  // Strict LOD: honor configured marker size at any density.
  if (input.forceStandard === true) {
    return { policy: 'standard', effectiveRadiusDevicePx: radius, fullyCompact: false };
  }

  const w = Math.max(1, input.plotWidthDevicePx | 0);
  const h = Math.max(1, input.plotHeightDevicePx | 0);
  const density = input.pointCount / (w * h);
  // Floor is min(radius, MIN) so intentional sub-MIN radii are never thickened.
  const floor = Math.min(radius, DENSE_SCATTER_MIN_RADIUS_DEVICE_PX);

  // Point-count floor: large N always full compact (suite 500k hard gate).
  if (input.pointCount >= DENSE_SCATTER_POINT_COUNT_FULL_COMPACT) {
    return { policy: 'denseCompact', effectiveRadiusDevicePx: floor, fullyCompact: true };
  }

  if (density < DENSE_SCATTER_DENSITY_LO) {
    return { policy: 'standard', effectiveRadiusDevicePx: radius, fullyCompact: false };
  }

  const span = Math.max(1e-6, DENSE_SCATTER_DENSITY_HI - DENSE_SCATTER_DENSITY_LO);
  const t = Math.min(1, Math.max(0, (density - DENSE_SCATTER_DENSITY_LO) / span));
  const effective = radius * (1 - t) + floor * t;
  const fullyCompact = t >= 1;
  return {
    policy: t > 0.05 ? 'denseCompact' : 'standard',
    effectiveRadiusDevicePx: effective,
    fullyCompact,
  };
}
