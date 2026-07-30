// decimation.wgsl — GPU-side line-series decimation (downsampling).
//
// Three compute entry points, all at `@workgroup_size(64)` (the portable
// sweet-spot recommended by the WebGPU fundamentals compute-shader lesson).
//
// Output contract (shared across entry points):
//   output[0]               = raw[visibleStart]                  (first anchor, fixed)
//   output[targetBuckets-1] = raw[visibleEnd - 1]                (last anchor, fixed)
//   output[1..targetBuckets-2] = one decimated point per interior bucket
//
// Total output point count = `targetBuckets`. The caller draws `targetBuckets`
// vertices as a connected line strip of segments.
//
// Interior bucket index convention:
//   "interior bucket b" ∈ [0, targetBuckets - 2), covering raw index range
//     rangeStart = visibleStart + 1 + floor(span * b       / (targetBuckets - 2))
//     rangeEnd   = visibleStart + 1 + floor(span * (b + 1) / (targetBuckets - 2))
//   where `span = (visibleEnd - visibleStart) - 2`.
//
// Entry points:
//   1. `minMaxDecimate` — per-bucket argmin or argmax on y, mode bit 0 picks
//      min (0) vs max (1). Emits one point per bucket.
//   2. `computeBucketAverages` — per-bucket mean written into `averages`, used
//      as the stable anchor set for the parallel-LTTB pass.
//   3. `parallelLttbDecimate` — per-bucket triangle-area maximization where
//      the anchor is `averages[b - 1]` and the next reference is
//      `averages[b + 1]`. Standard "parallel LTTB" variant.
//
// Uniformity notes (Tint is strict):
//   - `workgroup_id.x` is uniform within a workgroup; it's safe to use as a
//     condition that gates a barrier.
//   - Every `workgroupBarrier()` in this file is reached by ALL threads of the
//     workgroup (no partial-workgroup returns before a barrier).

struct DecimationUniforms {
  rawPointCount : u32,
  visibleStart  : u32,
  visibleEnd    : u32,
  targetBuckets : u32,
  // Mode bit 0: 0 = min, 1 = max. Only consulted by min/max entry points.
  mode          : u32,
  // Fixed-capacity ring FIFO: physical index of the oldest logical point.
  // When ringCapacity == 0, raw storage is linear chronological (raw[i] = logical i).
  ringStart     : u32,
  ringCapacity  : u32,
  // Bit 0: hierarchy present path is active for this encode (TS sets from policy).
  hierarchyFlags : u32,
  // Number of valid physical tiles in `tiles` storage (ceil(physicalCap / 1024)).
  tileCount     : u32,
  // Physical capacity used to bound tile physical ranges (ringCapacity or N).
  physicalCapacity : u32,
  pad1          : u32,
  pad2          : u32,
};

// Physical tile aggregate (matches decimationHierarchy.wgsl `Tile`, 32 bytes).
struct HierarchyTile {
  minY   : f32,
  maxY   : f32,
  minIdx : u32,
  maxIdx : u32,
  sumX   : f32,
  sumY   : f32,
  count  : u32,
  pad    : u32,
};

@group(0) @binding(0) var<uniform> uni : DecimationUniforms;
@group(0) @binding(1) var<storage, read> rawPoints : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> output : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> averages : array<vec2<f32>>;
// Hierarchy tiles (physical). Always bound; legacy entry points ignore them.
@group(0) @binding(4) var<storage, read> tiles : array<HierarchyTile>;

// Map a chronological (logical) raw index into physical storage. Ring mode
// stores points modularly after FIFO wrap; linear mode is a no-op.
//
// Full-ring FIFO (suite G7 steady state): logicalIdx < ringCapacity, so
// ringStart + logicalIdx wraps **at most once**. Prefer a compare + subtract
// over `%` — integer modulo is expensive in the dense LTTB candidate loop
// (Phase B multi-M).
fn rawAt(logicalIdx : u32) -> vec2<f32> {
  if (uni.ringCapacity == 0u) {
    return rawPoints[logicalIdx];
  }
  let sum = uni.ringStart + logicalIdx;
  let phys = select(sum, sum - uni.ringCapacity, sum >= uni.ringCapacity);
  return rawPoints[phys];
}

// Shared-memory scratchpads for the intra-workgroup reductions. Sized to the
// literal workgroup width (64) so WGSL front-ends don't have to resolve a
// module-scope `const` into the array size.
var<workgroup> sharedIdx   : array<u32, 64>;
var<workgroup> sharedScore : array<f32, 64>;
var<workgroup> sharedSumX  : array<f32, 64>;
var<workgroup> sharedSumY  : array<f32, 64>;
var<workgroup> sharedCount : array<u32, 64>;

// floor(a * b / denom) for u32 without intermediate overflow.
//
// Direct `(span * bucketId) / interior` wraps at 2^32 when the product exceeds
// ~4.29e9. With default samplingThreshold=5000 (interior=4998) that first
// hits around visible span ≈ 859k points — the ultimate-benchmark "cut":
// early buckets stay correct (dense band on the left) while later buckets
// map to the wrong raw indices (thin wrong stroke on the right).
//
// Identity: floor(a*b/d) = floor(a/d)*b + floor((a%d)*b/d).
// Call sites pass b ≤ denom (bucketId ≤ interior), so floor(a/d)*b ≤ a.
fn umul64(a : u32, b : u32) -> vec2<u32> {
  // Returns (hi, lo) of the full 64-bit product a*b.
  let aLo = a & 0xFFFFu;
  let aHi = a >> 16u;
  let bLo = b & 0xFFFFu;
  let bHi = b >> 16u;
  let p0 = aLo * bLo;
  let p1 = aLo * bHi;
  let p2 = aHi * bLo;
  let p3 = aHi * bHi;
  let mid = (p0 >> 16u) + (p1 & 0xFFFFu) + (p2 & 0xFFFFu);
  let lo = (p0 & 0xFFFFu) | ((mid & 0xFFFFu) << 16u);
  let hi = p3 + (p1 >> 16u) + (p2 >> 16u) + (mid >> 16u);
  return vec2<u32>(hi, lo);
}

// floor((hi<<32 | lo) / d) as u32. Requires the true quotient to fit in 32 bits.
// Uses 32-step restoring division with remainder always < d (so rem*2 fits
// whenever d ≤ 2^31 — true for all ChartGPU bucket counts).
fn udiv64by32(hi : u32, lo : u32, d : u32) -> u32 {
  if (d == 0u) {
    return 0u;
  }
  var rem = hi % d;
  var quot : u32 = 0u;
  for (var i = 0u; i < 32u; i = i + 1u) {
    let bit = 31u - i;
    let loBit = (lo >> bit) & 1u;
    // rem < d ⇒ rem*2 + loBit < 2*d ≤ 2^32 when d ≤ 2^31.
    let candidate = rem * 2u + loBit;
    quot = quot << 1u;
    if (candidate >= d) {
      rem = candidate - d;
      quot = quot | 1u;
    } else {
      rem = candidate;
    }
  }
  return quot;
}

fn mulDivU32(a : u32, b : u32, denom : u32) -> u32 {
  if (denom == 0u || a == 0u || b == 0u) {
    return 0u;
  }
  // Fast path: a*b fits in u32.
  if (a <= 0xFFFFFFFFu / b) {
    return (a * b) / denom;
  }
  let q = a / denom;
  let r = a % denom;
  let main = q * b;
  if (r == 0u) {
    return main;
  }
  // Remainder term: floor(r*b/denom). Prefer direct mul when it fits.
  if (r <= 0xFFFFFFFFu / b) {
    return main + (r * b) / denom;
  }
  let prod = umul64(r, b);
  return main + udiv64by32(prod.x, prod.y, denom);
}

// Max raw points examined per interior bucket. When the bucket range is
// larger, candidates are uniformly subsampled (including endpoints).
//
// Rationale (FIFO extreme-N, e.g. 5M–10M × 5 series, samplingThreshold=2500):
//   Parallel LTTB otherwise full-scans the visible span twice per series
//   (~100M raw reads/frame at 10M×5). Cap keeps quality on dense waveforms
//   while bounding GPU bandwidth so period=1 (G2) stays interactive.
//
// At 1M × 2500 buckets ≈ 400 pts/bucket → full scan (exact; no 1M×5 regression).
// At 5M ≈ 2000 pts/bucket → DENSE_MAX candidates (~4× less bandwidth than a
//   512-cap; ~16× less than an uncapped scan).
// At 10M ≈ 4000 pts/bucket → same DENSE_MAX cap.
//
// **Approximation (all three entry points when rangeLen > 512):**
//   - LTTB / averages: triangle-area / mean over the uniform candidate set.
//   - min/max: argmin/argmax over candidates only — not the true bucket
//     extremum. Dense ECG/noise still preserves peaks well at 128 samples.
//   - Averages at extreme density use an even tighter set (see
//     bucketAverageCandidateCount) — coarse anchors are enough for parallel
//     LTTB while nearly free vs a second full candidate scan.
//
// Literal (not module const) so Chrome's WGSL front-end never couples this
// to workgroup_size / array-size resolution (see AGENTS.md WG_SIZE note).
//
// Map candidate index s ∈ [0, candCount) → raw index in [rangeStart, rangeEnd).
fn candidateRawIndex(rangeStart : u32, rangeLen : u32, s : u32, candCount : u32) -> u32 {
  if (candCount <= 1u || rangeLen <= 1u) {
    return rangeStart;
  }
  if (candCount >= rangeLen) {
    return rangeStart + s;
  }
  // Uniform including endpoints: floor(s * (rangeLen - 1) / (candCount - 1)).
  return rangeStart + mulDivU32(rangeLen - 1u, s, candCount - 1u);
}

// Exact scan while pts/bucket ≤ 512 (covers 1M×2500 ≈ 400). Above that,
// Phase B tight cap (128) for honest every-frame LTTB bandwidth.
// Shared by min/max + LTTB selection. Averages use bucketAverageCandidateCount.
fn bucketCandidateCount(rangeLen : u32) -> u32 {
  if (rangeLen > 512u) {
    return 128u;
  }
  return rangeLen;
}

// Averages only need coarse triangle anchors. At extreme density, scan far
// fewer points than LTTB selection (still endpoint-inclusive via candidateRawIndex).
fn bucketAverageCandidateCount(rangeLen : u32) -> u32 {
  if (rangeLen > 512u) {
    return 64u;
  }
  return rangeLen;
}

// Interior-bucket raw-index range, exclusive upper bound. Guarantees a
// non-empty range so reductions always have at least one candidate.
fn interiorBucketRange(bucketId : u32) -> vec2<u32> {
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;
  let buckets  = uni.targetBuckets;

  var result : vec2<u32> = vec2<u32>(visStart, visStart);

  if (buckets >= 3u && visEnd >= visStart + 2u) {
    let span     = visEnd - visStart - 2u;
    let interior = buckets - 2u;
    // Overflow-safe: see mulDivU32 (span*bucket u32 wrap).
    let lo       = visStart + 1u + mulDivU32(span, bucketId, interior);
    let hi       = visStart + 1u + mulDivU32(span, bucketId + 1u, interior);

    let maxIdx = visEnd - 1u;
    var loClamped = lo;
    if (loClamped > maxIdx) {
      loClamped = maxIdx;
    }
    var hiClamped = hi;
    if (hiClamped > maxIdx) {
      hiClamped = maxIdx;
    }
    if (hiClamped <= loClamped) {
      hiClamped = loClamped + 1u;
    }
    result = vec2<u32>(loClamped, hiClamped);
  }

  return result;
}

// WGSL has no isnan(); x != x is the IEEE-754 way to detect NaN.
fn isFiniteVec2(v : vec2<f32>) -> bool {
  return v.x == v.x && v.y == v.y;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point 1: min/max per-bucket (argmin or argmax on y).
// Dispatched with `max(targetBuckets - 2, 1)` workgroups.
// ─────────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn minMaxDecimate(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  // Thread 0 of workgroup 0 writes the two fixed anchors (first/last points).
  // Writes are scalar; no barrier interaction.
  if (bucketId == 0u && tid == 0u && buckets >= 1u && visEnd > visStart) {
    output[0] = rawAt(visStart);
    if (buckets >= 2u) {
      output[buckets - 1u] = rawAt(visEnd - 1u);
    }
  }

  let range      = interiorBucketRange(bucketId);
  let rangeStart = range.x;
  let rangeEnd   = range.y;
  let wantMax    = (uni.mode & 1u) == 1u;

  // Sentinel initialization: start at opposite extreme of what we're seeking.
  var bestY   : f32 = 3.4e38;
  if (wantMax) {
    bestY = -3.4e38;
  }
  var bestIdx : u32 = rangeStart;

  // Stride over candidates in workgroup-sized chunks (64 threads each).
  // Oversized buckets are uniformly subsampled (see bucketCandidateCount).
  // Degenerate empty range → candCount 0 → every thread skips; reduction safe.
  let rangeLenMm = rangeEnd - rangeStart;
  let candCountMm = bucketCandidateCount(rangeLenMm);
  var sMm : u32 = tid;
  while (sMm < candCountMm) {
    let i = candidateRawIndex(rangeStart, rangeLenMm, sMm, candCountMm);
    let p = rawAt(i);
    if (isFiniteVec2(p)) {
      if (wantMax) {
        if (p.y > bestY) {
          bestY = p.y;
          bestIdx = i;
        }
      } else {
        if (p.y < bestY) {
          bestY = p.y;
          bestIdx = i;
        }
      }
    }
    sMm = sMm + 64u;
  }

  sharedScore[tid] = bestY;
  sharedIdx[tid]   = bestIdx;
  workgroupBarrier();

  // Tree reduction (workgroup size is a power of two — 64).
  var stride : u32 = 32u;
  while (stride > 0u) {
    if (tid < stride) {
      let otherScore = sharedScore[tid + stride];
      let otherIdx   = sharedIdx[tid + stride];
      let mine       = sharedScore[tid];
      var take : bool = false;
      if (wantMax) {
        take = otherScore > mine;
      } else {
        take = otherScore < mine;
      }
      if (take) {
        sharedScore[tid] = otherScore;
        sharedIdx[tid]   = otherIdx;
      }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  // Only workgroups that correspond to actual interior buckets write an output.
  // Workgroup id 0 maps to interior bucket 0 → output slot 1. The last
  // dispatched workgroup maps to interior bucket (buckets - 3) → slot buckets-2.
  if (tid == 0u && buckets >= 3u && bucketId <= buckets - 3u) {
    output[bucketId + 1u] = rawAt(sharedIdx[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point 2: per-bucket averages (pre-pass for parallel LTTB).
// Dispatched with `targetBuckets` workgroups.
//
// Workgroup 0 writes averages[0] = raw[visibleStart] (first anchor).
// Workgroup (targetBuckets - 1) writes averages[last] = raw[visibleEnd - 1].
// Interior workgroups compute the mean of raw points in their interior bucket.
// ─────────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn computeBucketAverages(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  // Partition: isFirstAnchor (bucket 0), isLastAnchor (bucket last), else
  // interior. All three branches are uniform per workgroup because `bucketId`
  // and `buckets` are both workgroup-uniform.
  let isFirstAnchor = buckets >= 1u && bucketId == 0u;
  let isLastAnchor  = buckets >= 2u && bucketId + 1u == buckets;
  let isInterior    = buckets >= 3u && bucketId >= 1u && bucketId + 1u < buckets;

  // Anchor writes are single-scalar, so a non-uniform guard on tid is fine.
  if (isFirstAnchor && tid == 0u && visEnd > visStart) {
    averages[0] = rawAt(visStart);
  }
  if (isLastAnchor && tid == 0u && visEnd > visStart) {
    averages[buckets - 1u] = rawAt(visEnd - 1u);
  }

  // Interior bucket reduction. Even when !isInterior, all threads participate
  // in the shared-memory writes + barriers so the barrier is unconditionally
  // reached by the whole workgroup (single-exit uniform control flow).
  let range      = interiorBucketRange(bucketId - select(0u, 1u, isInterior));
  var rangeStart = range.x;
  var rangeEnd   = range.y;
  if (!isInterior) {
    // Collapse the range to zero so the accumulation loop is a no-op but the
    // barrier structure still fires for the whole workgroup.
    rangeStart = 0u;
    rangeEnd   = 0u;
  }

  var sumX : f32 = 0.0;
  var sumY : f32 = 0.0;
  var cnt  : u32 = 0u;

  // Uniform subsample when range is huge. Extreme density uses a tighter
  // average-only cap (bucketAverageCandidateCount) — anchors need less
  // precision than LTTB selection (Phase B bandwidth).
  let rangeLenAvg = rangeEnd - rangeStart;
  let candCountAvg = bucketAverageCandidateCount(rangeLenAvg);
  var sAvg : u32 = tid;
  while (sAvg < candCountAvg) {
    let i = candidateRawIndex(rangeStart, rangeLenAvg, sAvg, candCountAvg);
    let p = rawAt(i);
    if (isFiniteVec2(p)) {
      sumX = sumX + p.x;
      sumY = sumY + p.y;
      cnt  = cnt + 1u;
    }
    sAvg = sAvg + 64u;
  }

  sharedSumX[tid]  = sumX;
  sharedSumY[tid]  = sumY;
  sharedCount[tid] = cnt;
  workgroupBarrier();

  var stride : u32 = 32u;
  while (stride > 0u) {
    if (tid < stride) {
      sharedSumX[tid]  = sharedSumX[tid]  + sharedSumX[tid + stride];
      sharedSumY[tid]  = sharedSumY[tid]  + sharedSumY[tid + stride];
      sharedCount[tid] = sharedCount[tid] + sharedCount[tid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (isInterior && tid == 0u) {
    let totalCount = sharedCount[0];
    if (totalCount == 0u) {
      // Defensive fallback: empty bucket (all NaN). Use first raw point in the
      // nominal range so the downstream LTTB pass has a usable anchor.
      averages[bucketId] = rawAt(range.x);
    } else {
      let inv = 1.0 / f32(totalCount);
      averages[bucketId] = vec2<f32>(sharedSumX[0] * inv, sharedSumY[0] * inv);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point 3: parallel LTTB.
// Dispatched with `targetBuckets` workgroups (one per output slot).
//
// Workgroup 0 writes output[0] = first anchor.
// Workgroup (targetBuckets - 1) writes output[last] = last anchor.
// Interior workgroups maximize triangle area against (averages[b-1], averages[b+1]).
// ─────────────────────────────────────────────────────────────────────────────

@compute @workgroup_size(64)
fn parallelLttbDecimate(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  let isFirstAnchor = buckets >= 1u && bucketId == 0u;
  let isLastAnchor  = buckets >= 2u && bucketId + 1u == buckets;
  let isInterior    = buckets >= 3u && bucketId >= 1u && bucketId + 1u < buckets;

  if (isFirstAnchor && tid == 0u && visEnd > visStart) {
    output[0] = rawAt(visStart);
  }
  if (isLastAnchor && tid == 0u && visEnd > visStart) {
    output[buckets - 1u] = rawAt(visEnd - 1u);
  }

  // Interior reduction — same uniform-barrier structure as computeBucketAverages.
  let range      = interiorBucketRange(bucketId - select(0u, 1u, isInterior));
  var rangeStart = range.x;
  var rangeEnd   = range.y;
  if (!isInterior) {
    rangeStart = 0u;
    rangeEnd   = 0u;
  }

  // Safe to read `averages[bucketId ± 1]` only when interior; otherwise we read
  // a zeroed slot (harmless since we won't write output in those workgroups).
  var anchor  : vec2<f32> = vec2<f32>(0.0, 0.0);
  var nextRef : vec2<f32> = vec2<f32>(0.0, 0.0);
  if (isInterior) {
    anchor  = averages[bucketId - 1u];
    nextRef = averages[bucketId + 1u];
  }

  var bestScore : f32 = -1.0;
  var bestIdx   : u32 = rangeStart;

  // Cap candidates on oversized buckets (see bucketCandidateCount).
  let rangeLenLttb = rangeEnd - rangeStart;
  let candCountLttb = bucketCandidateCount(rangeLenLttb);
  var sLttb : u32 = tid;
  while (sLttb < candCountLttb) {
    let i = candidateRawIndex(rangeStart, rangeLenLttb, sLttb, candCountLttb);
    let c = rawAt(i);
    if (isFiniteVec2(c)) {
      // Unsigned triangle area (scaled by 2) via the cross product.
      let area2 = abs((anchor.x - nextRef.x) * (c.y - anchor.y)
                    - (anchor.x - c.x)     * (nextRef.y - anchor.y));
      if (area2 > bestScore) {
        bestScore = area2;
        bestIdx   = i;
      }
    }
    sLttb = sLttb + 64u;
  }

  sharedScore[tid] = bestScore;
  sharedIdx[tid]   = bestIdx;
  workgroupBarrier();

  var stride : u32 = 32u;
  while (stride > 0u) {
    if (tid < stride) {
      let otherScore = sharedScore[tid + stride];
      if (otherScore > sharedScore[tid]) {
        sharedScore[tid] = otherScore;
        sharedIdx[tid]   = sharedIdx[tid + stride];
      }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (isInterior && tid == 0u) {
    output[bucketId] = rawAt(sharedIdx[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy-backed present (Phase B multi‑M FIFO)
//
// Tiles are physical (buffer index). Logical bucket ranges map to ≤2 physical
// spans via ringStart. Full tiles contribute aggregates without raw re-scan;
// partial edge tiles scan raw on tid 0 (≤ TILE points per edge).
//
// Present kernels are **tid-0 only** and **O(tiles per bucket)** — never
// full-scan partial tiles (that path was as expensive as legacy at 1M×2500
// where each bucket is ~1 partial tile). Candidates:
//   - tile min/max when arg index falls in the bucket physical range
//   - else tile min/max y still used as shape proxy for LTTB (G4 residual)
//   - partial edges: ≤8 uniform raw samples + endpoints (not ≤128/full)
//
// This is the G4 hierarchy residual class: approximate extrema/shape vs full
// scan, same intent as the 128-candidate dense cap, but much cheaper at multi‑M.
// ─────────────────────────────────────────────────────────────────────────────

fn physicalAt(physIdx : u32) -> vec2<f32> {
  return rawPoints[physIdx];
}

fn logicalToPhysical(logicalIdx : u32) -> u32 {
  if (uni.ringCapacity == 0u) {
    return logicalIdx;
  }
  let sum = uni.ringStart + logicalIdx;
  return select(sum, sum - uni.ringCapacity, sum >= uni.ringCapacity);
}

fn logicalSpanPhysical(rangeStart : u32, rangeEnd : u32, spanIdx : u32) -> vec3<u32> {
  let logLen = rangeEnd - rangeStart;
  if (logLen == 0u) {
    return vec3<u32>(0u, 0u, 0u);
  }
  if (uni.ringCapacity == 0u) {
    if (spanIdx == 0u) {
      return vec3<u32>(rangeStart, rangeEnd, 1u);
    }
    return vec3<u32>(0u, 0u, 0u);
  }
  let phys0 = logicalToPhysical(rangeStart);
  if (phys0 + logLen <= uni.ringCapacity) {
    if (spanIdx == 0u) {
      return vec3<u32>(phys0, phys0 + logLen, 1u);
    }
    return vec3<u32>(0u, 0u, 0u);
  }
  let firstLen = uni.ringCapacity - phys0;
  if (spanIdx == 0u) {
    return vec3<u32>(phys0, uni.ringCapacity, 1u);
  }
  if (spanIdx == 1u) {
    return vec3<u32>(0u, logLen - firstLen, 1u);
  }
  return vec3<u32>(0u, 0u, 0u);
}

@compute @workgroup_size(64)
fn hierarchyMinMaxDecimate(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  if (tid != 0u) {
    return;
  }

  if (bucketId == 0u && buckets >= 1u && visEnd > visStart) {
    output[0] = rawAt(visStart);
    if (buckets >= 2u) {
      output[buckets - 1u] = rawAt(visEnd - 1u);
    }
  }

  if (buckets < 3u || bucketId > buckets - 3u) {
    return;
  }

  let range      = interiorBucketRange(bucketId);
  let rangeStart = range.x;
  let rangeEnd   = range.y;
  let wantMax    = (uni.mode & 1u) == 1u;

  var bestY : f32 = 3.4e38;
  if (wantMax) {
    bestY = -3.4e38;
  }
  var bestPhys : u32 = logicalToPhysical(rangeStart);

  let cap = select(uni.rawPointCount, uni.ringCapacity, uni.ringCapacity > 0u);
  let tileCap = uni.tileCount;

  for (var spanIdx = 0u; spanIdx < 2u; spanIdx = spanIdx + 1u) {
    let sp = logicalSpanPhysical(rangeStart, rangeEnd, spanIdx);
    if (sp.z == 0u) { continue; }
    let pLo = sp.x;
    let pHi = sp.y;
    if (pHi <= pLo) { continue; }

    var tStart = pLo / 1024u;
    var tEnd = (pHi - 1u) / 1024u + 1u;
    if (tEnd > tileCap) { tEnd = tileCap; }
    var t = tStart;
    while (t < tEnd) {
      let tilePhys0 = t * 1024u;
      var tilePhys1 = tilePhys0 + 1024u;
      if (tilePhys1 > cap) { tilePhys1 = cap; }
      let fullyCovered = tilePhys0 >= pLo && tilePhys1 <= pHi;
      let tile = tiles[t];
      if (tile.count > 0u) {
        // Prefer tile arg if it lands in this bucket's physical span.
        if (wantMax) {
          if (tile.maxIdx >= pLo && tile.maxIdx < pHi && tile.maxY > bestY) {
            bestY = tile.maxY;
            bestPhys = tile.maxIdx;
          } else if (fullyCovered && tile.maxY > bestY) {
            bestY = tile.maxY;
            bestPhys = tile.maxIdx;
          }
        } else {
          if (tile.minIdx >= pLo && tile.minIdx < pHi && tile.minY < bestY) {
            bestY = tile.minY;
            bestPhys = tile.minIdx;
          } else if (fullyCovered && tile.minY < bestY) {
            bestY = tile.minY;
            bestPhys = tile.minIdx;
          }
        }
      }
      if (!fullyCovered) {
        let sLo = select(pLo, tilePhys0, tilePhys0 > pLo);
        let sHi = select(pHi, tilePhys1, tilePhys1 < pHi);
        if (sHi > sLo) {
          let rangeLen = sHi - sLo;
          var candCount = rangeLen;
          if (candCount > 8u) { candCount = 8u; }
          var s = 0u;
          while (s < candCount) {
            var i = sLo;
            if (candCount > 1u && rangeLen > 1u) {
              i = sLo + mulDivU32(rangeLen - 1u, s, candCount - 1u);
            }
            let p = physicalAt(i);
            if (isFiniteVec2(p)) {
              if (wantMax) {
                if (p.y > bestY) { bestY = p.y; bestPhys = i; }
              } else {
                if (p.y < bestY) { bestY = p.y; bestPhys = i; }
              }
            }
            s = s + 1u;
          }
        }
      }
      t = t + 1u;
    }
  }

  output[bucketId + 1u] = physicalAt(bestPhys);
}

@compute @workgroup_size(64)
fn hierarchyBucketAverages(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  if (tid != 0u) {
    return;
  }

  let isFirstAnchor = buckets >= 1u && bucketId == 0u;
  let isLastAnchor  = buckets >= 2u && bucketId + 1u == buckets;
  let isInterior    = buckets >= 3u && bucketId >= 1u && bucketId + 1u < buckets;

  if (isFirstAnchor && visEnd > visStart) {
    averages[0] = rawAt(visStart);
  }
  if (isLastAnchor && visEnd > visStart) {
    averages[buckets - 1u] = rawAt(visEnd - 1u);
  }
  if (!isInterior) {
    return;
  }

  let range      = interiorBucketRange(bucketId - 1u);
  let rangeStart = range.x;
  let rangeEnd   = range.y;

  var sumX : f32 = 0.0;
  var sumY : f32 = 0.0;
  var cnt  : u32 = 0u;

  let cap = select(uni.rawPointCount, uni.ringCapacity, uni.ringCapacity > 0u);
  let tileCap = uni.tileCount;

  for (var spanIdx = 0u; spanIdx < 2u; spanIdx = spanIdx + 1u) {
    let sp = logicalSpanPhysical(rangeStart, rangeEnd, spanIdx);
    if (sp.z == 0u) { continue; }
    let pLo = sp.x;
    let pHi = sp.y;
    if (pHi <= pLo) { continue; }

    var tStart = pLo / 1024u;
    var tEnd = (pHi - 1u) / 1024u + 1u;
    if (tEnd > tileCap) { tEnd = tileCap; }
    var t = tStart;
    while (t < tEnd) {
      let tilePhys0 = t * 1024u;
      var tilePhys1 = tilePhys0 + 1024u;
      if (tilePhys1 > cap) { tilePhys1 = cap; }
      let fullyCovered = tilePhys0 >= pLo && tilePhys1 <= pHi;
      let tile = tiles[t];
      if (fullyCovered) {
        sumX = sumX + tile.sumX;
        sumY = sumY + tile.sumY;
        cnt = cnt + tile.count;
      } else if (tile.count > 0u) {
        // Partial: scale tile mean by overlap count estimate (no full raw scan).
        let sLo = select(pLo, tilePhys0, tilePhys0 > pLo);
        let sHi = select(pHi, tilePhys1, tilePhys1 < pHi);
        let overlap = sHi - sLo;
        let tileLen = tilePhys1 - tilePhys0;
        if (tileLen > 0u && overlap > 0u) {
          let frac = f32(overlap) / f32(tileLen);
          let estCount = u32(f32(tile.count) * frac + 0.5);
          let useCount = select(1u, estCount, estCount > 0u);
          let inv = 1.0 / f32(tile.count);
          let meanX = tile.sumX * inv;
          let meanY = tile.sumY * inv;
          sumX = sumX + meanX * f32(useCount);
          sumY = sumY + meanY * f32(useCount);
          cnt = cnt + useCount;
        }
      }
      t = t + 1u;
    }
  }

  if (cnt == 0u) {
    averages[bucketId] = rawAt(rangeStart);
  } else {
    let inv = 1.0 / f32(cnt);
    averages[bucketId] = vec2<f32>(sumX * inv, sumY * inv);
  }
}

@compute @workgroup_size(64)
fn hierarchyParallelLttb(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid      = lid.x;
  let bucketId = wgid.x;
  let buckets  = uni.targetBuckets;
  let visStart = uni.visibleStart;
  let visEnd   = uni.visibleEnd;

  if (tid != 0u) {
    return;
  }

  let isFirstAnchor = buckets >= 1u && bucketId == 0u;
  let isLastAnchor  = buckets >= 2u && bucketId + 1u == buckets;
  let isInterior    = buckets >= 3u && bucketId >= 1u && bucketId + 1u < buckets;

  if (isFirstAnchor && visEnd > visStart) {
    output[0] = rawAt(visStart);
  }
  if (isLastAnchor && visEnd > visStart) {
    output[buckets - 1u] = rawAt(visEnd - 1u);
  }
  if (!isInterior) {
    return;
  }

  let range      = interiorBucketRange(bucketId - 1u);
  let rangeStart = range.x;
  let rangeEnd   = range.y;
  let anchor     = averages[bucketId - 1u];
  let nextRef    = averages[bucketId + 1u];

  var bestScore : f32 = -1.0;
  var bestPhys  : u32 = logicalToPhysical(rangeStart);

  let cap = select(uni.rawPointCount, uni.ringCapacity, uni.ringCapacity > 0u);
  let tileCap = uni.tileCount;

  for (var spanIdx = 0u; spanIdx < 2u; spanIdx = spanIdx + 1u) {
    let sp = logicalSpanPhysical(rangeStart, rangeEnd, spanIdx);
    if (sp.z == 0u) { continue; }
    let pLo = sp.x;
    let pHi = sp.y;
    if (pHi <= pLo) { continue; }

    var tStart = pLo / 1024u;
    var tEnd = (pHi - 1u) / 1024u + 1u;
    if (tEnd > tileCap) { tEnd = tileCap; }
    var t = tStart;
    while (t < tEnd) {
      let tilePhys0 = t * 1024u;
      var tilePhys1 = tilePhys0 + 1024u;
      if (tilePhys1 > cap) { tilePhys1 = cap; }
      let fullyCovered = tilePhys0 >= pLo && tilePhys1 <= pHi;
      let tile = tiles[t];
      if (tile.count > 0u) {
        // Always score tile min/max as LTTB candidates (O(1) per tile).
        // If arg is outside the bucket span, still use it as a shape proxy (G4)
        // but prefer clamping pick to an in-range endpoint when needed.
        var i0 = tile.minIdx;
        var i1 = tile.maxIdx;
        if (i0 < pLo || i0 >= pHi) {
          i0 = pLo;
        }
        if (i1 < pLo || i1 >= pHi) {
          i1 = select(pLo, pHi - 1u, pHi > pLo);
        }
        let c0 = physicalAt(i0);
        let c1 = physicalAt(i1);
        // Also score true tile extrema samples when in range (already handled)
        // and tile mean snapped to mid physical of overlap.
        let sLo = select(pLo, tilePhys0, tilePhys0 > pLo);
        let sHi = select(pHi, tilePhys1, tilePhys1 < pHi);
        let mid = sLo + (sHi - sLo) / 2u;
        let cMid = physicalAt(mid);

        let candidates = array<vec2<f32>, 3>(c0, c1, cMid);
        let candIdx = array<u32, 3>(i0, i1, mid);
        for (var ci = 0u; ci < 3u; ci = ci + 1u) {
          let c = candidates[ci];
          if (isFiniteVec2(c)) {
            let area2 = abs((anchor.x - nextRef.x) * (c.y - anchor.y)
                          - (anchor.x - c.x) * (nextRef.y - anchor.y));
            if (area2 > bestScore) {
              bestScore = area2;
              bestPhys = candIdx[ci];
            }
          }
        }

        // When tile arg is inside range, also score the exact tile extreme point
        // (may differ from clamped i0/i1 when we replaced out-of-range args).
        if (tile.minIdx >= pLo && tile.minIdx < pHi) {
          let c = physicalAt(tile.minIdx);
          let area2 = abs((anchor.x - nextRef.x) * (c.y - anchor.y)
                        - (anchor.x - c.x) * (nextRef.y - anchor.y));
          if (area2 > bestScore) {
            bestScore = area2;
            bestPhys = tile.minIdx;
          }
        }
        if (tile.maxIdx >= pLo && tile.maxIdx < pHi) {
          let c = physicalAt(tile.maxIdx);
          let area2 = abs((anchor.x - nextRef.x) * (c.y - anchor.y)
                        - (anchor.x - c.x) * (nextRef.y - anchor.y));
          if (area2 > bestScore) {
            bestScore = area2;
            bestPhys = tile.maxIdx;
          }
        }
      }
      if (!fullyCovered) {
        // Bounded edge refine: ≤8 samples (not 128 / not full tile).
        let sLo = select(pLo, tilePhys0, tilePhys0 > pLo);
        let sHi = select(pHi, tilePhys1, tilePhys1 < pHi);
        let rangeLen = sHi - sLo;
        var candCount = rangeLen;
        if (candCount > 8u) { candCount = 8u; }
        var s = 0u;
        while (s < candCount) {
          var i = sLo;
          if (candCount > 1u && rangeLen > 1u) {
            i = sLo + mulDivU32(rangeLen - 1u, s, candCount - 1u);
          }
          let c = physicalAt(i);
          if (isFiniteVec2(c)) {
            let area2 = abs((anchor.x - nextRef.x) * (c.y - anchor.y)
                          - (anchor.x - c.x) * (nextRef.y - anchor.y));
            if (area2 > bestScore) {
              bestScore = area2;
              bestPhys = i;
            }
          }
          s = s + 1u;
        }
      }
      t = t + 1u;
    }
  }

  output[bucketId] = physicalAt(bestPhys);
}
