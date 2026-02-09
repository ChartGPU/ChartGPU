/**
 * Drag handler for repositioning annotations
 *
 * Handles dragging annotations to reposition them:
 * - lineX: constrained to horizontal movement
 * - lineY: constrained to vertical movement
 * - text: free 2D movement (data or plot space)
 * - point: free 2D movement (data space)
 *
 * Uses optimistic updates during drag for 60 FPS performance.
 */

import type { AnnotationConfig, DataPoint } from '../config/types.js';
import type { ChartGPUInstance } from '../ChartGPU.js';

export interface AnnotationDragCallbacks {
  onDragMove: (index: number, updates: Partial<AnnotationConfig>) => void;
  onDragEnd: (index: number, updates: Partial<AnnotationConfig>) => void;
  onDragCancel: () => void;
}

export interface AnnotationDragHandler {
  startDrag(
    annotationIndex: number,
    annotation: AnnotationConfig,
    startPointerX: number,
    startPointerY: number
  ): void;
  isDragging(): boolean;
  dispose(): void;
}

interface DragState {
  annotationIndex: number;
  annotation: AnnotationConfig;
  startPointerX: number;
  startPointerY: number;
  pointerId: number | null;
}

/**
 * Creates a drag handler for repositioning annotations
 */
export function createAnnotationDragHandler(
  chart: ChartGPUInstance,
  canvas: HTMLCanvasElement,
  callbacks: AnnotationDragCallbacks
): AnnotationDragHandler {
  let dragState: DragState | null = null;

  // Type guards for data points
  const isTupleDataPoint = (p: any): p is [number, number] => Array.isArray(p);
  const isTupleOHLCDataPoint = (p: any): p is [number, number, number, number, number] => Array.isArray(p);
  const getPointX = (p: any): number => (isTupleDataPoint(p) ? p[0] : p.x);
  const getPointY = (p: any): number => (isTupleDataPoint(p) ? p[1] : p.y);
  const getOHLCTimestamp = (p: any): number => (isTupleOHLCDataPoint(p) ? p[0] : p.timestamp);
  const getOHLCHigh = (p: any): number => (isTupleOHLCDataPoint(p) ? p[2] : p.high);
  const getOHLCLow = (p: any): number => (isTupleOHLCDataPoint(p) ? p[3] : p.low);

  /**
   * Compute the actual X domain from series data (with zoom applied)
   */
  function computeXDomain(): { min: number; max: number } {
    const opts = chart.options;
    let xMin = opts.xAxis?.min;
    let xMax = opts.xAxis?.max;

    if (xMin === undefined || xMax === undefined) {
      const series = opts.series ?? [];
      let dataXMin = Number.POSITIVE_INFINITY;
      let dataXMax = Number.NEGATIVE_INFINITY;

      for (const s of series) {
        if (s.type === 'pie') continue;

        if (s.type === 'candlestick') {
          const data = s.data;
          for (const p of data) {
            const timestamp = getOHLCTimestamp(p);
            if (timestamp < dataXMin) dataXMin = timestamp;
            if (timestamp > dataXMax) dataXMax = timestamp;
          }
        } else {
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          const data = s.data as ReadonlyArray<DataPoint>;
          for (const p of data) {
            const x = getPointX(p);
            if (x < dataXMin) dataXMin = x;
            if (x > dataXMax) dataXMax = x;
          }
        }
      }

      if (xMin === undefined) xMin = Number.isFinite(dataXMin) ? dataXMin : 0;
      if (xMax === undefined) xMax = Number.isFinite(dataXMax) ? dataXMax : 100;
    }

    const zoomRange = chart.getZoomRange();
    if (zoomRange) {
      const span = xMax - xMin;
      const zoomMin = xMin + (zoomRange.start / 100) * span;
      const zoomMax = xMin + (zoomRange.end / 100) * span;
      return { min: zoomMin, max: zoomMax };
    }

    return { min: xMin, max: xMax };
  }

  /**
   * Compute the actual Y domain from series data
   */
  function computeYDomain(): { min: number; max: number } {
    const opts = chart.options;
    let yMin = opts.yAxis?.min;
    let yMax = opts.yAxis?.max;

    if (yMin === undefined || yMax === undefined) {
      const series = opts.series ?? [];
      let dataYMin = Number.POSITIVE_INFINITY;
      let dataYMax = Number.NEGATIVE_INFINITY;

      for (const s of series) {
        if (s.type === 'pie') continue;

        if (s.type === 'candlestick') {
          const data = s.data;
          for (const p of data) {
            const high = getOHLCHigh(p);
            const low = getOHLCLow(p);
            if (high > dataYMax) dataYMax = high;
            if (low < dataYMin) dataYMin = low;
          }
        } else {
          // TODO(step 2): normalize CartesianSeriesData to ReadonlyArray<DataPoint>
          const data = s.data as ReadonlyArray<DataPoint>;
          for (const p of data) {
            const y = getPointY(p);
            if (y < dataYMin) dataYMin = y;
            if (y > dataYMax) dataYMax = y;
          }
        }
      }

      if (yMin === undefined) yMin = Number.isFinite(dataYMin) ? dataYMin : 0;
      if (yMax === undefined) yMax = Number.isFinite(dataYMax) ? dataYMax : 100;
    }

    return { min: yMin, max: yMax };
  }

  /**
   * Convert canvas-space CSS pixels to data-space coordinates
   */
  function canvasToData(canvasX: number, canvasY: number): { x: number; y: number } {
    const chartOptions = chart.options;
    const rect = canvas.getBoundingClientRect();

    const grid = chartOptions.grid ?? { left: 60, right: 20, top: 40, bottom: 40 };
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;

    const plotLeft = grid.left ?? 60;
    const plotRight = canvasWidth - (grid.right ?? 20);
    const plotTop = grid.top ?? 40;
    const plotBottom = canvasHeight - (grid.bottom ?? 40);
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    const xAxis = chartOptions.xAxis;
    const yAxis = chartOptions.yAxis;

    let dataX = 0;
    let dataY = 0;

    // Convert X coordinate
    if (xAxis) {
      const xFraction = (canvasX - plotLeft) / plotWidth;
      if (xAxis.type === 'category' && Array.isArray((xAxis as any).data)) {
        // Category scale: map fraction to category index
        const data = (xAxis as any).data as any[];
        const index = Math.round(xFraction * (data.length - 1 || 1));
        dataX = data[Math.max(0, Math.min(index, data.length - 1))] as number;
      } else {
        // Linear scale - compute actual domain from data
        const domain = computeXDomain();
        dataX = domain.min + xFraction * (domain.max - domain.min);
      }
    }

    // Convert Y coordinate (inverted: canvas top = max Y value)
    if (yAxis) {
      const yFraction = (plotBottom - canvasY) / plotHeight;
      // Compute actual domain from data
      const domain = computeYDomain();
      dataY = domain.min + yFraction * (domain.max - domain.min);
    }

    return { x: dataX, y: dataY };
  }

  /**
   * Convert canvas-space CSS pixels to plot-space coordinates (0-1 fractions)
   */
  function canvasToPlot(canvasX: number, canvasY: number): { x: number; y: number } {
    const chartOptions = chart.options;
    const rect = canvas.getBoundingClientRect();

    const grid = chartOptions.grid ?? { left: 60, right: 20, top: 40, bottom: 40 };
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;

    const plotLeft = grid.left ?? 60;
    const plotRight = canvasWidth - (grid.right ?? 20);
    const plotTop = grid.top ?? 40;
    const plotBottom = canvasHeight - (grid.bottom ?? 40);
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;

    const x = (canvasX - plotLeft) / plotWidth;
    const y = (canvasY - plotTop) / plotHeight;

    // Clamp to [0, 1]
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  /**
   * Handle pointer move during drag
   */
  function onPointerMove(e: PointerEvent): void {
    if (!dragState) {
      return;
    }

    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    const annotation = dragState.annotation;
    const updates: any = {}; // Use 'any' to bypass TypeScript union narrowing issues

    if (annotation.type === 'lineX') {
      // Constrain to horizontal movement only
      const { x } = canvasToData(canvasX, 0);
      updates.x = x;
    } else if (annotation.type === 'lineY') {
      // Constrain to vertical movement only
      const { y } = canvasToData(0, canvasY);
      updates.y = y;
    } else if (annotation.type === 'text') {
      // Free 2D movement (respect original space)
      const space = annotation.position.space;
      if (space === 'plot') {
        const { x, y } = canvasToPlot(canvasX, canvasY);
        updates.position = { space, x, y };
      } else {
        // data space
        const { x, y } = canvasToData(canvasX, canvasY);
        updates.position = { space, x, y };
      }
    } else if (annotation.type === 'point') {
      // Free 2D movement in data space
      const { x, y } = canvasToData(canvasX, canvasY);
      updates.x = x;
      updates.y = y;
    }

    // Optimistic update (no history push)
    callbacks.onDragMove(dragState.annotationIndex, updates);
  }

  /**
   * Handle pointer up (drag end)
   */
  function onPointerUp(e: PointerEvent): void {
    if (!dragState) return;

    const rect = canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    const annotation = dragState.annotation;
    const updates: any = {}; // Use 'any' to bypass TypeScript union narrowing issues

    if (annotation.type === 'lineX') {
      const { x } = canvasToData(canvasX, 0);
      updates.x = x;
    } else if (annotation.type === 'lineY') {
      const { y } = canvasToData(0, canvasY);
      updates.y = y;
    } else if (annotation.type === 'text') {
      const space = annotation.position.space;
      if (space === 'plot') {
        const { x, y } = canvasToPlot(canvasX, canvasY);
        updates.position = { space, x, y };
      } else {
        const { x, y } = canvasToData(canvasX, canvasY);
        updates.position = { space, x, y };
      }
    } else if (annotation.type === 'point') {
      const { x, y } = canvasToData(canvasX, canvasY);
      updates.x = x;
      updates.y = y;
    }

    // Push single history entry with final position
    callbacks.onDragEnd(dragState.annotationIndex, updates);

    cleanup();
  }

  /**
   * Handle pointer cancel (drag cancelled)
   */
  function onPointerCancel(): void {
    if (!dragState) return;

    // Revert to original position
    callbacks.onDragCancel();

    cleanup();
  }

  /**
   * Handle keyboard events during drag
   */
  function onKeyDown(e: KeyboardEvent): void {
    if (!dragState) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      onPointerCancel();
    }
  }

  /**
   * Cleanup drag state and event listeners
   */
  function cleanup(): void {
    if (!dragState) return;

    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('keydown', onKeyDown);

    if (dragState.pointerId !== null) {
      try {
        canvas.releasePointerCapture(dragState.pointerId);
      } catch (err) {
        // Ignore errors (pointer may already be released)
      }
    }

    document.body.style.cursor = '';
    dragState = null;
  }

  /**
   * Start dragging an annotation
   */
  function startDrag(
    annotationIndex: number,
    annotation: AnnotationConfig,
    startPointerX: number,
    startPointerY: number
  ): void {
    // Cancel any existing drag
    if (dragState) {
      cleanup();
    }

    dragState = {
      annotationIndex,
      annotation,
      startPointerX,
      startPointerY,
      pointerId: null,
    };

    // Set cursor based on annotation type
    if (annotation.type === 'lineX') {
      document.body.style.cursor = 'ew-resize';
    } else if (annotation.type === 'lineY') {
      document.body.style.cursor = 'ns-resize';
    } else {
      document.body.style.cursor = 'grabbing';
    }

    // Attach window-level listeners for smooth dragging outside canvas
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    document.addEventListener('keydown', onKeyDown, { passive: false });

    // Visual feedback: reduce opacity
    callbacks.onDragMove(annotationIndex, {
      style: { ...annotation.style, opacity: 0.7 },
    });
  }

  /**
   * Check if currently dragging
   */
  function isDragging(): boolean {
    return dragState !== null;
  }

  /**
   * Dispose of resources
   */
  function dispose(): void {
    cleanup();
  }

  return {
    startDrag,
    isDragging,
    dispose,
  };
}
