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
  transform       : mat4x4<f32>,  // 64 bytes: data-coord → clip-space
  canvasSize      : vec2<f32>,     //  8 bytes: device pixels (width, height)
  devicePixelRatio: f32,           //  4 bytes
  lineWidthCssPx  : f32,           //  4 bytes: line width in CSS pixels
};
// Total: 80 bytes (aligned to 16).

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

  // Read segment endpoints in data coordinates.
  let pA_data = points[iid];
  let pB_data = points[iid + 1u];

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
