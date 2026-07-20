// heatmap.wgsl — Uniform data-space heatmap (texture + colormap LUT).
//
// One data-space quad (6 verts). VS places corners via signed origin+extent so
// UV (0,0) always maps to cell (0,0) even when xStep/yStep are negative (matches
// heatmapCellIndex / heatmapHitTest on CPU).
// FS: textureLoad raw z (r32float) → normalize → sample 1D LUT.

struct VSUniforms {
  transform  : mat4x4<f32>, // (log-)data-coord → clip-space
  // Signed grid placement (not sorted AABB):
  //   p = gridOrigin + uv * gridExtent
  gridOrigin : vec2<f32>,   // cell (0,0) min-corner after cellAnchor
  gridExtent : vec2<f32>,   // (columns*xStep, rows*yStep) — may be negative
  logBaseX   : f32,
  logBaseY   : f32,
  logFlags   : u32,         // bit0 = log X, bit1 = log Y
  _pad0      : u32,
};
// layout: mat4=64 + origin=8 + extent=8 + 4+4+4+4 = 96 bytes

struct FSUniforms {
  zMin         : f32,
  zMax         : f32,
  opacity      : f32,
  // 0 = linear, 1 = log
  zScaleMode   : u32,
  // 0 = transparent, 1 = lowest, 2 = highest
  nullHandling : u32,
  columns      : u32,
  rows         : u32,
  // UV inset for cellGap (0 = none)
  gapTexels    : f32,
};
// 32 bytes

@group(0) @binding(0) var<uniform> vsUniforms : VSUniforms;
@group(0) @binding(1) var<uniform> fsUniforms : FSUniforms;
@group(0) @binding(2) var zTex : texture_2d<f32>;
@group(0) @binding(3) var lutTex : texture_2d<f32>;

struct VSOut {
  @builtin(position) clipPosition : vec4<f32>,
  @location(0) uv : vec2<f32>, // 0..1 across grid (u = col index frac, v = row)
};

fn canLogProject(p : vec2<f32>) -> bool {
  let flags = vsUniforms.logFlags;
  if ((flags & 1u) != 0u && p.x <= 0.0) {
    return false;
  }
  if ((flags & 2u) != 0u && p.y <= 0.0) {
    return false;
  }
  return true;
}

fn projectData(p : vec2<f32>) -> vec2<f32> {
  let flags = vsUniforms.logFlags;
  if (flags == 0u) {
    return p;
  }
  var x = p.x;
  var y = p.y;
  if ((flags & 1u) != 0u) {
    x = log(x) / log(vsUniforms.logBaseX);
  }
  if ((flags & 2u) != 0u) {
    y = log(y) / log(vsUniforms.logBaseY);
  }
  return vec2<f32>(x, y);
}

// 6-vertex unit quad: uv in [0,1]^2 covering the grid.
fn quadUv(vid : u32) -> vec2<f32> {
  switch (vid) {
    case 0u: { return vec2<f32>(0.0, 0.0); }
    case 1u: { return vec2<f32>(1.0, 0.0); }
    case 2u: { return vec2<f32>(0.0, 1.0); }
    case 3u: { return vec2<f32>(0.0, 1.0); }
    case 4u: { return vec2<f32>(1.0, 0.0); }
    default: { return vec2<f32>(1.0, 1.0); }
  }
}

@vertex
fn vsMain(@builtin(vertex_index) vid : u32) -> VSOut {
  let uv = quadUv(vid);
  // Signed placement: u=0 is always column 0 (not axis-sorted left edge).
  let p = vsUniforms.gridOrigin + uv * vsUniforms.gridExtent;

  var out : VSOut;
  out.uv = uv;

  if (!canLogProject(p)) {
    // Degenerate off-screen for log-invalid corners.
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let pp = projectData(p);
  out.clipPosition = vsUniforms.transform * vec4<f32>(pp.x, pp.y, 0.0, 1.0);
  return out;
}

fn normalizeZ(z : f32) -> f32 {
  let zMin = fsUniforms.zMin;
  let zMax = fsUniforms.zMax;
  if (fsUniforms.zScaleMode == 1u) {
    // log
    if (!(z > 0.0) || !(zMin > 0.0) || !(zMax > 0.0)) {
      return -1.0; // sentinel → nullHandling
    }
    let lz = log(z);
    let l0 = log(zMin);
    let l1 = log(zMax);
    if (l0 == l1) {
      return 0.0;
    }
    return clamp((lz - l0) / (l1 - l0), 0.0, 1.0);
  }
  if (zMin == zMax) {
    return 0.0;
  }
  return clamp((z - zMin) / (zMax - zMin), 0.0, 1.0);
}

@fragment
fn fsMain(in : VSOut) -> @location(0) vec4f {
  let cols = fsUniforms.columns;
  let rows = fsUniforms.rows;
  if (cols == 0u || rows == 0u) {
    return vec4f(0.0);
  }

  // UV → texel: u=0 → column 0, v=0 → row 0 (matches heatmapCellIndex).
  let u = in.uv.x;
  let v = in.uv.y;

  let gap = fsUniforms.gapTexels;
  if (gap > 0.0) {
    let fx = u * f32(cols);
    let fy = v * f32(rows);
    let localX = fract(fx);
    let localY = fract(fy);
    // Approximate: discard near cell borders in UV space
    let border = clamp(gap * 0.5 / max(f32(cols), 1.0), 0.0, 0.45);
    if (localX < border || localX > (1.0 - border) || localY < border || localY > (1.0 - border)) {
      return vec4f(0.0);
    }
  }

  let ix = i32(clamp(floor(u * f32(cols)), 0.0, f32(cols - 1u)));
  let iy = i32(clamp(floor(v * f32(rows)), 0.0, f32(rows - 1u)));

  let zSample = textureLoad(zTex, vec2<i32>(ix, iy), 0).r;

  // Non-finite detection: compare with self (NaN != NaN).
  if (zSample != zSample) {
    if (fsUniforms.nullHandling == 1u) {
      let lut = textureLoad(lutTex, vec2<i32>(0, 0), 0);
      return vec4f(lut.rgb, lut.a * fsUniforms.opacity);
    }
    if (fsUniforms.nullHandling == 2u) {
      let lut = textureLoad(lutTex, vec2<i32>(255, 0), 0);
      return vec4f(lut.rgb, lut.a * fsUniforms.opacity);
    }
    return vec4f(0.0);
  }

  var t = normalizeZ(zSample);
  if (t < 0.0) {
    if (fsUniforms.nullHandling == 1u) {
      t = 0.0;
    } else if (fsUniforms.nullHandling == 2u) {
      t = 1.0;
    } else {
      return vec4f(0.0);
    }
  }

  let lutX = i32(round(t * 255.0));
  let lut = textureLoad(lutTex, vec2<i32>(lutX, 0), 0);
  return vec4f(lut.rgb, lut.a * fsUniforms.opacity);
}
