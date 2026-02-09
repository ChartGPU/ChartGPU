/**
 * Unit tests for findNearestPoint with binary search optimization
 */

import { describe, it, expect } from 'vitest';
import { findNearestPoint } from '../findNearestPoint';
import { createLinearScale } from '../../utils/scales';
import type { ResolvedSeriesConfig } from '../../config/OptionResolver';
import type { DataPoint, CartesianSeriesData } from '../../config/types';

describe('findNearestPoint', () => {
  describe('Binary search optimization with monotonic data', () => {
    it('finds nearest point in monotonic DataPoint[] array (tuple format)', () => {
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]];
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
      const data: CartesianSeriesData = { x: [1, 2, 3, 4, 5], y: [10, 20, 30, 40, 50] };
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
      const data: DataPoint[] = [[3, 30], [1, 10], [4, 40], [2, 20]];
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
      const data: CartesianSeriesData = { x: [3, 1, 4, 2], y: [30, 10, 40, 20] };
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
      const data: DataPoint[] = [[1, 10], [2, NaN], [3, 30], [4, 40]];
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
      const data: DataPoint[] = [[1, 10], [2, 20], [2, 25], [3, 30]];
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
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
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
      const data: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
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
      const data1: DataPoint[] = [[1, 10], [2, 20], [3, 30]];
      const data2: DataPoint[] = [[1, 15], [2, 25], [3, 35]];
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
      const data1: DataPoint[] = [[1, 10], [2, 20]];
      const data2: DataPoint[] = [[1, 10], [2, 20]];
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
});
