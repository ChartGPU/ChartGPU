// axes3dGpuLabels.wgsl
// Camera-facing (screen-constant CSS px) glyph billboards for 3D axis labels.
// Instance storage: 12 floats —
//   world.xyz, pxOffset.x, pxOffset.y, halfW, halfH, u0, v0, u1, v1, pad
// Draw: draw(6, instanceCount). Depth test on, depth write off (pipeline state).

struct VSUniforms {
  viewProj: mat4x4<f32>,
  // xy = viewport CSS px, z = depth bias toward camera (NDC-ish * w), w = unused
  viewport: vec4<f32>,
  // theme text color (premul applied in FS with atlas alpha)
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;
@group(0) @binding(1) var<storage, read> instances: array<vec4<f32>>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSamp: sampler;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

fn cornerOffset(corner: u32) -> vec2<f32> {
  // CSS-ish: +x right, +y down for pixel offsets
  switch corner {
    case 0u: { return vec2<f32>(-1.0, -1.0); } // top-left if y-down
    case 1u: { return vec2<f32>(1.0, -1.0); }
    case 2u: { return vec2<f32>(-1.0, 1.0); }
    case 3u: { return vec2<f32>(-1.0, 1.0); }
    case 4u: { return vec2<f32>(1.0, -1.0); }
    default: { return vec2<f32>(1.0, 1.0); }
  }
}

@vertex
fn vsMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VSOut {
  var out: VSOut;
  // 3 vec4s per instance (12 floats)
  let base = instanceIndex * 3u;
  let a = instances[base + 0u];
  let b = instances[base + 1u];
  let c = instances[base + 2u];

  let world = vec3<f32>(a.x, a.y, a.z);
  let pxOffset = vec2<f32>(a.w, b.x);
  let halfSize = vec2<f32>(b.y, b.z);
  let uv0 = vec2<f32>(b.w, c.x);
  let uv1 = vec2<f32>(c.y, c.z);

  let clip = vsUniforms.viewProj * vec4<f32>(world, 1.0);
  // Hide behind-camera anchors (camera-only frames keep geometry without CPU cull).
  if (clip.w <= 1e-6) {
    out.clipPosition = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    out.uv = vec2<f32>(0.0, 0.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let corner = cornerOffset(vertexIndex % 6u);
  let px = pxOffset + corner * halfSize;
  let viewport = max(vsUniforms.viewport.xy, vec2<f32>(1.0, 1.0));

  // Expand in clip space (constant CSS px after perspective divide).
  // CSS y down → flip for NDC y up.
  let ndcOffset = vec2<f32>(
    px.x * 2.0 / viewport.x,
    -px.y * 2.0 / viewport.y,
  );

  // Pull slightly toward camera so labels win over box edges (depth write off).
  let zBias = vsUniforms.viewport.z;
  out.clipPosition = vec4<f32>(
    clip.x + ndcOffset.x * clip.w,
    clip.y + ndcOffset.y * clip.w,
    clip.z + zBias * clip.w,
    clip.w,
  );

  // corner (-1,-1) → uv0, (1,1) → uv1
  let uu = mix(uv0.x, uv1.x, corner.x * 0.5 + 0.5);
  let vv = mix(uv0.y, uv1.y, corner.y * 0.5 + 0.5);
  out.uv = vec2<f32>(uu, vv);
  out.color = vsUniforms.color;
  return out;
}

@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let s = textureSample(atlasTex, atlasSamp, input.uv);
  // Atlas is white glyphs + alpha (coverage). Colorize with theme textColor.
  let a = s.a * input.color.a;
  if (a <= 0.001) {
    discard;
  }
  // Premultiplied alpha for correct blend
  return vec4<f32>(input.color.rgb * a, a);
}
