/**
 * Pure helpers for GPU tile hierarchy decimation (Phase B multi‑M FIFO).
 *
 * Tile layout is **physical** (buffer index space): modular FIFO append only
 * invalidates tiles covering the overwritten physical range. Present path maps
 * logical bucket ranges → physical tiles via ringStart/ringCapacity.
 *
 * TILE = 1024 (literal; keep in sync with decimationHierarchy.wgsl /
 * decimation.wgsl). Do not reintroduce multi-frame present amortization.
 */

/** Fixed physical tile width (points). Power of two; matches WGSL literals. */
export const HIERARCHY_TILE = 1024;

/**
 * Enable hierarchy present when raw residency is at least this many points
 * (avoids hierarchy overhead on tiny series). Modular FIFO multi‑K+ also
 * enables above this floor even when pts/bucket ≤ 512.
 */
export const HIERARCHY_ENABLE_MIN_RAW = 8192;

/** Bytes per tile struct in WGSL (`Tile`: 8 × 4). */
export const HIERARCHY_TILE_BYTES = 32;

export interface TileAggregate {
  minY: number;
  maxY: number;
  /** Physical index of argmin y (or physStart if empty). */
  minIdx: number;
  /** Physical index of argmax y (or physStart if empty). */
  maxIdx: number;
  sumX: number;
  sumY: number;
  count: number;
}

export function tileCountForCapacity(physicalCapacity: number, tileSize = HIERARCHY_TILE): number {
  const cap = Math.max(0, physicalCapacity | 0);
  if (cap <= 0) return 0;
  return Math.ceil(cap / tileSize);
}

export function tileIndexForPhysical(physIdx: number, tileSize = HIERARCHY_TILE): number {
  return Math.floor(Math.max(0, physIdx) / tileSize);
}

/**
 * Inclusive tile range covering physical indices [physStart, physEnd).
 * Returns null when the range is empty.
 */
export function tilesOverlappingPhysical(
  physStart: number,
  physEnd: number,
  tileSize = HIERARCHY_TILE
): { startTile: number; endTileExclusive: number } | null {
  const lo = Math.max(0, physStart | 0);
  const hi = Math.max(lo, physEnd | 0);
  if (hi <= lo) return null;
  const startTile = Math.floor(lo / tileSize);
  const endTileExclusive = Math.floor((hi - 1) / tileSize) + 1;
  return { startTile, endTileExclusive };
}

/**
 * Physical ranges overwritten when a full modular ring advances `ringStart`
 * from `oldRingStart` to `newRingStart` (capacity fixed). Length k steps
 * forward; wraps into at most two half-open intervals.
 */
export function modularOverwriteRanges(
  oldRingStart: number,
  newRingStart: number,
  ringCapacity: number
): Array<{ start: number; end: number }> {
  const cap = ringCapacity | 0;
  if (cap <= 0) return [];
  const oldS = ((oldRingStart % cap) + cap) % cap;
  const newS = ((newRingStart % cap) + cap) % cap;
  if (oldS === newS) return [];
  // k points written starting at oldRingStart (the previous oldest slots).
  if (newS > oldS) {
    return [{ start: oldS, end: newS }];
  }
  // Wrap: [oldS, cap) U [0, newS)
  const ranges: Array<{ start: number; end: number }> = [{ start: oldS, end: cap }];
  if (newS > 0) ranges.push({ start: 0, end: newS });
  return ranges;
}

/**
 * Map a half-open logical index range to physical half-open ranges (≤2).
 * Mirrors WGSL `rawAt` / ring layout: phys = (ringStart + logical) % cap.
 */
export function logicalRangeToPhysicalRanges(
  logicalStart: number,
  logicalEnd: number,
  ringStart: number,
  ringCapacity: number
): Array<{ start: number; end: number }> {
  const lo = Math.max(0, logicalStart | 0);
  const hi = Math.max(lo, logicalEnd | 0);
  if (hi <= lo) return [];
  const cap = ringCapacity | 0;
  if (cap <= 0) {
    return [{ start: lo, end: hi }];
  }
  const rs = ((ringStart % cap) + cap) % cap;
  const len = hi - lo;
  const phys0 = (rs + lo) % cap;
  if (phys0 + len <= cap) {
    return [{ start: phys0, end: phys0 + len }];
  }
  const firstLen = cap - phys0;
  return [
    { start: phys0, end: cap },
    { start: 0, end: len - firstLen },
  ];
}

/**
 * Whether hierarchy present should be used for this prepare signature.
 * Legacy full-scan remains for small N / sparse buckets when not modular multi‑K.
 *
 * Suite G7 1M×5 @ samplingThreshold 2500 ≈ 400 pts/bucket (≤512 exact band) but
 * still needs hierarchy for interactive FPS — enable on modular multi‑K **and**
 * near-M+ raw residency even when pts/bucket ≤ 512.
 */
export function shouldUseHierarchyPresent(opts: {
  rawPointCount: number;
  targetBuckets: number;
  visibleStart: number;
  visibleEnd: number;
  ringCapacity: number;
  hierarchyReady: boolean;
}): boolean {
  if (!opts.hierarchyReady) return false;
  const n = opts.rawPointCount | 0;
  if (n < HIERARCHY_ENABLE_MIN_RAW) return false;
  const buckets = Math.max(2, opts.targetBuckets | 0);
  const span = Math.max(0, (opts.visibleEnd | 0) - (opts.visibleStart | 0));
  const interior = Math.max(1, buckets - 2);
  const ptsPerBucket = span / interior;
  if (ptsPerBucket > 512) return true;
  // Modular FIFO multi‑K+: hierarchy maintain is O(append); present uses tile reps.
  if ((opts.ringCapacity | 0) > 0) return true;
  // Near-M+ linear residency (1M×2500 ≈ 400 pts/bucket still benefits).
  if (n >= 250_000) return true;
  if (n >= 512 * buckets) return true;
  return false;
}

/**
 * CPU reference tile builder over interleaved xy Float32 (or {x,y} pairs).
 * Physical indices [0, physicalCapacity); points beyond `liveCount` are ignored.
 */
export function buildTilesCpuReference(
  xy: ArrayLike<number>,
  liveCount: number,
  physicalCapacity: number,
  tileSize = HIERARCHY_TILE
): TileAggregate[] {
  const live = Math.max(0, Math.min(liveCount | 0, physicalCapacity | 0));
  const cap = Math.max(0, physicalCapacity | 0);
  const nTiles = tileCountForCapacity(cap, tileSize);
  const tiles: TileAggregate[] = new Array(nTiles);
  for (let t = 0; t < nTiles; t++) {
    const physStart = t * tileSize;
    const physEnd = Math.min(physStart + tileSize, live, cap);
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minIdx = physStart;
    let maxIdx = physStart;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let i = physStart; i < physEnd; i++) {
      const x = xy[i * 2]!;
      const y = xy[i * 2 + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (y < minY) {
        minY = y;
        minIdx = i;
      }
      if (y > maxY) {
        maxY = y;
        maxIdx = i;
      }
      sumX += x;
      sumY += y;
      count++;
    }
    tiles[t] = {
      minY: count === 0 ? 0 : minY,
      maxY: count === 0 ? 0 : maxY,
      minIdx,
      maxIdx,
      sumX,
      sumY,
      count,
    };
  }
  return tiles;
}

/**
 * Apply range maintain on top of existing tiles (CPU). Rebuilds only tiles
 * overlapping the given physical ranges — used to assert O(touched) policy.
 */
export function maintainTilesCpuRange(
  xy: ArrayLike<number>,
  liveCount: number,
  physicalCapacity: number,
  tiles: TileAggregate[],
  ranges: Array<{ start: number; end: number }>,
  tileSize = HIERARCHY_TILE
): { tiles: TileAggregate[]; tilesTouched: number } {
  const touched = new Set<number>();
  for (const r of ranges) {
    const ov = tilesOverlappingPhysical(r.start, r.end, tileSize);
    if (!ov) continue;
    for (let t = ov.startTile; t < ov.endTileExclusive; t++) {
      touched.add(t);
    }
  }
  const full = buildTilesCpuReference(xy, liveCount, physicalCapacity, tileSize);
  const next = tiles.slice();
  for (const t of touched) {
    if (t >= 0 && t < full.length) {
      next[t] = full[t]!;
    }
  }
  // Ensure length matches
  while (next.length < full.length) {
    next.push(full[next.length]!);
  }
  return { tiles: next, tilesTouched: touched.size };
}
