# Render Coordinator Summary

**⚠️ IMPORTANT FOR LLMs**: Use this summary instead of reading the full `createRenderCoordinator.ts` file (3,599 lines). This document contains only the essential public interfaces and factory function signature needed for understanding the RenderCoordinator API.

The render coordinator uses a modular architecture under `src/core/renderCoordinator/` (overview: [INTERNALS.md](INTERNALS.md#render-coordinator-internal)).

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
  onZoomRangeChange(
    cb: (range: Readonly<{ start: number; end: number }>, sourceKind?: ZoomChangeSourceKind) => void
  ): () => void;
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
   * Optional shared cache for shader modules, render pipelines, and compute pipelines (CGPU-PIPELINE-CACHE).
   *
   * Must be bound to the same `GPUDevice` as `gpuContext.device`.
   * If omitted, coordinator and renderers behave identically (no caching).
   */
  readonly pipelineCache?: PipelineCache;
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

## Rendering Pipeline

The render coordinator implements a **2-pass MSAA strategy** (Phase 4b — no third single-sample top overlay):

### Pass 1: Main Scene (`MAIN_SCENE_MSAA_SAMPLE_COUNT` = **4×**)
- **Target**: 4× MSAA texture (`mainColorTexture`)
- **Resolve**: Single-sample texture (`mainResolveTexture`)
- **Renderers**: grid, area, line, bar, scatter, candlestick, **below-series** reference lines / markers
- **Sample count**: All main-pass series/grid/below-annotation pipelines use `MAIN_SCENE_MSAA_SAMPLE_COUNT` (4; WebGPU allows only 1 or 4)

### Pass 2: Annotation Overlay (`ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` = **4×**)
- **Target**: 4× MSAA overlay texture, resolved to swapchain
- **Contents**: Blit resolved main scene → above-series annotations → **axes / crosshair / highlight**
- **Sample count**: Axes, crosshair, highlight, and above-series annotation pipelines use `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)

**Critical for renderer implementations:**
- `MAIN_SCENE_MSAA_SAMPLE_COUNT` (4) and `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4) are exported from `textureManager.ts`
- Main-pass pipelines **must** match main sample count; overlay UI/annotation pipelines **must** match overlay sample count
- Do **not** reintroduce a third single-sample top overlay pass

## Related Types

- `ResolvedChartGPUOptions`: See [`types.ts`](../../src/config/types.ts)
- `DataPoint`, `OHLCDataPoint`: See [`types.ts`](../../src/config/types.ts)
- `ChartGPUEventPayload`: See [`types.ts`](../../src/config/types.ts)
- `NearestPointMatch`, `PieSliceMatch`, `CandlestickMatch`: See [`types.ts`](../../src/config/types.ts)
- `PipelineCache`: See [`PipelineCache.ts`](../../src/core/PipelineCache.ts)
- `ZoomChangeSourceKind`: Exported from the public entrypoint (`src/index.ts`) via [`ChartGPU.ts`](../../src/ChartGPU.ts)

## Documentation

For detailed documentation on RenderCoordinator usage and responsibilities, see [INTERNALS.md](INTERNALS.md#render-coordinator-internal).
