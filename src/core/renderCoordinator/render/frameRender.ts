/**
 * Frame render ownership — GPU pass planning + series prepare/draw + encode helpers.
 *
 * Coordinator impl owns domains/tooltips/DOM labels; this module owns:
 * - pass-graph planning (order, direct resolve, texture needs)
 * - series prepare / compute encode / series draw helpers
 *
 * @module frameRender
 * @internal
 */

import {
  prepareSeries,
  hasDenseHairlineLines,
  hasDenseDeferredArea,
  hasDenseDeferredScatter,
  hasNonDeferredMainSeriesContent,
  renderDenseHairlineLines,
  renderDenseDeferredArea,
  renderDenseDeferredScatter,
  renderSeries,
  encodeDecimationCompute,
  encodeScatterDensityCompute,
  renderAboveSeriesAnnotations,
  createStackedMountainCache,
  invalidateStackedMountainCache,
  createStepExpandCache,
  invalidateStepExpandCache,
  type SeriesRenderers,
  type SeriesPrepareContext,
  type SeriesRenderContext,
  type LastSetSeriesCache,
  type SeriesPreparationResult,
  type AnnotationRenderers,
} from './renderSeries';

// Production surface: re-export only symbols imported by createRenderCoordinatorImpl.
export {
  prepareSeries,
  hasDenseHairlineLines,
  hasDenseDeferredArea,
  hasDenseDeferredScatter,
  hasNonDeferredMainSeriesContent,
  renderDenseHairlineLines,
  renderDenseDeferredArea,
  renderDenseDeferredScatter,
  renderAboveSeriesAnnotations,
  createStackedMountainCache,
  invalidateStackedMountainCache,
  createStepExpandCache,
  invalidateStepExpandCache,
  type LastSetSeriesCache,
};
// StackedMountainCache type is used only via create/invalidate at coordinator call sites.

/**
 * Order of optional post-resolve dense pass relative to main resolve and overlay.
 * Pass id remains `denseHairline` for backward-compatible plan consumers; the pass
 * also hosts dense-compact scatter (sampleCount:1) when deferred.
 */
type FramePassId = 'main' | 'denseHairline' | 'annotationOverlay';

function resolveFramePassOrder(needsPostResolveDensePass: boolean): FramePassId[] {
  if (needsPostResolveDensePass) {
    return ['main', 'denseHairline', 'annotationOverlay'];
  }
  return ['main', 'annotationOverlay'];
}

/**
 * Whether UI overlays share the main pass (direct swapchain resolve) when there is
 * no post-resolve dense content and resolve+overlay can collapse.
 */
function shouldUseDirectSwapchainResolve(input: {
  readonly needsPostResolveDensePass: boolean;
  readonly preferDirectResolve: boolean;
}): boolean {
  return input.preferDirectResolve && !input.needsPostResolveDensePass;
}

/**
 * Planned GPU frame graph for one chart. Drives texture ensure + pass encoding.
 */
type GpuFramePlan = {
  readonly passOrder: readonly FramePassId[];
  /** True when a post-resolve sampleCount:1 pass runs (dense hairline and/or dense scatter). */
  readonly needsDenseHairlinePass: boolean;
  readonly useDirectSwapchainResolve: boolean;
  readonly useSwapchainAsMainView: boolean;
  readonly needResolveAndOverlay: boolean;
  readonly needMainColor: boolean;
};

/**
 * Plan the GPU pass graph from MSAA sample count and post-resolve dense eligibility
 * (dense hairline lines and/or dense-compact scatter).
 * Callers must use the returned flags for ensureTextures / beginRenderPass — not re-derive.
 */
export function planGpuFrame(input: {
  readonly msaaSampleCount: 1 | 4;
  readonly hasDenseHairline: boolean;
  /** Dense-compact scatter deferred out of 4× MSAA main (group 2 ≥250k). */
  readonly hasDenseScatter?: boolean;
  /** Dense mountain/area fill deferred out of 4× MSAA main (group 8 multi-M). */
  readonly hasDenseArea?: boolean;
}): GpuFramePlan {
  // Post-resolve dense pass only helps when main is 4× MSAA.
  const needsDenseHairlinePass =
    input.msaaSampleCount > 1 && (input.hasDenseHairline || !!input.hasDenseScatter || !!input.hasDenseArea);
  const passOrder = resolveFramePassOrder(needsDenseHairlinePass);
  const useDirectSwapchainResolve = shouldUseDirectSwapchainResolve({
    needsPostResolveDensePass: needsDenseHairlinePass,
    preferDirectResolve: true,
  });
  const useSwapchainAsMainView = useDirectSwapchainResolve && input.msaaSampleCount === 1;
  return {
    passOrder,
    needsDenseHairlinePass,
    useDirectSwapchainResolve,
    useSwapchainAsMainView,
    needResolveAndOverlay: !useDirectSwapchainResolve,
    needMainColor: !useSwapchainAsMainView,
  };
}

/**
 * Encode scatter-density + line-decimation compute before the main render pass.
 * Owned here so frame GPU work is not scattered without a single entry.
 */
export function encodeFrameComputePasses(
  poolState: SeriesRenderers,
  seriesForRender: SeriesPrepareContext['seriesForRender'],
  encoder: GPUCommandEncoder
): void {
  encodeScatterDensityCompute(poolState, seriesForRender, encoder);
  encodeDecimationCompute(poolState, seriesForRender, encoder);
}

/**
 * Draw series layers into the main pass (grid is caller's responsibility before this).
 */
export function encodeMainSeriesPass(
  poolState: SeriesRenderers,
  annotationRenderers: AnnotationRenderers,
  renderCtx: SeriesRenderContext,
  seriesPreparation: SeriesPreparationResult
): void {
  renderSeries(poolState, annotationRenderers, renderCtx, seriesPreparation);
}

/**
 * True when the planned graph includes a dense-hairline pass after main resolve.
 */
export function framePlanIncludesDenseHairline(plan: GpuFramePlan): boolean {
  return plan.passOrder.includes('denseHairline');
}

/**
 * True when the planned graph uses a separate annotation overlay MSAA pass.
 */
export function framePlanIncludesAnnotationOverlay(plan: GpuFramePlan): boolean {
  return plan.passOrder.includes('annotationOverlay') && !plan.useDirectSwapchainResolve;
}
