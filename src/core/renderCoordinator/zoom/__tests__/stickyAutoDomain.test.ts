import { describe, it, expect } from 'vitest';
import {
  applyStickyAutoDomain,
  resolveStickyOrDataDomain,
  shouldApplyStickyAutoDomain,
  shouldSkipStickyAutoXDomain,
} from '../stickyAutoDomain';

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
