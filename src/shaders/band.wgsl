// band.wgsl
// Band fill between two curves sharing x:
// - points[i] = BandPoint { x, y, y1, _pad } in data coords
// - Draw triangle-list with 6 vertices × (pointCount - 1) instances
//   (one trapezoid per consecutive pair between y and y1 curves)
// - Dual-endpoint NaN check collapses gap-spanning segments (matches area.wgsl).

struct VSUniforms {
  transform: mat4x4<f32>,
  // Unused pad kept so layout matches area VS for shared affine helpers.
  _padBaseline: f32,
  logBaseX: f32,
  logBaseY: f32,
  logFlags: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct FSUniforms {
  color: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms: FSUniforms;

struct BandPoint {
  x: f32,
  y: f32,
  y1: f32,
  _pad: f32,
};

@group(0) @binding(2) var<storage, read> points: array<BandPoint>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
};

// 6 vertices of a segment quad between the two curves:
//   0: A y,  1: B y,  2: A y1
//   3: A y1, 4: B y,  5: B y1
// uv.x: 0 → endpoint A, 1 → endpoint B
// uv.y: 0 → y curve, 1 → y1 curve
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
  let pA = points[instanceIndex];
  let pB = points[instanceIndex + 1u];

  // Dual-endpoint gap detection: any NaN in x/y/y1 at A or B discards the segment.
  // WGSL has no isnan(); use NaN != NaN.
  if (
    pA.x != pA.x || pA.y != pA.y || pA.y1 != pA.y1 ||
    pB.x != pB.x || pB.y != pB.y || pB.y1 != pB.y1
  ) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let uv = segmentUv(vertexIndex);
  let x = select(pA.x, pB.x, uv.x > 0.5);
  let yCurve = select(pA.y, pB.y, uv.x > 0.5);
  let y1Curve = select(pA.y1, pB.y1, uv.x > 0.5);
  let y = select(yCurve, y1Curve, uv.y > 0.5);
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
