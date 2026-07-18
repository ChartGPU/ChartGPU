import { describe, expect, it } from 'vitest';
import { createAxisScale, createLinearScale, createLogScale, normalizeLogBase, DEFAULT_LOG_BASE } from '../scales';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
  resolveLogProjection,
} from '../../renderers/packedXAffine';
import { sanitizeLogDomain } from '../../core/renderCoordinator/utils/boundsComputation';
import {
  formatLogTickValue,
  generateLogTicks,
  generateLogTicksForVisibleDomain,
} from '../../core/renderCoordinator/axis/computeAxisTicks';

describe('createLinearScale (kind continuous)', () => {
  it('exposes kind linear and getDomain/getRange', () => {
    const s = createLinearScale().domain(0, 10).range(0, 100);
    expect(s.kind).toBe('linear');
    expect(s.getDomain()).toEqual({ min: 0, max: 10 });
    expect(s.getRange()).toEqual({ min: 0, max: 100 });
    expect(s.scale(5)).toBe(50);
    expect(s.invert(50)).toBe(5);
  });
});

describe('createLogScale', () => {
  it('round-trips scale/invert for base 10 within float tolerance', () => {
    const s = createLogScale(10).domain(0.01, 1000).range(0, 400);
    for (const v of [0.01, 0.1, 1, 10, 100, 1000]) {
      const p = s.scale(v);
      const back = s.invert(p);
      expect(back / v).toBeCloseTo(1, 10);
    }
  });

  it('returns NaN for non-positive scale inputs', () => {
    const s = createLogScale().domain(1, 100).range(0, 1);
    expect(Number.isNaN(s.scale(0))).toBe(true);
    expect(Number.isNaN(s.scale(-1))).toBe(true);
  });

  it('supports base 2', () => {
    const s = createLogScale(2).domain(1, 16).range(0, 4);
    expect(s.scale(1)).toBeCloseTo(0, 10);
    expect(s.scale(16)).toBeCloseTo(4, 10);
    expect(s.scale(4)).toBeCloseTo(2, 10);
  });

  it('clamps each non-positive domain end independently', () => {
    // Preserve valid max when min is non-positive (not hard [1, 10]).
    const s = createLogScale(10).domain(-1, 100).range(0, 1);
    const d = s.getDomain();
    expect(d.min).toBe(1);
    expect(d.max).toBe(100);

    // Preserve valid min when max is non-positive.
    const s2 = createLogScale(10).domain(5, -1).range(0, 1);
    const d2 = s2.getDomain();
    expect(d2.min).toBe(5);
    expect(d2.max).toBe(10); // fallbackMax for base 10
  });

  it('maps equal decades to equal range spacing', () => {
    const s = createLogScale(10).domain(1, 1000).range(0, 300);
    const p1 = s.scale(1);
    const p10 = s.scale(10);
    const p100 = s.scale(100);
    const p1000 = s.scale(1000);
    expect(p10 - p1).toBeCloseTo(p100 - p10, 8);
    expect(p100 - p10).toBeCloseTo(p1000 - p100, 8);
  });
});

describe('normalizeLogBase', () => {
  it('defaults invalid bases to 10', () => {
    expect(normalizeLogBase(undefined)).toBe(DEFAULT_LOG_BASE);
    expect(normalizeLogBase(1)).toBe(10);
    expect(normalizeLogBase(-2)).toBe(10);
    expect(normalizeLogBase(Number.NaN)).toBe(10);
    expect(normalizeLogBase(2)).toBe(2);
  });
});

describe('createAxisScale', () => {
  it('returns log scale for type log', () => {
    const s = createAxisScale({ type: 'log', logBase: 10 });
    expect(s.kind).toBe('log');
    expect(s.base).toBe(10);
  });

  it('returns linear for value/time', () => {
    expect(createAxisScale({ type: 'value' }).kind).toBe('linear');
    expect(createAxisScale({ type: 'time' }).kind).toBe('linear');
  });
});

describe('generateLogTicks', () => {
  it('includes powers for [0.01, 1000] base 10', () => {
    const ticks = generateLogTicks(0.01, 1000, 10);
    expect(ticks).toEqual([0.01, 0.1, 1, 10, 100, 1000]);
  });

  it('handles reversed domain', () => {
    const ticks = generateLogTicks(1000, 0.01, 10);
    expect(ticks[0]).toBeLessThan(ticks[ticks.length - 1]!);
    expect(ticks).toContain(1);
  });

  it('handles base 2', () => {
    const ticks = generateLogTicks(1, 16, 2);
    expect(ticks).toEqual([1, 2, 4, 8, 16]);
  });

  it('handles non-positive domain with fallback', () => {
    const ticks = generateLogTicks(-5, 0, 10);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.every((t) => t > 0)).toBe(true);
  });

  it('uses domain endpoints for intra-decade domains (no surrounding powers)', () => {
    const ticks = generateLogTicks(2, 3, 10);
    expect(ticks).toEqual([2, 3]);
    // Surrounding powers 1 and 10 must not be emitted outside the domain.
    expect(ticks).not.toContain(1);
    expect(ticks).not.toContain(10);
  });
});

describe('generateLogTicksForVisibleDomain', () => {
  it('densifies intra-decade zoom [2e3, 8e3] with in-range intermediate ticks', () => {
    const ticks = generateLogTicksForVisibleDomain(2e3, 8e3, 10);
    // Must not fall back to only full-span powers (1e3/1e4 outside window).
    expect(ticks).not.toContain(1e3);
    expect(ticks).not.toContain(1e4);
    // All ticks inside the visible window.
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(2e3 * (1 - 1e-12));
      expect(t).toBeLessThanOrEqual(8e3 * (1 + 1e-12));
    }
    // More than bare endpoints — densified mantissas (2×/3×/5×…).
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks).toContain(2e3);
    expect(ticks).toContain(5e3);
    // Visible domain endpoints always merged (8e3 is not on 1/2/3/5/7 ladder).
    expect(ticks).toContain(8e3);
  });

  it('keeps integer-power majors when they fall inside the visible domain', () => {
    const ticks = generateLogTicksForVisibleDomain(500, 2e4, 10);
    expect(ticks).toContain(1e3);
    expect(ticks).toContain(1e4);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(500 * (1 - 1e-12));
      expect(t).toBeLessThanOrEqual(2e4 * (1 + 1e-12));
    }
  });

  it('uses classic decade majors for a wide multi-decade window (no forced densify clutter)', () => {
    const ticks = generateLogTicksForVisibleDomain(1, 1e5, 10);
    expect(ticks).toEqual([1, 10, 100, 1e3, 1e4, 1e5]);
  });

  it('matches generateLogTicks majors for full-span powers when domain has ≥3 powers', () => {
    const full = generateLogTicks(0.01, 1000, 10);
    const visible = generateLogTicksForVisibleDomain(0.01, 1000, 10);
    expect(visible).toEqual(full);
  });

  it('does not emit surrounding powers outside a tight visible band', () => {
    const ticks = generateLogTicksForVisibleDomain(2, 3, 10);
    expect(ticks).not.toContain(1);
    expect(ticks).not.toContain(10);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(2 * (1 - 1e-12));
      expect(t).toBeLessThanOrEqual(3 * (1 + 1e-12));
    }
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatLogTickValue', () => {
  it('formats powers of ten', () => {
    expect(formatLogTickValue(0.01, 10)).toBe('0.01');
    expect(formatLogTickValue(1, 10)).toBe('1');
    expect(formatLogTickValue(100, 10)).toBe('100');
    expect(formatLogTickValue(1000, 10)).toBe('1e3');
    expect(formatLogTickValue(1e6, 10)).toBe('1e6');
  });

  it('returns null for non-positive', () => {
    expect(formatLogTickValue(0)).toBeNull();
    expect(formatLogTickValue(-1)).toBeNull();
  });
});

describe('sanitizeLogDomain', () => {
  it('passes through valid positive domains', () => {
    const r = sanitizeLogDomain(0.1, 100, { base: 10, warn: false });
    expect(r.min).toBe(0.1);
    expect(r.max).toBe(100);
    expect(r.warned).toBe(false);
  });

  it('falls back when all non-positive', () => {
    const r = sanitizeLogDomain(-10, -1, { base: 10, warn: false });
    expect(r.min).toBeGreaterThan(0);
    expect(r.max).toBeGreaterThan(r.min);
    expect(r.warned).toBe(true);
  });

  it('clamps explicit min ≤ 0 using positiveDataMin', () => {
    const r = sanitizeLogDomain(0, 100, { base: 10, positiveDataMin: 2, warn: false });
    expect(r.min).toBeGreaterThan(0);
    expect(r.min).toBeLessThanOrEqual(2);
    expect(r.max).toBe(100);
  });

  it('floors positiveDataMin×0.5 to a power of base when clamping ≤0', () => {
    // pd=9 → half=4.5 → floor power of 10 → 1
    const r = sanitizeLogDomain(0, 100, { base: 10, positiveDataMin: 9, warn: false });
    expect(r.min).toBe(1);
    expect(r.max).toBe(100);
    expect(r.warned).toBe(true);
  });
});

describe('computeClipAffineFromContinuousScale', () => {
  it('matches linear sample at 0,1', () => {
    const s = createLinearScale().domain(0, 10).range(-1, 1);
    const a = computeClipAffineFromContinuousScale(s);
    const b = computeClipAffineFromScale(s, 0, 1);
    expect(a.a).toBeCloseTo(b.a, 12);
    expect(a.b).toBeCloseTo(b.b, 12);
  });

  it('maps log domain endpoints correctly via log space', () => {
    const s = createLogScale(10).domain(1, 1000).range(-1, 1);
    const { a, b } = computeClipAffineFromContinuousScale(s);
    // clip = a * log10(v) + b
    const clip1 = a * Math.log10(1) + b;
    const clip1000 = a * Math.log10(1000) + b;
    expect(clip1).toBeCloseTo(s.scale(1), 10);
    expect(clip1000).toBeCloseTo(s.scale(1000), 10);
  });
});

describe('resolveLogProjection', () => {
  it('flags off for linear pair', () => {
    const x = createLinearScale();
    const y = createLinearScale();
    expect(resolveLogProjection(x, y).logFlags).toBe(0);
  });

  it('sets logY bit for log Y', () => {
    const x = createLinearScale();
    const y = createLogScale(10);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(x, y);
    expect(logFlags & 2).toBe(2);
    expect(logFlags & 1).toBe(0);
    expect(logBaseY).toBe(10);
    expect(logBaseX).toBe(10); // unused when linear X, still written as default
  });

  it('keeps independent bases for dual log X/Y', () => {
    const x = createLogScale(2);
    const y = createLogScale(10);
    const { logFlags, logBaseX, logBaseY } = resolveLogProjection(x, y);
    expect(logFlags & 1).toBe(1);
    expect(logFlags & 2).toBe(2);
    expect(logBaseX).toBe(2);
    expect(logBaseY).toBe(10);
  });
});
