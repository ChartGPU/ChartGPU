// area.wgsl
// Minimal area-fill shader (triangle-strip):
// - Vertex input: vec2<f32> position in data coords
// - Uniforms: clip-space transform + baseline value + solid RGBA color
// - Topology: triangle-strip
// - CPU duplicates vertices as p0,p0,p1,p1,... and we use vertex_index parity:
//   even index -> "top" vertex (original y)
//   odd index  -> "baseline" vertex (uniform baseline)

struct VSUniforms {
  transform: mat4x4<f32>,
  baseline: f32,
  // Pad to 16-byte multiple (uniform buffer layout requirements).
  _pad0: vec3<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct FSUniforms {
  color: vec4<f32>,
};

@group(0) @binding(1) var<uniform> fsUniforms: FSUniforms;

struct VSIn {
  @location(0) position: vec2<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
};

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  var out: VSOut;
  let useBaseline = (vertexIndex & 1u) == 1u;
  let y = select(in.position.y, vsUniforms.baseline, useBaseline);
  let pos = vec2<f32>(in.position.x, y);
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return fsUniforms.color;
}

