/**
 * Line draw policy for dense high-N paths (group 3 residual; also any line at N≥threshold).
 *
 * At high segment counts, fill from thick AA quads dominates. This policy slightly
 * reduces effective CSS line width for **draw only** when N is extreme — does not
 * change sampling, packing, or data residency. Applies to all line series above
 * {@link DENSE_LINE_POINT_THRESHOLD} (including FIFO 1M thin strokes), not only
 * group-3 unsorted rewrites.
 *
 * @module lineDrawPolicy
 * @internal
 */

export type LineDrawPolicy = 'standard' | 'denseThin';

export type LineDrawPolicyInput = Readonly<{
  readonly pointCount: number;
  readonly lineWidthCssPx: number;
}>;

export type LineDrawPolicyResult = Readonly<{
  readonly policy: LineDrawPolicy;
  readonly effectiveLineWidthCssPx: number;
}>;

/** Enter denseThin above this segment-adjacent point count. */
export const DENSE_LINE_POINT_THRESHOLD = 200_000;
/** Floor width under denseThin (CSS px). */
export const DENSE_LINE_MIN_WIDTH_CSS = 1;

/**
 * Resolve draw-only line width policy for high-N full rewrites.
 */
export function resolveLineDrawPolicy(input: LineDrawPolicyInput): LineDrawPolicyResult {
  const w =
    Number.isFinite(input.lineWidthCssPx) && input.lineWidthCssPx > 0 ? input.lineWidthCssPx : 2;
  if (input.pointCount < DENSE_LINE_POINT_THRESHOLD) {
    return { policy: 'standard', effectiveLineWidthCssPx: w };
  }
  // Soft blend from threshold → 1M toward min width (group 3 @ 1M fully thinned).
  // Floor is min(w, MIN) so intentional hairlines (w < MIN) are never thickened.
  const t = Math.min(1, (input.pointCount - DENSE_LINE_POINT_THRESHOLD) / 800_000);
  const floor = Math.min(w, DENSE_LINE_MIN_WIDTH_CSS);
  const effective = w * (1 - t) + floor * t;
  return {
    policy: t > 0.05 ? 'denseThin' : 'standard',
    effectiveLineWidthCssPx: effective,
  };
}
