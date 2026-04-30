import { describe, it, expect } from "vitest";
import { generateTicks, formatLogTick } from "../tickHelpers";

describe("generateTicks", () => {
  it("generates linear ticks for value axis", () => {
    const ticks = generateTicks("value", 0, 100, 5);
    expect(ticks).toEqual([0, 25, 50, 75, 100]);
  });

  it("generates power of 10 ticks for log axis", () => {
    const ticks = generateTicks("log", 1, 1000, 5);
    expect(ticks).toEqual([1, 10, 100, 1000]);
  });

  it("generates fractional power of 10 ticks for log axis", () => {
    const ticks = generateTicks("log", 0.01, 1, 5);
    expect(ticks).toEqual([0.01, 0.1, 1]);
  });

  it("falls back to log-spaced linear ticks when range is narrow", () => {
    const ticks = generateTicks("log", 2, 8, 3);
    // Math.log10(2) ~ 0.301, Math.log10(8) ~ 0.903
    // t=0 -> 2
    // t=0.5 -> ~4
    // t=1 -> 8
    expect(ticks.length).toBe(3);
    expect(ticks[0]).toBeCloseTo(2);
    expect(ticks[1]).toBeCloseTo(4);
    expect(ticks[2]).toBeCloseTo(8);
  });
});

describe("formatLogTick", () => {
  it("formats powers of 10 with superscript", () => {
    expect(formatLogTick(1)).toBe("10⁰");
    expect(formatLogTick(10)).toBe("10¹");
    expect(formatLogTick(100)).toBe("10²");
    expect(formatLogTick(1000)).toBe("10³");
    expect(formatLogTick(0.1)).toBe("10⁻¹");
    expect(formatLogTick(0.01)).toBe("10⁻²");
  });

  it("formats intermediate values with standard precision", () => {
    expect(formatLogTick(5)).toBe("5");
    expect(formatLogTick(50)).toBe("50");
    expect(formatLogTick(500)).toBe("500");
  });
});
