// axisBox3d.wgsl — simple 12-edge AABB wireframe for 3D charts.

struct VSUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  @location(0) position: vec3<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vsMain(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPosition = vsUniforms.viewProj * vec4<f32>(input.position, 1.0);
  out.color = vsUniforms.color;
  return out;
}

@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let a = input.color.a;
  return vec4<f32>(input.color.rgb * a, a);
}
