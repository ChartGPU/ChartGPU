import { describe, it, expect, vi } from 'vitest';
import {
  planGpuFrame,
  framePlanIncludesDenseHairline,
  framePlanIncludesAnnotationOverlay,
  hasDenseHairlineLines,
  renderDenseHairlineLines,
  prepareSeries,
  encodeFrameComputePasses,
  encodeMainSeriesPass,
} from '../frameRender';
import { MAIN_SCENE_MSAA_SAMPLE_COUNT, ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT } from '../../gpu/textureManager';
import type { SeriesPrepareContext, SeriesRenderers } from '../renderSeries';

describe('frameRender pass graph', () => {
  it('uses legal MSAA sample counts (1|4 only; main + overlay constants are 4)', () => {
    expect(MAIN_SCENE_MSAA_SAMPLE_COUNT).toBe(4);
    expect(ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT).toBe(4);
  });

  it('planGpuFrame orders dense hairline after main and before overlay', () => {
    const withHair = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: true });
    expect(withHair.passOrder).toEqual(['main', 'denseHairline', 'annotationOverlay']);
    expect(framePlanIncludesDenseHairline(withHair)).toBe(true);
    expect(framePlanIncludesAnnotationOverlay(withHair)).toBe(true);
    expect(withHair.useDirectSwapchainResolve).toBe(false);
    expect(withHair.needResolveAndOverlay).toBe(true);

    const noHair = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: false });
    expect(noHair.passOrder).toEqual(['main', 'annotationOverlay']);
    expect(noHair.useDirectSwapchainResolve).toBe(true);
    expect(framePlanIncludesAnnotationOverlay(noHair)).toBe(false);
  });

  it('direct swapchain resolve only without dense hairline', () => {
    const direct = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: false });
    expect(direct.useDirectSwapchainResolve).toBe(true);
    const blocked = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: true });
    expect(blocked.useDirectSwapchainResolve).toBe(false);
  });

  it('planGpuFrame drives texture needs and pass inclusion', () => {
    const withHair = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: true });
    expect(withHair.needsDenseHairlinePass).toBe(true);
    expect(withHair.useDirectSwapchainResolve).toBe(false);
    expect(withHair.needResolveAndOverlay).toBe(true);
    expect(framePlanIncludesDenseHairline(withHair)).toBe(true);
    expect(framePlanIncludesAnnotationOverlay(withHair)).toBe(true);

    const direct = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: false });
    expect(direct.useDirectSwapchainResolve).toBe(true);
    expect(direct.needResolveAndOverlay).toBe(false);
    expect(framePlanIncludesAnnotationOverlay(direct)).toBe(false);

    const sample1 = planGpuFrame({ msaaSampleCount: 1, hasDenseHairline: true });
    expect(sample1.needsDenseHairlinePass).toBe(false);
    expect(sample1.useSwapchainAsMainView).toBe(true);
    expect(sample1.needMainColor).toBe(false);
  });

  it('dense-compact scatter alone opens post-resolve dense pass (group 2)', () => {
    const withScatter = planGpuFrame({
      msaaSampleCount: 4,
      hasDenseHairline: false,
      hasDenseScatter: true,
    });
    expect(withScatter.needsDenseHairlinePass).toBe(true);
    expect(withScatter.passOrder).toEqual(['main', 'denseHairline', 'annotationOverlay']);
    expect(withScatter.useDirectSwapchainResolve).toBe(false);

    const sample1Scatter = planGpuFrame({
      msaaSampleCount: 1,
      hasDenseHairline: false,
      hasDenseScatter: true,
    });
    expect(sample1Scatter.needsDenseHairlinePass).toBe(false);
  });

  it('both dense hairline and dense scatter still need post-resolve pass', () => {
    const both = planGpuFrame({
      msaaSampleCount: 4,
      hasDenseHairline: true,
      hasDenseScatter: true,
    });
    expect(both.needsDenseHairlinePass).toBe(true);
    expect(both.passOrder).toEqual(['main', 'denseHairline', 'annotationOverlay']);
    expect(both.useDirectSwapchainResolve).toBe(false);
  });

  it('exports series prepare/draw and encode helpers (frame ownership)', () => {
    expect(typeof prepareSeries).toBe('function');
    expect(typeof hasDenseHairlineLines).toBe('function');
    expect(typeof renderDenseHairlineLines).toBe('function');
    expect(typeof encodeFrameComputePasses).toBe('function');
    expect(typeof encodeMainSeriesPass).toBe('function');
  });

  it('WS2: encodeFrameComputePasses runs encodeCompute when needsEncode (before draw helpers)', () => {
    // Coordinator order (createRenderCoordinatorImpl): prepareSeries → encodeFrameComputePasses
    // → encodeMainSeriesPass / render passes. Assert compute encodes dirty instances
    // when needsEncode, and is a no-op when clean — same frame gate as production.
    const encodeCompute = vi.fn();
    const needsEncode = vi.fn(() => true);
    const encodeComputeClean = vi.fn();
    const needsEncodeClean = vi.fn(() => false);

    const dirtyCompute = { needsEncode, encodeCompute };
    const cleanCompute = { needsEncode: needsEncodeClean, encodeCompute: encodeComputeClean };

    const poolState = {
      decimationComputes: [dirtyCompute, cleanCompute],
      scatterDensityRenderers: [],
    } as unknown as SeriesRenderers;

    const seriesForRender = [
      { type: 'line', visible: true },
      { type: 'line', visible: true },
    ] as SeriesPrepareContext['seriesForRender'];

    // Minimal encoder: beginComputePass for the batch path.
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
    const encoder = {
      beginComputePass: vi.fn(() => pass),
    } as unknown as GPUCommandEncoder;

    encodeFrameComputePasses(poolState, seriesForRender, encoder);

    expect(needsEncode).toHaveBeenCalled();
    expect(encodeCompute).toHaveBeenCalledTimes(1);
    expect(encodeCompute).toHaveBeenCalledWith(encoder, pass);
    // Clean instance skipped (needsEncode false).
    expect(encodeComputeClean).not.toHaveBeenCalled();
    expect(pass.end).toHaveBeenCalledTimes(1);

    // encodeMainSeriesPass is the draw entry after encode — both must remain exported
    // and callable independently so prepare→encode→draw order is enforceable at call sites.
    expect(typeof encodeFrameComputePasses).toBe('function');
    expect(typeof encodeMainSeriesPass).toBe('function');
  });
});
