/**
 * 3D render coordinator — separate from the 2D RenderCoordinator.
 * Frame graph: clear color+depth → surface meshes → point clouds → optional axis box.
 * sampleCount 1 (depth path; MSAA deferred).
 */

import type {
  ResolvedChartGPUOptions,
  ResolvedPointCloud3DSeriesConfig,
  ResolvedSurface3DSeriesConfig,
} from '../../config/OptionResolver';
import type { PointCloud3DData, RenderMode } from '../../config/types';
import { GPUContext } from '../GPUContext';
import type { PipelineCache } from '../PipelineCache';
import { createPointCloud3DRenderer } from '../../renderers/createPointCloud3DRenderer';
import { createSurface3DRenderer } from '../../renderers/createSurface3DRenderer';
import { createAxisBox3DRenderer } from '../../renderers/createAxisBox3DRenderer';
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
import { resolveCloudValueChannelIdentity, shouldInvalidateCloudPack, type CloudPackSeed } from '../3d/cloudPackPolicy';
import { packPointCloud3D, appendPackedPointCloud3D, type PackedPointCloud3D } from '../../data/pointCloud3dData';
import { packSurface3D } from '../../data/surface3dData';
import { parseCssColorToGPUColor, parseCssColorToRgba01 } from '../../utils/colors';
import { createLegend } from '../../components/createLegend';
import type { Legend } from '../../components/createLegend';
import { createTooltip } from '../../components/createTooltip';
import type { Tooltip } from '../../components/createTooltip';
import { enqueueDeviceSubmit } from '../gpu/submitBatcher';

export type RenderCoordinator3DCallbacks = Readonly<{
  readonly onRequestRender?: () => void;
  readonly pipelineCache?: PipelineCache;
}>;

export type PointCloudPickResult = Readonly<{
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly value: number;
  readonly seriesName: string | null;
  readonly color: string;
}>;

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
  /** Nearest point cloud sample in screen space (CSS px). */
  pick(cssX: number, cssY: number, thresholdPx?: number): PointCloudPickResult | null;
  /**
   * Append points to a resolved-index pointCloud3d series.
   * Durable across setOption when that series' `data` identity is unchanged.
   */
  appendPointCloudData(seriesIndex: number, newPoints: PointCloud3DData): AppendPointCloudResult | null;
  /** Test/debug: packed point count for series (includes appends). */
  getPointCloudCount(seriesIndex: number): number;
  getCanvas(): HTMLCanvasElement | null;
}

const SAMPLE_COUNT = 1;

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

  // Per-series renderers (pool grows with series list)
  const pointCloudRenderers: Array<ReturnType<typeof createPointCloud3DRenderer> | null> = [];
  const surfaceRenderers: Array<ReturnType<typeof createSurface3DRenderer> | null> = [];
  // Runtime packed cloud data for append — durable while data + value-channel seed is stable
  const cloudPackedByIndex: Array<PackedPointCloud3D | null> = [];
  /** Seed identities (data + value channel) used to build cloudPackedByIndex[i]. */
  const cloudSeedByIndex: Array<CloudPackSeed | null> = [];
  /** Cached surface AABB keyed by data + y channel (geometry; not colormap domain). */
  const surfaceAabbCacheByIndex: Array<{
    data: unknown;
    y: unknown;
    aabb: AABB | null;
  } | null> = [];

  const axisBox = createAxisBox3DRenderer(device, {
    targetFormat,
    sampleCount: SAMPLE_COUNT,
    pipelineCache,
  });

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
    return packed;
  };

  const getSurfaceAABB = (i: number, s: ResolvedSurface3DSeriesConfig): AABB | null => {
    const yRef = s.data?.y;
    const cached = surfaceAabbCacheByIndex[i];
    if (cached && cached.data === s.data && cached.y === yRef) {
      return cached.aabb;
    }
    // Geometry AABB is independent of colormap domain (yMin/yMax uniforms).
    const packed = packSurface3D(s.data);
    const aabb = packed?.aabb ?? null;
    surfaceAabbCacheByIndex[i] = { data: s.data, y: yRef, aabb };
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
    while (cloudPackedByIndex.length < n) cloudPackedByIndex.push(null);
    while (cloudSeedByIndex.length < n) cloudSeedByIndex.push(null);
    while (surfaceAabbCacheByIndex.length < n) surfaceAabbCacheByIndex.push(null);
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
        surfaceAabbCacheByIndex[i] = null;
      } else if (s.type === 'surface3d') {
        if (!surfaceRenderers[i]) {
          surfaceRenderers[i] = createSurface3DRenderer(device, {
            targetFormat,
            sampleCount: SAMPLE_COUNT,
            pipelineCache,
          });
        }
        pointCloudRenderers[i]?.dispose();
        pointCloudRenderers[i] = null;
        cloudPackedByIndex[i] = null;
        cloudSeedByIndex[i] = null;
      }
    }
    // Dispose extras
    for (let i = n; i < pointCloudRenderers.length; i++) {
      pointCloudRenderers[i]?.dispose();
      pointCloudRenderers[i] = null;
      surfaceRenderers[i]?.dispose();
      surfaceRenderers[i] = null;
      cloudPackedByIndex[i] = null;
      cloudSeedByIndex[i] = null;
      surfaceAabbCacheByIndex[i] = null;
    }
  };

  // --- Interaction ---
  let pointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let isPan = false;

  const onPointerDown = (e: PointerEvent): void => {
    if (disposed || !canvas) return;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    dragging = true;
    isPan = e.button === 2 || e.shiftKey || e.button === 1;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (disposed) return;
    if (dragging && pointerId === e.pointerId) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
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
    // Hover pick
    if (tooltip && currentOptions.tooltip?.show !== false && canvas) {
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const hit = pickInternal(cssX, cssY, 12);
      if (hit) {
        const name = hit.seriesName ?? `Series ${hit.seriesIndex + 1}`;
        const html =
          `<div style="font-weight:600;margin-bottom:4px;color:${hit.color}">${escapeHtml(name)}</div>` +
          `<div>x: ${fmt(hit.x)}</div>` +
          `<div>y: ${fmt(hit.y)}</div>` +
          `<div>z: ${fmt(hit.z)}</div>` +
          (Number.isFinite(hit.value) ? `<div>value: ${fmt(hit.value)}</div>` : '');
        // Coordinates are container-local CSS px
        tooltip.show(cssX, cssY, html);
      } else {
        tooltip.hide();
      }
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (pointerId === e.pointerId) {
      dragging = false;
      pointerId = null;
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

  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
  }

  const pickInternal = (cssX: number, cssY: number, thresholdPx = 10): PointCloudPickResult | null => {
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;
    if (w <= 0 || h <= 0) return null;
    const aspect = w / h;
    const viewProj = buildViewProj(cameraState, aspect, createMat4());

    let best: PointCloudPickResult | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let si = 0; si < currentOptions.series.length; si++) {
      const s = currentOptions.series[si]!;
      if (!s.visible || s.type !== 'pointCloud3d') continue;
      const p = ensureCloudPacked(si, s);
      const hit = pickNearestPointCloud(p.packed, p.count, viewProj, cssX, cssY, w, h, thresholdPx);
      if (hit && hit.dist2 < bestDist) {
        bestDist = hit.dist2;
        best = {
          seriesIndex: si,
          dataIndex: hit.dataIndex,
          x: hit.x,
          y: hit.y,
          z: hit.z,
          value: hit.value,
          seriesName: s.name ?? null,
          color: s.pointStyle.color,
        };
      }
    }
    return best;
  };

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
    // Invalidate cloud packed when data or value-channel identity changes (preserve appends otherwise).
    // Surface AABB cache invalidates when data/y geometry identity changes (not colormap domain).
    for (let i = 0; i < resolved.series.length; i++) {
      const s = resolved.series[i]!;
      if (s.type === 'pointCloud3d') {
        const nextSeed = cloudSeedFromSeries(s);
        if (shouldInvalidateCloudPack(cloudSeedByIndex[i], nextSeed)) {
          cloudPackedByIndex[i] = null;
          cloudSeedByIndex[i] = null;
        }
      } else {
        cloudPackedByIndex[i] = null;
        cloudSeedByIndex[i] = null;
      }
      if (s.type === 'surface3d') {
        const yRef = s.data?.y;
        const c = surfaceAabbCacheByIndex[i];
        if (!c || c.data !== s.data || c.y !== yRef) {
          surfaceAabbCacheByIndex[i] = null;
        }
      } else {
        surfaceAabbCacheByIndex[i] = null;
      }
    }
    for (let i = resolved.series.length; i < cloudPackedByIndex.length; i++) {
      cloudPackedByIndex[i] = null;
      cloudSeedByIndex[i] = null;
      surfaceAabbCacheByIndex[i] = null;
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

    // Prepare series (surfaces first for draw order)
    syncRenderers();
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible) continue;
      if (s.type === 'surface3d') {
        surfaceRenderers[i]?.prepare(s as ResolvedSurface3DSeriesConfig, { viewProj });
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

    if (currentOptions.axes3d.showBox) {
      const aabb = sanitizeAABB(computeSceneAABB());
      const edge = parseCssColorToRgba01(currentOptions.theme.axisLineColor ?? 'rgba(255,255,255,0.35)') ?? [
        0.6, 0.6, 0.65, 0.5,
      ];
      axisBox.prepare(aabb, viewProj, edge);
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

    // Surfaces then clouds
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible || s.type !== 'surface3d') continue;
      surfaceRenderers[i]?.render(pass);
    }
    for (let i = 0; i < currentOptions.series.length; i++) {
      const s = currentOptions.series[i]!;
      if (!s.visible || s.type !== 'pointCloud3d') continue;
      pointCloudRenderers[i]?.render(pass);
    }
    if (currentOptions.axes3d.showBox) {
      axisBox.render(pass);
    }
    pass.end();
    enqueueDeviceSubmit(device, encoder.finish());
  };

  // Initial setup
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
      if (canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('dblclick', onDblClick);
        canvas.removeEventListener('contextmenu', onContextMenu);
      }
      for (const r of pointCloudRenderers) r?.dispose();
      for (const r of surfaceRenderers) r?.dispose();
      axisBox.dispose();
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
    appendPointCloudData(seriesIndex, newPoints) {
      if (disposed) return null;
      const s = currentOptions.series[seriesIndex];
      if (!s || s.type !== 'pointCloud3d') {
        console.warn(
          `ChartGPU 3D: appendData seriesIndex ${seriesIndex} is not pointCloud3d (resolved index after OptionResolver filtering).`
        );
        return null;
      }
      const base = ensureCloudPacked(seriesIndex, s);
      const before = base.count;
      const next = appendPackedPointCloud3D(base.packed, base.count, newPoints, {
        valueOverride: s.colorBy?.values,
      });
      cloudPackedByIndex[seriesIndex] = next;
      // Keep seed identities so setOption with same data + value channel preserves appends
      cloudSeedByIndex[seriesIndex] = cloudSeedFromSeries(s);
      callbacks?.onRequestRender?.();
      const aabb = next.aabb;
      return {
        appended: next.count - before,
        totalCount: next.count,
        xExtent: {
          min: aabb ? aabb.min[0] : 0,
          max: aabb ? aabb.max[0] : 0,
        },
      };
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

// silence unused RenderMode import if tree-shaken
void (0 as unknown as RenderMode);
