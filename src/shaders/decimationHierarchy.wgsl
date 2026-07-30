// decimationHierarchy.wgsl — GPU tile hierarchy maintain for streaming decimation.
//
// Physical-index tiles of size 1024 store min/max/sum aggregates over the raw
// storage buffer. Maintain is O(touched tiles): full rebuild on cold / equal-N
// rewrite, range invalidate on modular FIFO append overwrite or linear growth.
//
// Present path (hierarchyMinMax / hierarchyAverages / hierarchyLttb) lives in
// decimation.wgsl and reads these tiles. Tile layout is **physical** so ring
// wrap only rebuilds the overwritten physical range (not a full logical shift).
//
// Tile struct (32 bytes, 8 × u32/f32):
//   minY, maxY : f32
//   minIdx, maxIdx : u32   (physical indices of argmin/argmax y)
//   sumX, sumY : f32
//   count : u32
//   pad : u32
//
// Workgroup size is the literal 64 (Chrome WGSL lesson — do not use a shared
// const for both @workgroup_size and workgroup array sizes).

struct HierarchyMaintainUniforms {
  // Logical point count currently valid in the ring / linear buffer.
  rawPointCount    : u32,
  ringStart        : u32,
  // 0 = linear chronological; else fixed physical capacity of the ring.
  ringCapacity     : u32,
  // Physical indices that exist in raw storage (ringCapacity or rawPointCount).
  physicalCapacity : u32,
  // Inclusive-start tile index for this maintain dispatch.
  maintainStartTile : u32,
  // Number of tiles this dispatch rebuilds (workgroup count).
  maintainTileCount : u32,
  pad0 : u32,
  pad1 : u32,
};

struct Tile {
  minY   : f32,
  maxY   : f32,
  minIdx : u32,
  maxIdx : u32,
  sumX   : f32,
  sumY   : f32,
  count  : u32,
  pad    : u32,
};

@group(0) @binding(0) var<uniform> uni : HierarchyMaintainUniforms;
@group(0) @binding(1) var<storage, read> rawPoints : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> tiles : array<Tile>;

var<workgroup> sharedMinY   : array<f32, 64>;
var<workgroup> sharedMaxY   : array<f32, 64>;
var<workgroup> sharedMinIdx : array<u32, 64>;
var<workgroup> sharedMaxIdx : array<u32, 64>;
var<workgroup> sharedSumX   : array<f32, 64>;
var<workgroup> sharedSumY   : array<f32, 64>;
var<workgroup> sharedCount  : array<u32, 64>;

fn isFiniteVec2(v : vec2<f32>) -> bool {
  return v.x == v.x && v.y == v.y;
}

// Rebuild one physical tile per workgroup. Tile size is literal 1024.
@compute @workgroup_size(64)
fn maintainTiles(
  @builtin(workgroup_id) wgid : vec3<u32>,
  @builtin(local_invocation_id) lid : vec3<u32>,
) {
  let tid = lid.x;
  let localTile = wgid.x;
  if (localTile >= uni.maintainTileCount) {
    // Still participate in barriers via zeroed reduction below.
  }

  let tileId = uni.maintainStartTile + localTile;
  // TILE = 1024 (literal).
  let physStart = tileId * 1024u;
  var physEnd = physStart + 1024u;
  if (physEnd > uni.physicalCapacity) {
    physEnd = uni.physicalCapacity;
  }

  // Only physical indices that currently hold live points contribute.
  // Linear: live = [0, rawPointCount).
  // Ring full (rawPointCount == ringCapacity): all physical indices live.
  // Ring filling (ringStart == 0, N < cap): live = [0, N).
  // After wrap, all physical slots hold live data when N == ringCapacity.
  var liveEnd = uni.rawPointCount;
  if (uni.ringCapacity > 0u && uni.rawPointCount >= uni.ringCapacity) {
    liveEnd = uni.ringCapacity;
  }
  if (physEnd > liveEnd && uni.ringCapacity == 0u) {
    physEnd = liveEnd;
  }
  // Ring mode after wrap: entire physicalCapacity is live when full.
  // During fill (ringStart==0): live is [0, rawPointCount).
  if (uni.ringCapacity > 0u && uni.rawPointCount < uni.ringCapacity) {
    if (physEnd > uni.rawPointCount) {
      physEnd = uni.rawPointCount;
    }
  }

  var bestMinY : f32 = 3.4e38;
  var bestMaxY : f32 = -3.4e38;
  var bestMinIdx : u32 = physStart;
  var bestMaxIdx : u32 = physStart;
  var sumX : f32 = 0.0;
  var sumY : f32 = 0.0;
  var cnt  : u32 = 0u;

  if (localTile < uni.maintainTileCount && physStart < physEnd) {
    var i = physStart + tid;
    while (i < physEnd) {
      let p = rawPoints[i];
      if (isFiniteVec2(p)) {
        if (p.y < bestMinY) {
          bestMinY = p.y;
          bestMinIdx = i;
        }
        if (p.y > bestMaxY) {
          bestMaxY = p.y;
          bestMaxIdx = i;
        }
        sumX = sumX + p.x;
        sumY = sumY + p.y;
        cnt = cnt + 1u;
      }
      i = i + 64u;
    }
  }

  sharedMinY[tid] = bestMinY;
  sharedMaxY[tid] = bestMaxY;
  sharedMinIdx[tid] = bestMinIdx;
  sharedMaxIdx[tid] = bestMaxIdx;
  sharedSumX[tid] = sumX;
  sharedSumY[tid] = sumY;
  sharedCount[tid] = cnt;
  workgroupBarrier();

  var stride : u32 = 32u;
  while (stride > 0u) {
    if (tid < stride) {
      let oMinY = sharedMinY[tid + stride];
      if (oMinY < sharedMinY[tid]) {
        sharedMinY[tid] = oMinY;
        sharedMinIdx[tid] = sharedMinIdx[tid + stride];
      }
      let oMaxY = sharedMaxY[tid + stride];
      if (oMaxY > sharedMaxY[tid]) {
        sharedMaxY[tid] = oMaxY;
        sharedMaxIdx[tid] = sharedMaxIdx[tid + stride];
      }
      sharedSumX[tid] = sharedSumX[tid] + sharedSumX[tid + stride];
      sharedSumY[tid] = sharedSumY[tid] + sharedSumY[tid + stride];
      sharedCount[tid] = sharedCount[tid] + sharedCount[tid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (tid == 0u && localTile < uni.maintainTileCount) {
    var t : Tile;
    let total = sharedCount[0];
    if (total == 0u) {
      t.minY = 0.0;
      t.maxY = 0.0;
      t.minIdx = physStart;
      t.maxIdx = physStart;
      t.sumX = 0.0;
      t.sumY = 0.0;
      t.count = 0u;
      t.pad = 0u;
    } else {
      t.minY = sharedMinY[0];
      t.maxY = sharedMaxY[0];
      t.minIdx = sharedMinIdx[0];
      t.maxIdx = sharedMaxIdx[0];
      t.sumX = sharedSumX[0];
      t.sumY = sharedSumY[0];
      t.count = total;
      t.pad = 0u;
    }
    tiles[tileId] = t;
  }
}
