// surface3d.wgsl
// Uniform grid surface mesh: positions + normals + height colormap.
// Vertex stride: x,y,z, nx,ny,nz, height, pad (8 floats).

struct VSUniforms {
  viewProj: mat4x4<f32>,
  // xyz = light direction (world), w = lighting strength 0..1
  light: vec4<f32>,
  // x = yMin, y = yMax, z = opacity, w = unused
  colorParams: vec4<f32>,
  // ambient RGB + pad
  ambient: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;
@group(0) @binding(1) var colormapLut: texture_2d<f32>;

struct VSIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) height: f32,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vsMain(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPosition = vsUniforms.viewProj * vec4<f32>(input.position, 1.0);
  out.worldNormal = input.normal;

  let ymin = vsUniforms.colorParams.x;
  let ymax = vsUniforms.colorParams.y;
  let span = max(ymax - ymin, 1e-12);
  let t = clamp((input.height - ymin) / span, 0.0, 1.0);
  let sample = textureLoad(colormapLut, vec2<i32>(i32(t * 255.0), 0), 0);
  let opacity = clamp(vsUniforms.colorParams.z, 0.0, 1.0);
  out.color = vec4<f32>(sample.rgb, sample.a * opacity);
  return out;
}

@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(input.worldNormal);
  let lightDir = normalize(vsUniforms.light.xyz);
  let strength = clamp(vsUniforms.light.w, 0.0, 1.0);
  let ndotl = max(dot(n, lightDir), 0.0);
  let ambient = vsUniforms.ambient.rgb;
  // lighting=0 → unlit colormap; lighting=1 → ambient + diffuse
  let lit = mix(vec3<f32>(1.0), ambient + vec3<f32>(ndotl), strength);
  let rgb = input.color.rgb * lit;
  let a = input.color.a;
  return vec4<f32>(rgb * a, a);
}

// Wireframe path reuses same VS but solid gray-ish from height mix
@vertex
fn vsMainWire(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPosition = vsUniforms.viewProj * vec4<f32>(input.position, 1.0);
  out.worldNormal = input.normal;
  let ymin = vsUniforms.colorParams.x;
  let ymax = vsUniforms.colorParams.y;
  let span = max(ymax - ymin, 1e-12);
  let t = clamp((input.height - ymin) / span, 0.0, 1.0);
  let sample = textureLoad(colormapLut, vec2<i32>(i32(t * 255.0), 0), 0);
  let opacity = clamp(vsUniforms.colorParams.z, 0.0, 1.0);
  // Slightly brighten wire
  out.color = vec4<f32>(sample.rgb * 0.85 + 0.15, opacity);
  return out;
}

@fragment
fn fsMainWire(input: VSOut) -> @location(0) vec4<f32> {
  let a = input.color.a;
  return vec4<f32>(input.color.rgb * a, a);
}
