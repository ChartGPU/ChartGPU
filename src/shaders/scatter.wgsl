// scatter.wgsl
// Instanced anti-aliased circle shader (SDF) with storage buffer reads:
// - Points read from a storage buffer (binding 2) containing interleaved [x, y] pairs
// - Per-instance: each point is one instance; vertex shader reads dataBuffer[instance_index]
// - Per-instance size read from binding 3 (one f32 per instance, in device pixels)
// - Draw call: draw(6, pointCount) using triangle-list expansion in VS
// - Uniforms:
//   - @group(0) @binding(0): VSUniforms { transform, viewportPx, symbolSizePx (unused) }
//   - @group(0) @binding(1): FSUniforms { color }
//   - @group(0) @binding(2): dataBuffer (storage, read-only array<vec2<f32>>)
//   - @group(0) @binding(3): sizes     (storage, read-only array<f32>) — device-pixel radius per instance
//
// Notes:
// - `viewportPx` is the current render target size in pixels (width, height).
// - Per-instance `sizes[instanceIndex]` is the circle radius in device pixels.
// - The quad is expanded in clip space using the per-instance radius and `viewportPx`.

struct VSUniforms {
  transform: mat4x4<f32>,
  viewportPx: vec2<f32>,
  // Retained for layout stability; no longer consumed by the shader (per-instance sizes
  // come from binding 3). Kept to avoid churn in the TS-side uniform byte layout.
  symbolSizePx: f32,
  // Pad to 16-byte alignment (mat4x4 is 64B; vec2 adds 8B; f32 adds 4B; pad f32 4B = 80B).
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct FSUniforms {
  color: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms: FSUniforms;

@group(0) @binding(2) var<storage, read> dataBuffer: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> sizes: array<f32>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) localPx: vec2<f32>,
  @location(1) radiusPx: f32,
};

@vertex
fn vsMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VSOut {
  // Fixed local corners for 2 triangles (triangle-list).
  // `localNdc` is a quad in [-1, 1]^2; we convert it to pixel offsets via symbolSizePx.
  let localNdc = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );

  let point = dataBuffer[instanceIndex];
  let radiusPx = sizes[instanceIndex];

  // NaN gap detection: WGSL has no isnan(); use the IEEE 754 property that NaN != NaN.
  // Emit a clip-space position that is guaranteed to be culled by fixed-function clipping
  // ((2,2) with w=1 lies outside the [-1,1] clip volume), rather than a degenerate
  // vec4(0,0,0,0) whose 0/0 perspective divide is implementation-defined.
  if (point.x != point.x || point.y != point.y) {
    var out: VSOut;
    out.clipPosition = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.localPx = vec2<f32>(0.0, 0.0);
    out.radiusPx = 0.0;
    return out;
  }

  let corner = localNdc[vertexIndex];
  let localPx = corner * radiusPx;

  // Convert pixel offset to clip-space offset.
  // Clip space spans [-1, 1] across the viewport, so px -> clip is (2 / viewportPx).
  let localClip = localPx * (2.0 / vsUniforms.viewportPx);

  let centerClip = (vsUniforms.transform * vec4<f32>(point, 0.0, 1.0)).xy;

  var out: VSOut;
  out.clipPosition = vec4<f32>(centerClip + localClip, 0.0, 1.0);
  out.localPx = localPx;
  out.radiusPx = radiusPx;
  return out;
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
