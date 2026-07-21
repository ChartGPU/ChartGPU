/**
 * 3D render coordinator — separate from the 2D RenderCoordinator.
 * Frame graph: clear color+depth → surface meshes → contours → point clouds → axes (box/grid/ticks) → GPU labels.
 * sampleCount 1 (depth path; MSAA deferred).
 *
 * Labeled axes: GPU box/grid/ticks; tick numbers/titles via GPU atlas (`labelMode: 'gpu'|'auto'`) or DOM (`'dom'`).
 */

import type {
  ResolvedChartGPUOptions,
  ResolvedPointCloud3DSeriesConfig,
  ResolvedSurface3DSeriesConfig,
} from '../../config/OptionResolver';
import type { PointCloud3DData, RenderMode, Surface3DGridData, Surface3DUpdate } from '../../config/types';
import { GPUContext } from '../GPUContext';
import type { PipelineCache } from '../PipelineCache';
import { createPointCloud3DRenderer } from '../../renderers/createPointCloud3DRenderer';
import { createSurface3DRenderer } from '../../renderers/createSurface3DRenderer';
import { createAxisBox3DRenderer, type Axes3DTickPlan } from '../../renderers/createAxisBox3DRenderer';
import { createContour3DRenderer } from '../../renderers/createContour3DRenderer';
import {
  applyCameraOptions,
  buildViewProj,
  createDefaultOrbitCameraState,
  fitCameraToAABB,
  orbitByPixels,
  panByPixels,
  toResolvedCamera,
  zoomByWheel,
  type OrbitCameraState,
  type ResolvedCamera,
} from '../3d/camera';
import { emptyAABB, expandAABB, sanitizeAABB, type AABB } from '../3d/aabb';
import { createMat4 } from '../3d/mat4';
import { pickNearestPointCloud } from '../3d/pickPointCloud';
import {
  createEmptyPointCloudScreenGrid,
  pickNearestPointCloudWithGrid,
  pointCloudScreenGridStamp,
  rebuildPointCloudScreenGrid,
  type PointCloudScreenGrid,
} from '../3d/pickPointCloudGrid';
import { pickSurface3D } from '../3d/pickSurface3d';
import { createAxes3DLabels } from '../3d/axes3dLabels';
import { resolveAxes3DLabelMode } from '../3d/axes3dLabelItems';
import { createAxes3DGpuLabelsRenderer } from '../../renderers/createAxes3DGpuLabelsRenderer';
import { resolveCloudValueChannelIdentity, shouldInvalidateCloudPack, type CloudPackSeed } from '../3d/cloudPackPolicy';
import { packPointCloud3D, appendPackedPointCloud3D, type PackedPointCloud3D } from '../../data/pointCloud3dData';
import { computeSurface3DAABB, shiftSurface3DAABBColumnScroll } from '../../data/surface3dData';
import { applySurface3DUpdate, computeSurface3DDomain, shouldClearSurfaceStream } from '../../data/surface3dStream';
import { parseCssColorToGPUColor, parseCssColorToRgba01 } from '../../utils/colors';
import { createLegend } from '../../components/createLegend';
import type { Legend } from '../../components/createLegend';
import { createTooltip } from '../../components/createTooltip';
import type { Tooltip } from '../../components/createTooltip';
import { enqueueDeviceSubmit } from '../gpu/submitBatcher';
import { normalizeMaxPoints } from '../../data/maxPointsWindow';

export type RenderCoordinator3DCallbacks = Readonly<{
  readonly onRequestRender?: () => void;
  readonly pipelineCache?: PipelineCache;
  /** Fire click / mouseover / mouseout with pick payload (createChartGPU3D wires listeners). */
  readonly onPickEvent?: (name: 'click' | 'mouseover' | 'mouseout', payload: Chart3DPickResult | null) => void;
}>;

export type PointCloudPickResult = Readonly<{
  readonly kind: 'pointCloud3d';
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly value: number;
  readonly seriesName: string | null;
  readonly color: string;
  readonly screenDistancePx: number;
}>;

export type SurfacePickResult = Readonly<{
  readonly kind: 'surface3d';
  readonly seriesIndex: number;
  readonly i: number;
  readonly j: number;
  readonly dataIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly height: number;
  readonly seriesName: string | null;
  readonly color: string;
}>;

export type Chart3DPickResult = PointCloudPickResult | SurfacePickResult;

export type AppendPointCloudResult = Readonly<{
  readonly appended: number;
  readonly totalCount: number;
  readonly xExtent: { readonly min: number; readonly max: number };
}>;

export interface RenderCoordinator3D {
  setOptions(resolved: ResolvedChartGPUOptions): void;
  render(): void;
  dispose(): void;
  resetCamera(): void;
  setCamera(partial: import('../../config/types').Chart3DCameraOptions): void;
  getCamera(): ResolvedCamera;
  /** Nearest pick (surface or point cloud) in screen space (CSS px). */
  pick(cssX: number, cssY: number, thresholdPx?: number): Chart3DPickResult | null;
  /**
   * Append points to a resolved-index pointCloud3d series.
   * Durable across setOption when that series' `data` identity is unchanged.
   * `maxPoints` applies FIFO window via pack rewrite.
   */
  appendPointCloudData(
    seriesIndex: number,
    newPoints: PointCloud3DData,
    opts?: { readonly maxPoints?: number }
  ): AppendPointCloudResult | null;
  /** Streaming / partial surface update (replaceY, appendColumns, appendRows). */
  updateSurface3D(seriesIndex: number, update: Surface3DUpdate): boolean;
  /** Test/debug: packed point count for series (includes appends). */
  getPointCloudCount(seriesIndex: number): number;
  getCanvas(): HTMLCanvasElement | null;
}

const SAMPLE_COUNT = 1;
const PICK_THROTTLE_MS = 33; // ~30 Hz tooltip / mouseover

export function createRenderCoordinator3D(
  gpuContext: GPUContext,
  initialOptions: ResolvedChartGPUOptions,
  callbacks?: RenderCoordinator3DCallbacks
): RenderCoordinator3D {
  let disposed = false;
  let currentOptions = initialOptions;
  const device = gpuContext.device;
  if (!device) {
    throw new Error('createRenderCoordinator3D: GPUContext has no device.');
  }
  const pipelineCache = callbacks?.pipelineCache;
  const targetFormat = gpuContext.preferredFormat ?? 'bgra8unorm';

  const cameraState: OrbitCameraState = createDefaultOrbitCameraState();
  applyCameraOptions(cameraState, {
    type: initialOptions.camera.type,
    fovY: initialOptions.camera.fovY,
    near: initialOptions.camera.near,
    far: initialOptions.camera.far,
    eye: initialOptions.camera.eye,
    target: initialOptions.camera.target,
    up: initialOptions.camera.up,
    orthoSize: initialOptions.camera.orthoSize,
  });
  if (initialOptions.camera.eye && initialOptions.camera.target) {
    cameraState.needsFit = false;
    cameraState.userLocked = true;
  }

  let depthTexture: GPUTexture | null = null;
  let depthView: GPUTextureView | null = null;
  let depthW = 0;
  let depthH = 0;

  const ensureDepth = (w: number, h: number): GPUTextureView => {
    if (!depthTexture || !depthView || depthW !== w || depthH !== h) {
      depthTexture?.destroy();
      depthTexture = device.createTexture({
        label: 'coordinator3d/depth',
        size: { width: Math.max(1, w), height: Math.max(1, h) },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      depthView = depthTexture.createView();
      depthW = w;
      depthH = h;
    }
    return depthView;
  };

  const pointCloudRenderers: Array<ReturnType<typeof createPointCloud3DRenderer> | null> = [];
  const surfaceRenderers: Array<ReturnType<typeof createSurface3DRenderer> | null> = [];
  const contourRenderers: Array<ReturnType<typeof createContour3DRenderer> | null> = [];
  const cloudPackedByIndex: Array<PackedPointCloud3D | null> = [];
  const cloudSeedByIndex: Array<CloudPackSeed | null> = [];
  const surfaceAabbCacheByIndex: Array<{
    data: unknown;
    y: unknown;
    aabb: AABB | null;
  } | null> = [];
  /** Mutable surface data owned by stream API (overrides series.data when set). */
  const surfaceStreamDataByIndex: Array<Surface3DGridData | null> = [];
  /**
   * Last user-provided surface `data` identity from setOption.
   * Stream is cleared only when this identity changes (new user data object),
   * not when style-only setOption reuses the same data ref.
   */
  const surfaceUserDataByIndex: Array<Surface3DGridData | null> = [];
  /** Colormap domain overrides from updateSurface3D (replaceY yMin/yMax or auto recompute). */
  const surfaceDomainByIndex: Array<{ yMin: number; yMax: number } | null> = [];
  const cloudPickGrids: Array<PointCloudScreenGrid | null> = [];

  const axisBox = createAxisBox3DRenderer(device, {
    targetFormat,
    sampleCount: SAMPLE_COUNT,
    pipelineCache,
  });
  const axesLabelsDom = createAxes3DLabels();
  const axesLabelsGpu = createAxes3DGpuLabelsRenderer(device, {
    targetFormat,
    sampleCount: SAMPLE_COUNT,
    pipelineCache,
  });
  /** Warn once per chart when auto/gpu falls back to DOM after atlas init failure. */
  let gpuLabelsFallbackWarned = false;
  /** Last exclusive paint path — detach DOM root only on transition into GPU. */
  let lastLabelPaint: 'gpu' | 'dom' | null = null;
  let lastTickPlan: Axes3DTickPlan | null = null;

  let legend: Legend | null = null;
  let tooltip: Tooltip | null = null;
  const canvas = gpuContext.canvas;

  const ensureUi = (): void => {
    if (!canvas || !canvas.parentElement) return;
    const host = canvas.parentElement;
    const legendShow = currentOptions.legend?.show !== false && currentOptions.series.length > 0;
    if (legendShow) {
      if (!legend) {
        legend = createLegend(host, currentOptions.legend?.position ?? 'right');
      }
      legend.update(currentOptions.series, currentOptions.theme);
    } else if (legend) {
      legend.dispose();
      legend = null;
    }
    if (currentOptions.tooltip?.show !== false) {
      if (!tooltip) {
        tooltip = createTooltip(host);
      }
    } else if (tooltip) {
      tooltip.dispose();
      tooltip = null;
    }
  };

  const cloudSeedFromSeries = (s: ResolvedPointCloud3DSeriesConfig): CloudPackSeed => ({
    data: s.data,
    valueChannel: resolveCloudValueChannelIdentity(s.data, s.colorBy?.values),
  });

  const ensureCloudPacked = (i: number, s: ResolvedPointCloud3DSeriesConfig): PackedPointCloud3D => {
    const nextSeed = cloudSeedFromSeries(s);
    if (cloudPackedByIndex[i] && !shouldInvalidateCloudPack(cloudSeedByIndex[i], nextSeed)) {
      return cloudPackedByIndex[i]!;
    }
    const packed = packPointCloud3D(s.data, { valueOverride: s.colorBy?.values });
    cloudPackedByIndex[i] = packed;
    cloudSeedByIndex[i] = nextSeed;
    cloudPickGrids[i] = null;
    return packed;
  };

  const resolveSurfaceSeries = (i: number, s: ResolvedSurface3DSeriesConfig): ResolvedSurface3DSeriesConfig => {
    const streamed = surfaceStreamDataByIndex[i];
    const domain = surfaceDomainByIndex[i];
    if (!streamed && !domain) return s;
    return {
      ...s,
      data: streamed ?? s.data,
      yMin: domain?.yMin ?? s.yMin,
      yMax: domain?.yMax ?? s.yMax,
    };
  };

  const getSurfaceAABB = (i: number, s: ResolvedSurface3DSeriesConfig): AABB | null => {
    const eff = resolveSurfaceSeries(i, s);
    const yRef = eff.data?.y;
    const cached = surfaceAabbCacheByIndex[i];
    if (cached && cached.data === eff.data && cached.y === yRef) {
      return cached.aabb;
    }
    // Cheap height walk only — do not full mesh-pack for axes AABB on every strip tick.
    const aabb = computeSurface3DAABB(eff.data);
    surfaceAabbCacheByIndex[i] = { data: eff.data, y: yRef, aabb };
    return aabb;
  };

  const computeSceneAABB = (): AABB | null => {
    const acc = emptyAABB();
    let any = false;
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible) continue;
      if (s.type === 'pointCloud3d') {
        const packed = ensureCloudPacked(i, s);
        if (packed.aabb) {
          expandAABB(acc, packed.aabb);
          any = true;
        }
      } else if (s.type === 'surface3d') {
        const aabb = getSurfaceAABB(i, s);
        if (aabb) {
          expandAABB(acc, aabb);
          any = true;
        }
      }
    }
    if (!any) return null;
    return {
      min: [acc.min[0], acc.min[1], acc.min[2]],
      max: [acc.max[0], acc.max[1], acc.max[2]],
    };
  };

  const syncRenderers = (): void => {
    const n = currentOptions.series.length;
    while (pointCloudRenderers.length < n) pointCloudRenderers.push(null);
    while (surfaceRenderers.length < n) surfaceRenderers.push(null);
    while (contourRenderers.length < n) contourRenderers.push(null);
    while (cloudPackedByIndex.length < n) cloudPackedByIndex.push(null);
    while (cloudSeedByIndex.length < n) cloudSeedByIndex.push(null);
    while (surfaceAabbCacheByIndex.length < n) surfaceAabbCacheByIndex.push(null);
    while (surfaceStreamDataByIndex.length < n) surfaceStreamDataByIndex.push(null);
    while (surfaceUserDataByIndex.length < n) surfaceUserDataByIndex.push(null);
    while (surfaceDomainByIndex.length < n) surfaceDomainByIndex.push(null);
    while (cloudPickGrids.length < n) cloudPickGrids.push(null);
    for (let i = 0; i < n; i++) {
      const s = currentOptions.series[i]!;
      if (s.type === 'pointCloud3d') {
        if (!pointCloudRenderers[i]) {
          pointCloudRenderers[i] = createPointCloud3DRenderer(device, {
            targetFormat,
            sampleCount: SAMPLE_COUNT,
            pipelineCache,
          });
        }
        surfaceRenderers[i]?.dispose();
        surfaceRenderers[i] = null;
        contourRenderers[i]?.dispose();
        contourRenderers[i] = null;
        surfaceAabbCacheByIndex[i] = null;
        surfaceStreamDataByIndex[i] = null;
        surfaceUserDataByIndex[i] = null;
        surfaceDomainByIndex[i] = null;
      } else if (s.type === 'surface3d') {
        if (!surfaceRenderers[i]) {
          surfaceRenderers[i] = createSurface3DRenderer(device, {
            targetFormat,
            sampleCount: SAMPLE_COUNT,
            pipelineCache,
          });
        }
        if (!contourRenderers[i]) {
          contourRenderers[i] = createContour3DRenderer(device, {
            targetFormat,
            sampleCount: SAMPLE_COUNT,
            pipelineCache,
          });
        }
        pointCloudRenderers[i]?.dispose();
        pointCloudRenderers[i] = null;
        cloudPackedByIndex[i] = null;
        cloudSeedByIndex[i] = null;
        cloudPickGrids[i] = null;
      }
    }
    for (let i = n; i < pointCloudRenderers.length; i++) {
      pointCloudRenderers[i]?.dispose();
      pointCloudRenderers[i] = null;
      surfaceRenderers[i]?.dispose();
      surfaceRenderers[i] = null;
      contourRenderers[i]?.dispose();
      contourRenderers[i] = null;
      cloudPackedByIndex[i] = null;
      cloudSeedByIndex[i] = null;
      surfaceAabbCacheByIndex[i] = null;
      surfaceStreamDataByIndex[i] = null;
      surfaceUserDataByIndex[i] = null;
      surfaceDomainByIndex[i] = null;
      cloudPickGrids[i] = null;
    }
  };

  // --- Interaction ---
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let isPan = false;
  let lastHover: Chart3DPickResult | null = null;
  let lastPickThrottle = 0;
  let pendingPickRaf: number | null = null;
  let pendingPickEvent: PointerEvent | null = null;
  let pointerDownX = 0;
  let pointerDownY = 0;
  let didDrag = false;

  /** Cancel trailing hover rAF so leave/drag cannot re-fire tooltip/mouseover off-canvas. */
  const cancelPendingHoverPick = (): void => {
    if (pendingPickRaf != null) {
      cancelAnimationFrame(pendingPickRaf);
      pendingPickRaf = null;
    }
    pendingPickEvent = null;
  };

  const ensureCloudPickGrid = (
    si: number,
    packed: PackedPointCloud3D,
    viewProj: Float32Array,
    cssW: number,
    cssH: number
  ): PointCloudScreenGrid => {
    let grid = cloudPickGrids[si];
    if (!grid) {
      grid = createEmptyPointCloudScreenGrid();
      cloudPickGrids[si] = grid;
    }
    const stamp = pointCloudScreenGridStamp(packed.count, cssW, cssH, viewProj, packed.packed);
    if (grid.stamp !== stamp) {
      rebuildPointCloudScreenGrid(grid, packed.packed, packed.count, viewProj, cssW, cssH);
    }
    return grid;
  };

  const pickInternal = (cssX: number, cssY: number, thresholdPx = 10): Chart3DPickResult | null => {
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    if (w <= 0 || h <= 0) return null;
    const aspect = w / h;
    const viewProj = buildViewProj(cameraState, aspect, createMat4());

    let bestCloud: PointCloudPickResult | null = null;
    let bestCloudDist = Number.POSITIVE_INFINITY;
    let bestSurface: SurfacePickResult | null = null;
    let bestSurfaceT = Number.POSITIVE_INFINITY;

    for (let si = 0; si < currentOptions.series.length; si++) {
      const s = currentOptions.series[si]!;
      if (!s.visible) continue;
      if (s.type === 'pointCloud3d') {
        const p = ensureCloudPacked(si, s);
        const grid = ensureCloudPickGrid(si, p, viewProj, w, h);
        const hit =
          pickNearestPointCloudWithGrid(grid, p.packed, p.count, viewProj, cssX, cssY, w, h, thresholdPx) ??
          pickNearestPointCloud(p.packed, p.count, viewProj, cssX, cssY, w, h, thresholdPx);
        if (hit && hit.dist2 < bestCloudDist) {
          bestCloudDist = hit.dist2;
          bestCloud = {
            kind: 'pointCloud3d',
            seriesIndex: si,
            dataIndex: hit.dataIndex,
            x: hit.x,
            y: hit.y,
            z: hit.z,
            value: hit.value,
            seriesName: s.name ?? null,
            color: s.pointStyle.color,
            screenDistancePx: Math.sqrt(hit.dist2),
          };
        }
      } else if (s.type === 'surface3d') {
        const eff = resolveSurfaceSeries(si, s);
        const hit = pickSurface3D(
          {
            xStart: eff.data.xStart,
            xStep: eff.data.xStep,
            zStart: eff.data.zStart,
            zStep: eff.data.zStep,
            columns: eff.data.columns,
            rows: eff.data.rows,
            y: eff.data.y,
          },
          viewProj,
          cssX,
          cssY,
          w,
          h
        );
        if (hit && hit.t < bestSurfaceT) {
          bestSurfaceT = hit.t;
          bestSurface = {
            kind: 'surface3d',
            seriesIndex: si,
            i: hit.i,
            j: hit.j,
            dataIndex: hit.j * eff.data.columns + hit.i,
            x: hit.x,
            y: hit.y,
            z: hit.z,
            height: hit.height,
            seriesName: s.name ?? null,
            color: s.color,
          };
        }
      }
    }

    // Mixed surface+cloud under cursor:
    // - Prefer cloud when within 75% of the pick threshold (points sit on the mesh).
    // - Else prefer cloud if screen distance < 6 CSS px (tight hover on billboards).
    // - Otherwise report surface (larger hit area). Depth comparison is not used
    //   because billboard centers and heightfield hits are not directly comparable.
    if (bestCloud && bestSurface) {
      if (bestCloud.screenDistancePx <= thresholdPx * 0.75) return bestCloud;
      return bestCloud.screenDistancePx < 6 ? bestCloud : bestSurface;
    }
    return bestCloud ?? bestSurface;
  };

  const formatPickTooltip = (hit: Chart3DPickResult): string => {
    if (hit.kind === 'pointCloud3d') {
      const name = hit.seriesName ?? `Series ${hit.seriesIndex + 1}`;
      return (
        `<div style="font-weight:600;margin-bottom:4px;color:${hit.color}">${escapeHtml(name)}</div>` +
        `<div>x: ${fmt(hit.x)}</div>` +
        `<div>y: ${fmt(hit.y)}</div>` +
        `<div>z: ${fmt(hit.z)}</div>` +
        (Number.isFinite(hit.value) ? `<div>value: ${fmt(hit.value)}</div>` : '')
      );
    }
    const name = hit.seriesName ?? `Series ${hit.seriesIndex + 1}`;
    return (
      `<div style="font-weight:600;margin-bottom:4px;color:${hit.color}">${escapeHtml(name)}</div>` +
      `<div>cell: (${hit.i}, ${hit.j})</div>` +
      `<div>x: ${fmt(hit.x)}</div>` +
      `<div>y: ${fmt(hit.y)}</div>` +
      `<div>z: ${fmt(hit.z)}</div>` +
      `<div>height: ${fmt(hit.height)}</div>`
    );
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed || !canvas) return;
    // Drag start: drop any trailing hover pick so orbit/pan does not re-fire tooltip.
    cancelPendingHoverPick();
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    didDrag = false;
    dragging = true;
    isPan = e.button === 2 || e.shiftKey || e.button === 1;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  };

  const applyHoverPick = (e: PointerEvent): void => {
    if (disposed || !canvas || dragging) return;
    lastPickThrottle = performance.now();
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const hit = pickInternal(cssX, cssY, 12);

    if (tooltip && currentOptions.tooltip?.show !== false) {
      if (hit) {
        tooltip.show(cssX, cssY, formatPickTooltip(hit));
      } else {
        tooltip.hide();
      }
    }

    const prevKey = lastHover
      ? lastHover.kind === 'pointCloud3d'
        ? `c:${lastHover.seriesIndex}:${lastHover.dataIndex}`
        : `s:${lastHover.seriesIndex}:${lastHover.i}:${lastHover.j}`
      : null;
    const nextKey = hit
      ? hit.kind === 'pointCloud3d'
        ? `c:${hit.seriesIndex}:${hit.dataIndex}`
        : `s:${hit.seriesIndex}:${hit.i}:${hit.j}`
      : null;
    if (prevKey !== nextKey) {
      if (lastHover && !hit) {
        callbacks?.onPickEvent?.('mouseout', lastHover);
      } else if (hit && prevKey !== nextKey) {
        if (lastHover) callbacks?.onPickEvent?.('mouseout', lastHover);
        callbacks?.onPickEvent?.('mouseover', hit);
      }
      lastHover = hit;
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed) return;
    if (dragging && pointerId === e.pointerId) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 4) didDrag = true;
      const ix = currentOptions.interaction3d;
      const h = canvas?.clientHeight ?? 1;
      if (isPan && ix.pan) {
        panByPixels(cameraState, dx, dy, h, ix.panSpeed);
      } else if (!isPan && ix.orbit) {
        orbitByPixels(cameraState, dx, dy, ix.orbitSpeed);
      }
      cameraState.userLocked = true;
      callbacks?.onRequestRender?.();
      return;
    }
    // Throttled hover pick (~30 Hz) with trailing rAF so a stop after skip still updates.
    const now = performance.now();
    if (now - lastPickThrottle < PICK_THROTTLE_MS) {
      pendingPickEvent = e;
      if (pendingPickRaf == null) {
        pendingPickRaf = requestAnimationFrame(() => {
          pendingPickRaf = null;
          const pe = pendingPickEvent;
          pendingPickEvent = null;
          if (pe) applyHoverPick(pe);
        });
      }
      return;
    }
    pendingPickEvent = null;
    applyHoverPick(e);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (pointerId === e.pointerId) {
      dragging = false;
      pointerId = null;
      // Click if not a drag
      if (!didDrag && canvas) {
        const rect = canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const cssY = e.clientY - rect.top;
        const hit = pickInternal(cssX, cssY, 12);
        callbacks?.onPickEvent?.('click', hit);
      }
    }
  };

  const onWheel = (e: WheelEvent): void => {
    if (disposed) return;
    if (!currentOptions.interaction3d.zoom) return;
    e.preventDefault();
    zoomByWheel(cameraState, e.deltaY, currentOptions.interaction3d.zoomSpeed);
    cameraState.userLocked = true;
    callbacks?.onRequestRender?.();
  };

  const onDblClick = (): void => {
    if (disposed) return;
    resetCameraInternal();
    callbacks?.onRequestRender?.();
  };

  const onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  const onPointerLeave = (): void => {
    cancelPendingHoverPick();
    if (lastHover) {
      callbacks?.onPickEvent?.('mouseout', lastHover);
      lastHover = null;
    }
    tooltip?.hide();
  };

  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
  }

  const resetCameraInternal = (): void => {
    const aabb = computeSceneAABB();
    fitCameraToAABB(cameraState, aabb);
  };

  const setOptions = (resolved: ResolvedChartGPUOptions): void => {
    if (disposed) return;
    currentOptions = resolved;
    applyCameraOptions(cameraState, {
      type: resolved.camera.type,
      fovY: resolved.camera.fovY,
      near: resolved.camera.near,
      far: resolved.camera.far,
      eye: resolved.camera.eye,
      target: resolved.camera.target,
      up: resolved.camera.up,
      orthoSize: resolved.camera.orthoSize,
    });
    for (let i = 0; i < resolved.series.length; i++) {
      const s = resolved.series[i]!;
      if (s.type === 'pointCloud3d') {
        const nextSeed = cloudSeedFromSeries(s);
        if (shouldInvalidateCloudPack(cloudSeedByIndex[i], nextSeed)) {
          cloudPackedByIndex[i] = null;
          cloudSeedByIndex[i] = null;
          cloudPickGrids[i] = null;
        }
      } else {
        cloudPackedByIndex[i] = null;
        cloudSeedByIndex[i] = null;
        cloudPickGrids[i] = null;
      }
      if (s.type === 'surface3d') {
        // Stream vs setOption: see shouldClearSurfaceStream (single policy source).
        const prevUser = surfaceUserDataByIndex[i];
        if (shouldClearSurfaceStream(prevUser, s.data)) {
          surfaceStreamDataByIndex[i] = null;
          surfaceDomainByIndex[i] = null;
          contourRenderers[i]?.invalidate();
        }
        surfaceUserDataByIndex[i] = s.data;
        const effData = surfaceStreamDataByIndex[i] ?? s.data;
        const yRef = effData?.y;
        const c = surfaceAabbCacheByIndex[i];
        if (!c || c.data !== effData || c.y !== yRef) {
          surfaceAabbCacheByIndex[i] = null;
        }
      } else {
        surfaceAabbCacheByIndex[i] = null;
        surfaceStreamDataByIndex[i] = null;
        surfaceUserDataByIndex[i] = null;
        surfaceDomainByIndex[i] = null;
      }
    }
    for (let i = resolved.series.length; i < cloudPackedByIndex.length; i++) {
      cloudPackedByIndex[i] = null;
      cloudSeedByIndex[i] = null;
      surfaceAabbCacheByIndex[i] = null;
      surfaceStreamDataByIndex[i] = null;
      surfaceUserDataByIndex[i] = null;
      surfaceDomainByIndex[i] = null;
      cloudPickGrids[i] = null;
    }
    syncRenderers();
    ensureUi();
    if (cameraState.needsFit && !cameraState.userLocked) {
      resetCameraInternal();
    }
    callbacks?.onRequestRender?.();
  };

  const render = (): void => {
    if (disposed) return;
    const canvasContext = gpuContext.canvasContext;
    if (!canvasContext || !device) return;

    const texW = canvas?.width ?? 1;
    const texH = canvas?.height ?? 1;
    const cssW = canvas?.clientWidth || texW;
    const cssH = canvas?.clientHeight || texH;
    const aspect = cssW / Math.max(1, cssH);

    if (cameraState.needsFit && !cameraState.userLocked) {
      resetCameraInternal();
    }

    const viewProj = buildViewProj(cameraState, aspect, createMat4());
    const depthView = ensureDepth(texW, texH);
    const colorView = canvasContext.getCurrentTexture().createView();
    const bg = parseCssColorToGPUColor(currentOptions.theme.backgroundColor ?? '#0a0a0a', {
      r: 0.04,
      g: 0.04,
      b: 0.06,
      a: 1,
    });

    syncRenderers();
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible) continue;
      if (s.type === 'surface3d') {
        const eff = resolveSurfaceSeries(i, s);
        surfaceRenderers[i]?.prepare(eff, { viewProj });
        contourRenderers[i]?.prepare(eff, viewProj);
      } else if (s.type === 'pointCloud3d') {
        const pc = s as ResolvedPointCloud3DSeriesConfig;
        const packed = ensureCloudPacked(i, pc);
        pointCloudRenderers[i]?.preparePacked(pc, packed, {
          viewProj,
          viewportCssW: cssW,
          viewportCssH: cssH,
        });
      }
    }

    const axes = currentOptions.axes3d;
    const sceneAabb = sanitizeAABB(computeSceneAABB());
    // Always prepare (ticks may draw even when showBox+showGrid are false if axes visible).
    const edge = parseCssColorToRgba01(currentOptions.theme.axisLineColor ?? 'rgba(255,255,255,0.35)') ?? [
      0.6, 0.6, 0.65, 0.5,
    ];
    const grid = parseCssColorToRgba01(currentOptions.theme.gridLineColor ?? 'rgba(255,255,255,0.12)') ?? [
      0.4, 0.4, 0.45, 0.25,
    ];
    lastTickPlan = axisBox.prepare(sceneAabb, viewProj, edge, axes, grid);

    // Exclusive label path: GPU atlas quads or DOM spans (never both).
    const labelModeResolved = resolveAxes3DLabelMode(axes.labelMode, {
      atlasReady: axesLabelsGpu.ready,
    });
    if (!axesLabelsGpu.ready && (axes.labelMode === 'gpu' || axes.labelMode === 'auto') && !gpuLabelsFallbackWarned) {
      gpuLabelsFallbackWarned = true;
      console.warn(
        "ChartGPU 3D: axes3d GPU label atlas failed to init; falling back to labelMode 'dom' for this chart instance."
      );
    }

    const textColorRaw = currentOptions.theme.textColor ?? 'rgba(224,224,224,0.9)';
    const textColorStr = typeof textColorRaw === 'string' ? textColorRaw : '#e0e0e0';
    const textRgba = parseCssColorToRgba01(textColorStr) ?? ([0.88, 0.88, 0.88, 0.92] as const);

    if (labelModeResolved === 'gpu' && lastTickPlan) {
      if (lastLabelPaint !== 'gpu') {
        axesLabelsDom.clear(); // detach data-chartgpu-axes3d-labels root on enter GPU
      }
      lastLabelPaint = 'gpu';
      axesLabelsGpu.prepare(sceneAabb, lastTickPlan, axes, viewProj, cssW, cssH, textRgba);
    } else if (canvas?.parentElement && lastTickPlan) {
      lastLabelPaint = 'dom';
      axesLabelsDom.update(canvas.parentElement, sceneAabb, lastTickPlan, axes, viewProj, cssW, cssH, textColorStr);
    }

    const encoder = device.createCommandEncoder({ label: 'coordinator3d/frame' });
    const pass = encoder.beginRenderPass({
      label: 'coordinator3d/main',
      colorAttachments: [
        {
          view: colorView,
          clearValue: bg,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // Surfaces → contours → clouds → axes lines → GPU labels
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible || s.type !== 'surface3d') continue;
      surfaceRenderers[i]?.render(pass);
    }
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible || s.type !== 'surface3d') continue;
      contourRenderers[i]?.render(pass);
    }
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible || s.type !== 'pointCloud3d') continue;
      pointCloudRenderers[i]?.render(pass);
    }
    // Draw whenever prepare produced geometry (box, grid, and/or ticks-only).
    axisBox.render(pass);
    if (labelModeResolved === 'gpu') {
      axesLabelsGpu.render(pass);
    }
    pass.end();
    enqueueDeviceSubmit(device, encoder.finish());
  };

  syncRenderers();
  ensureUi();
  if (cameraState.needsFit) {
    resetCameraInternal();
  }

  return {
    setOptions,
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingHoverPick();
      if (canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('dblclick', onDblClick);
        canvas.removeEventListener('contextmenu', onContextMenu);
      }
      for (const r of pointCloudRenderers) r?.dispose();
      for (const r of surfaceRenderers) r?.dispose();
      for (const r of contourRenderers) r?.dispose();
      axisBox.dispose();
      axesLabelsDom.dispose();
      axesLabelsGpu.dispose();
      depthTexture?.destroy();
      legend?.dispose();
      tooltip?.dispose();
      legend = null;
      tooltip = null;
    },
    resetCamera() {
      resetCameraInternal();
      callbacks?.onRequestRender?.();
    },
    setCamera(partial) {
      applyCameraOptions(cameraState, partial);
      callbacks?.onRequestRender?.();
    },
    getCamera: () => toResolvedCamera(cameraState),
    pick: (cssX, cssY, thresholdPx) => pickInternal(cssX, cssY, thresholdPx),
    appendPointCloudData(seriesIndex, newPoints, opts) {
      if (disposed) return null;
      const s = currentOptions.series[seriesIndex];
      if (!s || s.type !== 'pointCloud3d') {
        console.warn(
          `ChartGPU 3D: appendData seriesIndex ${seriesIndex} is not pointCloud3d (resolved index after OptionResolver filtering).`
        );
        return null;
      }
      const base = ensureCloudPacked(seriesIndex, s);
      const maxPoints = normalizeMaxPoints(opts?.maxPoints);
      const next = appendPackedPointCloud3D(base.packed, base.count, newPoints, {
        valueOverride: s.colorBy?.values,
        maxPoints,
      });
      cloudPackedByIndex[seriesIndex] = next;
      cloudSeedByIndex[seriesIndex] = cloudSeedFromSeries(s);
      cloudPickGrids[seriesIndex] = null;
      callbacks?.onRequestRender?.();
      const aabb = next.aabb;
      // dataAppend.count = accepted new samples (all of batch under window, or tail on strict replace)
      const newPacked = packPointCloud3D(newPoints, { valueOverride: s.colorBy?.values });
      const appended = maxPoints != null && newPacked.count >= maxPoints ? maxPoints : newPacked.count;
      return {
        appended,
        totalCount: next.count,
        xExtent: {
          min: aabb ? aabb.min[0] : 0,
          max: aabb ? aabb.max[0] : 0,
        },
      };
    },
    updateSurface3D(seriesIndex, update) {
      if (disposed) return false;
      const s = currentOptions.series[seriesIndex];
      if (!s || s.type !== 'surface3d') {
        console.warn(
          `ChartGPU 3D: updateSurface3D seriesIndex ${seriesIndex} is not surface3d (got ${s?.type ?? 'missing'}).`
        );
        return false;
      }
      const base = surfaceStreamDataByIndex[seriesIndex] ?? s.data;
      // Seed user-data identity so subsequent style setOption can keep the stream
      // when the same data ref is reused.
      if (surfaceUserDataByIndex[seriesIndex] == null) {
        surfaceUserDataByIndex[seriesIndex] = s.data;
      }
      const result = applySurface3DUpdate(base, update);
      surfaceStreamDataByIndex[seriesIndex] = result.data;

      // Domain: explicit replaceY; single-column scroll expands from new strip only;
      // full recompute when multi-column or replaceY without explicit domain.
      if (result.yMin != null && result.yMax != null && !result.recomputeDomain) {
        surfaceDomainByIndex[seriesIndex] = { yMin: result.yMin, yMax: result.yMax };
      } else if (
        update.mode === 'appendColumns' &&
        update.scrollX !== false &&
        update.columns === 1 &&
        !result.recomputeDomain
      ) {
        const prev = surfaceDomainByIndex[seriesIndex];
        const col = update.y;
        let lo = prev?.yMin ?? Infinity;
        let hi = prev?.yMax ?? -Infinity;
        const n = Math.min(col.length, result.data.rows);
        for (let r = 0; r < n; r++) {
          const v = Number(col[r]);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo)) {
          const auto = computeSurface3DDomain(result.data.y, result.data.columns * result.data.rows);
          lo = auto.yMin;
          hi = auto.yMax;
        }
        surfaceDomainByIndex[seriesIndex] = {
          yMin: lo,
          yMax: hi > lo ? hi : lo + 1,
        };
      } else if (result.recomputeDomain) {
        const auto = computeSurface3DDomain(result.data.y, result.data.columns * result.data.rows);
        const yMin = result.yMin ?? auto.yMin;
        const yMax = result.yMax ?? auto.yMax;
        surfaceDomainByIndex[seriesIndex] = {
          yMin,
          yMax: yMax > yMin ? yMax : yMin + 1,
        };
      }

      // AABB: single-column scroll shifts prior bounds by +dx and expands Y from the new strip.
      // Avoid a full height walk every tick at 30–60 Hz.
      if (update.mode === 'appendColumns' && update.scrollX !== false && update.columns === 1 && result.scrolled) {
        const prevCache = surfaceAabbCacheByIndex[seriesIndex];
        const dx = result.data.xStep * Math.max(0, Math.floor(update.columns));
        if (prevCache?.aabb && dx !== 0) {
          const shifted = shiftSurface3DAABBColumnScroll(prevCache.aabb, dx, update.y, result.data.rows);
          surfaceAabbCacheByIndex[seriesIndex] = {
            data: result.data,
            y: result.data.y,
            aabb: shifted,
          };
        } else {
          surfaceAabbCacheByIndex[seriesIndex] = null;
        }
      } else {
        surfaceAabbCacheByIndex[seriesIndex] = null;
      }

      // Contours rebuild with an internal time throttle during strip stream;
      // force immediate rebuild on full field replace.
      if (update.mode === 'replaceY') {
        contourRenderers[seriesIndex]?.invalidate();
      }
      callbacks?.onRequestRender?.();
      return true;
    },
    getPointCloudCount(seriesIndex) {
      const p = cloudPackedByIndex[seriesIndex];
      if (p) return p.count;
      const s = currentOptions.series[seriesIndex];
      if (s?.type === 'pointCloud3d') return ensureCloudPacked(seriesIndex, s).count;
      return 0;
    },
    getCanvas: () => canvas,
  };
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return n.toExponential(3);
  return n.toPrecision(6).replace(/\.?0+$/, '');
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

void (0 as unknown as RenderMode);
