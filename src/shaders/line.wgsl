// line.wgsl
// Minimal line-strip shader:
// - Vertex input: vec2<f32> position in data coords
// - Uniforms: clip-space transform + solid RGBA color

struct VSUniforms {
  transform: mat4x4<f32>,
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
fn vsMain(in: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPosition = vsUniforms.transform * vec4<f32>(in.position, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return fsUniforms.color;
}

