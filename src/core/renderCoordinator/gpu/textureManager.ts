/**
 * GPU texture management for the RenderCoordinator.
 *
 * Handles lazy allocation of render target textures and MSAA overlay management.
 * Uses a **2-pass** rendering strategy (Phase 4b — no third single-sample top pass):
 * 1. Main scene → 4× MSAA texture, resolved to single-sample mainResolveTexture
 * 2. Overlay 4× MSAA: blit resolved main → above-series annotations → axes/crosshair/highlight
 *    → resolve to swapchain
 *
 * @module textureManager
 */

import { createRenderPipeline } from '../../../renderers/rendererUtils';
import type { PipelineCache } from '../../PipelineCache';

/**
 * MSAA sample count for the main scene render pass.
 * All series renderers (line, area, bar, scatter, etc.) and the grid
 * must create pipelines with this sample count.
 *
 * WebGPU only allows multisample counts of **1 or 4** (portable). A prior
 * residual attempt used 2× for fill-rate; that fails validation on Chrome
 * (`Invalid CommandBuffer` / invalid texture sampleCount) and is not legal.
 * Keep main + overlay at 4×. Dense high-N lines use a **post-resolve
 * sampleCount:1 hairline pass** (see `renderDenseHairlineLines`) so unsorted
 * full rewrites do not pay 4× MSAA overdraw on every segment.
 */
export const MAIN_SCENE_MSAA_SAMPLE_COUNT = 4;

/**
 * MSAA sample count for annotation overlay pass.
 * Higher values reduce aliasing but increase memory/performance cost.
 */
export const ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT = 4;

/**
 * Blit shader for copying main color texture to MSAA target.
 * Uses textureLoad (no filtering) for pixel-exact copy.
 */
const OVERLAY_BLIT_WGSL = `
struct VSOut { @builtin(position) pos: vec4f };

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var o: VSOut;
  o.pos = vec4f(positions[i], 0.0, 1.0);
  return o;
}

// Using textureLoad (no filtering) for pixel-exact blit into the MSAA overlay pass.
@group(0) @binding(0) var srcTex: texture_2d<f32>;

@fragment
fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let xy = vec2<i32>(pos.xy);
  return textureLoad(srcTex, xy, 0);
}
`;

/**
 * Texture manager state exposed to the render coordinator.
 */
export interface TextureManagerState {
  readonly mainColorView: GPUTextureView | null;
  /** Single-sample resolve target for the MSAA main pass. Used by the overlay blit. */
  readonly mainResolveView: GPUTextureView | null;
  readonly overlayMsaaView: GPUTextureView | null;
  readonly overlayBlitBindGroup: GPUBindGroup | null;
  readonly overlayBlitPipeline: GPURenderPipeline;
  readonly msaaSampleCount: number;
  /** MSAA sample count for the main scene render pass. */
  readonly mainSceneMsaaSampleCount: number;
}

/**
 * Internal mutable state for texture management.
 */
interface InternalState {
  mainColorTexture: GPUTexture | null;
  mainColorView: GPUTextureView | null;
  /** Single-sample resolve target for the MSAA main pass. */
  mainResolveTexture: GPUTexture | null;
  mainResolveView: GPUTextureView | null;
  overlayMsaaTexture: GPUTexture | null;
  overlayMsaaView: GPUTextureView | null;
  overlayBlitBindGroup: GPUBindGroup | null;
  overlayTargetsWidth: number;
  overlayTargetsHeight: number;
  overlayTargetsFormat: GPUTextureFormat | null;
}

/**
 * Configuration for texture manager creation.
 */
export interface TextureManagerConfig {
  readonly device: GPUDevice;
  readonly targetFormat: GPUTextureFormat;
  readonly pipelineCache?: PipelineCache;
  /**
   * MSAA sample count for main + overlay targets (WebGPU portable: 1 or 4 only).
   * Defaults to {@link MAIN_SCENE_MSAA_SAMPLE_COUNT} (4). Pass 1 when
   * `options.antialias === false` for multi-chart / streaming grids.
   */
  readonly sampleCount?: 1 | 4;
}

/**
 * Texture manager interface returned by factory function.
 */
export interface TextureManager {
  /**
   * Ensures textures are allocated for the given dimensions.
   * Reallocates if size or format changes.
   *
   * @param width - Canvas width in device pixels
   * @param height - Canvas height in device pixels
   * @param options.needResolveAndOverlay - When false (direct swapchain resolve path),
   *   only the main 4× MSAA color target is allocated. When true (dense-hairline /
   *   2-pass path), also allocate mainResolve + overlay MSAA + blit bind group.
   *   Default true for backward compatibility.
   */
  ensureTextures(
    width: number,
    height: number,
    options?: {
      readonly needResolveAndOverlay?: boolean;
      /** When false, skip main MSAA color (sampleCount-1 direct-to-swapchain path). Default true. */
      readonly needMainColor?: boolean;
    }
  ): void;

  /**
   * Gets current texture manager state for rendering.
   *
   * @returns Current state with texture views and bind groups
   */
  getState(): TextureManagerState;

  /**
   * Disposes all GPU resources.
   * Textures, views, and bind groups are destroyed.
   */
  dispose(): void;
}

/**
 * Safely destroys a GPU texture.
 * Best-effort: swallows exceptions if texture is already destroyed or invalid.
 *
 * @param tex - Texture to destroy or null
 */
function destroyTexture(tex: GPUTexture | null): void {
  if (!tex) return;
  try {
    tex.destroy();
  } catch {
    // best-effort: texture may already be destroyed or invalid
  }
}

/**
 * Creates a texture manager for render target allocation and management.
 *
 * The texture manager uses lazy allocation: textures are only created when
 * first requested via ensureTextures(), and are reallocated if dimensions
 * or format change.
 *
 * **Architecture:**
 * - Main color texture: 4× MSAA render target for main scene
 * - Main resolve texture: Single-sample resolve target (read by overlay blit)
 * - Overlay MSAA texture: Multi-sample render target for annotations
 * - Blit pipeline: Copies resolved main scene to MSAA target for overlay pass
 *
 * @param config - Configuration with device and target format
 * @returns Texture manager instance
 */
export function createTextureManager(config: TextureManagerConfig): TextureManager {
  const { device, targetFormat } = config;
  const sampleCount: 1 | 4 = config.sampleCount === 1 ? 1 : 4;

  // Internal mutable state
  const state: InternalState = {
    mainColorTexture: null,
    mainColorView: null,
    mainResolveTexture: null,
    mainResolveView: null,
    overlayMsaaTexture: null,
    overlayMsaaView: null,
    overlayBlitBindGroup: null,
    overlayTargetsWidth: 0,
    overlayTargetsHeight: 0,
    overlayTargetsFormat: null,
  };

  // Create bind group layout for blit pipeline
  const overlayBlitBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
    ],
  });

  // Create blit pipeline for copying main color to MSAA target
  const overlayBlitPipeline = createRenderPipeline(
    device,
    {
      label: 'textureManager/overlayBlitPipeline',
      bindGroupLayouts: [overlayBlitBindGroupLayout],
      vertex: {
        code: OVERLAY_BLIT_WGSL,
        label: 'textureManager/overlayBlit.wgsl',
      },
      fragment: {
        code: OVERLAY_BLIT_WGSL,
        label: 'textureManager/overlayBlit.wgsl',
        formats: targetFormat,
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: sampleCount },
    },
    config.pipelineCache
  );

  /**
   * Ensures overlay textures are allocated for the given dimensions.
   * Reallocates if size or format changes.
   *
   * When `needResolveAndOverlay` is false (direct swapchain resolve), only the
   * main 4× MSAA color target is kept — multi-chart grids without dense hairline
   * avoid ~5× extra RT memory (resolve 1× + overlay MSAA 4×) per instance.
   */
  function ensureTextures(
    canvasWidthDevicePx: number,
    canvasHeightDevicePx: number,
    options?: {
      readonly needResolveAndOverlay?: boolean;
      readonly needMainColor?: boolean;
    }
  ): void {
    // Clamp dimensions to valid range [1, infinity)
    const w = Number.isFinite(canvasWidthDevicePx) ? Math.max(1, Math.floor(canvasWidthDevicePx)) : 1;
    const h = Number.isFinite(canvasHeightDevicePx) ? Math.max(1, Math.floor(canvasHeightDevicePx)) : 1;
    const needResolveAndOverlay = options?.needResolveAndOverlay !== false;
    const needMainColor = options?.needMainColor !== false;

    const sizeOk =
      state.overlayTargetsWidth === w &&
      state.overlayTargetsHeight === h &&
      state.overlayTargetsFormat === targetFormat;
    const mainOk = !needMainColor || !!state.mainColorTexture;
    const resolveOverlayOk =
      !needResolveAndOverlay ||
      (state.mainResolveTexture && state.overlayMsaaTexture && state.overlayBlitBindGroup);

    if (sizeOk && mainOk && resolveOverlayOk) {
      // Free unused targets when path switches to leaner modes.
      let freed = false;
      if (!needMainColor && state.mainColorTexture) {
        destroyTexture(state.mainColorTexture);
        state.mainColorTexture = null;
        state.mainColorView = null;
        freed = true;
      }
      if (!needResolveAndOverlay && (state.mainResolveTexture || state.overlayMsaaTexture)) {
        destroyTexture(state.mainResolveTexture);
        destroyTexture(state.overlayMsaaTexture);
        state.mainResolveTexture = null;
        state.mainResolveView = null;
        state.overlayMsaaTexture = null;
        state.overlayMsaaView = null;
        state.overlayBlitBindGroup = null;
        freed = true;
      }
      if (freed) cachedState = null;
      return;
    }

    // Destroy old textures before allocating new ones
    destroyTexture(state.mainColorTexture);
    destroyTexture(state.mainResolveTexture);
    destroyTexture(state.overlayMsaaTexture);
    state.mainColorTexture = null;
    state.mainColorView = null;
    state.mainResolveTexture = null;
    state.mainResolveView = null;
    state.overlayMsaaTexture = null;
    state.overlayMsaaView = null;
    state.overlayBlitBindGroup = null;

    if (needMainColor) {
      // Allocate main color texture (MSAA render target).
      // RENDER_ATTACHMENT only — multisampled textures cannot have TEXTURE_BINDING.
      state.mainColorTexture = device.createTexture({
        label: 'textureManager/mainColorTexture',
        size: { width: w, height: h },
        sampleCount,
        format: targetFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      state.mainColorView = state.mainColorTexture.createView();
    }

    if (needResolveAndOverlay) {
      // Allocate single-sample resolve target for the MSAA main pass.
      // This receives the resolved result and is read by the overlay blit pipeline.
      state.mainResolveTexture = device.createTexture({
        label: 'textureManager/mainResolveTexture',
        size: { width: w, height: h },
        format: targetFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      state.mainResolveView = state.mainResolveTexture.createView();

      // Allocate MSAA overlay texture (multi-sample)
      state.overlayMsaaTexture = device.createTexture({
        label: 'textureManager/annotationOverlayMsaaTexture',
        size: { width: w, height: h },
        sampleCount,
        format: targetFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      state.overlayMsaaView = state.overlayMsaaTexture.createView();

      // Create bind group for blit pipeline — reads from the resolved (single-sample) texture.
      state.overlayBlitBindGroup = device.createBindGroup({
        label: 'textureManager/overlayBlitBindGroup',
        layout: overlayBlitBindGroupLayout,
        entries: [{ binding: 0, resource: state.mainResolveView }],
      });
    }

    // Update cached dimensions and format
    state.overlayTargetsWidth = w;
    state.overlayTargetsHeight = h;
    state.overlayTargetsFormat = targetFormat;

    // Invalidate cached getState snapshot after reallocation.
    cachedState = null;
  }

  // Cached getState snapshot — avoids per-frame object allocation.
  // Invalidated only when ensureTextures() reallocates resources.
  let cachedState: TextureManagerState | null = null;

  /**
   * Gets current texture manager state for rendering.
   * Returns a cached object to avoid per-frame allocations.
   * The cache is invalidated when ensureTextures() reallocates.
   */
  function getState(): TextureManagerState {
    if (!cachedState) {
      cachedState = {
        mainColorView: state.mainColorView,
        mainResolveView: state.mainResolveView,
        overlayMsaaView: state.overlayMsaaView,
        overlayBlitBindGroup: state.overlayBlitBindGroup,
        overlayBlitPipeline,
        msaaSampleCount: sampleCount,
        mainSceneMsaaSampleCount: sampleCount,
      };
    }
    return cachedState;
  }

  /**
   * Disposes all GPU resources.
   */
  function dispose(): void {
    destroyTexture(state.mainColorTexture);
    destroyTexture(state.mainResolveTexture);
    destroyTexture(state.overlayMsaaTexture);

    // Clear references
    state.mainColorTexture = null;
    state.mainColorView = null;
    state.mainResolveTexture = null;
    state.mainResolveView = null;
    state.overlayMsaaTexture = null;
    state.overlayMsaaView = null;
    state.overlayBlitBindGroup = null;
    state.overlayTargetsWidth = 0;
    state.overlayTargetsHeight = 0;
    state.overlayTargetsFormat = null;
    cachedState = null;
  }

  return {
    ensureTextures,
    getState,
    dispose,
  };
}
