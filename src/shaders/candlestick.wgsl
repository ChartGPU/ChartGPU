// candlestick.wgsl
// Instanced candlestick shader (bodies + wicks):
// - Per-instance vertex input is in **relative domain space** (issue 1.3):
//   - x = timestamp - packingOrigin (f32-safe; ms epoch collapses as absolute f32)
//   - open, close, low, high, bodyWidthDomain (5 more floats)
//   - bodyColor rgba (4 floats)
// - Geometry is expanded in relative domain; VSUniforms.transform maps →clip
//   with origin baked into the translation column (bx' = bx + ax * packingOrigin).
// - wickWidth is also domain units (CSS px converted each frame) so pan/zoom
//   updates uniforms only when instance layout is stable.
// - Draw call: draw(18, instanceCount) using triangle-list expansion in VS
//   - vertices 0-5: body quad (2 triangles)
//   - vertices 6-11: upper wick (2 triangles)
//   - vertices 12-17: lower wick (2 triangles)

struct VSUniforms {
  transform: mat4x4<f32>,
  wickWidth: f32,
  // Independent bases so dual-log X/Y project correctly.
  logBaseX: f32,
  logBaseY: f32,
  // bit0 = log X, bit1 = log Y
  logFlags: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  @location(0) x: f32,
  @location(1) open: f32,
  @location(2) close: f32,
  @location(3) low: f32,
  @location(4) high: f32,
  @location(5) bodyWidth: f32,
  @location(6) bodyColor: vec4<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  // Domain-space body bounds (transform maps to clip)
  let bodyTop = max(in.open, in.close);
  let bodyBottom = min(in.open, in.close);
  let bodyLeft = in.x - in.bodyWidth * 0.5;
  let bodyRight = in.x + in.bodyWidth * 0.5;

  // Wick bounds (wickWidth is domain units converted from CSS px each frame)
  let wickLeft = in.x - vsUniforms.wickWidth * 0.5;
  let wickRight = in.x + vsUniforms.wickWidth * 0.5;

  var pos: vec2<f32>;

  if (vertexIndex < 6u) {
    // Body quad (vertices 0-5)
    let corners = array<vec2<f32>, 6>(
      vec2<f32>(0.0, 0.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(1.0, 1.0)
    );
    let corner = corners[vertexIndex];
    let bodyMin = vec2<f32>(bodyLeft, bodyBottom);
    let bodyMax = vec2<f32>(bodyRight, bodyTop);
    pos = bodyMin + corner * (bodyMax - bodyMin);
  } else if (vertexIndex < 12u) {
    // Upper wick (vertices 6-11): from bodyTop to high
    let idx = vertexIndex - 6u;
    let corners = array<vec2<f32>, 6>(
      vec2<f32>(0.0, 0.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(1.0, 1.0)
    );
    let corner = corners[idx];
    let wickMin = vec2<f32>(wickLeft, bodyTop);
    let wickMax = vec2<f32>(wickRight, in.high);
    pos = wickMin + corner * (wickMax - wickMin);
  } else {
    // Lower wick (vertices 12-17): from low to bodyBottom
    let idx = vertexIndex - 12u;
    let corners = array<vec2<f32>, 6>(
      vec2<f32>(0.0, 0.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(1.0, 1.0)
    );
    let corner = corners[idx];
    let wickMin = vec2<f32>(wickLeft, in.low);
    let wickMax = vec2<f32>(wickRight, bodyBottom);
    pos = wickMin + corner * (wickMax - wickMin);
  }

  // Log projection per-corner (OHLC stay data-space in instance buffer).
  let flags = vsUniforms.logFlags;
  if (flags != 0u) {
    if ((flags & 1u) != 0u) {
      if (pos.x <= 0.0) {
        var outBad: VSOut;
        outBad.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        outBad.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return outBad;
      }
      pos.x = log(pos.x) / log(vsUniforms.logBaseX);
    }
    if ((flags & 2u) != 0u) {
      if (pos.y <= 0.0) {
        var outBad: VSOut;
        outBad.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        outBad.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return outBad;
      }
      pos.y = log(pos.y) / log(vsUniforms.logBaseY);
    }
  }

  var out: VSOut;
  out.clipPosition = vsUniforms.transform * vec4<f32>(pos, 0.0, 1.0);
  out.color = in.bodyColor;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
