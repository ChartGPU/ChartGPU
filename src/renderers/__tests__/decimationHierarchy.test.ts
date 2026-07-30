/**
 * CPU-side hierarchy tile math + aggregate reference tests.
 * GPU maintain kernels are covered structurally in decimationCompute.test.ts
 * and numerically via examples/acceptance/gpu-decimation.ts when WebGPU is live.
 */

import { describe, it, expect } from 'vitest';
import {
  HIERARCHY_TILE,
  HIERARCHY_ENABLE_MIN_RAW,
  buildTilesCpuReference,
  logicalRangeToPhysicalRanges,
  maintainTilesCpuRange,
  modularOverwriteRanges,
  shouldUseHierarchyPresent,
  tileCountForCapacity,
  tilesOverlappingPhysical,
} from '../decimationHierarchy';

function makeSineXy(n: number): Float32Array {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    xy[i * 2] = i;
    xy[i * 2 + 1] = Math.sin(i * 0.01) * 100 + (i % 17);
  }
  return xy;
}

describe('decimationHierarchy pure helpers', () => {
  it('tileCountForCapacity rounds up by TILE', () => {
    expect(tileCountForCapacity(0)).toBe(0);
    expect(tileCountForCapacity(1)).toBe(1);
    expect(tileCountForCapacity(HIERARCHY_TILE)).toBe(1);
    expect(tileCountForCapacity(HIERARCHY_TILE + 1)).toBe(2);
    expect(tileCountForCapacity(1_000_000)).toBe(Math.ceil(1_000_000 / HIERARCHY_TILE));
  });

  it('tilesOverlappingPhysical covers partial edges', () => {
    expect(tilesOverlappingPhysical(0, 0)).toBeNull();
    expect(tilesOverlappingPhysical(100, 200)).toEqual({ startTile: 0, endTileExclusive: 1 });
    expect(tilesOverlappingPhysical(1023, 1025)).toEqual({ startTile: 0, endTileExclusive: 2 });
    expect(tilesOverlappingPhysical(2048, 4096)).toEqual({ startTile: 2, endTileExclusive: 4 });
  });

  it('modularOverwriteRanges handles wrap into two spans', () => {
    expect(modularOverwriteRanges(0, 100, 1000)).toEqual([{ start: 0, end: 100 }]);
    expect(modularOverwriteRanges(900, 50, 1000)).toEqual([
      { start: 900, end: 1000 },
      { start: 0, end: 50 },
    ]);
    expect(modularOverwriteRanges(10, 10, 1000)).toEqual([]);
  });

  it('logicalRangeToPhysicalRanges maps ring spans (≤2)', () => {
    expect(logicalRangeToPhysicalRanges(10, 20, 0, 0)).toEqual([{ start: 10, end: 20 }]);
    // No wrap
    expect(logicalRangeToPhysicalRanges(0, 100, 50, 1000)).toEqual([{ start: 50, end: 150 }]);
    // Wrap physical
    expect(logicalRangeToPhysicalRanges(0, 100, 950, 1000)).toEqual([
      { start: 950, end: 1000 },
      { start: 0, end: 50 },
    ]);
  });

  it('shouldUseHierarchyPresent: policy matrix (branches + floor edges)', () => {
    const cases: Array<{
      name: string;
      opts: Parameters<typeof shouldUseHierarchyPresent>[0];
      want: boolean;
    }> = [
      {
        name: 'tiny N legacy',
        opts: {
          rawPointCount: 1000,
          targetBuckets: 100,
          visibleStart: 0,
          visibleEnd: 1000,
          ringCapacity: 0,
          hierarchyReady: true,
        },
        want: false,
      },
      {
        name: 'below HIERARCHY_ENABLE_MIN_RAW',
        opts: {
          rawPointCount: HIERARCHY_ENABLE_MIN_RAW - 1,
          targetBuckets: 64,
          visibleStart: 0,
          visibleEnd: HIERARCHY_ENABLE_MIN_RAW - 1,
          ringCapacity: HIERARCHY_ENABLE_MIN_RAW - 1,
          hierarchyReady: true,
        },
        want: false,
      },
      {
        name: 'modular multi-K at floor',
        opts: {
          rawPointCount: HIERARCHY_ENABLE_MIN_RAW,
          targetBuckets: 64,
          visibleStart: 0,
          visibleEnd: HIERARCHY_ENABLE_MIN_RAW,
          ringCapacity: HIERARCHY_ENABLE_MIN_RAW,
          hierarchyReady: true,
        },
        want: true,
      },
      {
        name: '1M modular (suite FIFO)',
        opts: {
          rawPointCount: 1_000_000,
          targetBuckets: 2500,
          visibleStart: 0,
          visibleEnd: 1_000_000,
          ringCapacity: 1_000_000,
          hierarchyReady: true,
        },
        want: true,
      },
      {
        name: '1M linear near-M (pts/bucket≈400 ≤512)',
        opts: {
          rawPointCount: 1_000_000,
          targetBuckets: 2500,
          visibleStart: 0,
          visibleEnd: 1_000_000,
          ringCapacity: 0,
          hierarchyReady: true,
        },
        want: true,
      },
      {
        name: 'pts/bucket > 512 linear',
        opts: {
          rawPointCount: 5_000_000,
          targetBuckets: 2500,
          visibleStart: 0,
          visibleEnd: 5_000_000,
          ringCapacity: 0,
          hierarchyReady: true,
        },
        want: true,
      },
      {
        name: 'not ready → never',
        opts: {
          rawPointCount: 1_000_000,
          targetBuckets: 2500,
          visibleStart: 0,
          visibleEnd: 1_000_000,
          ringCapacity: 1_000_000,
          hierarchyReady: false,
        },
        want: false,
      },
      {
        name: '249999 linear below near-M floor',
        opts: {
          rawPointCount: 249_999,
          targetBuckets: 2500,
          visibleStart: 0,
          visibleEnd: 249_999,
          ringCapacity: 0,
          hierarchyReady: true,
        },
        want: false,
      },
    ];
    for (const c of cases) {
      expect(shouldUseHierarchyPresent(c.opts), c.name).toBe(c.want);
    }
    expect(HIERARCHY_ENABLE_MIN_RAW).toBeGreaterThan(0);
  });
});

describe('CPU tile aggregates', () => {
  it('buildTilesCpuReference matches per-tile min/max/count on sine series', () => {
    const n = 5000;
    const xy = makeSineXy(n);
    const tiles = buildTilesCpuReference(xy, n, n);
    expect(tiles.length).toBe(tileCountForCapacity(n));

    // Spot-check tile 0 and last full-ish tile.
    for (const t of [0, 1, tiles.length - 1]) {
      const tile = tiles[t]!;
      const physStart = t * HIERARCHY_TILE;
      const physEnd = Math.min(physStart + HIERARCHY_TILE, n);
      let minY = Infinity;
      let maxY = -Infinity;
      let count = 0;
      let sumY = 0;
      for (let i = physStart; i < physEnd; i++) {
        const y = xy[i * 2 + 1]!;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        sumY += y;
        count++;
      }
      expect(tile.count).toBe(count);
      expect(tile.minY).toBeCloseTo(minY, 5);
      expect(tile.maxY).toBeCloseTo(maxY, 5);
      expect(tile.sumY).toBeCloseTo(sumY, 3);
      expect(xy[tile.minIdx * 2 + 1]).toBeCloseTo(minY, 5);
      expect(xy[tile.maxIdx * 2 + 1]).toBeCloseTo(maxY, 5);
    }
  });

  it('partial last tile at non-multiple of TILE has correct count', () => {
    const n = HIERARCHY_TILE + 100;
    const xy = makeSineXy(n);
    const tiles = buildTilesCpuReference(xy, n, n);
    expect(tiles[0]!.count).toBe(HIERARCHY_TILE);
    expect(tiles[1]!.count).toBe(100);
  });

  it('after modular overwrite, range maintain touches O(tiles) not all tiles', () => {
    const cap = 100_000; // ~98 tiles
    const xy = makeSineXy(cap);
    // Full ring live
    let tiles = buildTilesCpuReference(xy, cap, cap);
    const nTiles = tiles.length;
    expect(nTiles).toBeGreaterThan(50);

    // Append 200 points overwriting physical [0, 200) (ringStart advanced 0→200)
    for (let i = 0; i < 200; i++) {
      xy[i * 2] = 1_000_000 + i;
      xy[i * 2 + 1] = 999;
    }
    const ranges = modularOverwriteRanges(0, 200, cap);
    const result = maintainTilesCpuRange(xy, cap, cap, tiles, ranges);
    // 200 points touch 1 tile only
    expect(result.tilesTouched).toBeLessThanOrEqual(2);
    expect(result.tilesTouched).toBeLessThan(nTiles / 4);

    // Rebuilt tile 0 should see the new peaks
    expect(result.tiles[0]!.maxY).toBeCloseTo(999, 5);
    // Untouched far tile unchanged identity
    const far = nTiles - 1;
    expect(result.tiles[far]).toEqual(tiles[far]);
  });

  it('multi-layer consistency: full rebuild equals incremental after several wraps', () => {
    const cap = 8192;
    const xy = makeSineXy(cap);
    let tiles = buildTilesCpuReference(xy, cap, cap);
    let ringStart = 0;

    for (let step = 0; step < 5; step++) {
      const k = 300;
      const newStart = (ringStart + k) % cap;
      // Overwrite physical range with new values
      const ranges = modularOverwriteRanges(ringStart, newStart, cap);
      for (const r of ranges) {
        for (let i = r.start; i < r.end; i++) {
          xy[i * 2] = step * 10_000 + i;
          xy[i * 2 + 1] = step * 100 + (i % 50);
        }
      }
      const incr = maintainTilesCpuRange(xy, cap, cap, tiles, ranges);
      tiles = incr.tiles;
      ringStart = newStart;

      const full = buildTilesCpuReference(xy, cap, cap);
      expect(tiles.length).toBe(full.length);
      for (let t = 0; t < full.length; t++) {
        expect(tiles[t]!.count).toBe(full[t]!.count);
        expect(tiles[t]!.minY).toBeCloseTo(full[t]!.minY, 4);
        expect(tiles[t]!.maxY).toBeCloseTo(full[t]!.maxY, 4);
        expect(tiles[t]!.sumY).toBeCloseTo(full[t]!.sumY, 2);
        expect(tiles[t]!.minIdx).toBe(full[t]!.minIdx);
        expect(tiles[t]!.maxIdx).toBe(full[t]!.maxIdx);
      }
    }
  });

  it('present residual: tile extrema selection dominates full-scan mid on synthetic peak', () => {
    // Pure-TS model of hierarchy min/max present: pick tile argmin/argmax when
    // fully covered; partial edges sample ≤8 endpoints-inclusive. Verifies a
    // single-peak series is recovered without scanning every point.
    const n = 4096;
    const xy = new Float32Array(n * 2);
    const peakIdx = 2500;
    for (let i = 0; i < n; i++) {
      xy[i * 2] = i;
      xy[i * 2 + 1] = i === peakIdx ? 1e6 : Math.sin(i * 0.01);
    }
    const tiles = buildTilesCpuReference(xy, n, n);
    // Interior bucket spanning tiles around the peak (logical = physical).
    const rangeStart = 2048;
    const rangeEnd = 3072;
    let bestY = -Infinity;
    let bestIdx = rangeStart;
    const t0 = Math.floor(rangeStart / HIERARCHY_TILE);
    const t1 = Math.floor((rangeEnd - 1) / HIERARCHY_TILE);
    for (let t = t0; t <= t1; t++) {
      const tile = tiles[t]!;
      const tilePhys0 = t * HIERARCHY_TILE;
      const tilePhys1 = Math.min(tilePhys0 + HIERARCHY_TILE, n);
      const full = tilePhys0 >= rangeStart && tilePhys1 <= rangeEnd;
      if (full && tile.count > 0 && tile.maxY > bestY) {
        bestY = tile.maxY;
        bestIdx = tile.maxIdx;
      } else if (!full) {
        const sLo = Math.max(rangeStart, tilePhys0);
        const sHi = Math.min(rangeEnd, tilePhys1);
        const rangeLen = sHi - sLo;
        const candCount = Math.min(8, rangeLen);
        for (let s = 0; s < candCount; s++) {
          const i = candCount <= 1 ? sLo : sLo + Math.floor((s * (rangeLen - 1)) / (candCount - 1));
          const y = xy[i * 2 + 1]!;
          if (y > bestY) {
            bestY = y;
            bestIdx = i;
          }
        }
      }
    }
    expect(bestIdx).toBe(peakIdx);
    expect(bestY).toBeCloseTo(1e6, 5);
  });

  it('CPU dual-range seam wrap: incremental matches full and tilesTouched O(overwrite)', () => {
    const cap = 4096;
    const xy = makeSineXy(cap);
    let tiles = buildTilesCpuReference(xy, cap, cap);
    // Cross seam: 3800 → 200 overwrites [3800,4096) U [0,200)
    const oldStart = 3800;
    const newStart = 200;
    const ranges = modularOverwriteRanges(oldStart, newStart, cap);
    expect(ranges).toHaveLength(2);
    for (const r of ranges) {
      for (let i = r.start; i < r.end; i++) {
        xy[i * 2] = 99_000 + i;
        xy[i * 2 + 1] = -42;
      }
    }
    const incr = maintainTilesCpuRange(xy, cap, cap, tiles, ranges);
    expect(incr.tilesTouched).toBeLessThan(10);
    const full = buildTilesCpuReference(xy, cap, cap);
    for (let t = 0; t < full.length; t++) {
      expect(incr.tiles[t]!.minY).toBeCloseTo(full[t]!.minY, 4);
      expect(incr.tiles[t]!.maxY).toBeCloseTo(full[t]!.maxY, 4);
      expect(incr.tiles[t]!.count).toBe(full[t]!.count);
    }
  });

  it('ring seam partial tile: logical→physical wrap covers two physical ranges', () => {
    const cap = 4096;
    const ranges = logicalRangeToPhysicalRanges(0, 1500, 3500, cap);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({ start: 3500, end: 4096 });
    expect(ranges[1]).toEqual({ start: 0, end: 904 });
    // Tile coverage across seam
    const touched = new Set<number>();
    for (const r of ranges) {
      const ov = tilesOverlappingPhysical(r.start, r.end)!;
      for (let t = ov.startTile; t < ov.endTileExclusive; t++) touched.add(t);
    }
    expect(touched.has(3)).toBe(true); // 3500/1024 = 3
    expect(touched.has(0)).toBe(true);
  });
});
