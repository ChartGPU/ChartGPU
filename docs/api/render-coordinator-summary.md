# Render Coordinator Summary

**⚠️ IMPORTANT FOR LLMs**: Use this summary instead of reading the full `createRenderCoordinator.ts` file (3852 lines). This document contains only the essential public interfaces and factory function signature needed for understanding the RenderCoordinator API.

For complete implementation details, see [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

## Public Interfaces

### GPUContextLike

```typescript
export interface GPUContextLike {
  readonly device: GPUDevice | null;
  readonly canvas: SupportedCanvas | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly initialized: boolean;
  readonly devicePixelRatio?: number;
}
```

### RenderCoordinator

```typescript
export interface RenderCoordinator {
  setOptions(resolvedOptions: ResolvedChartGPUOptions): void;
  /**
   * Appends new points to a cartesian series' runtime data without requiring a full `setOptions(...)`
   * resolver pass.
   *
   * Appends are coalesced and flushed once per render frame.
   */
  appendData(seriesIndex: number, newPoints: ReadonlyArray<DataPoint> | ReadonlyArray<OHLCDataPoint>): void;
  /**
   * Gets the current "interaction x" in domain units (or `null` when inactive).
   *
   * This is derived from pointer movement inside the plot grid and can also be driven
   * externally via `setInteractionX(...)` (e.g. chart sync).
   */
  getInteractionX(): number | null;
  /**
   * Drives the chart's crosshair + tooltip from a domain-space x value.
   *
   * Passing `null` clears the interaction (hides crosshair/tooltip).
   */
  setInteractionX(x: number | null, source?: unknown): void;
  /**
   * Subscribes to interaction x changes (domain units).
   *
   * Returns an unsubscribe function.
   */
  onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void;
  /**
   * Returns the current percent-space zoom window (or `null` when zoom is disabled).
   */
  getZoomRange(): Readonly<{ start: number; end: number }> | null;
  /**
   * Sets the percent-space zoom window.
   *
   * No-op when zoom is disabled.
   */
  setZoomRange(start: number, end: number): void;
  /**
   * Subscribes to zoom window changes (percent space).
   *
   * Returns an unsubscribe function.
   */
  onZoomRangeChange(cb: (range: Readonly<{ start: number; end: number }>) => void): () => void;
  /**
   * Renders a full frame.
   */
  render(): void;
  dispose(): void;
}
```

### RenderCoordinatorCallbacks

```typescript
export type RenderCoordinatorCallbacks = Readonly<{
  /**
   * Optional hook for render-on-demand systems (like `ChartGPU`) to re-render when
   * interaction state changes (e.g. crosshair on pointer move).
   */
  readonly onRequestRender?: () => void;
  /**
   * Called when GPU device is lost.
   */
  readonly onDeviceLost?: (reason: string) => void;
}>;
```

## Factory Function

```typescript
export function createRenderCoordinator(
  gpuContext: GPUContextLike,
  options: ResolvedChartGPUOptions,
  callbacks?: RenderCoordinatorCallbacks
): RenderCoordinator
```

## Related Types

- `ResolvedChartGPUOptions`: See [`types.ts`](../../src/config/types.ts)
- `DataPoint`, `OHLCDataPoint`: See [`types.ts`](../../src/config/types.ts)
- `ChartGPUEventPayload`: See [`types.ts`](../../src/config/types.ts)
- `NearestPointMatch`, `PieSliceMatch`, `CandlestickMatch`: See [`types.ts`](../../src/config/types.ts)

## Documentation

For detailed documentation on RenderCoordinator usage and responsibilities, see [INTERNALS.md](INTERNALS.md#render-coordinator-internal--contributor-notes).
