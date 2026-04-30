import { describe, it, expect } from "vitest";
import { createLogScale } from "../scales";

describe("createLogScale", () => {
  it("computes correct log scaled values", () => {
    const scale = createLogScale().domain(1, 100).range(0, 100);

    expect(scale.scale(1)).toBeCloseTo(0);
    expect(scale.scale(10)).toBeCloseTo(50);
    expect(scale.scale(100)).toBeCloseTo(100);
  });

  it("handles inversion correctly", () => {
    const scale = createLogScale().domain(1, 100).range(0, 100);

    expect(scale.invert(0)).toBeCloseTo(1);
    expect(scale.invert(50)).toBeCloseTo(10);
    expect(scale.invert(100)).toBeCloseTo(100);
  });

  it("clamps non-positive domain values", () => {
    const scale = createLogScale().domain(0, 100).range(0, 100);
    
    expect(scale.scale(1e-10)).toBeCloseTo(0);
    expect(scale.scale(Math.sqrt(1e-10 * 100))).toBeCloseTo(50);
    expect(scale.scale(100)).toBeCloseTo(100);
  });

  it("returns NaN for zero or negative values", () => {
    const scale = createLogScale().domain(1, 100).range(0, 100);
    
    expect(scale.scale(0)).toBeNaN();
    expect(scale.scale(-10)).toBeNaN();
  });
});
