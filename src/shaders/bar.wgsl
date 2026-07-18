// bar.wgsl
// Instanced bar/rect shader:
// - Per-instance vertex input:
//   - rect  = vec4<f32>(x, y, width, height) in DATA DOMAIN space
//   - color = vec4<f32>(r, g, b, a) in [0..1]
// - Draw call: draw(6, instanceCount) using triangle-list expansion in VS
// - Uniforms:
//   - @group(0) @binding(0): VSUniforms { transform }  // domain → clip affine mat4
//
// Rect corners are expanded in domain space, then mapped to clip via:
//   clip = transform * vec4(domainPos, 0, 1)
// where transform encodes xClip = ax*x + bx, yClip = ay*y + by.

struct VSUniforms {
  transform: mat4x4<f32>,
  // Independent bases so dual-log X/Y project correctly.
  logBaseX: f32,
  logBaseY: f32,
  // bit0 = log X, bit1 = log Y
  logFlags: u32,
  _pad0: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  // rect.xy = origin (domain), rect.zw = size (domain width, domain height)
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

  // Normalize negative width/height by computing min/max extents (domain space).
  let p0 = in.rect.xy;
  let p1 = in.rect.xy + in.rect.zw;
  let rectMin = min(p0, p1);
  let rectMax = max(p0, p1);
  let rectSize = rectMax - rectMin;

  let corner = corners[vertexIndex];
  let domainPos = rectMin + corner * rectSize;

  // Log projection per-corner (data-space rect → log space → clip affine).
  var pos = domainPos;
  let flags = vsUniforms.logFlags;
  if (flags != 0u) {
    if ((flags & 1u) != 0u) {
      if (pos.x <= 0.0) {
        var outBad: VSOut;
        outBad.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        outBad.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return outBad;
      }
      pos.x = log(pos.x) / log(vsUniforms.logBaseX);
    }
    if ((flags & 2u) != 0u) {
      if (pos.y <= 0.0) {
        var outBad: VSOut;
        outBad.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        outBad.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return outBad;
      }
      pos.y = log(pos.y) / log(vsUniforms.logBaseY);
    }
  }

  var out: VSOut;
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
