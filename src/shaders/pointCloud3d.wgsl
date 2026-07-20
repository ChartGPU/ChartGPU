// pointCloud3d.wgsl
// Camera-facing billboard quads for 3D point clouds (screen-constant size in CSS px).
// Instance data: storage buffer of struct { x, y, z, value } (16-byte stride).
// Draw: draw(6, instanceCount) triangle-list expansion in VS.

struct VSUniforms {
  viewProj: mat4x4<f32>,
  // xy = viewport CSS px, z = point size CSS px (default), w = dpr (unused for size)
  viewport: vec4<f32>,
  // x = valueMin, y = valueMax, z = useColormap (0/1), w = opacity
  colorParams: vec4<f32>,
  // solid RGBA when not colormapping
  solidColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(2) var colormapLut: texture_2d<f32>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) localPx: vec2<f32>,
  @location(1) radiusPx: f32,
  @location(2) color: vec4<f32>,
};

fn cornerOffset(corner: u32) -> vec2<f32> {
  // 0:(-1,-1) 1:(1,-1) 2:(-1,1) 3:(-1,1) 4:(1,-1) 5:(1,1) for two tris
  switch corner {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
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
  let p = points[instanceIndex];
  let world = vec4<f32>(p.xyz, 1.0);
  let clip = vsUniforms.viewProj * world;

  let radiusPx = max(0.5, vsUniforms.viewport.z * 0.5);
  let corner = cornerOffset(vertexIndex % 6u);
  let viewport = max(vsUniforms.viewport.xy, vec2<f32>(1.0, 1.0));

  // Expand in NDC by pixel size (constant screen size)
  let ndcOffset = vec2<f32>(
    corner.x * radiusPx * 2.0 / viewport.x,
    corner.y * radiusPx * 2.0 / viewport.y,
  );

  // Apply offset in clip space proportional to w so size is stable after perspective divide
  out.clipPosition = vec4<f32>(
    clip.x + ndcOffset.x * clip.w,
    clip.y + ndcOffset.y * clip.w,
    clip.z,
    clip.w,
  );
  out.localPx = corner * radiusPx;
  out.radiusPx = radiusPx;

  let useColormap = vsUniforms.colorParams.z > 0.5;
  let opacity = clamp(vsUniforms.colorParams.w, 0.0, 1.0);
  if (useColormap) {
    let vmin = vsUniforms.colorParams.x;
    let vmax = vsUniforms.colorParams.y;
    let span = max(vmax - vmin, 1e-12);
    let t = clamp((p.w - vmin) / span, 0.0, 1.0);
    // 256-wide 1D LUT stored as 256x1 texture
    let texW = f32(textureDimensions(colormapLut).x);
    let u = (t * (texW - 1.0) + 0.5) / texW;
    let sample = textureLoad(colormapLut, vec2<i32>(i32(t * 255.0), 0), 0);
    out.color = vec4<f32>(sample.rgb, sample.a * opacity);
  } else {
    out.color = vec4<f32>(vsUniforms.solidColor.rgb, vsUniforms.solidColor.a * opacity);
  }
  return out;
}

@fragment
fn fsMain(input: VSOut) -> @location(0) vec4<f32> {
  let d = length(input.localPx);
  let aa = fwidth(d);
  let alpha = 1.0 - smoothstep(input.radiusPx - aa, input.radiusPx, d);
  if (alpha <= 0.001) {
    discard;
  }
  let c = input.color;
  // Premultiply for correct blend with depth write on opaque-ish points
  let a = c.a * alpha;
  return vec4<f32>(c.rgb * a, a);
}
