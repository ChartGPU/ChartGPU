// area.wgsl
// Area-fill from a storage buffer of domain points (shared with line stroke):
// - points[i] = vec2(x, y) in data coords (optionally x - xOffset packed)
// - Draw triangle-list with 6 vertices × drawSegmentCount instances
//   (one trapezoid per consecutive pair; optional dense LOD stride)
// - instance_index selects the segment; vertex_index selects the 6 quad corners
// - Dual-endpoint NaN check collapses gap-spanning segments (matches line.wgsl).
//   Continuous triangle-strip collapse to clip origin does NOT restart a strip
//   and incorrectly fans through (0,0,0,0) — see GitHub issue #153.
// - Dense LOD (performance.lod auto): lodStride > 1 samples every Nth point so
//   multi-M raw residency still draws ~plot-pixel budget (group 8 mountain).

struct VSUniforms {
  transform: mat4x4<f32>,
  baseline: f32,
  // Independent bases so dual-log X/Y project correctly.
  logBaseX: f32,
  logBaseY: f32,
  // bit0 = log X, bit1 = log Y (DataStore stays data-space; log before mat4).
  logFlags: u32,
  // Dense draw LOD: instance i connects points[i0] → points[i1] where
  //   i0 = min(i * lodStride, lastPointIndex)
  //   i1 = min(i0 + lodStride, lastPointIndex)
  // lodStride == 1 → classic consecutive segments.
  lodStride: u32,
  lastPointIndex: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct FSUniforms {
  color: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms: FSUniforms;

@group(0) @binding(2) var<storage, read> points: array<vec2<f32>>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
};

// 6 vertices of a segment quad (2 triangles = trapezoid to baseline):
//   0: A top, 1: B top, 2: A baseline
//   3: A baseline, 4: B top, 5: B baseline
// uv.x: 0 → endpoint A, 1 → endpoint B
// uv.y: 0 → series y (top), 1 → baseline
fn segmentUv(vid: u32) -> vec2<f32> {
  switch (vid) {
    case 0u: { return vec2<f32>(0.0, 0.0); }
    case 1u: { return vec2<f32>(1.0, 0.0); }
    case 2u: { return vec2<f32>(0.0, 1.0); }
    case 3u: { return vec2<f32>(0.0, 1.0); }
    case 4u: { return vec2<f32>(1.0, 0.0); }
    default: { return vec2<f32>(1.0, 1.0); }
  }
}

// Chrome Tint rejects NaN constants — use explicit positive checks instead.
fn canLogProject(p: vec2<f32>) -> bool {
  let flags = vsUniforms.logFlags;
  if ((flags & 1u) != 0u && p.x <= 0.0) {
    return false;
  }
  if ((flags & 2u) != 0u && p.y <= 0.0) {
    return false;
  }
  return true;
}

fn projectData(p: vec2<f32>) -> vec2<f32> {
  let flags = vsUniforms.logFlags;
  if (flags == 0u) {
    return p;
  }
  var x = p.x;
  var y = p.y;
  if ((flags & 1u) != 0u) {
    x = log(x) / log(vsUniforms.logBaseX);
  }
  if ((flags & 2u) != 0u) {
    y = log(y) / log(vsUniforms.logBaseY);
  }
  return vec2<f32>(x, y);
}

@vertex
fn vsMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VSOut {
  var out: VSOut;
  let stride = max(vsUniforms.lodStride, 1u);
  let last = vsUniforms.lastPointIndex;
  let i0 = min(instanceIndex * stride, last);
  let i1 = min(i0 + stride, last);
  // Degenerate (no advance) — collapse (should not happen with correct draw count).
  if (i0 == i1) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let pA = points[i0];
  let pB = points[i1];

  // Dual-endpoint gap detection (same contract as line.wgsl).
  // Null entries are packed as NaN by the CPU. WGSL has no isnan(); use NaN != NaN.
  // Collapsing only one vertex of a continuous strip fans finite neighbors through
  // clip origin — per-segment instances fully discard when either endpoint is NaN.
  if (pA.x != pA.x || pA.y != pA.y || pB.x != pB.x || pB.y != pB.y) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let uv = segmentUv(vertexIndex);
  let p = select(pA, pB, uv.x > 0.5);
  // Baseline is data-space; log projection applies after select so fill-to-min works on log Y.
  let y = select(p.y, vsUniforms.baseline, uv.y > 0.5);
  let domainPos = vec2<f32>(p.x, y);
  if (!canLogProject(domainPos)) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let pos = projectData(domainPos);
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return fsUniforms.color;
}
