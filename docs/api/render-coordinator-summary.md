# Render Coordinator Summary

**⚠️ IMPORTANT FOR LLMs**: Use this summary instead of reading the full implementation. The public factory is a thin re-export; the composition root lives in `createRenderCoordinatorImpl.ts` (~3.6k LOC). This document covers public interfaces and the high-level frame graph only.

| Layer | Path |
|-------|------|
| **Shell (public factory)** | [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts) |
| **Composition root** | [`createRenderCoordinatorImpl.ts`](../../src/core/renderCoordinator/createRenderCoordinatorImpl.ts) |
| **Pass graph / encode helpers** | [`frameRender.ts`](../../src/core/renderCoordinator/render/frameRender.ts) |
| **Domain modules** | [`src/core/renderCoordinator/`](../../src/core/renderCoordinator/) |

Overview: [INTERNALS.md](INTERNALS.md#render-coordinator-internal).

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

Default frame graph (`planGpuFrame` in `frameRender.ts`):

1. **Compute** (dirty-gated): scatter density binning + line GPU decimation
2. **Main scene** (`MAIN_SCENE_MSAA_SAMPLE_COUNT` = **4×**, or **1×** when `antialias: false`): series + grid + below-series annotations → resolve to `mainResolveTexture`
3. **Optional dense hairline** (`sampleCount: 1` on resolve): high-N line-list strokes deferred out of main MSAA
4. **Overlay** (`ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` = **4×** or **1×**): blit resolved main → above-series annotations → **axes / crosshair / highlight** → swapchain
5. **Submit**: one `queue.submit` per frame via `submitBatcher` (microtask-coalesced across charts on the same device)

**Critical for renderer implementations:**
- `MAIN_SCENE_MSAA_SAMPLE_COUNT` and `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` are exported from `textureManager.ts` (portable WebGPU multisample counts are only **1 or 4**)
- Main-pass pipelines **must** match main sample count; overlay UI/annotation pipelines **must** match overlay sample count
- Dense hairline is a legal sampleCount-1 load-pass on the resolve texture — not a third MSAA overlay pass

## Related Types

- `ResolvedChartGPUOptions`: See [`types.ts`](../../src/config/types.ts)
- `DataPoint`, `OHLCDataPoint`: See [`types.ts`](../../src/config/types.ts)
- `ChartGPUEventPayload`: See [`types.ts`](../../src/config/types.ts)
- `NearestPointMatch`, `PieSliceMatch`, `CandlestickMatch`: See [`types.ts`](../../src/config/types.ts)
- `PipelineCache`: See [`PipelineCache.ts`](../../src/core/PipelineCache.ts)
- `ZoomChangeSourceKind`: Exported from the public entrypoint (`src/index.ts`) via [`ChartGPU.ts`](../../src/ChartGPU.ts)

## Documentation

For detailed documentation on RenderCoordinator usage and responsibilities, see [INTERNALS.md](INTERNALS.md#render-coordinator-internal).
