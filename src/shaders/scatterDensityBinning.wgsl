struct ComputeUniforms {
  transform: mat4x4<f32>,
  viewportPx: vec2f,
  _pad0: vec2f,
  plotOriginPx: vec2<u32>,
  plotSizePx: vec2<u32>,
  binSizePx: u32,
  binCountX: u32,
  binCountY: u32,
  visibleStart: u32,
  visibleEnd: u32,
  normalization: u32,
  _pad1: vec2<u32>,
};

@group(0) @binding(0) var<uniform> u: ComputeUniforms;
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>>;

struct MaxBuffer {
  value: atomic<u32>,
};
@group(0) @binding(3) var<storage, read_write> maxBuf: MaxBuffer;

fn clipToDevicePx(clip: vec2f) -> vec2f {
  // clip in [-1,1] -> device pixel in [0, viewport]
  return vec2f(
    (clip.x * 0.5 + 0.5) * u.viewportPx.x,
    (-clip.y * 0.5 + 0.5) * u.viewportPx.y
  );
}

@compute @workgroup_size(256)
fn binPoints(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = u.visibleStart + gid.x;
  if (idx >= u.visibleEnd) {
    return;
  }

  let p = points[idx];
  let clip4 = u.transform * vec4f(p.x, p.y, 0.0, 1.0);
  let clip = clip4.xy / max(1e-9, clip4.w);
  let px = clipToDevicePx(clip);

  // Scissor bounds in device px
  let left = f32(u.plotOriginPx.x);
  let top = f32(u.plotOriginPx.y);
  let right = left + f32(u.plotSizePx.x);
  let bottom = top + f32(u.plotSizePx.y);

  if (px.x < left || px.x >= right || px.y < top || px.y >= bottom) {
    return;
  }

  let localX = u32((px.x - left) / f32(u.binSizePx));
  let localY = u32((px.y - top) / f32(u.binSizePx));
  if (localX >= u.binCountX || localY >= u.binCountY) {
    return;
  }

  let binIndex = localY * u.binCountX + localX;
  atomicAdd(&bins[binIndex], 1u);
}

@compute @workgroup_size(256)
fn reduceMax(@builtin(global_invocation_id) gid: vec3<u32>) {
  let binTotal = u.binCountX * u.binCountY;
  let i = gid.x;
  if (i >= binTotal) {
    return;
  }

  let v = atomicLoad(&bins[i]);
  atomicMax(&maxBuf.value, v);
}

