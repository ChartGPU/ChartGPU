/**
 * Tests for axis tick computation and formatting.
 * Verifies tick generation, decimal precision calculation, and number formatting.
 */

import { describe, it, expect } from 'vitest';
import { generateLinearTicks, generateValueAxisTicks, createTickFormatter, formatTickValue } from '../computeAxisTicks';
import { generateNiceAxisTicks } from '../../../../utils/niceAxisTicks';

describe('generateLinearTicks', () => {
  it('generates single tick at midpoint', () => {
    const ticks = generateLinearTicks(0, 100, 1);

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toBe(50);
  });

  it('generates evenly-spaced ticks', () => {
    const ticks = generateLinearTicks(0, 100, 5);

    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toBe(0);
    expect(ticks[1]).toBe(25);
    expect(ticks[2]).toBe(50);
    expect(ticks[3]).toBe(75);
    expect(ticks[4]).toBe(100);
  });

  it('handles negative domains', () => {
    const ticks = generateLinearTicks(-50, 50, 3);

    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toBe(-50);
    expect(ticks[1]).toBe(0);
    expect(ticks[2]).toBe(50);
  });

  it('handles fractional tick counts by flooring', () => {
    const ticks = generateLinearTicks(0, 10, 3.7);

    expect(ticks).toHaveLength(3);
  });

  it('clamps tick count to minimum 1', () => {
    const ticks = generateLinearTicks(0, 100, 0);

    expect(ticks).toHaveLength(1);
  });

  it('handles reversed domains', () => {
    const ticks = generateLinearTicks(100, 0, 3);

    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toBe(100);
    expect(ticks[1]).toBe(50);
    expect(ticks[2]).toBe(0);
  });

  it('handles zero-span domains', () => {
    const ticks = generateLinearTicks(50, 50, 3);

    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => t === 50)).toBe(true);
  });
});

describe('generateValueAxisTicks', () => {
  it('parity with domain-clamped generateNiceAxisTicks', () => {
    expect(generateValueAxisTicks(0, 100, 5)).toEqual(generateNiceAxisTicks(0, 100, 5, { clampToDomain: true }));
    expect(generateValueAxisTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('non-finite domain uses nice safe fallback [0, 1] (not empty)', () => {
    // generateNiceAxisTicks returns [0,1] for non-finite ends (length >= 2), so
    // generateValueAxisTicks never reaches the equal-split linear branch here.
    expect(generateValueAxisTicks(Number.NaN, Number.NaN, 5)).toEqual([0, 1]);
    expect(generateValueAxisTicks(Number.POSITIVE_INFINITY, 10, 5)).toEqual([0, 1]);
  });

  it('keeps majors inside domain (presentation contract)', () => {
    const ticks = generateValueAxisTicks(100, 1000, 5);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(100 - 1e-9);
      expect(t).toBeLessThanOrEqual(1000 + 1e-9);
    }
  });
});

describe('createTickFormatter (covers fraction-digit policy)', () => {
  it('uses integer formatting for integer steps', () => {
    expect(createTickFormatter(1).format(1.0)).toBe('1');
    expect(createTickFormatter(10).format(20)).toBe('20');
  });

  it('preserves one decimal for 0.5 steps', () => {
    expect(createTickFormatter(0.5).format(1.5)).toBe('1.5');
  });

  it('preserves two decimals for 0.25 steps', () => {
    expect(createTickFormatter(0.25).format(1.25)).toBe('1.25');
  });

  it('handles zero/non-finite steps without throwing', () => {
    expect(createTickFormatter(0).format(1)).toBe('1');
    expect(createTickFormatter(NaN).format(1)).toBe('1');
  });
});

describe('createTickFormatter', () => {
  it('creates formatter with appropriate decimal places for integer step', () => {
    const formatter = createTickFormatter(1);
    const formatted = formatter.format(123);

    expect(formatted).toBe('123');
  });

  it('creates formatter with appropriate decimal places for 0.5 step', () => {
    const formatter = createTickFormatter(0.5);
    const formatted = formatter.format(2.5);

    expect(formatted).toBe('2.5');
  });

  it('creates formatter with appropriate decimal places for 0.25 step', () => {
    const formatter = createTickFormatter(0.25);
    const formatted = formatter.format(1.25);

    expect(formatted).toBe('1.25');
  });

  it('handles negative steps', () => {
    const formatter = createTickFormatter(-0.5);
    const formatted = formatter.format(3.5);

    expect(formatted).toBe('3.5');
  });
});

describe('formatTickValue', () => {
  const formatter = createTickFormatter(1);

  it('formats finite values', () => {
    expect(formatTickValue(formatter, 123)).toBe('123');
    expect(formatTickValue(formatter, 0)).toBe('0');
    expect(formatTickValue(formatter, -45)).toBe('-45');
  });

  it('normalizes near-zero values to avoid -0', () => {
    expect(formatTickValue(formatter, 1e-13)).toBe('0');
    expect(formatTickValue(formatter, -1e-13)).toBe('0');
    expect(formatTickValue(formatter, 1e-12)).toBe('0');
  });

  it('returns null for non-finite values', () => {
    expect(formatTickValue(formatter, NaN)).toBe(null);
    expect(formatTickValue(formatter, Infinity)).toBe(null);
    expect(formatTickValue(formatter, -Infinity)).toBe(null);
  });

  it('uses formatter decimal precision', () => {
    const decimalFormatter = createTickFormatter(0.5);
    expect(formatTickValue(decimalFormatter, 2.5)).toBe('2.5');
    expect(formatTickValue(decimalFormatter, 3.0)).toBe('3');
  });

  it('handles large numbers', () => {
    expect(formatTickValue(formatter, 1e6)).toBe('1,000,000');
    expect(formatTickValue(formatter, 1e9)).toBe('1,000,000,000');
  });

  it('handles small numbers', () => {
    const smallFormatter = createTickFormatter(0.0001);
    expect(formatTickValue(smallFormatter, 0.0005)).toContain('0.0005');
  });
});

describe('integration: tick generation and formatting', () => {
  it('generates and formats integer ticks', () => {
    const ticks = generateLinearTicks(0, 100, 5);
    const tickStep = 25;
    const formatter = createTickFormatter(tickStep);

    const labels = ticks.map((v) => formatTickValue(formatter, v));

    expect(labels).toEqual(['0', '25', '50', '75', '100']);
  });

  it('generates and formats decimal ticks', () => {
    const ticks = generateLinearTicks(0, 1, 5);
    const tickStep = 0.25;
    const formatter = createTickFormatter(tickStep);

    const labels = ticks.map((v) => formatTickValue(formatter, v));

    expect(labels).toEqual(['0', '0.25', '0.5', '0.75', '1']);
  });

  it('generates and formats negative range ticks', () => {
    const ticks = generateLinearTicks(-10, 10, 5);
    const tickStep = 5;
    const formatter = createTickFormatter(tickStep);

    const labels = ticks.map((v) => formatTickValue(formatter, v));

    expect(labels).toEqual(['-10', '-5', '0', '5', '10']);
  });
});
