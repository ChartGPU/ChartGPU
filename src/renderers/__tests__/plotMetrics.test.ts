import { describe, it, expect } from 'vitest';
import {
  clamp01,
  clampInt,
  nextPow2,
  nearEqual,
  computePlotSizeCssPx,
  computePlotClipRect,
  computePlotScissorDevicePx,
  writeTransformMat4F32,
  createCssToDomainConverters,
} from '../plotMetrics';
import type { GridArea } from '../createGridRenderer';
import { createLinearScale, createLogScale } from '../../utils/scales';

const fixtureGrid = (overrides: Partial<GridArea> = {}): GridArea => ({
  left: 40,
  right: 20,
  top: 10,
  bottom: 30,
  canvasWidth: 800,
  canvasHeight: 600,
  devicePixelRatio: 2,
  ...overrides,
});

describe('plotMetrics', () => {
  describe('nextPow2', () => {
    it('returns 1 for non-positive / non-finite', () => {
      expect(nextPow2(0)).toBe(1);
      expect(nextPow2(-3)).toBe(1);
      expect(nextPow2(Number.NaN)).toBe(1);
      expect(nextPow2(Number.POSITIVE_INFINITY)).toBe(1);
    });

    it('rounds up to next power of two', () => {
      expect(nextPow2(1)).toBe(1);
      expect(nextPow2(2)).toBe(2);
      expect(nextPow2(3)).toBe(4);
      expect(nextPow2(5)).toBe(8);
      expect(nextPow2(8)).toBe(8);
      expect(nextPow2(9)).toBe(16);
    });
  });

  describe('nearEqual / clamp', () => {
    it('nearEqual tolerates relative float noise', () => {
      expect(nearEqual(1, 1)).toBe(true);
      expect(nearEqual(1000, 1000 + 1e-7)).toBe(true);
      expect(nearEqual(0, 1)).toBe(false);
    });

    it('clamp01 and clampInt', () => {
      expect(clamp01(-0.5)).toBe(0);
      expect(clamp01(0.5)).toBe(0.5);
      expect(clamp01(2)).toBe(1);
      expect(clampInt(3.9, 0, 10)).toBe(3);
      expect(clampInt(-1, 0, 10)).toBe(0);
      expect(clampInt(99, 0, 10)).toBe(10);
    });
  });

  describe('computePlotSizeCssPx', () => {
    it('returns CSS plot size from grid margins', () => {
      const size = computePlotSizeCssPx(fixtureGrid());
      // canvas 800/2=400 CSS wide; left 40 + right 20 → plot 340
      expect(size).toEqual({ plotWidthCss: 340, plotHeightCss: 260 });
    });

    it('returns null when dpr invalid or plot non-positive', () => {
      expect(computePlotSizeCssPx(fixtureGrid({ devicePixelRatio: 0 }))).toBeNull();
      expect(
        computePlotSizeCssPx(fixtureGrid({ left: 300, right: 300, canvasWidth: 400, devicePixelRatio: 1 }))
      ).toBeNull();
    });
  });

  describe('computePlotClipRect / scissor', () => {
    it('clip rect spans plot in NDC with width/height', () => {
      const clip = computePlotClipRect(fixtureGrid());
      expect(clip.width).toBeCloseTo(clip.right - clip.left, 10);
      expect(clip.height).toBeCloseTo(clip.top - clip.bottom, 10);
      expect(clip.left).toBeLessThan(clip.right);
      expect(clip.top).toBeGreaterThan(clip.bottom);
    });

    it('scissor clamps to canvas bounds in device px', () => {
      const sc = computePlotScissorDevicePx(fixtureGrid());
      expect(sc.x).toBeGreaterThanOrEqual(0);
      expect(sc.y).toBeGreaterThanOrEqual(0);
      expect(sc.x + sc.w).toBeLessThanOrEqual(800);
      expect(sc.y + sc.h).toBeLessThanOrEqual(600);
      expect(sc.w).toBeGreaterThan(0);
      expect(sc.h).toBeGreaterThan(0);
    });
  });

  describe('writeTransformMat4F32', () => {
    it('writes column-major affine mat4', () => {
      const out = new Float32Array(16);
      writeTransformMat4F32(out, 2, 3, 4, 5);
      expect(out[0]).toBe(2);
      expect(out[5]).toBe(4);
      expect(out[10]).toBe(1);
      expect(out[12]).toBe(3);
      expect(out[13]).toBe(5);
      expect(out[15]).toBe(1);
      expect(out[1]).toBe(0);
    });
  });

  describe('createCssToDomainConverters', () => {
    it('linear: CSS width maps via |ax|', () => {
      const xScale = createLinearScale().domain(0, 100).range(-1, 1);
      const yScale = createLinearScale().domain(0, 50).range(1, -1);
      // clipPerCss = full clip span / CSS width. Full X clip span = 2 for [-1,1].
      const { cssWidthToDomainX, cssHeightToDomainY } = createCssToDomainConverters({
        xScale,
        yScale,
        ax: 2 / 100, // domain 0..100 → clip -1..1
        ay: -2 / 50,
        clipPerCssX: 2 / 200,
        clipPerCssY: 2 / 100,
      });
      // 200 CSS px = full plot width = full domain 100
      expect(cssWidthToDomainX(200)).toBeCloseTo(100, 5);
      expect(cssHeightToDomainY(100)).toBeCloseTo(50, 5);
      expect(cssWidthToDomainX(0)).toBe(0);
    });

    it('log X uses geometric mid invert span', () => {
      const xScale = createLogScale(10).domain(1, 1000).range(-1, 1);
      const yScale = createLinearScale().domain(0, 1).range(1, -1);
      const { cssWidthToDomainX } = createCssToDomainConverters({
        xScale,
        yScale,
        ax: 1,
        ay: 1,
        clipPerCssX: 0.01,
        clipPerCssY: 0.01,
      });
      const w = cssWidthToDomainX(10);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    });
  });
});
