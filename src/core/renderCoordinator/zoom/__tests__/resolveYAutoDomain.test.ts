import { describe, it, expect } from 'vitest';
import { resolveYAutoDomainForPaint, animatedAlphaFromDtMs } from '../resolveYAutoDomain';
/** Keep in sync with stickyAutoDomain.ts private DEFAULT_CONTINUOUS_GROW_BY. */
const DEFAULT_CONTINUOUS_GROW_BY = 0.05;

describe('resolveYAutoDomainForPaint', () => {
  const data = { min: 0, max: 100 };

  it('sticky default holds after establish until breach', () => {
    const first = resolveYAutoDomainForPaint({
      dataDomain: data,
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: undefined,
      growBy: undefined,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: null,
      animatedDisplay: null,
    });
    expect(first.mode).toBe('sticky');
    expect(first.domain).toEqual({ min: 0, max: 100 });
    expect(first.nextSticky).toEqual({ min: 0, max: 100 });
    expect(first.nextAnimatedDisplay).toBeNull();

    const held = resolveYAutoDomainForPaint({
      dataDomain: { min: 0, max: 99 },
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'sticky',
      growBy: undefined,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: first.nextSticky,
      animatedDisplay: null,
    });
    expect(held.domain).toBe(first.nextSticky);
  });

  it('continuous tracks data every call and clears sticky', () => {
    const a = resolveYAutoDomainForPaint({
      dataDomain: data,
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: 0.1,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: { min: 0, max: 200 },
      animatedDisplay: { min: 0, max: 150 },
    });
    expect(a.mode).toBe('continuous');
    expect(a.nextSticky).toBeNull();
    expect(a.nextAnimatedDisplay).toBeNull();
    expect(a.domain.min).toBeCloseTo(-10, 10);
    expect(a.domain.max).toBeCloseTo(110, 10);

    const b = resolveYAutoDomainForPaint({
      dataDomain: { min: 0, max: 120 },
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: 0.1,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: null,
      animatedDisplay: null,
    });
    expect(b.domain.max).toBeGreaterThan(a.domain.max);
  });

  it('animated needsFrame until settled; clears sticky', () => {
    let display: { min: number; max: number } | null = { min: 0, max: 100 };
    let needsFrame = true;
    let last = display;
    for (let i = 0; i < 40 && needsFrame; i++) {
      const r = resolveYAutoDomainForPaint({
        dataDomain: { min: 0, max: 200 },
        explicitMin: undefined,
        explicitMax: undefined,
        autoRange: 'animated',
        growBy: 0,
        axisType: 'value',
        logBase: undefined,
        updateTransitionActive: false,
        sticky: { min: -1, max: 1 },
        animatedDisplay: display,
        animatedAlpha: 0.22,
      });
      expect(r.mode).toBe('animated');
      expect(r.nextSticky).toBeNull();
      display = r.nextAnimatedDisplay;
      last = r.domain;
      needsFrame = r.needsFrame;
    }
    expect(needsFrame).toBe(false);
    expect(last!.max).toBeCloseTo(200, 5);
  });

  it('explicit one-sided min disables continuous pad (returns data domain)', () => {
    const r = resolveYAutoDomainForPaint({
      dataDomain: { min: 0, max: 100 },
      explicitMin: 0,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: 0.2,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: { min: -10, max: 200 },
      animatedDisplay: { min: 0, max: 50 },
    });
    expect(r.mode).toBe('explicit');
    expect(r.domain).toEqual({ min: 0, max: 100 });
    expect(r.nextSticky).toBeNull();
    expect(r.nextAnimatedDisplay).toBeNull();
    expect(r.needsFrame).toBe(false);
  });

  it('transition clears sticky/animated and uses transition domain', () => {
    const r = resolveYAutoDomainForPaint({
      dataDomain: data,
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: undefined,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: true,
      transitionDomain: { min: 5, max: 15 },
      sticky: { min: 0, max: 100 },
      animatedDisplay: { min: 0, max: 100 },
    });
    expect(r.mode).toBe('transition');
    expect(r.domain).toEqual({ min: 5, max: 15 });
    expect(r.nextSticky).toBeNull();
    expect(r.nextAnimatedDisplay).toBeNull();
  });

  it('log continuous pads in log space', () => {
    const r = resolveYAutoDomainForPaint({
      dataDomain: { min: 1, max: 100 },
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: 0.1,
      axisType: 'log',
      logBase: 10,
      updateTransitionActive: false,
      sticky: null,
      animatedDisplay: null,
    });
    expect(r.mode).toBe('continuous');
    expect(r.domain.min).toBeLessThan(1);
    expect(r.domain.max).toBeGreaterThan(100);
    expect(r.domain.min).toBeGreaterThan(0);
  });

  it('continuous→sticky residue: sticky map must be cleared by nextSticky null', () => {
    const cont = resolveYAutoDomainForPaint({
      dataDomain: data,
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'continuous',
      growBy: DEFAULT_CONTINUOUS_GROW_BY,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: { min: 0, max: 500 },
      animatedDisplay: null,
    });
    expect(cont.nextSticky).toBeNull();
    // Caller deletes sticky when nextSticky is null — subsequent sticky starts cold.
    const sticky = resolveYAutoDomainForPaint({
      dataDomain: data,
      explicitMin: undefined,
      explicitMax: undefined,
      autoRange: 'sticky',
      growBy: undefined,
      axisType: 'value',
      logBase: undefined,
      updateTransitionActive: false,
      sticky: cont.nextSticky,
      animatedDisplay: null,
    });
    expect(sticky.domain).toEqual({ min: 0, max: 100 });
  });
});

describe('animatedAlphaFromDtMs', () => {
  it('returns 1 for non-positive / non-finite dt', () => {
    expect(animatedAlphaFromDtMs(0)).toBe(1);
    expect(animatedAlphaFromDtMs(-5)).toBe(1);
    expect(animatedAlphaFromDtMs(Number.NaN)).toBe(1);
  });

  it('increases with dt and is in (0,1]', () => {
    const a16 = animatedAlphaFromDtMs(16, 120);
    const a100 = animatedAlphaFromDtMs(100, 120);
    expect(a16).toBeGreaterThan(0);
    expect(a16).toBeLessThan(1);
    expect(a100).toBeGreaterThan(a16);
    expect(animatedAlphaFromDtMs(10_000, 120)).toBe(1);
  });
});
