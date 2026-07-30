import { describe, it, expect } from 'vitest';
import {
  applyStickyAutoDomain,
  applyStickyAutoLogDomain,
  applyContinuousAutoDomain,
  applyContinuousAutoLogDomain,
  stepAnimatedAutoDomain,
  resolveAutoRangeMode,
  resolveStickyOrDataDomain,
  shouldApplyStickyAutoDomain,
  shouldSkipStickyAutoXDomain,
} from '../stickyAutoDomain';

/** Keep in sync with stickyAutoDomain.ts private DEFAULT_CONTINUOUS_GROW_BY. */
const DEFAULT_CONTINUOUS_GROW_BY = 0.05;

describe('applyStickyAutoDomain', () => {
  it('establishes exact data domain (no pad) so static charts fill the plot', () => {
    // Column/mountain suite: 0..100k must map to full plot width (not 0..110k).
    const next = applyStickyAutoDomain({ min: 0, max: 100_000 }, null, 0.1);
    expect(next.min).toBe(0);
    expect(next.max).toBe(100_000);
  });

  it('reuses sticky while data stays inside domain (static / slow growth)', () => {
    const sticky = applyStickyAutoDomain({ min: 0, max: 100_000 }, null, 0.1);
    const mid = applyStickyAutoDomain({ min: 0, max: 99_000 }, sticky, 0.1);
    expect(mid).toBe(sticky);
    expect(mid.max).toBe(100_000);
  });

  it('compression min=0 growing max reuses sticky after growBy expand', () => {
    // Unbounded series compression: establish exact, first breach pads, then reuse.
    let sticky = applyStickyAutoDomain({ min: 0, max: 1_000_000 }, null, 0.1);
    expect(sticky.max).toBe(1_000_000);
    sticky = applyStickyAutoDomain({ min: 0, max: 1_000_001 }, sticky, 0.1);
    const afterBreach = sticky;
    expect(afterBreach.max).toBeGreaterThan(1_000_001);
    for (let max = 1_000_001; max <= afterBreach.max; max += 1_000) {
      sticky = applyStickyAutoDomain({ min: 0, max }, sticky, 0.1);
    }
    expect(sticky).toBe(afterBreach);
    expect(sticky.min).toBe(0);
  });

  it('expands max with fresh headroom when data breaches sticky max', () => {
    const sticky = applyStickyAutoDomain({ min: 0, max: 100_000 }, null, 0.1);
    expect(sticky.max).toBe(100_000);
    const next = applyStickyAutoDomain({ min: 0, max: 100_001 }, sticky, 0.1);
    expect(next.min).toBe(0);
    // span at breach ≈ 100001 → pad ≈ 10000.1 → max ≈ 110001.1
    expect(next.max).toBeCloseTo(100_001 + 100_001 * 0.1, 5);
  });

  it('X headroom 0 tracks exact max so streaming stays full-width (no empty-right gutter)', () => {
    // Ultimate-benchmark pattern: generate N points, then append forever with auto X.
    // Non-zero headroom left ~10% empty on the right that filled then re-jumped.
    let sticky = applyStickyAutoDomain({ min: 0, max: 100_000 }, null, 0);
    expect(sticky.max).toBe(100_000);
    sticky = applyStickyAutoDomain({ min: 0, max: 100_001 }, sticky, 0);
    expect(sticky.min).toBe(0);
    expect(sticky.max).toBe(100_001);
    sticky = applyStickyAutoDomain({ min: 0, max: 1_270_000 }, sticky, 0);
    expect(sticky.max).toBe(1_270_000);
    // Static frame reuses identity once max stops growing.
    const held = applyStickyAutoDomain({ min: 0, max: 1_270_000 }, sticky, 0);
    expect(held).toBe(sticky);
  });

  it('expands min with headroom when data breaches sticky min', () => {
    const sticky = { min: 0, max: 100 };
    const next = applyStickyAutoDomain({ min: -10, max: 90 }, sticky, 0.1);
    expect(next.max).toBe(100);
    // span = 100, pad = 10 → min = -10 - 10 = -20
    expect(next.min).toBeCloseTo(-20, 5);
  });

  it('is identity-stable across many in-range frames (overlay memo)', () => {
    let sticky = applyStickyAutoDomain({ min: 0, max: 1000 }, null, 0.1);
    // Breach once to get headroom, then stay inside
    sticky = applyStickyAutoDomain({ min: 0, max: 1001 }, sticky, 0.1);
    const first = sticky;
    for (let n = 1001; n <= first.max; n += 10) {
      sticky = applyStickyAutoDomain({ min: 0, max: n }, sticky, 0.1);
    }
    expect(sticky).toBe(first);
  });

  it('follows sliding data min (FIFO maxPoints drop-oldest) instead of freezing origin', () => {
    const sticky = applyStickyAutoDomain({ min: 0, max: 100_000 }, null, 0.1);
    expect(sticky.min).toBe(0);
    expect(sticky.max).toBe(100_000);
    // Window slides past sticky max: min must follow, not stay 0.
    const slid = applyStickyAutoDomain({ min: 50_000, max: 150_000 }, sticky, 0.1);
    expect(slid.min).toBe(50_000);
    expect(slid.max).toBeGreaterThan(150_000);
    // Inside sticky range slide: exact re-establish of window (no pad).
    const mid = applyStickyAutoDomain({ min: 20_000, max: 90_000 }, sticky, 0.1);
    expect(mid.min).toBe(20_000);
    expect(mid.max).toBe(90_000);
  });

  it('autoScroll-off windowed series: repeated min slides keep domain on window', () => {
    let sticky: { min: number; max: number } | null = null;
    sticky = applyStickyAutoDomain({ min: 0, max: 1000 }, sticky, 0.1);
    for (let i = 1; i <= 5; i++) {
      const wMin = i * 200;
      const wMax = wMin + 1000;
      sticky = applyStickyAutoDomain({ min: wMin, max: wMax }, sticky, 0.1);
      expect(sticky.min).toBe(wMin);
      // Span stays ~1000; domain should not stretch back to historical 0.
      expect(sticky.max - sticky.min).toBeLessThan(1000 * 1.25);
    }
  });

  it('passes through non-finite data domain without inventing bounds', () => {
    const next = applyStickyAutoDomain({ min: Number.NaN, max: 10 }, null, 0.1);
    expect(Number.isNaN(next.min)).toBe(true);
    expect(next.max).toBe(10);
  });

  it('expands min=max data to a unit span after sticky normalize', () => {
    const next = applyStickyAutoDomain({ min: 5, max: 5 }, null, 0.1);
    expect(next.min).toBe(5);
    expect(next.max).toBe(6);
  });
});

describe('applyStickyAutoLogDomain', () => {
  it('establishes exact positive domain (no pad) on cold start', () => {
    const next = applyStickyAutoLogDomain({ min: 1, max: 1000 }, null, 10, 0);
    expect(next.min).toBeCloseTo(1, 10);
    expect(next.max).toBeCloseTo(1000, 10);
  });

  it('expands equal-span domains by base factor (not linear +1)', () => {
    // Linear sticky with headroom 0 expands min===max to min+1; log uses min*base.
    const next = applyStickyAutoLogDomain({ min: 5, max: 5 }, null, 10, 0);
    expect(next.min).toBeCloseTo(5, 10);
    expect(next.max).toBeCloseTo(50, 10);
  });

  it('with headroom 0 tracks data max tightly (log-X sticky policy)', () => {
    let sticky = applyStickyAutoLogDomain({ min: 1, max: 100 }, null, 10, 0);
    sticky = applyStickyAutoLogDomain({ min: 1, max: 200 }, sticky, 10, 0);
    expect(sticky.min).toBeCloseTo(1, 10);
    expect(sticky.max).toBeCloseTo(200, 10);
  });
});

describe('shouldApplyStickyAutoDomain (coordinator any-explicit gate)', () => {
  it('applies only when both ends are auto', () => {
    expect(shouldApplyStickyAutoDomain(undefined, undefined)).toBe(true);
  });

  it('skips when only min is explicit', () => {
    expect(shouldApplyStickyAutoDomain(0, undefined)).toBe(false);
  });

  it('skips when only max is explicit', () => {
    expect(shouldApplyStickyAutoDomain(undefined, 100)).toBe(false);
  });

  it('skips when both ends are explicit', () => {
    expect(shouldApplyStickyAutoDomain(-10, 10)).toBe(false);
  });
});

describe('shouldSkipStickyAutoXDomain (autoScroll + explicit gate)', () => {
  it('skips sticky X when autoScroll is true (FIFO suite path)', () => {
    expect(shouldSkipStickyAutoXDomain(true, undefined, undefined)).toBe(true);
  });

  it('allows sticky X when autoScroll is false/undefined and both ends auto', () => {
    expect(shouldSkipStickyAutoXDomain(false, undefined, undefined)).toBe(false);
    expect(shouldSkipStickyAutoXDomain(undefined, undefined, undefined)).toBe(false);
  });

  it('skips when autoScroll is off but one-sided X is explicit', () => {
    expect(shouldSkipStickyAutoXDomain(false, 0, undefined)).toBe(true);
    expect(shouldSkipStickyAutoXDomain(false, undefined, 1e6)).toBe(true);
  });
});

describe('resolveStickyOrDataDomain (read-path sticky vs data)', () => {
  const data = { min: 0, max: 100_000 };
  const sticky = { min: 0, max: 110_000 };

  it('returns data domain when skipSticky (autoScroll / explicit ends)', () => {
    const next = resolveStickyOrDataDomain(data, sticky, { skipSticky: true });
    expect(next).toEqual(data);
    expect(next).not.toBe(sticky);
  });

  it('returns sticky when present and skipSticky is false', () => {
    const next = resolveStickyOrDataDomain(data, sticky, { skipSticky: false });
    expect(next).toBe(sticky);
    expect(next.max).toBe(110_000);
  });

  it('falls back to data when sticky is null', () => {
    const next = resolveStickyOrDataDomain(data, null, { skipSticky: false });
    expect(next).toEqual(data);
  });

  it('falls back to data when sticky has non-finite ends', () => {
    const next = resolveStickyOrDataDomain(data, { min: Number.NaN, max: 1 }, { skipSticky: false });
    expect(next).toEqual(data);
  });

  it('matches paint gates: skipSticky = shouldSkipStickyAutoXDomain(...)', () => {
    // autoScroll on → read path must not use sticky headroom
    const skip = shouldSkipStickyAutoXDomain(true, undefined, undefined);
    expect(resolveStickyOrDataDomain(data, sticky, { skipSticky: skip })).toEqual(data);
    // both ends auto, autoScroll off → sticky applies
    const allow = shouldSkipStickyAutoXDomain(false, undefined, undefined);
    expect(resolveStickyOrDataDomain(data, sticky, { skipSticky: allow })).toBe(sticky);
  });
});

describe('resolveAutoRangeMode', () => {
  it('defaults unknown / omitted to sticky', () => {
    expect(resolveAutoRangeMode(undefined)).toBe('sticky');
    expect(resolveAutoRangeMode('nope')).toBe('sticky');
    expect(resolveAutoRangeMode(1)).toBe('sticky');
  });

  it('accepts sticky | continuous | animated', () => {
    expect(resolveAutoRangeMode('sticky')).toBe('sticky');
    expect(resolveAutoRangeMode('continuous')).toBe('continuous');
    expect(resolveAutoRangeMode('animated')).toBe('animated');
  });
});

describe('applyContinuousAutoDomain', () => {
  it('tracks data every call with default growBy pad (not sticky freeze)', () => {
    const a = applyContinuousAutoDomain({ min: 0, max: 100 });
    expect(a.min).toBeCloseTo(0 - 100 * DEFAULT_CONTINUOUS_GROW_BY, 10);
    expect(a.max).toBeCloseTo(100 + 100 * DEFAULT_CONTINUOUS_GROW_BY, 10);

    const b = applyContinuousAutoDomain({ min: 0, max: 120 });
    expect(b.max).toBeCloseTo(120 + 120 * DEFAULT_CONTINUOUS_GROW_BY, 10);
    // Unlike sticky, intermediate domain is not held — always derived from data.
    expect(b.max).toBeGreaterThan(a.max);
  });

  it('respects growBy number and tuple', () => {
    const single = applyContinuousAutoDomain({ min: 0, max: 100 }, 0.1);
    expect(single.min).toBeCloseTo(-10, 10);
    expect(single.max).toBeCloseTo(110, 10);

    const tuple = applyContinuousAutoDomain({ min: 0, max: 100 }, [0, 0.2]);
    expect(tuple.min).toBe(0);
    expect(tuple.max).toBeCloseTo(120, 10);
  });

  it('handles equal / non-finite domains', () => {
    const eq = applyContinuousAutoDomain({ min: 5, max: 5 }, 0);
    expect(eq.min).toBeLessThan(eq.max);
    const bad = applyContinuousAutoDomain({ min: Number.NaN, max: 1 });
    expect(Number.isNaN(bad.min)).toBe(true);
  });
});

describe('applyContinuousAutoLogDomain', () => {
  it('pads in log space', () => {
    const next = applyContinuousAutoLogDomain({ min: 1, max: 100 }, 10, 0.1);
    expect(next.min).toBeLessThan(1);
    expect(next.max).toBeGreaterThan(100);
    expect(next.min).toBeGreaterThan(0);
  });
});

describe('stepAnimatedAutoDomain', () => {
  it('snaps on cold start (null display)', () => {
    const { domain, settled } = stepAnimatedAutoDomain(null, { min: 0, max: 100 }, 0.22);
    expect(domain).toEqual({ min: 0, max: 100 });
    expect(settled).toBe(true);
  });

  it('lerps toward target and eventually settles', () => {
    let display: { min: number; max: number } | null = { min: 0, max: 100 };
    const target = { min: 0, max: 200 };
    let settled = false;
    for (let i = 0; i < 40; i++) {
      const step = stepAnimatedAutoDomain(display, target, 0.22);
      display = step.domain;
      settled = step.settled;
      if (settled) break;
    }
    expect(settled).toBe(true);
    expect(display!.min).toBeCloseTo(0, 6);
    expect(display!.max).toBeCloseTo(200, 6);
  });

  it('alpha 1 snaps immediately', () => {
    const { domain, settled } = stepAnimatedAutoDomain({ min: 0, max: 10 }, { min: 0, max: 100 }, 1);
    expect(domain).toEqual({ min: 0, max: 100 });
    expect(settled).toBe(true);
  });
});

describe('sticky default vs continuous (multi-layer policy)', () => {
  it('sticky still freezes inside headroom while continuous tracks', () => {
    let sticky = applyStickyAutoDomain({ min: 0, max: 100 }, null, 0.1);
    sticky = applyStickyAutoDomain({ min: 0, max: 101 }, sticky, 0.1);
    // After breach, sticky holds with pad.
    const held = applyStickyAutoDomain({ min: 0, max: 105 }, sticky, 0.1);
    expect(held).toBe(sticky);

    const c1 = applyContinuousAutoDomain({ min: 0, max: 101 }, 0.1);
    const c2 = applyContinuousAutoDomain({ min: 0, max: 105 }, 0.1);
    expect(c2.max).toBeGreaterThan(c1.max);
  });
});

describe('continuous/animated edge cases', () => {
  it.each([
    [undefined, DEFAULT_CONTINUOUS_GROW_BY],
    [-1, DEFAULT_CONTINUOUS_GROW_BY],
    [Number.NaN, DEFAULT_CONTINUOUS_GROW_BY],
    [0, 0],
  ] as const)('invalid growBy %# falls back or applies', (growBy, expectedFrac) => {
    const d = applyContinuousAutoDomain({ min: 0, max: 100 }, growBy as number);
    expect(d.min).toBeCloseTo(0 - 100 * expectedFrac, 8);
    expect(d.max).toBeCloseTo(100 + 100 * expectedFrac, 8);
  });

  it('stepAnimatedAutoDomain clamps alpha to [0,1]', () => {
    const over = stepAnimatedAutoDomain({ min: 0, max: 10 }, { min: 0, max: 100 }, 2);
    expect(over.domain).toEqual({ min: 0, max: 100 });
    expect(over.settled).toBe(true);

    const under = stepAnimatedAutoDomain({ min: 0, max: 10 }, { min: 0, max: 100 }, -1);
    expect(under.domain).toEqual({ min: 0, max: 10 });
    expect(under.settled).toBe(false);
  });

  it('stepAnimatedAutoDomain treats non-finite display as cold start', () => {
    const r = stepAnimatedAutoDomain({ min: Number.NaN, max: 1 }, { min: 0, max: 50 }, 0.1);
    expect(r.domain).toEqual({ min: 0, max: 50 });
    expect(r.settled).toBe(true);
  });

  it('log continuous pad precision (decade span)', () => {
    const r = applyContinuousAutoLogDomain({ min: 10, max: 1000 }, 10, 0.1);
    // log10 span = 2; pad 0.1 decades each side → min ~ 10^(1-0.2)=6.309..., max ~ 10^(3+0.2)
    expect(r.min).toBeCloseTo(10 ** (1 - 0.2), 6);
    expect(r.max).toBeCloseTo(10 ** (3 + 0.2), 6);
  });
});
