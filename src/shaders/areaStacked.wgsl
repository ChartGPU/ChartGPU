// areaStacked.wgsl
// Stacked mountain/area fill: per-point yTop and yBottom (composition baselines).
// - points[i] = AreaPoint { x, y (top), y0 (bottom), _pad }
// - Triangle-list 6 verts × drawSegmentCount instances (same topology as area.wgsl)
// - Dual-endpoint NaN discard on x/y/y0
// - Dense LOD lodStride matches area.wgsl (performance.lod auto multi-M)

struct VSUniforms {
  transform: mat4x4<f32>,
  // Unused scalar baseline slot (layout parity with area.wgsl / affine helpers).
  _padBaseline: f32,
  logBaseX: f32,
  logBaseY: f32,
  logFlags: u32,
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

struct AreaPoint {
  x: f32,
  y: f32,
  y0: f32,
  _pad: f32,
};

@group(0) @binding(2) var<storage, read> points: array<AreaPoint>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
};

// 6 vertices of a segment quad between yTop and yBottom:
//   0: A top, 1: B top, 2: A bottom
//   3: A bottom, 4: B top, 5: B bottom
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
  if (i0 == i1) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let pA = points[i0];
  let pB = points[i1];

  if (
    pA.x != pA.x || pA.y != pA.y || pA.y0 != pA.y0 ||
    pB.x != pB.x || pB.y != pB.y || pB.y0 != pB.y0
  ) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let uv = segmentUv(vertexIndex);
  let x = select(pA.x, pB.x, uv.x > 0.5);
  let yTop = select(pA.y, pB.y, uv.x > 0.5);
  let yBot = select(pA.y0, pB.y0, uv.x > 0.5);
  let y = select(yTop, yBot, uv.y > 0.5);
  let domainPos = vec2<f32>(x, y);
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
