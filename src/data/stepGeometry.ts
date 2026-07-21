/**
 * Pure step (digital) connection geometry for line / area mountain.
 *
 * Expands source samples into an owned polyline of stair corners.
 * Never mutates caller-owned arrays. Hit-test/tooltip use source samples;
 * only GPU prepare consumes the expanded polyline.
 *
 * @module stepGeometry
 * @internal
 */

import type { CartesianSeriesData, StepMode } from '../config/types';
import { getPointCount, getX, getY, type CoordinatorCartesianData } from './cartesianData';

/** Re-export public StepMode so internal modules import from one place. */
export type { StepMode };

/** Owned expanded polyline as XY columns (CartesianSeriesData shape). */
export type StepPolyline = Readonly<{
  readonly x: Float64Array;
  readonly y: Float64Array;
}>;

/** Owned stacked step expand (shared x, stepped yBottom/yTop). */
export type StepStackedPolyline = Readonly<{
  readonly x: Float64Array;
  readonly yBottom: Float64Array;
  readonly yTop: Float64Array;
}>;

const STEP_MODES = new Set<string>(['before', 'middle', 'after']);

/**
 * Normalize public `step` option to a mode, or null for linear geometry.
 * Invalid strings return null (caller may warn).
 */
export function resolveStepMode(step: boolean | StepMode | string | undefined | null): StepMode | null {
  if (step === true) return 'after';
  if (step === false || step == null) return null;
  if (typeof step === 'string' && STEP_MODES.has(step)) {
    return step as StepMode;
  }
  return null;
}

/** True when a string was provided but is not a valid StepMode. */
export function isInvalidStepValue(step: unknown): boolean {
  if (step == null || step === true || step === false) return false;
  if (typeof step === 'string') return !STEP_MODES.has(step);
  // Non-boolean, non-string truthy values are invalid
  return typeof step !== 'boolean';
}

function isFiniteSample(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y);
}

/**
 * Count output vertices for a gap-free run of `n` finite samples under `mode`.
 * n<=0 → 0; n===1 → 1; else after/before: 2n-1, middle: 3n-2.
 */
export function stepExpandedCount(sampleCount: number, mode: StepMode): number {
  const n = Math.max(0, sampleCount | 0);
  if (n <= 1) return n;
  if (mode === 'middle') return 3 * n - 2;
  return 2 * n - 1;
}

/**
 * Expand consecutive finite samples into a stair polyline.
 *
 * - Non-finite x/y break the path (new run) unless `connectNulls` is true
 *   (gaps are stripped first by the caller when connectNulls — this function
 *   still treats non-finite as breaks if they remain).
 * - Never mutates input. Returns owned Float64Array columns.
 * - Single isolated finite sample → one-point polyline (no stroke segments).
 */
export function expandStepPolyline(
  data: CoordinatorCartesianData,
  mode: StepMode,
  options?: Readonly<{ readonly connectNulls?: boolean }>
): StepPolyline {
  const connectNulls = options?.connectNulls === true;
  const n = getPointCount(data);
  if (n <= 0) {
    return { x: new Float64Array(0), y: new Float64Array(0) };
  }

  // Upper bound: middle mode worst-case 3n-2 if all finite and no gaps.
  const cap = stepExpandedCount(n, mode);
  const outX = new Float64Array(cap);
  const outY = new Float64Array(cap);
  let w = 0;

  let prevX = Number.NaN;
  let prevY = Number.NaN;
  let hasPrev = false;

  const emit = (x: number, y: number): void => {
    outX[w] = x;
    outY[w] = y;
    w++;
  };

  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (!isFiniteSample(x, y)) {
      if (!connectNulls) {
        hasPrev = false;
      }
      continue;
    }

    if (!hasPrev) {
      emit(x, y);
      prevX = x;
      prevY = y;
      hasPrev = true;
      continue;
    }

    // Stair from prev → current
    if (mode === 'after') {
      emit(x, prevY);
      emit(x, y);
    } else if (mode === 'before') {
      emit(prevX, y);
      emit(x, y);
    } else {
      // middle
      const m = (prevX + x) * 0.5;
      emit(m, prevY);
      emit(m, y);
      emit(x, y);
    }
    prevX = x;
    prevY = y;
  }

  if (w === cap) {
    return { x: outX, y: outY };
  }
  return {
    x: outX.subarray(0, w) as Float64Array,
    y: outY.subarray(0, w) as Float64Array,
  };
}

/**
 * Expand stacked mountain yBottom/yTop with the same step x-policy.
 * `data` supplies x (and gap structure); yBottom/yTop are parallel arrays
 * of length getPointCount(data). Non-finite x or either y breaks the run
 * (unless connectNulls — caller should pre-filter).
 */
export function expandStepStacked(
  data: CoordinatorCartesianData,
  yBottom: ArrayLike<number>,
  yTop: ArrayLike<number>,
  mode: StepMode,
  options?: Readonly<{ readonly connectNulls?: boolean }>
): StepStackedPolyline {
  const connectNulls = options?.connectNulls === true;
  const n = getPointCount(data);
  if (n <= 0) {
    return {
      x: new Float64Array(0),
      yBottom: new Float64Array(0),
      yTop: new Float64Array(0),
    };
  }

  const cap = stepExpandedCount(n, mode);
  const outX = new Float64Array(cap);
  const outBot = new Float64Array(cap);
  const outTop = new Float64Array(cap);
  let w = 0;

  let prevX = Number.NaN;
  let prevBot = Number.NaN;
  let prevTop = Number.NaN;
  let hasPrev = false;

  const emit = (x: number, bot: number, top: number): void => {
    outX[w] = x;
    outBot[w] = bot;
    outTop[w] = top;
    w++;
  };

  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    const bot = yBottom[i]!;
    const top = yTop[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(bot) || !Number.isFinite(top)) {
      if (!connectNulls) {
        hasPrev = false;
      }
      continue;
    }

    if (!hasPrev) {
      emit(x, bot, top);
      prevX = x;
      prevBot = bot;
      prevTop = top;
      hasPrev = true;
      continue;
    }

    if (mode === 'after') {
      emit(x, prevBot, prevTop);
      emit(x, bot, top);
    } else if (mode === 'before') {
      emit(prevX, bot, top);
      emit(x, bot, top);
    } else {
      const m = (prevX + x) * 0.5;
      emit(m, prevBot, prevTop);
      emit(m, bot, top);
      emit(x, bot, top);
    }
    prevX = x;
    prevBot = bot;
    prevTop = top;
  }

  if (w === cap) {
    return { x: outX, yBottom: outBot, yTop: outTop };
  }
  return {
    x: outX.subarray(0, w) as Float64Array,
    yBottom: outBot.subarray(0, w) as Float64Array,
    yTop: outTop.subarray(0, w) as Float64Array,
  };
}

/**
 * Expand when step is active; otherwise return null so callers keep linear path.
 */
export function maybeExpandStepPolyline(
  data: CoordinatorCartesianData,
  step: boolean | StepMode | string | undefined | null,
  options?: Readonly<{ readonly connectNulls?: boolean }>
): StepPolyline | null {
  const mode = resolveStepMode(step);
  if (mode == null) return null;
  return expandStepPolyline(data, mode, options);
}

/** XY-columns CartesianSeriesData from a step polyline (view over owned arrays). */
export function stepPolylineAsCartesian(poly: StepPolyline): CartesianSeriesData {
  return { x: poly.x, y: poly.y };
}
