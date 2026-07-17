/**
 * Overlay prepare memoization (P1-6).
 *
 * Grid and axis geometry only change when layout, counts, colors, scale affines,
 * or axis config change. When the memo signature matches the previous frame,
 * `prepareOverlays` skips grid/axis prepare (avoiding vertex rebuild + writeBuffer).
 * Crosshair and highlight always re-prepare (pointer-driven).
 *
 * @module overlayPrepareMemo
 */

import type { AxisConfig } from '../../../config/types';
import type { LinearScale } from '../../../utils/scales';
import type { GridArea } from '../../../renderers/createGridRenderer';

/** Compact layout + grid line inputs that affect grid vertex/color uploads. */
interface GridPrepareSignature {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly devicePixelRatio: number;
  readonly horizontalCount: number;
  readonly verticalCount: number;
  readonly horizontalColor: string;
  readonly verticalColor: string;
  readonly show: boolean;
}

/** Compact axis inputs that affect axis vertex/color uploads. */
interface AxisPrepareSignature {
  readonly orientation: 'x' | 'y';
  readonly axisId: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly devicePixelRatio: number;
  /** Affine sample: scale.scale(0) */
  readonly scaleAt0: number;
  /** Affine sample: scale.scale(1) */
  readonly scaleAt1: number;
  readonly tickCount: number;
  /**
   * Explicit tick domain values (e.g. nice time ticks). Empty when using linear-from-count only.
   * Must be compared element-wise so mark positions stay aligned with DOM labels.
   */
  readonly tickValues: readonly number[];
  readonly tickLength: number | undefined;
  readonly position: string | undefined;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly axisLineColor: string;
  readonly axisTickColor: string;
}

/**
 * Mutable memo held by the coordinator across frames.
 * `prepareOverlays` updates these after a successful prepare (or when skipping).
 */
export interface OverlayPrepareMemo {
  grid: GridPrepareSignature | null;
  xAxis: AxisPrepareSignature | null;
  /** Keyed by y-axis id. */
  yAxes: Map<string, AxisPrepareSignature>;
}

export function createOverlayPrepareMemo(): OverlayPrepareMemo {
  return {
    grid: null,
    xAxis: null,
    yAxes: new Map(),
  };
}

/** Reset memo (e.g. on dispose or hard layout invalidation). */
export function clearOverlayPrepareMemo(memo: OverlayPrepareMemo): void {
  memo.grid = null;
  memo.xAxis = null;
  memo.yAxes.clear();
}

export function buildGridPrepareSignature(input: {
  readonly gridArea: GridArea;
  readonly show: boolean;
  readonly horizontalCount: number;
  readonly verticalCount: number;
  readonly horizontalColor: string;
  readonly verticalColor: string;
}): GridPrepareSignature {
  const { gridArea } = input;
  return {
    left: gridArea.left,
    right: gridArea.right,
    top: gridArea.top,
    bottom: gridArea.bottom,
    canvasWidth: gridArea.canvasWidth,
    canvasHeight: gridArea.canvasHeight,
    devicePixelRatio: gridArea.devicePixelRatio,
    horizontalCount: input.horizontalCount,
    verticalCount: input.verticalCount,
    horizontalColor: input.horizontalColor,
    verticalColor: input.verticalColor,
    show: input.show,
  };
}

export function gridPrepareSignaturesEqual(a: GridPrepareSignature | null, b: GridPrepareSignature): boolean {
  if (a == null) return false;
  return (
    a.left === b.left &&
    a.right === b.right &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.horizontalCount === b.horizontalCount &&
    a.verticalCount === b.verticalCount &&
    a.horizontalColor === b.horizontalColor &&
    a.verticalColor === b.verticalColor &&
    a.show === b.show
  );
}

const tickValuesEqual = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export function buildAxisPrepareSignature(input: {
  readonly axisConfig: AxisConfig;
  readonly scale: LinearScale;
  readonly orientation: 'x' | 'y';
  readonly axisId: string;
  readonly gridArea: GridArea;
  readonly axisLineColor: string;
  readonly axisTickColor: string;
  readonly tickCount: number;
  /** Explicit tick domain values; omit or empty for linear-from-count axes. */
  readonly tickValues?: readonly number[];
}): AxisPrepareSignature {
  const { gridArea, scale, axisConfig } = input;
  const tickValues = input.tickValues != null && input.tickValues.length > 0 ? input.tickValues.slice() : [];
  return {
    orientation: input.orientation,
    axisId: input.axisId,
    left: gridArea.left,
    right: gridArea.right,
    top: gridArea.top,
    bottom: gridArea.bottom,
    canvasWidth: gridArea.canvasWidth,
    canvasHeight: gridArea.canvasHeight,
    devicePixelRatio: gridArea.devicePixelRatio,
    scaleAt0: scale.scale(0),
    scaleAt1: scale.scale(1),
    tickCount: input.tickCount,
    tickValues,
    tickLength: axisConfig.tickLength,
    position: axisConfig.position,
    min: axisConfig.min,
    max: axisConfig.max,
    axisLineColor: input.axisLineColor,
    axisTickColor: input.axisTickColor,
  };
}

export function axisPrepareSignaturesEqual(
  a: AxisPrepareSignature | null | undefined,
  b: AxisPrepareSignature
): boolean {
  if (a == null) return false;
  return (
    a.orientation === b.orientation &&
    a.axisId === b.axisId &&
    a.left === b.left &&
    a.right === b.right &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.scaleAt0 === b.scaleAt0 &&
    a.scaleAt1 === b.scaleAt1 &&
    a.tickCount === b.tickCount &&
    tickValuesEqual(a.tickValues, b.tickValues) &&
    a.tickLength === b.tickLength &&
    a.position === b.position &&
    a.min === b.min &&
    a.max === b.max &&
    a.axisLineColor === b.axisLineColor &&
    a.axisTickColor === b.axisTickColor
  );
}
