/**
 * Animation helper utilities for intro and update animations.
 *
 * Provides pure functions for animation config resolution, easing transformations,
 * series interpolation, and animation state management. These utilities support
 * both intro animations (initial reveal) and update animations (smooth transitions).
 *
 * @module animationHelpers
 */

import type { AnimationConfig, DataPoint } from '../../../config/types';
import type { ResolvedPieSeriesConfig } from '../../../config/OptionResolver';
import type { EasingFunction } from '../../../utils/easing';
import { isTupleDataPoint } from '../utils/dataPointUtils';
import { getPointCount, getX, getY } from '../../../data/cartesianData';
import type { CartesianSeriesData } from '../../../config/types';

/**
 * Intro animation phase state machine.
 */
type IntroPhase = 'pending' | 'running' | 'done';

/**
 * Domain boundaries with min and max values.
 */
interface DomainBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Resolved animation configuration with timing and easing.
 */
interface ResolvedAnimationConfig {
  readonly delayMs: number;
  readonly durationMs: number;
  readonly easing: EasingFunction;
}

/**
 * Series configuration type that supports all series types.
 */
export type AnySeriesConfig =
  | { readonly type: 'line'; readonly data: ReadonlyArray<DataPoint> }
  | { readonly type: 'area'; readonly data: ReadonlyArray<DataPoint> }
  | { readonly type: 'bar'; readonly data: ReadonlyArray<DataPoint> }
  | { readonly type: 'scatter'; readonly data: ReadonlyArray<DataPoint> }
  | { readonly type: 'candlestick'; readonly data: ReadonlyArray<any> }
  | {
      readonly type: 'heatmap';
      readonly data: {
        readonly columns?: number;
        readonly rows?: number;
        readonly z?: { readonly length?: number };
      };
    }
  | ResolvedPieSeriesConfig;

/**
 * Clamps a value between 0 and 1.
 *
 * @param value - Value to clamp
 * @returns Clamped value in [0, 1]
 */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Resolves animation configuration from options.
 *
 * Returns null if animation is disabled (false or null).
 * Returns default config if animation is true or an empty object.
 * Converts duration/delay from user config to milliseconds.
 *
 * @param animation - Animation options from chart config
 * @param getEasingFn - Function to resolve easing by name (to avoid circular deps)
 * @returns Resolved animation config or null if disabled
 */
export function resolveAnimationConfig(
  animation: boolean | AnimationConfig | null | undefined,
  getEasingFn: (name: string) => EasingFunction
): ResolvedAnimationConfig | null {
  if (animation === false || animation == null) return null;

  const cfg: AnimationConfig | null = animation === true ? {} : animation;
  if (!cfg) return null;

  // Extract duration and delay with defaults
  const durationMsRaw = cfg.duration ?? 300;
  const delayMsRaw = cfg.delay ?? 0;

  const durationMs = Number.isFinite(durationMsRaw) ? Math.max(0, durationMsRaw) : 300;
  const delayMs = Number.isFinite(delayMsRaw) ? Math.max(0, delayMsRaw) : 0;

  // Resolve easing (string name or function)
  const easingConfig = cfg.easing ?? 'cubicOut';
  const easing = typeof easingConfig === 'string' ? getEasingFn(easingConfig) : easingConfig;

  return {
    durationMs,
    delayMs,
    easing,
  };
}

/**
 * Creates an easing function that incorporates delay.
 *
 * The returned function maps t ∈ [0, 1] to an output considering both delay
 * and duration:
 * - t in [0, delay]: output = 0 (delay phase)
 * - t in [delay, delay+duration]: output = easing((t-delay)/duration)
 * - t > delay+duration: output = 1 (complete)
 *
 * @param delayMs - Delay before animation starts (milliseconds)
 * @param durationMs - Animation duration after delay (milliseconds)
 * @param easing - Base easing function to apply after delay
 * @returns Easing function with delay incorporated
 */
export function createEasingWithDelay(delayMs: number, durationMs: number, easing: EasingFunction): EasingFunction {
  return (t01: number): number => {
    const t = clamp01(t01);
    const totalMs = delayMs + durationMs;

    if (!(totalMs > 0)) return 1;

    const elapsedMs = t * totalMs;
    if (elapsedMs < delayMs) return 0;

    if (!(durationMs > 0)) return 1;
    const innerT = (elapsedMs - delayMs) / durationMs;
    return easing(innerT);
  };
}

/**
 * Checks if a series configuration has drawable marks.
 *
 * Returns true if the series has data that will produce visible marks:
 * - Pie: at least one slice with value > 0
 * - Cartesian (line/area/bar/scatter/candlestick): at least one data point
 *
 * @param series - Series configuration to check
 * @returns True if series has drawable content
 */
function hasDrawableMarks(series: AnySeriesConfig): boolean {
  switch (series.type) {
    case 'pie': {
      return series.data.some((it: any) => typeof it?.value === 'number' && Number.isFinite(it.value) && it.value > 0);
    }
    case 'heatmap': {
      const d = series.data as { columns?: number; rows?: number; z?: { length?: number } };
      const cols = Math.floor(Number(d?.columns));
      const rows = Math.floor(Number(d?.rows));
      const zLen = d?.z && typeof d.z.length === 'number' ? d.z.length : 0;
      return cols >= 1 && rows >= 1 && zLen > 0;
    }
    case 'line':
    case 'area':
    case 'bar':
    case 'scatter': {
      return getPointCount(series.data as CartesianSeriesData) > 0;
    }
    case 'candlestick': {
      return Array.isArray(series.data)
        ? series.data.length > 0
        : getPointCount(series.data as CartesianSeriesData) > 0;
    }
    default: {
      return false;
    }
  }
}

/**
 * Checks if any series in the list has drawable marks.
 *
 * @param seriesList - Array of series configurations
 * @returns True if at least one series has drawable marks
 */
export function hasAnyDrawableMarks(seriesList: ReadonlyArray<AnySeriesConfig>): boolean {
  for (let i = 0; i < seriesList.length; i++) {
    if (hasDrawableMarks(seriesList[i]!)) {
      return true;
    }
  }
  return false;
}

/**
 * Linearly interpolates between two domain bounds.
 *
 * @param from - Starting domain
 * @param to - Ending domain
 * @param t - Interpolation progress [0, 1]
 * @returns Interpolated domain
 */
export function lerpDomain(from: DomainBounds, to: DomainBounds, t: number): DomainBounds {
  const t01 = clamp01(t);
  return {
    min: from.min + (to.min - from.min) * t01,
    max: from.max + (to.max - from.max) * t01,
  };
}

/**
 * Interpolates domain bounds in **log space** (for log axes).
 *
 * When any endpoint is non-positive or non-finite, falls back to linear
 * {@link lerpDomain} so callers can still sanitize afterward.
 *
 * @param from - Starting domain (data space)
 * @param to - Ending domain (data space)
 * @param t - Interpolation progress [0, 1]
 * @returns Interpolated domain in data space
 */
export function lerpLogDomain(from: DomainBounds, to: DomainBounds, t: number): DomainBounds {
  const t01 = clamp01(t);
  if (t01 === 0) return { min: from.min, max: from.max };
  if (t01 === 1) return { min: to.min, max: to.max };
  if (
    !(from.min > 0) ||
    !(from.max > 0) ||
    !(to.min > 0) ||
    !(to.max > 0) ||
    !Number.isFinite(from.min) ||
    !Number.isFinite(from.max) ||
    !Number.isFinite(to.min) ||
    !Number.isFinite(to.max)
  ) {
    return lerpDomain(from, to, t01);
  }
  // Natural log is fine — base is an affine transform in log space.
  return {
    min: Math.exp(Math.log(from.min) + (Math.log(to.min) - Math.log(from.min)) * t01),
    max: Math.exp(Math.log(from.max) + (Math.log(to.max) - Math.log(from.max)) * t01),
  };
}

/**
 * Linearly interpolates between two numbers.
 *
 * @param from - Starting value
 * @param to - Ending value
 * @param t - Interpolation progress [0, 1]
 * @returns Interpolated value
 */
function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t);
}

/**
 * Interpolates cartesian series data between from and to states.
 *
 * Returns null if array lengths don't match (can't interpolate mismatched arrays).
 * Reuses cache array if provided and same length.
 *
 * @param fromData - Starting data points
 * @param toData - Ending data points
 * @param t - Interpolation progress [0, 1]
 * @param cache - Optional cache array to reuse
 * @returns Interpolated data points or null if lengths mismatch
 */
export function interpolateCartesianData(
  fromData: CartesianSeriesData | ReadonlyArray<DataPoint>,
  toData: CartesianSeriesData | ReadonlyArray<DataPoint>,
  t: number,
  cache: DataPoint[] | null
): DataPoint[] | null {
  const n = getPointCount(toData as CartesianSeriesData);
  if (getPointCount(fromData as CartesianSeriesData) !== n) return null;
  if (n === 0) return cache ?? [];

  const out =
    cache && cache.length === n
      ? cache
      : (() => {
          const created: DataPoint[] = new Array(n);
          for (let i = 0; i < n; i++) {
            created[i] = [getX(toData as CartesianSeriesData, i), 0] as DataPoint;
          }
          return created;
        })();

  const t01 = clamp01(t);
  for (let i = 0; i < n; i++) {
    const xFrom = getX(fromData as CartesianSeriesData, i);
    const xTo = getX(toData as CartesianSeriesData, i);
    const yFrom = getY(fromData as CartesianSeriesData, i);
    const yTo = getY(toData as CartesianSeriesData, i);
    const x = Number.isFinite(xFrom) && Number.isFinite(xTo) ? lerp(xFrom, xTo, t01) : xTo;
    const y = Number.isFinite(yFrom) && Number.isFinite(yTo) ? lerp(yFrom, yTo, t01) : yTo;
    const p = out[i]!;
    if (isTupleDataPoint(p)) {
      (p as unknown as number[])[0] = x;
      (p as unknown as number[])[1] = y;
    } else {
      (p as { x: number; y: number }).x = x;
      (p as { y: number }).y = y;
    }
  }
  return out;
}

/**
 * Interpolates pie series data between from and to states.
 *
 * Returns the toSeries unchanged if data array lengths don't match.
 * Only interpolates the value property; angles are recomputed by the renderer.
 *
 * @param fromSeries - Starting pie series
 * @param toSeries - Ending pie series
 * @param t - Interpolation progress [0, 1]
 * @param cache - Optional cache array to reuse
 * @returns Interpolated pie series
 */
export function interpolatePieData(
  fromSeries: ResolvedPieSeriesConfig,
  toSeries: ResolvedPieSeriesConfig,
  t: number,
  cache: ResolvedPieSeriesConfig['data'] | null
): ResolvedPieSeriesConfig {
  const fromData = fromSeries.data;
  const toData = toSeries.data;

  if (fromData.length !== toData.length) return toSeries;

  const n = toData.length;
  if (n === 0) return toSeries;

  // Create or reuse cache array
  const out =
    cache && cache.length === n
      ? cache
      : (() => {
          const created: any[] = new Array(n);
          for (let i = 0; i < n; i++) {
            // Preserve name/color from "to"; patch value per frame
            created[i] = { ...toData[i]!, value: 0 };
          }
          return created as ResolvedPieSeriesConfig['data'];
        })();

  const t01 = clamp01(t);

  for (let i = 0; i < n; i++) {
    const vFrom = (fromData[i] as any)?.value;
    const vTo = (toData[i] as any)?.value;

    // Interpolate value if both are valid numbers
    const nextValue =
      typeof vFrom === 'number' && typeof vTo === 'number' && Number.isFinite(vFrom) && Number.isFinite(vTo)
        ? Math.max(0, lerp(vFrom, vTo, t01))
        : typeof vTo === 'number' && Number.isFinite(vTo)
          ? vTo
          : 0;

    (out[i] as any).value = nextValue;
  }

  return { ...toSeries, data: out };
}

/**
 * Checks if two domain bounds are equal.
 *
 * @param a - First domain
 * @param b - Second domain
 * @returns True if domains have identical min and max
 */
export function isDomainEqual(a: DomainBounds, b: DomainBounds): boolean {
  return a.min === b.min && a.max === b.max;
}

/**
 * Determines the next intro phase based on current state and conditions.
 *
 * State machine transitions:
 * - pending → running: when has drawable marks and animation enabled
 * - running → done: when animation completes
 * - done → pending: when retriggering (e.g., visibility change)
 *
 * @param currentPhase - Current intro phase
 * @param hasDrawable - Whether series have drawable marks
 * @param animationEnabled - Whether animation is enabled
 * @param retrigger - Whether to retrigger from done state
 * @returns Next intro phase
 */
export function computeNextIntroPhase(
  currentPhase: IntroPhase,
  hasDrawable: boolean,
  animationEnabled: boolean,
  retrigger: boolean = false
): IntroPhase {
  if (retrigger && currentPhase === 'done') {
    return 'pending';
  }

  if (currentPhase === 'pending' && hasDrawable && animationEnabled) {
    return 'running';
  }

  return currentPhase;
}

/**
 * Applies intro animation progress to create an animated bar Y scale.
 *
 * During intro, bars grow from the zero line (or domain min if no zero).
 * This creates a scale that compresses bars based on progress.
 *
 * @param baseYScale - Original Y scale
 * @param yMin - Domain minimum
 * @param yMax - Domain maximum
 * @param progress - Animation progress [0, 1]
 * @returns Y coordinate adjusted for intro animation
 */
export function applyBarIntroProgress(baseY: number, yMin: number, yMax: number, progress: number): number {
  const p = clamp01(progress);

  // Find zero line or use domain min as anchor
  const zeroLine = yMin <= 0 && yMax >= 0 ? 0 : yMin;

  // Interpolate from zero line to actual value
  return lerp(zeroLine, baseY, p);
}
