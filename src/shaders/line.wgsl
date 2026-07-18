// line.wgsl — Screen-space quad expansion with SDF-based anti-aliasing.
//
// Each "instance" draws one line segment (point[i] → point[i+1]).
// 6 vertices per instance (2 triangles = 1 quad per segment).
//
// The vertex shader:
//   1. Reads endpoints from a storage buffer.
//   2. Transforms both to clip space using the mat4x4 transform.
//   3. Converts clip→screen (NDC * canvasSize * 0.5).
//   4. Computes the perpendicular direction in screen space.
//   5. Offsets vertices by ±(halfWidth + AA_PADDING) along the perpendicular.
//   6. Converts back to clip space.
//   7. Outputs `acrossDevice` varying for SDF-based AA.
//
// The fragment shader applies smoothstep AA on the distance-from-edge.

const AA_PADDING: f32 = 1.5;

struct VSUniforms {
  transform       : mat4x4<f32>,  // 64 bytes: (log-)data-coord → clip-space
  canvasSize      : vec2<f32>,     //  8 bytes: device pixels (width, height)
  devicePixelRatio: f32,           //  4 bytes
  lineWidthCssPx  : f32,           //  4 bytes: line width in CSS pixels
  // Fixed-capacity ring FIFO (matches decimation.wgsl): physical index of oldest
  // logical point. When ringCapacity == 0, storage is linear chronological.
  ringStart       : u32,           //  4 bytes
  ringCapacity    : u32,           //  4 bytes
  // Log projection (DataStore stays data-space): bit0 = log X, bit1 = log Y.
  // When set, VS applies log_b(v) before the mat4. Non-positive → degenerate gap.
  // Bases are independent so dual-log X/Y can use different bases.
  logBaseX        : f32,           //  4 bytes
  logBaseY        : f32,           //  4 bytes
  logFlags        : u32,           //  4 bytes
  _pad0           : u32,           //  4 bytes
};
// Total: 112 bytes (aligned to 16).

@group(0) @binding(0) var<uniform> vsUniforms : VSUniforms;

struct FSUniforms {
  color : vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms : FSUniforms;

@group(0) @binding(2) var<storage, read> points : array<vec2<f32>>;

struct VSOut {
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) acrossDevice       : f32,
  @location(1) @interpolate(flat) widthDevice : f32,
};

// Map chronological (logical) index → physical storage. After maxPoints wrap,
// DataStore keeps modular physical order; drawing must connect logical neighbors
// (same contract as decimation.wgsl rawAt).
fn pointAt(logicalIdx : u32) -> vec2<f32> {
  if (vsUniforms.ringCapacity == 0u) {
    return points[logicalIdx];
  }
  let phys = (vsUniforms.ringStart + logicalIdx) % vsUniforms.ringCapacity;
  return points[phys];
}

// True when log-enabled axes have strictly positive values (required for log).
// Chrome Tint rejects NaN constants (`0.0/0.0`, bitcast quiet-NaN), so gaps are
// handled by canLogProject + degenerate verts — never by synthesizing NaN in WGSL.
fn canLogProject(p : vec2<f32>) -> bool {
  let flags = vsUniforms.logFlags;
  if ((flags & 1u) != 0u && p.x <= 0.0) {
    return false;
  }
  if ((flags & 2u) != 0u && p.y <= 0.0) {
    return false;
  }
  return true;
}

// Optional log projection in data space before the clip affine (mat4).
// Flags off → identity. Precondition: canLogProject(p) when flags != 0.
fn projectData(p : vec2<f32>) -> vec2<f32> {
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

// Returns UV for the 6 vertices of a quad (2 triangles):
//   uv.x: 0 → endpoint A, 1 → endpoint B
//   uv.y: 0 → +side, 1 → −side
fn quadUv(vid : u32) -> vec2<f32> {
  switch (vid) {
    case 0u: { return vec2<f32>(0.0, 0.0); }
    case 1u: { return vec2<f32>(1.0, 0.0); }
    case 2u: { return vec2<f32>(0.0, 1.0); }
    case 3u: { return vec2<f32>(0.0, 1.0); }
    case 4u: { return vec2<f32>(1.0, 0.0); }
    default: { return vec2<f32>(1.0, 1.0); }
  }
}

@vertex
fn vsMain(
  @builtin(vertex_index) vid : u32,
  @builtin(instance_index) iid : u32,
) -> VSOut {
  let uv = quadUv(vid);

  // Read segment endpoints in data coordinates (logical order under ring mode).
  let pA_raw = pointAt(iid);
  let pB_raw = pointAt(iid + 1u);

  // ── Gap detection ──────────────────────────────────────────────
  // Null entries in the data array are packed as NaN by the CPU.
  // Collapse the quad to a degenerate point so the rasterizer discards it.
  // WGSL has no isnan(); use the IEEE 754 property that NaN != NaN.
  if (pA_raw.x != pA_raw.x || pA_raw.y != pA_raw.y ||
      pB_raw.x != pB_raw.x || pB_raw.y != pB_raw.y ||
      !canLogProject(pA_raw) || !canLogProject(pB_raw)) {
    var out: VSOut;
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.acrossDevice = 0.0;
    out.widthDevice = 0.0;
    return out;
  }

  // Log axes: project data → log space, then affine (mat4) is in transformed space.
  let pA_data = projectData(pA_raw);
  let pB_data = projectData(pB_raw);

  // Transform to clip space.
  let clipA = vsUniforms.transform * vec4<f32>(pA_data, 0.0, 1.0);
  let clipB = vsUniforms.transform * vec4<f32>(pB_data, 0.0, 1.0);

  // Convert clip → screen (device pixels). 
  // screen = (ndc * 0.5 + 0.5) * canvasSize, but Y is flipped.
  let ndcA = clipA.xy / clipA.w;
  let ndcB = clipB.xy / clipB.w;
  let screenA = vec2<f32>(
    (ndcA.x * 0.5 + 0.5) * vsUniforms.canvasSize.x,
    (1.0 - (ndcA.y * 0.5 + 0.5)) * vsUniforms.canvasSize.y,
  );
  let screenB = vec2<f32>(
    (ndcB.x * 0.5 + 0.5) * vsUniforms.canvasSize.x,
    (1.0 - (ndcB.y * 0.5 + 0.5)) * vsUniforms.canvasSize.y,
  );

  // Segment direction and perpendicular in screen space.
  let delta = screenB - screenA;
  let segLen = length(delta);

  // Degenerate segment: collapse quad to a degenerate triangle.
  if (segLen < 1e-6) {
    var out : VSOut;
    out.clipPosition = clipA;
    out.acrossDevice = 0.0;
    out.widthDevice = 0.0;
    return out;
  }

  let dir = delta / segLen;
  // Perpendicular: rotate 90° CW → (dy, -dx).
  let perp = vec2<f32>(dir.y, -dir.x);

  // Compute line width in device pixels + AA padding.
  let dpr = max(vsUniforms.devicePixelRatio, 1e-6);
  let widthDevice = max(1.0, vsUniforms.lineWidthCssPx * dpr);
  let halfExtent = widthDevice * 0.5 + AA_PADDING;

  // Select endpoint: uv.x=0 → A, uv.x=1 → B.
  let baseScreen = mix(screenA, screenB, uv.x);

  // Offset perpendicular: uv.y selects +side (0) vs −side (1).
  let side = mix(1.0, -1.0, uv.y);
  let screenPos = baseScreen + perp * halfExtent * side;

  // acrossDevice: 0 at −side edge, widthDevice at +side edge.
  // Map from [−halfExtent, +halfExtent] to [0, widthDevice + 2*AA_PADDING].
  let totalExtent = 2.0 * halfExtent;
  let acrossDevice = (side * halfExtent + halfExtent) / totalExtent * totalExtent;
  // Simplified: acrossDevice = halfExtent * (1 + side) = halfExtent + halfExtent * side
  // But for the fragment shader we want [0, totalExtent]:
  // Let's define it properly:
  // At side=+1: screenPos is at +halfExtent from center → acrossDevice = totalExtent
  // At side=-1: screenPos is at -halfExtent from center → acrossDevice = 0
  let acrossDeviceVal = halfExtent * (1.0 + side);

  // Convert screen → clip.
  let clipX = (screenPos.x / vsUniforms.canvasSize.x) * 2.0 - 1.0;
  let clipY = 1.0 - (screenPos.y / vsUniforms.canvasSize.y) * 2.0;

  var out : VSOut;
  out.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.acrossDevice = acrossDeviceVal;
  out.widthDevice = widthDevice;
  return out;
}

@fragment
fn fsMain(in : VSOut) -> @location(0) vec4<f32> {
  let totalExtent = in.widthDevice + 2.0 * AA_PADDING;
  let edgeDist = min(in.acrossDevice, totalExtent - in.acrossDevice);

  // Smooth step from 0 to AA zone for anti-aliased edges.
  let aa = max(fwidth(in.acrossDevice), 1e-3) * 1.25;
  let edgeCoverage = smoothstep(0.0, aa, edgeDist);

  // Also fade out in the AA_PADDING region (beyond the nominal half-width).
  // The padding zone is [0, AA_PADDING] at each edge.
  // Distance from the nominal edge = edgeDist - AA_PADDING (negative means inside).
  // Actually, remap: the nominal line occupies [AA_PADDING, AA_PADDING + widthDevice].
  let nominalDist = min(in.acrossDevice - AA_PADDING, (AA_PADDING + in.widthDevice) - in.acrossDevice);
  let paddingCoverage = smoothstep(0.0, aa, nominalDist);

  // Combine: paddingCoverage handles the SDF fade, edgeCoverage handles the outer trim.
  // For thin lines (< 1 device px), paddingCoverage alone provides the desired fade.
  let coverage = min(edgeCoverage, paddingCoverage);

  var color = fsUniforms.color;
  color = vec4<f32>(color.rgb, color.a * coverage);
  return color;
}

// ── Dense hairline path (group 3 @ ≥DENSE_HAIRLINE_POINT_THRESHOLD) ─────────
// WebGPU line-list: 2 vertices per instance, native 1 device-px stroke.
// Avoids AA-quad expansion (6 verts + SDF fill) that cliffs ~50k under 4× MSAA.
// Used only when resolveLineDrawPolicy returns denseHairline; does not change data/sampling.

@vertex
fn vsMainHairline(
  @builtin(vertex_index) vid : u32,
  @builtin(instance_index) iid : u32,
) -> VSOut {
  // Dual-endpoint gap check (matches AA path): if either endpoint is NaN, collapse
  // the whole segment so one-sided nulls cannot draw a spur to clip origin.
  // Modular ring remap matches vsMain / decimation so wrap does not draw physical
  // newest→oldest edges.
  let pA_raw = pointAt(iid);
  let pB_raw = pointAt(iid + 1u);
  if (pA_raw.x != pA_raw.x || pA_raw.y != pA_raw.y || pB_raw.x != pB_raw.x || pB_raw.y != pB_raw.y ||
      !canLogProject(pA_raw) || !canLogProject(pB_raw)) {
    var out: VSOut;
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.acrossDevice = 0.0;
    out.widthDevice = 0.0;
    return out;
  }
  let pA = projectData(pA_raw);
  let pB = projectData(pB_raw);

  // vid is 0 or 1 for line-list topology.
  let p = select(pA, pB, vid != 0u);
  let clip = vsUniforms.transform * vec4<f32>(p, 0.0, 1.0);
  var out: VSOut;
  out.clipPosition = clip;
  // Solid coverage for fsMainHairline (varyings unused except color path).
  out.acrossDevice = 1.0;
  out.widthDevice = 1.0;
  return out;
}

@fragment
fn fsMainHairline(_in : VSOut) -> @location(0) vec4<f32> {
  return fsUniforms.color;
}
