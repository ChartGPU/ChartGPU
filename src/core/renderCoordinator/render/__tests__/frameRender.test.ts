import { describe, it, expect } from 'vitest';
import { planGpuFrame, framePlanIncludesDenseHairline, framePlanIncludesAnnotationOverlay } from '../frameRender';
import { MAIN_SCENE_MSAA_SAMPLE_COUNT, ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT } from '../../gpu/textureManager';

describe('frameRender pass graph', () => {
  it('uses 4× MSAA for main and overlay (textureManager constants)', () => {
    expect(MAIN_SCENE_MSAA_SAMPLE_COUNT).toBe(4);
    expect(ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT).toBe(4);
  });

  it('planGpuFrame orders dense hairline after main and before overlay', () => {
    const withHair = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: true });
    expect(withHair.passOrder).toEqual(['main', 'denseHairline', 'annotationOverlay']);
    const noHair = planGpuFrame({ msaaSampleCount: 4, hasDenseHairline: false });
    expect(noHair.passOrder).toEqual(['main', 'annotationOverlay']);
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
});
