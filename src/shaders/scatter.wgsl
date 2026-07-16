// scatter.wgsl
// Instanced anti-aliased circle shader (SDF):
// - Variable-radius path (vsMain): per-instance center (vec2) + radiusPx.
// - Const-radius dual-buffer (vsMainConstRadiusSplit, production Option A):
//   separate float32 x and y instance buffers (shaderLocation 0/1); radius from
//   VSUniforms.radiusPx. Enables equal-N y-only upload of N×4 y bytes only.
// - Legacy interleaved const-radius entry (vsMainConstRadius): float32x2 centers
//   in one buffer — kept for shader completeness; renderer uses split path.
// - Draw call: draw(6, instanceCount) using triangle-list expansion in VS
// - Uniforms:
//   - @group(0) @binding(0): VSUniforms { transform, viewportPx, radiusPx }
//   - @group(0) @binding(1): FSUniforms { color }
//
// Notes:
// - `viewportPx` is the current render target size in pixels (width, height).
// - The quad is expanded in clip space using `radiusPx` and `viewportPx`.

struct VSUniforms {
  transform: mat4x4<f32>,
  viewportPx: vec2<f32>,
  // Constant-radius path: used by vsMainConstRadius. Per-instance path ignores this.
  radiusPx: f32,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct FSUniforms {
  color: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms: FSUniforms;

struct VSIn {
  @location(0) center: vec2<f32>,
  @location(1) radiusPx: f32,
};

struct VSInCenterOnly {
  @location(0) center: vec2<f32>,
};

// Dual-buffer const-radius: x and y in separate instance buffers so equal-N
// y-only rewrites upload only the y channel (N×4 bytes).
struct VSInXYSplit {
  @location(0) x: f32,
  @location(1) y: f32,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) localPx: vec2<f32>,
  @location(1) radiusPx: f32,
};

fn expandCircle(center: vec2<f32>, radiusPx: f32, vertexIndex: u32) -> VSOut {
  // Fixed local corners for 2 triangles (triangle-list).
  // `localNdc` is a quad in [-1, 1]^2; we convert it to pixel offsets via radiusPx.
  let localNdc = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );

  let corner = localNdc[vertexIndex];
  let localPx = corner * radiusPx;

  // Convert pixel offset to clip-space offset.
  // Clip space spans [-1, 1] across the viewport, so px -> clip is (2 / viewportPx).
  let localClip = localPx * (2.0 / vsUniforms.viewportPx);

  let centerClip = (vsUniforms.transform * vec4<f32>(center, 0.0, 1.0)).xy;

  var out: VSOut;
  out.clipPosition = vec4<f32>(centerClip + localClip, 0.0, 1.0);
  out.localPx = localPx;
  out.radiusPx = radiusPx;
  return out;
}

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  return expandCircle(in.center, in.radiusPx, vertexIndex);
}

@vertex
fn vsMainConstRadius(in: VSInCenterOnly, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  return expandCircle(in.center, vsUniforms.radiusPx, vertexIndex);
}

@vertex
fn vsMainConstRadiusSplit(in: VSInXYSplit, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  return expandCircle(vec2<f32>(in.x, in.y), vsUniforms.radiusPx, vertexIndex);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  // Signed distance to the circle boundary (negative inside).
  let dist = length(in.localPx) - in.radiusPx;

  // Analytic-ish AA: smooth edge based on derivative of dist in screen space.
  let w = fwidth(dist);
  let a = 1.0 - smoothstep(0.0, w, dist);

  // Discard fully outside to avoid unnecessary blending work.
  if (a <= 0.0) {
    discard;
  }

  return vec4<f32>(fsUniforms.color.rgb, fsUniforms.color.a * a);
}
