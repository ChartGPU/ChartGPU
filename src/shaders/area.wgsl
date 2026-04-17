// area.wgsl
// Area-fill shader (triangle-strip) using storage buffer reads:
// - No vertex buffer inputs — points are read from a shared storage buffer
// - Uniforms: clip-space transform + baseline value + solid RGBA color
// - Topology: triangle-strip
// - Each data point produces 2 vertices via vertex_index:
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

@group(0) @binding(2) var<storage, read> dataBuffer: array<vec2<f32>>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
  var out: VSOut;
  let dataIdx = vertexIndex / 2u;
  let isBaseline = (vertexIndex & 1u) == 1u;
  let point = dataBuffer[dataIdx];

  // NaN gap detection: WGSL has no isnan(); use the IEEE 754 property that NaN != NaN.
  // Emit a clip-space position guaranteed to be culled by fixed-function clipping
  // ((2,2) with w=1 lies outside the [-1,1] clip volume) to avoid implementation-defined
  // behavior when NaN coordinates would otherwise flow through the transform.
  if (point.x != point.x || point.y != point.y) {
    out.clipPosition = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    return out;
  }

  let y = select(point.y, vsUniforms.baseline, isBaseline);
  let pos = vec2<f32>(point.x, y);
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain() -> @location(0) vec4<f32> {
  return fsUniforms.color;
}
