/**
 * Pure helpers for 3D axis label placement (shared anchors for DOM + GPU paths)
 * and GPU glyph instance packing.
 */

import type { Mat4 } from './mat4';
import type { AABB } from './aabb';
import { projectWorldToCss } from './projectWorldToCss';
import { formatAxisTick3D } from './axisTicks3d';
import { lookupGlyph, type GlyphAtlas, type GlyphMetrics } from './glyphAtlas';
import type { Axes3DTickPlan } from '../../renderers/createAxisBox3DRenderer';
import type { ResolvedAxes3D } from '../../config/OptionResolver';

export type Axes3DLabelItem = Readonly<{
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly text: string;
  readonly title: boolean;
}>;

export type ResolvedAxes3DLabelMode = 'dom' | 'gpu';

/**
 * Resolve public `labelMode` to a concrete paint path.
 * - `dom` → always DOM
 * - `gpu` → GPU when atlas ready, else DOM (caller should warn on fallback)
 * - `auto` → prefer GPU when atlas init succeeded
 */
export function resolveAxes3DLabelMode(
  mode: 'auto' | 'dom' | 'gpu' | undefined,
  caps: Readonly<{ readonly atlasReady: boolean }>
): ResolvedAxes3DLabelMode {
  if (mode === 'dom') return 'dom';
  if (mode === 'gpu') return caps.atlasReady ? 'gpu' : 'dom';
  // auto (default)
  return caps.atlasReady ? 'gpu' : 'dom';
}

/** Same world anchors as the P6 DOM path. */
export function buildAxes3DLabelItems(aabb: AABB, plan: Axes3DTickPlan, axes: ResolvedAxes3D): Axes3DLabelItem[] {
  const [x0, y0, z0] = aabb.min;
  const [x1, y1, z1] = aabb.max;
  const items: Axes3DLabelItem[] = [];

  if (axes.x.visible) {
    for (const xv of plan.xTicks) {
      items.push({ x: xv, y: y0, z: z0, text: formatAxisTick3D(xv), title: false });
    }
    if (axes.x.name) {
      items.push({
        x: (x0 + x1) * 0.5,
        y: y0,
        z: z0 - Math.abs(z1 - z0) * 0.08,
        text: axes.x.name,
        title: true,
      });
    }
  }
  if (axes.y.visible) {
    for (const yv of plan.yTicks) {
      items.push({ x: x0, y: yv, z: z0, text: formatAxisTick3D(yv), title: false });
    }
    if (axes.y.name) {
      items.push({
        x: x0 - Math.abs(x1 - x0) * 0.08,
        y: (y0 + y1) * 0.5,
        z: z0,
        text: axes.y.name,
        title: true,
      });
    }
  }
  if (axes.z.visible) {
    for (const zv of plan.zTicks) {
      items.push({ x: x0, y: y0, z: zv, text: formatAxisTick3D(zv), title: false });
    }
    if (axes.z.name) {
      items.push({
        x: x0 - Math.abs(x1 - x0) * 0.08,
        y: y0,
        z: (z0 + z1) * 0.5,
        text: axes.z.name,
        title: true,
      });
    }
  }
  return items;
}

/** Stable signature for camera-only skip of instance rebuild. */
export function axes3DLabelPlanSignature(
  aabb: AABB,
  plan: Axes3DTickPlan,
  axes: ResolvedAxes3D,
  viewportCssW: number,
  viewportCssH: number,
  tickCssPx: number,
  titleCssPx: number
): string {
  const [x0, y0, z0] = aabb.min;
  const [x1, y1, z1] = aabb.max;
  return [
    x0,
    y0,
    z0,
    x1,
    y1,
    z1,
    plan.xTicks.join(','),
    plan.yTicks.join(','),
    plan.zTicks.join(','),
    axes.x.visible ? 1 : 0,
    axes.y.visible ? 1 : 0,
    axes.z.visible ? 1 : 0,
    axes.x.name,
    axes.y.name,
    axes.z.name,
    Math.round(viewportCssW),
    Math.round(viewportCssH),
    tickCssPx,
    titleCssPx,
  ].join('|');
}

/**
 * Whether GPU label instances must be rebuilt (plan/AABB/viewport scale change).
 * Camera-only frames keep the same signature → false (uniforms-only).
 */
export function shouldRebuildAxes3DGpuLabelInstances(
  lastSignature: string,
  nextSignature: string,
  hasPrepared: boolean
): boolean {
  return !(hasPrepared && nextSignature === lastSignature);
}

/** Exclusive paint targets for a resolved label mode (never both). */
export function exclusiveAxes3DLabelPaint(mode: ResolvedAxes3DLabelMode): Readonly<{
  readonly gpu: boolean;
  readonly dom: boolean;
}> {
  return mode === 'gpu' ? { gpu: true, dom: false } : { gpu: false, dom: true };
}

/** One-line warn body for missing atlas glyphs (caller enforces warn-once). */
export function formatAxes3DMissingGlyphsWarning(missingChars: readonly string[]): string {
  const shown = missingChars
    .slice(0, 16)
    .map((c) => JSON.stringify(c))
    .join(', ');
  const more = missingChars.length > 16 ? '…' : '';
  return `ChartGPU 3D: axes3d GPU labels missing glyphs (showing '?'): ${shown}${more}`;
}

/** Instance stride in floats: world(3) + pxOffset(2) + halfSize(2) + uv(4) + pad(1) = 12. */
export const AXES3D_GPU_LABEL_INSTANCE_FLOATS = 12;
export const AXES3D_GPU_LABEL_INSTANCE_BYTES = AXES3D_GPU_LABEL_INSTANCE_FLOATS * 4;

export type BuildAxes3DGpuLabelInstancesResult = Readonly<{
  /** Interleaved instance floats (length = instanceCount * 12). */
  readonly instances: Float32Array;
  readonly instanceCount: number;
  /** Labels that survived frustum + overlap (for tests). */
  readonly labelCount: number;
  readonly missingChars: readonly string[];
}>;

export type BuildAxes3DGpuLabelInstancesOptions = Readonly<{
  readonly atlas: GlyphAtlas;
  readonly viewProj: Mat4;
  readonly viewportCssW: number;
  readonly viewportCssH: number;
  /** Tick label CSS px height. Default 10. */
  readonly tickCssPx?: number;
  /** Title CSS px height. Default 12. */
  readonly titleCssPx?: number;
  /** Hard cap on glyph instances. Default 4096. */
  readonly maxGlyphs?: number;
  /** When true, collect missing codepoints (warn once at caller). */
  readonly trackMissing?: boolean;
}>;

/**
 * Build GPU billboard glyph instances from label items.
 * Overlap culling matches DOM heuristic (pixel distance) using current projection,
 * but is **frozen until the next plan/AABB/viewport rebuild** (camera orbit does not
 * re-cull — intentional FPS tradeoff vs DOM, which re-culls every frame).
 * Glyph pixel offsets are camera-independent so orbit can keep geometry (viewProj only).
 * No hard frustum cull — VS hides behind-camera anchors so camera-only frames stay valid.
 */
export function buildAxes3DGpuLabelInstances(
  items: readonly Axes3DLabelItem[],
  options: BuildAxes3DGpuLabelInstancesOptions
): BuildAxes3DGpuLabelInstancesResult {
  const { atlas, viewProj } = options;
  const viewportCssW = options.viewportCssW;
  const viewportCssH = options.viewportCssH;
  const tickCssPx = options.tickCssPx ?? 10;
  const titleCssPx = options.titleCssPx ?? 12;
  const maxGlyphs = Math.max(0, Math.min(16384, options.maxGlyphs ?? 4096));
  const trackMissing = options.trackMissing !== false;

  const scaleFor = (title: boolean): number => {
    const target = title ? titleCssPx : tickCssPx;
    return target / Math.max(1e-6, atlas.bakeFontPx);
  };

  const missingSet = new Set<string>();
  const placed: { x: number; y: number }[] = [];
  // Pre-size for max glyphs
  const out = new Float32Array(maxGlyphs * AXES3D_GPU_LABEL_INSTANCE_FLOATS);
  let instanceCount = 0;
  let labelCount = 0;

  const pushGlyph = (
    worldX: number,
    worldY: number,
    worldZ: number,
    pxX: number,
    pxY: number,
    halfW: number,
    halfH: number,
    g: GlyphMetrics
  ): boolean => {
    if (instanceCount >= maxGlyphs) return false;
    const o = instanceCount * AXES3D_GPU_LABEL_INSTANCE_FLOATS;
    out[o] = worldX;
    out[o + 1] = worldY;
    out[o + 2] = worldZ;
    out[o + 3] = pxX;
    out[o + 4] = pxY;
    out[o + 5] = halfW;
    out[o + 6] = halfH;
    out[o + 7] = g.u0;
    out[o + 8] = g.v0;
    out[o + 9] = g.u1;
    out[o + 10] = g.v1;
    out[o + 11] = 0;
    instanceCount++;
    return true;
  };

  for (const it of items) {
    if (!it.text) continue;
    const p = projectWorldToCss(viewProj, it.x, it.y, it.z, viewportCssW, viewportCssH);

    // Overlap only when projection is usable; still emit labels if behind camera
    // so camera-only orbit does not permanently drop them.
    if (p.visible) {
      let overlap = false;
      for (const q of placed) {
        if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < (it.title ? 400 : 196)) {
          overlap = true;
          break;
        }
      }
      if (overlap && !it.title) continue;
    }

    const scale = scaleFor(it.title);
    // Measure string width in CSS px for centering
    let totalAdvance = 0;
    const glyphs: Array<{ g: GlyphMetrics; advance: number }> = [];
    for (const ch of it.text) {
      const g = lookupGlyph(atlas, ch);
      if (!g) {
        if (trackMissing) missingSet.add(ch);
        // try '?' once
        const q = lookupGlyph(atlas, '?');
        if (!q) continue;
        glyphs.push({ g: q, advance: q.advancePx * scale });
        totalAdvance += q.advancePx * scale;
        continue;
      }
      const adv = g.advancePx * scale;
      glyphs.push({ g, advance: adv });
      totalAdvance += adv;
    }
    if (glyphs.length === 0) continue;

    // Baseline / vertical: center string vertically around anchor (DOM uses translate -50%,-50%)
    const lineH = atlas.lineHeightPx * scale;
    const baselineY = lineH * 0.25; // slight optical center

    let penX = -totalAdvance * 0.5;
    let allOk = true;
    for (const { g, advance } of glyphs) {
      const w = g.widthPx * scale;
      const h = g.heightPx * scale;
      const halfW = w * 0.5;
      const halfH = h * 0.5;
      // Glyph bitmap top-left relative to pen (CSS y down)
      const gx = penX + g.bearingXPx * scale;
      const gy = baselineY - g.bearingYPx * scale;
      const cx = gx + halfW;
      const cy = gy + halfH;
      if (!pushGlyph(it.x, it.y, it.z, cx, cy, halfW, halfH, g)) {
        allOk = false;
        break;
      }
      penX += advance;
    }
    if (!allOk && instanceCount >= maxGlyphs) break;

    if (p.visible) placed.push({ x: p.x, y: p.y });
    labelCount++;
  }

  return {
    instances:
      instanceCount > 0 ? out.subarray(0, instanceCount * AXES3D_GPU_LABEL_INSTANCE_FLOATS) : new Float32Array(0),
    instanceCount,
    labelCount,
    missingChars: [...missingSet],
  };
}
