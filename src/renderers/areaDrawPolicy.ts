/**
 * Area / mountain fill draw policy for multi-M dense paths (suite group 8).
 *
 * Under `performance.lod: 'auto'`, caps drawn fill trapezoids toward a plot-pixel
 * budget via {@link resolveDenseDrawStride}. Residency stays full raw when
 * `sampling: 'none'`; this is draw-only LOD (not harness sampling cheat).
 *
 * @module areaDrawPolicy
 * @internal
 */

import {
  resolveDenseDrawStride,
  DENSE_DRAW_POINT_THRESHOLD,
  DENSE_DRAW_MIN_TARGET_SEGMENTS,
  DENSE_DRAW_WIDTH_OVERSAMPLE,
  type DenseDrawStrideResult,
} from './denseDrawLod';

export type AreaDrawPolicy = 'standard' | 'denseLod';

export type AreaDrawPolicyInput = Readonly<{
  readonly pointCount: number;
  /** Plot width in device pixels (scissor / grid). */
  readonly plotWidthDevicePx?: number;
  /**
   * When true (`performance.lod: 'strict'`), always full N−1 segment draw.
   */
  readonly forceStandard?: boolean;
}>;

export type AreaDrawPolicyResult = Readonly<{
  readonly policy: AreaDrawPolicy;
  readonly stride: number;
  readonly drawSegmentCount: number;
  readonly lastPointIndex: number;
}>;

export {
  DENSE_DRAW_POINT_THRESHOLD as DENSE_AREA_POINT_THRESHOLD,
  DENSE_DRAW_MIN_TARGET_SEGMENTS as DENSE_AREA_MIN_TARGET_SEGMENTS,
  DENSE_DRAW_WIDTH_OVERSAMPLE as DENSE_AREA_WIDTH_OVERSAMPLE,
};

/**
 * Resolve mountain/area fill draw policy for the current prepare.
 */
export function resolveAreaDrawPolicy(input: AreaDrawPolicyInput): AreaDrawPolicyResult {
  const r: DenseDrawStrideResult = resolveDenseDrawStride({
    pointCount: input.pointCount,
    plotWidthDevicePx: input.plotWidthDevicePx,
    forceStandard: input.forceStandard,
  });
  return {
    policy: r.dense ? 'denseLod' : 'standard',
    stride: r.stride,
    drawSegmentCount: r.drawSegmentCount,
    lastPointIndex: r.lastPointIndex,
  };
}
