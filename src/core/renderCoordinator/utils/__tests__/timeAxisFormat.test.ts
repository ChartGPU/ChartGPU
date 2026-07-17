/**
 * Unit tests for adaptive time-axis label formatting (#161).
 * Expectations are built from local Date getters so results are TZ-stable.
 */

import { describe, it, expect } from 'vitest';
import { formatTimeTickValue } from '../timeAxisUtils';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_MONTH_APPROX = 30 * MS_PER_DAY;
const MS_PER_YEAR_APPROX = 365 * MS_PER_DAY;

/** Fixed epoch-ms: 2026-05-13T11:49:30.250Z */
const TS = Date.UTC(2026, 4, 13, 11, 49, 30, 250);

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');
const pad3 = (n: number): string => String(Math.trunc(n)).padStart(3, '0');

const localParts = (timestampMs: number) => {
  const d = new Date(timestampMs);
  return {
    yyyy: d.getFullYear(),
    mm: d.getMonth() + 1,
    dd: d.getDate(),
    hh: d.getHours(),
    min: d.getMinutes(),
    sec: d.getSeconds(),
    ms: d.getMilliseconds(),
    mmm: (['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const)[d.getMonth()]!,
  };
};

const hhmmss = (p: ReturnType<typeof localParts>) => `${pad2(p.hh)}:${pad2(p.min)}:${pad2(p.sec)}`;
const hhmm = (p: ReturnType<typeof localParts>) => `${pad2(p.hh)}:${pad2(p.min)}`;
const hhmmssSSS = (p: ReturnType<typeof localParts>) => `${pad2(p.hh)}:${pad2(p.min)}:${pad2(p.sec)}.${pad3(p.ms)}`;

describe('formatTimeTickValue', () => {
  it('returns null for non-finite timestamps', () => {
    expect(formatTimeTickValue(NaN, 60_000)).toBeNull();
    expect(formatTimeTickValue(Infinity, 60_000)).toBeNull();
  });

  it('formats with milliseconds when visible range is under 2 seconds', () => {
    const p = localParts(TS);
    const label = formatTimeTickValue(TS, 500);
    expect(label).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(label).toBe(hhmmssSSS(p));
  });

  it('formats HH:mm:ss when visible range is under 5 minutes', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, 30_000)).toBe(hhmmss(p));
    expect(formatTimeTickValue(TS, 4 * MS_PER_MINUTE)).toBe(hhmmss(p));
    expect(formatTimeTickValue(TS, 90 * MS_PER_SECOND)).toBe(hhmmss(p));
  });

  it('uses seconds just below the 5-minute boundary', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, 5 * MS_PER_MINUTE - 1)).toBe(hhmmss(p));
  });

  it('uses HH:mm at and above the 5-minute boundary (sub-day)', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, 5 * MS_PER_MINUTE)).toBe(hhmm(p));
    expect(formatTimeTickValue(TS, 3_600_000)).toBe(hhmm(p));
    expect(formatTimeTickValue(TS, 5 * MS_PER_MINUTE)!.split(':')).toHaveLength(2);
  });

  it('boundary: exactly 2 seconds is still HH:mm:ss (not ms)', () => {
    const p = localParts(TS);
    // `< 2 * MS_PER_SECOND` is ms tier; 2000 is seconds tier.
    expect(formatTimeTickValue(TS, 2 * MS_PER_SECOND)).toBe(hhmmss(p));
    expect(formatTimeTickValue(TS, 2 * MS_PER_SECOND - 1)).toBe(hhmmssSSS(p));
  });

  it('formats MM/DD HH:mm for multi-day ranges up to 7 days', () => {
    const p = localParts(TS);
    const expected = `${pad2(p.mm)}/${pad2(p.dd)} ${pad2(p.hh)}:${pad2(p.min)}`;
    expect(formatTimeTickValue(TS, 3 * MS_PER_DAY)).toBe(expected);
  });

  it('formats MM/DD for ranges under ~3 months beyond 7 days', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, 14 * MS_PER_DAY)).toBe(`${pad2(p.mm)}/${pad2(p.dd)}`);
  });

  it('formats MMM DD for ranges up to ~1 year', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, 6 * MS_PER_MONTH_APPROX)).toBe(`${p.mmm} ${pad2(p.dd)}`);
  });

  it('formats YYYY/MM for multi-year ranges', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, MS_PER_YEAR_APPROX + 1)).toBe(`${p.yyyy}/${pad2(p.mm)}`);
  });

  it('treats non-finite or negative visibleRangeMs as 0 (sub-second tier)', () => {
    const p = localParts(TS);
    expect(formatTimeTickValue(TS, NaN)).toBe(hhmmssSSS(p));
  });
});
