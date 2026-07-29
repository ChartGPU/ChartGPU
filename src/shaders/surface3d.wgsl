// surface3d.wgsl
// Uniform grid surface mesh: heights in storage buffer; position/normal expanded in VS.
// Steady-state replaceY uploads 4 B/cell (not 32 B interleaved vertices).

struct VSUniforms {
  viewProj: mat4x4<f32>,
  // xyz = light direction (world), w = lighting strength 0..1
  light: vec4<f32>,
  // x = yMin, y = yMax, z = opacity, w = unused
  colorParams: vec4<f32>,
  // ambient RGB + pad
  ambient: vec4<f32>,
  // xStart, xStep, zStart, zStep
  grid: vec4<f32>,
  // columns, rows, unused, unused (as f32 for uniform packing)
  gridDims: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;
@group(0) @binding(1) var colormapLut: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> heights: array<f32>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) color: vec4<f32>,
};

// Non-finite heights → 0 (matches prior packSurface3D heightAt policy).
fn heightAt(idx: u32, count: u32) -> f32 {
  if (idx >= count) {
    return 0.0;
  }
  let h = heights[idx];
  // NaN != NaN; also reject ±Inf via abs check against huge threshold is unnecessary —
  // WGSL select with isnan-equivalent: h == h is false for NaN.
  if (h != h) {
    return 0.0;
  }
  // ±Inf: treat as hole (0) for stable normals/positions
  if (h > 1e30 || h < -1e30) {
    return 0.0;
  }
  return h;
}

fn sampleVertex(vid: u32) -> VSOut {
  var out: VSOut;
  let columns = u32(vsUniforms.gridDims.x);
  let rows = u32(vsUniforms.gridDims.y);
  let count = columns * rows;
  if (columns < 2u || rows < 2u || vid >= count) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    out.worldNormal = vec3<f32>(0.0, 1.0, 0.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let i = vid % columns;
  let j = vid / columns;
  let xStart = vsUniforms.grid.x;
  let xStep = vsUniforms.grid.y;
  let zStart = vsUniforms.grid.z;
  let zStep = vsUniforms.grid.w;
  let x = xStart + f32(i) * xStep;
  let z = zStart + f32(j) * zStep;
  let h = heightAt(vid, count);

  // Central differences (edge-clamped), same as packSurface3D.
  // Use min/max — avoid u32 underflow from i-1 when i==0 in select() args.
  let iL = max(i, 1u) - 1u;
  let iR = min(i + 1u, columns - 1u);
  let jD = max(j, 1u) - 1u;
  let jU = min(j + 1u, rows - 1u);
  let hL = heightAt(j * columns + iL, count);
  let hR = heightAt(j * columns + iR, count);
  let hD = heightAt(jD * columns + i, count);
  let hU = heightAt(jU * columns + i, count);
  let dx = select(xStep, f32(iR - iL) * xStep, iR != iL);
  let dz = select(zStep, f32(jU - jD) * zStep, jU != jD);
  var nx = -(hR - hL) / dx;
  var ny = 1.0;
  var nz = -(hU - hD) / dz;
  let len = max(length(vec3<f32>(nx, ny, nz)), 1e-12);
  nx = nx / len;
  ny = ny / len;
  nz = nz / len;

  out.clipPosition = vsUniforms.viewProj * vec4<f32>(x, h, z, 1.0);
  out.worldNormal = vec3<f32>(nx, ny, nz);

  let ymin = vsUniforms.colorParams.x;
  let ymax = vsUniforms.colorParams.y;
  let span = max(ymax - ymin, 1e-12);
  let t = clamp((h - ymin) / span, 0.0, 1.0);
  let sample = textureLoad(colormapLut, vec2<i32>(i32(t * 255.0), 0), 0);
  let opacity = clamp(vsUniforms.colorParams.z, 0.0, 1.0);
  out.color = vec4<f32>(sample.rgb, sample.a * opacity);
  return out;
}

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  return sampleVertex(vid);
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

@vertex
fn vsMainWire(@builtin(vertex_index) vid: u32) -> VSOut {
  var out = sampleVertex(vid);
  // Slightly brighten wire (matches prior vsMainWire)
  out.color = vec4<f32>(out.color.rgb * 0.85 + 0.15, out.color.a);
  return out;
}

@fragment
fn fsMainWire(input: VSOut) -> @location(0) vec4<f32> {
  let a = input.color.a;
  return vec4<f32>(input.color.rgb * a, a);
}
