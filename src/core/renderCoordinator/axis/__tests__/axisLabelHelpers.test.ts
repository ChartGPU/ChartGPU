import { describe, it, expect } from 'vitest';
import {
  getYAxisLabelX,
  getRightYAxisLabelX,
  getYAxisTitleX,
  getRightYAxisTitleX,
  resolveXTickLabelAnchor,
  X_TICK_EDGE_ANCHOR_SLACK_CSS_PX,
} from '../axisLabelHelpers';

describe('axisLabelHelpers (production exports)', () => {
  it('computes left/right label X', () => {
    expect(getYAxisLabelX(70, 6)).toBeLessThan(70);
    expect(getRightYAxisLabelX(400, 6)).toBeGreaterThan(400);
  });
  it('computes title X from label position', () => {
    const yLabelX = getYAxisLabelX(70, 6);
    expect(getYAxisTitleX(yLabelX, 40, 12)).toBeLessThan(yLabelX);
    const r = getRightYAxisLabelX(400, 6);
    expect(getRightYAxisTitleX(r, 40, 12)).toBeGreaterThan(r);
  });

  describe('resolveXTickLabelAnchor', () => {
    const left = 60;
    const right = 740;

    it('centers inset ticks (nice majors not on domain rails)', () => {
      // Streaming value X: majors well inside [plotLeft, plotRight]
      expect(resolveXTickLabelAnchor(200, left, right)).toBe('middle');
      expect(resolveXTickLabelAnchor(400, left, right)).toBe('middle');
      expect(resolveXTickLabelAnchor(600, left, right)).toBe('middle');
    });

    it('hugs plot rails only when tick is near the edge', () => {
      expect(resolveXTickLabelAnchor(left, left, right)).toBe('start');
      expect(resolveXTickLabelAnchor(left + X_TICK_EDGE_ANCHOR_SLACK_CSS_PX, left, right)).toBe('start');
      expect(resolveXTickLabelAnchor(left + X_TICK_EDGE_ANCHOR_SLACK_CSS_PX + 1, left, right)).toBe('middle');
      expect(resolveXTickLabelAnchor(right, left, right)).toBe('end');
      expect(resolveXTickLabelAnchor(right - X_TICK_EDGE_ANCHOR_SLACK_CSS_PX, left, right)).toBe('end');
      expect(resolveXTickLabelAnchor(right - X_TICK_EDGE_ANCHOR_SLACK_CSS_PX - 1, left, right)).toBe('middle');
    });

    it('returns middle for non-finite inputs', () => {
      expect(resolveXTickLabelAnchor(NaN, left, right)).toBe('middle');
      expect(resolveXTickLabelAnchor(100, NaN, right)).toBe('middle');
    });
  });
});
