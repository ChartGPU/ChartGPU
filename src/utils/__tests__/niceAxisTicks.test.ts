import { describe, it, expect } from 'vitest';
import { niceNum, generateNiceAxisTicks } from '../niceAxisTicks';
import { generateValueAxisTicks, generateLinearTicks } from '../../core/renderCoordinator/axis/computeAxisTicks';
import { generateNiceAxisTicks3D } from '../../core/3d/axisTicks3d';

describe('niceNum', () => {
  it('returns 1/2/5×10^n ladder (ceil path)', () => {
    expect(niceNum(100, false)).toBe(100);
    expect(niceNum(12, false)).toBe(20);
    expect(niceNum(0, false)).toBe(1);
  });

  it('returns 1/2/5×10^n ladder (round path)', () => {
    expect(niceNum(30, true)).toBe(50);
    expect(niceNum(12, true)).toBe(10);
    expect(niceNum(7, true)).toBe(10);
  });
});

describe('generateNiceAxisTicks', () => {
  it('golden: 0–100 / 5 → exact 1–2–5 ladder (clamped)', () => {
    expect(generateNiceAxisTicks(0, 100, 5, { clampToDomain: true })).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('covers domain with ascending nice majors', () => {
    const ticks = generateNiceAxisTicks(0, 100, 5, { clampToDomain: true });
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    }
    expect(ticks[0]!).toBeLessThanOrEqual(0 + 1e-9);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(100 - 1e-6);
    for (const t of ticks) {
      expect(Number.isFinite(t)).toBe(true);
    }
  });

  it('clamps out-of-domain majors: [100,1000] and [3,97]', () => {
    const a = generateNiceAxisTicks(100, 1000, 5, { clampToDomain: true });
    for (const t of a) {
      expect(t).toBeGreaterThanOrEqual(100 - 1e-9);
      expect(t).toBeLessThanOrEqual(1000 + 1e-9);
    }
    expect(a.some((t) => t < 0)).toBe(false);

    const b = generateNiceAxisTicks(3, 97, 5, { clampToDomain: true });
    for (const t of b) {
      expect(t).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(t).toBeLessThanOrEqual(97 + 1e-9);
    }
    expect(b).toEqual([20, 40, 60, 80]);
  });

  it('fractional domain stays in-range', () => {
    const ticks = generateNiceAxisTicks(0.1, 0.9, 5, { clampToDomain: true });
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0.1 - 1e-12);
      expect(t).toBeLessThanOrEqual(0.9 + 1e-12);
    }
  });

  it('produces round-ish values (not arbitrary endpoint splits alone)', () => {
    const ticks = generateNiceAxisTicks(0, 100, 5, { clampToDomain: true });
    // At least one interior tick should be a clean multiple of 10 or 25.
    const clean = ticks.some((t) => Math.abs(t % 10) < 1e-9 || Math.abs(t % 25) < 1e-9);
    expect(clean).toBe(true);
  });

  it('handles equal min/max', () => {
    const ticks = generateNiceAxisTicks(5, 5, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]!).toBeLessThan(ticks[ticks.length - 1]!);
  });

  it('handles non-finite domains', () => {
    expect(generateNiceAxisTicks(Number.NaN, 10, 5)).toEqual([0, 1]);
    expect(generateNiceAxisTicks(0, Number.POSITIVE_INFINITY, 5)).toEqual([0, 1]);
  });

  it('handles reversed domains', () => {
    const ticks = generateNiceAxisTicks(100, 0, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0]!).toBeLessThan(ticks[ticks.length - 1]!);
  });

  it('clamps tick count hint (min 2, max 20)', () => {
    const few = generateNiceAxisTicks(0, 100, 1);
    expect(few.length).toBeGreaterThanOrEqual(2);
    const many = generateNiceAxisTicks(0, 100, 100);
    expect(many.length).toBeLessThanOrEqual(25);
  });

  it('handles negative domains', () => {
    const ticks = generateNiceAxisTicks(-50, 50, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.some((t) => t === 0 || Math.abs(t) < 1e-9)).toBe(true);
  });

  it('handles large epoch-like magnitudes', () => {
    const base = 1_700_000_000_000;
    const ticks = generateNiceAxisTicks(base, base + 60_000, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe('generateValueAxisTicks', () => {
  it('matches shared nice generator with clampToDomain for typical domains', () => {
    const a = generateValueAxisTicks(0, 100, 5);
    const b = generateNiceAxisTicks(0, 100, 5, { clampToDomain: true });
    expect(a).toEqual(b);
    expect(a).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('differs from equal-split linear ticks for non-nice domains', () => {
    const niceUgly = generateValueAxisTicks(3, 97, 5);
    const linearUgly = generateLinearTicks(3, 97, 5);
    expect(niceUgly[0]).not.toBe(linearUgly[0]);
    expect(niceUgly.length).toBeGreaterThanOrEqual(2);
    // All nice majors in domain
    for (const t of niceUgly) {
      expect(t).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(t).toBeLessThanOrEqual(97 + 1e-9);
    }
  });
});

describe('3D re-export parity', () => {
  it('generateNiceAxisTicks3D matches unclamped shared ladder', () => {
    expect(generateNiceAxisTicks3D(0, 100, 5)).toEqual(generateNiceAxisTicks(0, 100, 5, { clampToDomain: false }));
    expect(generateNiceAxisTicks3D(5, 5, 5)).toEqual(generateNiceAxisTicks(5, 5, 5, { clampToDomain: false }));
  });
});
