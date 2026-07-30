/**
 * Pure helpers for axis label rebuild / position-only update policy (WS4).
 *
 * @module axisLabelUpdatePolicy
 * @internal
 */

/** Throttle for non-tick structural thrash (theme layout churn). Tick-set changes are immediate. */
const AXIS_LABEL_STRUCTURAL_THROTTLE_MS = 50;

type AxisLabelUpdateDecisionInput = {
  readonly lastFullSignature: string;
  readonly lastContentSignature: string;
  readonly nextFullSignature: string;
  readonly nextContentSignature: string;
  readonly nowMs: number;
  readonly lastUpdateMs: number;
  /** Previous content tick-hash segment (`th:…`) for tick-set detection; empty when unknown. */
  readonly lastTickHashSegment?: string;
  readonly nextTickHashSegment?: string;
};

type AxisLabelUpdateDecision = {
  readonly shouldUpdate: boolean;
  readonly positionOnly: boolean;
  readonly contentChanged: boolean;
  readonly epochChanged: boolean;
  readonly tickSetChanged: boolean;
  readonly reason:
    | 'first'
    | 'position-only'
    | 'epoch'
    | 'tick-set'
    | 'structural-throttle'
    | 'skip-throttle'
    | 'unchanged';
};

function extractEpochSegment(sig: string): string {
  const idx = sig.indexOf('epoch:');
  if (idx < 0) return '';
  return sig.slice(idx, idx + 24);
}

function extractTickHashSegment(sig: string): string {
  const idx = sig.indexOf('th:');
  if (idx < 0) return '';
  const end = sig.indexOf('|', idx);
  return end < 0 ? sig.slice(idx) : sig.slice(idx, end + 1);
}

/**
 * Decide whether to rebuild axis labels this paint.
 *
 * - **Position-only** (content same, affine/full changed): every paint.
 * - **Tick set / epoch change**: immediate (no throttle) so labels stay in sync with GPU ticks/grid.
 * - **Other structural** (theme/layout thrash without tick change): may throttle ~50 ms.
 */
export function shouldUpdateAxisLabels(input: AxisLabelUpdateDecisionInput): AxisLabelUpdateDecision {
  if (input.nextFullSignature === input.lastFullSignature && input.lastFullSignature !== '') {
    return {
      shouldUpdate: false,
      positionOnly: false,
      contentChanged: false,
      epochChanged: false,
      tickSetChanged: false,
      reason: 'unchanged',
    };
  }

  if (input.lastFullSignature === '') {
    return {
      shouldUpdate: true,
      positionOnly: false,
      contentChanged: true,
      epochChanged: true,
      tickSetChanged: true,
      reason: 'first',
    };
  }

  const contentChanged = input.nextContentSignature !== input.lastContentSignature;
  const epochChanged =
    extractEpochSegment(input.lastContentSignature) !== extractEpochSegment(input.nextContentSignature);

  const lastTh = input.lastTickHashSegment ?? extractTickHashSegment(input.lastContentSignature);
  const nextTh = input.nextTickHashSegment ?? extractTickHashSegment(input.nextContentSignature);
  const tickSetChanged = lastTh !== nextTh && nextTh !== '';

  const positionOnly = !contentChanged;

  if (positionOnly) {
    return {
      shouldUpdate: true,
      positionOnly: true,
      contentChanged: false,
      epochChanged: false,
      tickSetChanged: false,
      reason: 'position-only',
    };
  }

  if (epochChanged) {
    return {
      shouldUpdate: true,
      positionOnly: false,
      contentChanged: true,
      epochChanged: true,
      tickSetChanged,
      reason: 'epoch',
    };
  }

  // Tick set / hash change: never throttle (labels must match GPU/grid same frame).
  if (tickSetChanged) {
    return {
      shouldUpdate: true,
      positionOnly: false,
      contentChanged: true,
      epochChanged: false,
      tickSetChanged: true,
      reason: 'tick-set',
    };
  }

  // Other structural content (names, types, layout chrome without tick hash): throttle.
  const elapsed = input.nowMs - input.lastUpdateMs;
  if (elapsed >= AXIS_LABEL_STRUCTURAL_THROTTLE_MS) {
    return {
      shouldUpdate: true,
      positionOnly: false,
      contentChanged: true,
      epochChanged: false,
      tickSetChanged: false,
      reason: 'structural-throttle',
    };
  }

  return {
    shouldUpdate: false,
    positionOnly: false,
    contentChanged: true,
    epochChanged: false,
    tickSetChanged: false,
    reason: 'skip-throttle',
  };
}
