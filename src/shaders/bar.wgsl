// bar.wgsl
// Instanced bar/rect shader:
// - Per-instance vertex input:
//   - rect  = vec4<f32>(x, y, width, height) in CLIP space
//   - color = vec4<f32>(r, g, b, a) in [0..1]
// - Draw call: draw(6, instanceCount) using triangle-list expansion in VS
// - Uniforms:
//   - @group(0) @binding(0): VSUniforms { transform }

struct VSUniforms {
  transform: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  // rect.xy = origin, rect.zw = size (width, height)
  @location(0) rect: vec4<f32>,
  @location(1) color: vec4<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  // Fixed local corners for 2 triangles (triangle-list).
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0)
  );

  // Normalize negative width/height by computing min/max extents.
  let p0 = in.rect.xy;
  let p1 = in.rect.xy + in.rect.zw;
  let rectMin = min(p0, p1);
  let rectMax = max(p0, p1);
  let rectSize = rectMax - rectMin;

  let corner = corners[vertexIndex];
  let pos = rectMin + corner * rectSize;

  var out: VSOut;
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}

