/**
 * Unit tests for findNearestPoint with binary search optimization
 */

import { describe, it, expect } from 'vitest';
import { findNearestPoint } from '../findNearestPoint';
import { bucketStackedXKey } from '../../utils/barStackKey';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedSeriesConfig } from '../../config/OptionResolver';
import type { DataPoint, CartesianSeriesData } from '../../config/types';

describe('findNearestPoint', () => {
  describe('step series uses source samples (not densified corners)', () => {
    it('reports source y values only — never densified stair corners as dataIndex', () => {
      // Source samples (0,1) and (2,3); after-step densified corner is (2,1) — not a sample.
      // findNearestPoint uses source series data only (step expand is prepare-only).
      const data: DataPoint[] = [
        [0, 1],
        [2, 3],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          step: 'after',
          color: '#ec4899',
          visible: true,
          connectNulls: false,
          sampling: 'none',
          samplingThreshold: 5000,
          yAxis: 'y',
          rawData: data,
          lineStyle: { width: 2, opacity: 1, color: '#ec4899' },
        } as any,
      ];
      const xScale = createLinearScale().domain(-1, 3).range(0, 400);
      const yScale = createLinearScale().domain(0, 4).range(400, 0);
      // Hover at source sample (2, 3)
      const hitTip = findNearestPoint(series, xScale.scale(2), yScale.scale(3), xScale, yScale, 100);
      expect(hitTip).not.toBeNull();
      expect(hitTip!.dataIndex).toBe(1);
      const yTip = Array.isArray(hitTip!.point) ? hitTip!.point[1] : (hitTip!.point as { y: number }).y;
      expect(yTip).toBe(3);

      // Hover near densified corner domain (2, 1) — still maps to a source sample (0 or 1), never a fake index
      const hitCorner = findNearestPoint(series, xScale.scale(2), yScale.scale(1), xScale, yScale, 200);
      expect(hitCorner).not.toBeNull();
      expect(hitCorner!.dataIndex === 0 || hitCorner!.dataIndex === 1).toBe(true);
      expect(hitCorner!.dataIndex).toBeLessThan(data.length);
      const yCorner = Array.isArray(hitCorner!.point) ? hitCorner!.point[1] : (hitCorner!.point as { y: number }).y;
      expect(yCorner === 1 || yCorner === 3).toBe(true);
    });
  });

  describe('Binary search optimization with monotonic data', () => {
    it('finds nearest point in monotonic DataPoint[] array (tuple format)', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
        [5, 50],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 6).range(0, 600);
      const yScale = createLinearScale().domain(0, 60).range(600, 0);

      // Cursor at scaled position for x=3.1, y=31
      const cursorX = xScale.scale(3.1);
      const cursorY = yScale.scale(31);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0);
      expect(result?.dataIndex).toBe(2); // Point at x=3
      expect(result?.point).toEqual([3, 30]);
    });

    it('finds nearest point in monotonic XYArraysData', () => {
      const data: CartesianSeriesData = {
        x: [1, 2, 3, 4, 5],
        y: [10, 20, 30, 40, 50],
      };
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 6).range(0, 600);
      const yScale = createLinearScale().domain(0, 60).range(600, 0);

      const cursorX = xScale.scale(2.1);
      const cursorY = yScale.scale(21);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0);
      expect(result?.dataIndex).toBe(1);
      expect(result?.point).toEqual([2, 20]);
    });

    it('finds nearest point in monotonic InterleavedXYData (Float32Array)', () => {
      const data = new Float32Array([1, 10, 2, 20, 3, 30, 4, 40, 5, 50]);
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 6).range(0, 600);
      const yScale = createLinearScale().domain(0, 60).range(600, 0);

      const cursorX = xScale.scale(4.2);
      const cursorY = yScale.scale(42);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0);
      expect(result?.dataIndex).toBe(3);
      expect(result?.point).toEqual([4, 40]);
    });

    it('handles InterleavedXYData subarray with byteOffset', () => {
      const base = new Float32Array([99, 99, 1, 10, 2, 20, 3, 30, 4, 40]);
      const data = base.subarray(2); // [1, 10, 2, 20, 3, 30, 4, 40]
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 5).range(0, 500);
      const yScale = createLinearScale().domain(0, 50).range(500, 0);

      const cursorX = xScale.scale(2.1);
      const cursorY = yScale.scale(21);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0);
      expect(result?.dataIndex).toBe(1);
      expect(result?.point).toEqual([2, 20]);
    });

    it('early exits when x-distance exceeds best distance (performance)', () => {
      // Large dataset with cursor far from most points
      const data: DataPoint[] = [];
      for (let i = 1; i <= 10000; i++) {
        data.push([i, i * 10]);
      }

      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 10001).range(0, 10001);
      const yScale = createLinearScale().domain(0, 100010).range(100010, 0);

      // Cursor near x=100
      const cursorX = xScale.scale(100.5);
      const cursorY = yScale.scale(1005);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.dataIndex).toBeGreaterThanOrEqual(99);
      expect(result?.dataIndex).toBeLessThanOrEqual(101);
    });
  });

  describe('Fallback to linear scan for non-monotonic data', () => {
    it('finds nearest point in non-monotonic DataPoint[] array', () => {
      const data: DataPoint[] = [
        [3, 30],
        [1, 10],
        [4, 40],
        [2, 20],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 5).range(0, 500);
      const yScale = createLinearScale().domain(0, 50).range(500, 0);

      const cursorX = xScale.scale(2.1);
      const cursorY = yScale.scale(21);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0);
      expect(result?.dataIndex).toBe(3); // Point at x=2
      expect(result?.point).toEqual([2, 20]);
    });

    it('handles non-monotonic XYArraysData', () => {
      const data: CartesianSeriesData = {
        x: [3, 1, 4, 2],
        y: [30, 10, 40, 20],
      };
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 5).range(0, 500);
      const yScale = createLinearScale().domain(0, 50).range(500, 0);

      const cursorX = xScale.scale(1.1);
      const cursorY = yScale.scale(11);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.dataIndex).toBe(1); // Point at x=1
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty series', () => {
      const data: DataPoint[] = [];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 10).range(0, 100);
      const yScale = createLinearScale().domain(0, 10).range(100, 0);

      const result = findNearestPoint(series, 50, 50, xScale, yScale, 20);
      expect(result).toBeNull();
    });

    it('skips non-finite points in monotonic data', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, NaN],
        [3, 30],
        [4, 40],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 5).range(0, 500);
      const yScale = createLinearScale().domain(0, 50).range(500, 0);

      const cursorX = xScale.scale(3);
      const cursorY = yScale.scale(30);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      // Should skip the NaN point at index 1 and find point at index 2
      expect(result?.dataIndex).toBe(2);
      expect(result?.point).toEqual([3, 30]);
    });

    it('handles duplicate x values in monotonic data', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [2, 25],
        [3, 30],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 4).range(0, 400);
      const yScale = createLinearScale().domain(0, 40).range(400, 0);

      const cursorX = xScale.scale(2);
      const cursorY = yScale.scale(22);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.point[0]).toBe(2);
      // Should find one of the two points at x=2
      expect([1, 2]).toContain(result?.dataIndex);
    });

    it('returns null when no points within maxDistance', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 10).range(0, 1000);
      const yScale = createLinearScale().domain(0, 100).range(1000, 0);

      // Cursor very far from all points
      const cursorX = xScale.scale(9);
      const cursorY = yScale.scale(90);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 5);
      expect(result).toBeNull();
    });

    it('handles zoom range outside data (monotonic)', () => {
      const data: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data,
          color: '#000',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(10, 20).range(0, 100);
      const yScale = createLinearScale().domain(0, 100).range(100, 0);

      // Cursor position when zoomed to range outside data
      const cursorX = 50;
      const cursorY = 50;

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 1000);
      // Should still find nearest point even if far away
      expect(result).not.toBeNull();
    });
  });

  describe('Multiple series', () => {
    it('finds nearest point across multiple monotonic series', () => {
      const data1: DataPoint[] = [
        [1, 10],
        [2, 20],
        [3, 30],
      ];
      const data2: DataPoint[] = [
        [1, 15],
        [2, 25],
        [3, 35],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data: data1,
          color: '#000',
          visible: true,
        } as any,
        {
          type: 'line',
          data: data2,
          color: '#f00',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 4).range(0, 400);
      const yScale = createLinearScale().domain(0, 40).range(400, 0);

      const cursorX = xScale.scale(2);
      const cursorY = yScale.scale(24);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(1); // Second series is closer
      expect(result?.dataIndex).toBe(1);
      expect(result?.point).toEqual([2, 25]);
    });

    it('prefers lower series index when distance is equal', () => {
      const data1: DataPoint[] = [
        [1, 10],
        [2, 20],
      ];
      const data2: DataPoint[] = [
        [1, 10],
        [2, 20],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'line',
          data: data1,
          color: '#000',
          visible: true,
        } as any,
        {
          type: 'line',
          data: data2,
          color: '#f00',
          visible: true,
        } as any,
      ];

      const xScale = createLinearScale().domain(0, 3).range(0, 300);
      const yScale = createLinearScale().domain(0, 30).range(300, 0);

      const cursorX = xScale.scale(1);
      const cursorY = yScale.scale(10);

      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result?.seriesIndex).toBe(0); // First series preferred
    });
  });

  describe('bucketStackedXKey', () => {
    it('prefers domain categoryStep over range-space buckets (matches bar renderer)', () => {
      // Noisy domain x near category 2 with step 1 → key 2 even if range-space would disagree.
      expect(bucketStackedXKey(999, 50, 2.04, 1)).toBe(2);
      expect(bucketStackedXKey(10, 5, 4.6, 1)).toBe(5);
      // Fall back to range-space only when categoryStep is unusable.
      expect(bucketStackedXKey(105, 50, 2.04, 0)).toBe(2);
    });
  });

  describe('band series hit-test', () => {
    it('finds nearest band sample by x and returns [x,y] point', () => {
      const data = {
        x: [1, 2, 3, 4, 5],
        y: [0, 0, 0, 0, 0],
        y1: [2, 4, 6, 8, 10],
      };
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'band',
          data,
          color: '#38bdf8',
          visible: true,
          connectNulls: false,
          sampling: 'none',
          samplingThreshold: 5000,
          yAxis: 'y',
          rawData: data,
          areaStyle: { color: '#38bdf8', opacity: 0.25 },
          lineStyle: { width: 1, opacity: 1, color: '#38bdf8' },
        } as any,
      ];
      const xScale = createLinearScale().domain(0, 6).range(0, 600);
      const yScale = createLinearScale().domain(0, 12).range(600, 0);
      const cursorX = xScale.scale(3.1);
      const cursorY = yScale.scale(3);
      const result = findNearestPoint(series, cursorX, cursorY, xScale, yScale, 50);
      expect(result).not.toBeNull();
      expect(result!.seriesIndex).toBe(0);
      expect(result!.dataIndex).toBe(2);
      expect(result!.point).toEqual([3, 0]);
    });

    it('skips null band samples', () => {
      const data = [[1, 0, 2], null, [3, 0, 4]] as any;
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'band',
          data,
          color: '#f00',
          visible: true,
          connectNulls: false,
          sampling: 'none',
          samplingThreshold: 5000,
          yAxis: 'y',
          rawData: data,
          areaStyle: { color: '#f00', opacity: 0.25 },
          lineStyle: { width: 0, opacity: 0, color: '#f00' },
        } as any,
      ];
      const xScale = createLinearScale().domain(0, 4).range(0, 400);
      const yScale = createLinearScale().domain(0, 5).range(400, 0);
      // Cursor near x=2 (null) — should pick a finite neighbor within max distance.
      const result = findNearestPoint(series, xScale.scale(2), yScale.scale(1), xScale, yScale, 200);
      expect(result).not.toBeNull();
      expect(result!.dataIndex === 0 || result!.dataIndex === 2).toBe(true);
      // Soft-if guard avoided: always assert dataIndex is finite sample.
      expect([0, 2]).toContain(result!.dataIndex);
    });

    it('works alongside a line series (multi-series)', () => {
      const bandData = { x: [1, 2, 3], y: [0, 0, 0], y1: [2, 2, 2] };
      const lineData: DataPoint[] = [
        [1, 10],
        [2, 10],
        [3, 10],
      ];
      const series: ResolvedSeriesConfig[] = [
        {
          type: 'band',
          data: bandData,
          color: '#0af',
          visible: true,
          connectNulls: false,
          sampling: 'none',
          samplingThreshold: 5000,
          yAxis: 'y',
          rawData: bandData,
          areaStyle: { color: '#0af', opacity: 0.2 },
          lineStyle: { width: 0, opacity: 0, color: '#0af' },
        } as any,
        {
          type: 'line',
          data: lineData,
          color: '#f00',
          visible: true,
        } as any,
      ];
      const xScale = createLinearScale().domain(0, 4).range(0, 400);
      const yScale = createLinearScale().domain(0, 12).range(400, 0);
      // Cursor near line at y=10
      const lineHit = findNearestPoint(series, xScale.scale(2), yScale.scale(10), xScale, yScale, 50);
      expect(lineHit).not.toBeNull();
      expect(lineHit!.seriesIndex).toBe(1);
      expect(lineHit!.dataIndex).toBe(1);
      expect(lineHit!.point).toEqual([2, 10]);
      // Cursor near band midline at x=2
      const bandHit = findNearestPoint(series, xScale.scale(2), yScale.scale(1), xScale, yScale, 50);
      expect(bandHit).not.toBeNull();
      expect(bandHit!.seriesIndex).toBe(0);
      expect(bandHit!.dataIndex).toBe(1);
      expect(bandHit!.point).toEqual([2, 0]);
    });
  });

  describe('stacked mountain hit-test', () => {
    const mountainLayer = (name: string, data: DataPoint[], color: string): ResolvedSeriesConfig =>
      ({
        type: 'line',
        name,
        data,
        rawData: data,
        color,
        visible: true,
        connectNulls: false,
        sampling: 'none',
        samplingThreshold: 5000,
        yAxis: 'y',
        stack: 'traffic',
        areaStyle: { color, opacity: 0.85 },
        lineStyle: { width: 1, opacity: 1, color },
      }) as any;

    it('hits topmost layer under cursor and reports contribution y + stackTotal', () => {
      // Layer0: y=1 → band [0,1]; Layer1: y=2 → band [1,3]; Layer2: y=3 → band [3,6]
      const s0 = mountainLayer(
        'Organic',
        [
          [0, 1],
          [1, 1],
          [2, 1],
        ],
        '#38bdf8'
      );
      const s1 = mountainLayer(
        'Paid',
        [
          [0, 2],
          [1, 2],
          [2, 2],
        ],
        '#a78bfa'
      );
      const s2 = mountainLayer(
        'Referral',
        [
          [0, 3],
          [1, 3],
          [2, 3],
        ],
        '#34d399'
      );
      const series = [s0, s1, s2];
      const xScale = createLinearScale().domain(0, 2).range(0, 200);
      const yScale = createLinearScale().domain(0, 8).range(400, 0);

      // y=4 is inside top layer [3,6]
      const top = findNearestPoint(series, xScale.scale(1), yScale.scale(4), xScale, yScale, 50);
      expect(top).not.toBeNull();
      expect(top!.seriesIndex).toBe(2);
      expect(top!.dataIndex).toBe(1);
      expect(top!.point).toEqual([1, 3]); // contribution for tooltip, not cumulative top
      expect(top!.highlightY).toBe(6); // stroke / fill surface for highlight marker
      expect(top!.stack).toBe('traffic');
      expect(top!.stackTotal).toBe(6);

      // y=1.5 is inside middle layer [1,3]
      const mid = findNearestPoint(series, xScale.scale(1), yScale.scale(1.5), xScale, yScale, 50);
      expect(mid).not.toBeNull();
      expect(mid!.seriesIndex).toBe(1);
      expect(mid!.point).toEqual([1, 2]);
      expect(mid!.highlightY).toBe(3);
      expect(mid!.stackTotal).toBe(6);

      // y=0.5 is inside bottom layer [0,1]
      const bot = findNearestPoint(series, xScale.scale(1), yScale.scale(0.5), xScale, yScale, 50);
      expect(bot).not.toBeNull();
      expect(bot!.seriesIndex).toBe(0);
      expect(bot!.point).toEqual([1, 1]);
      expect(bot!.highlightY).toBe(1);
    });

    it('cursor above stack with tiny maxDistance does not claim stackTotal fill hit', () => {
      const series = [
        mountainLayer(
          'A',
          [
            [0, 1],
            [1, 1],
          ],
          '#0af'
        ),
        mountainLayer(
          'B',
          [
            [0, 1],
            [1, 1],
          ],
          '#f0a'
        ),
      ];
      const xScale = createLinearScale().domain(0, 1).range(0, 100);
      const yScale = createLinearScale().domain(0, 10).range(100, 0);
      // Stack tops at 2; y=9 is outside all layers — maxDistance 1 px so stroke also misses
      const miss = findNearestPoint(series, xScale.scale(0.5), yScale.scale(9), xScale, yScale, 1);
      expect(miss).toBeNull();
      // Hard assert: y=1.5 must hit top layer (seriesIndex 1)
      const mustHit = findNearestPoint(series, xScale.scale(0.5), yScale.scale(1.5), xScale, yScale, 50);
      expect(mustHit).not.toBeNull();
      expect(mustHit!.seriesIndex).toBe(1);
      expect(mustHit!.point[1]).toBe(1); // contribution
      expect(mustHit!.highlightY).toBe(2); // cumulative yTop for highlight
      expect(mustHit!.stackTotal).toBe(2);
    });

    it('uses per-group yScale for multi-axis stacks', () => {
      const left = mountainLayer(
        'L0',
        [
          [0, 1],
          [1, 1],
        ],
        '#0af'
      );
      const left2 = mountainLayer(
        'L1',
        [
          [0, 1],
          [1, 1],
        ],
        '#0f0'
      );
      (left as any).yAxis = 'y';
      (left2 as any).yAxis = 'y';
      const right = mountainLayer(
        'R0',
        [
          [0, 100],
          [1, 100],
        ],
        '#f00'
      );
      const right2 = mountainLayer(
        'R1',
        [
          [0, 100],
          [1, 100],
        ],
        '#ff0'
      );
      (right as any).yAxis = 'y2';
      (right2 as any).yAxis = 'y2';
      const series = [left, left2, right, right2];
      const xScale = createLinearScale().domain(0, 1).range(0, 100);
      const yLeft = createLinearScale().domain(0, 4).range(100, 0);
      const yRight = createLinearScale().domain(0, 400).range(100, 0);
      const yScales = new Map([
        ['y', yLeft],
        ['y2', yRight],
      ]);
      // Cursor at right-axis mid-stack (~150 domain on y2 → between 100 and 200)
      const hit = findNearestPoint(series, xScale.scale(0.5), yRight.scale(150), xScale, yLeft, 50, yScales);
      expect(hit).not.toBeNull();
      expect(hit!.seriesIndex).toBe(3); // top right layer
      expect(hit!.stackTotal).toBe(200);
      expect(hit!.point[1]).toBe(100);
    });

    it('connectNulls uses filterGaps stack view so hit matches prepare pack baselines', () => {
      // Shared null gaps; connectNulls bridges so pack/hit see dense [0,1],[2,3] only.
      // Layer0 y=1 → [0,1]; Layer1 y=2 → [1,3] after stack on filtered view.
      const withGaps0: DataPoint[] = [[0, 1], null as unknown as DataPoint, [2, 1]];
      const withGaps1: DataPoint[] = [[0, 2], null as unknown as DataPoint, [2, 2]];
      const s0 = mountainLayer('A', withGaps0, '#0af');
      const s1 = mountainLayer('B', withGaps1, '#f0a');
      (s0 as any).connectNulls = true;
      (s1 as any).connectNulls = true;
      const series = [s0, s1];
      const xScale = createLinearScale().domain(0, 2).range(0, 200);
      const yScale = createLinearScale().domain(0, 4).range(400, 0);

      // Mid-stack at x=0 (y=1.5 inside top layer [1,3] on filtered baselines)
      const hit0 = findNearestPoint(series, xScale.scale(0), yScale.scale(1.5), xScale, yScale, 50);
      expect(hit0).not.toBeNull();
      expect(hit0!.seriesIndex).toBe(1);
      expect(hit0!.stackTotal).toBe(3);
      expect(hit0!.point).toEqual([0, 2]);
      // dataIndex is into filtered view (first dense sample), not raw index 0-only coincidence
      expect(hit0!.dataIndex).toBe(0);

      // At x=2 (filtered index 1): same composition
      const hit2 = findNearestPoint(series, xScale.scale(2), yScale.scale(1.5), xScale, yScale, 50);
      expect(hit2).not.toBeNull();
      expect(hit2!.seriesIndex).toBe(1);
      expect(hit2!.dataIndex).toBe(1);
      expect(hit2!.stackTotal).toBe(3);

      // Bottom layer band [0,1]
      const bot = findNearestPoint(series, xScale.scale(2), yScale.scale(0.5), xScale, yScale, 50);
      expect(bot).not.toBeNull();
      expect(bot!.seriesIndex).toBe(0);
      expect(bot!.point).toEqual([2, 1]);
    });
  });
});
