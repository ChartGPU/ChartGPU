// ohlc.wgsl
// Instanced thin OHLC bars (stem + open tick + close tick):
// - Per-instance vertex input is in **relative domain space** (same as candlestick):
//   - x = timestamp - packingOrigin (f32-safe; ms epoch collapses as absolute f32)
//   - open, close, low, high, tickLengthDomain (5 more floats)
//   - bodyColor rgba (4 floats)
// - Geometry expanded in relative domain; VSUniforms.transform maps →clip
//   with origin baked into the translation column (bx' = bx + ax * packingOrigin).
// - stemWidth is domain **X** units (CSS px → X) for vertical stem thickness.
// - tickThicknessY is domain **Y** units (CSS px → Y) for open/close tick thickness.
//   These must not share the X conversion: timestamp-scale X widths are huge in price Y
//   and would paint full-height slabs.
// - Draw call: draw(18, instanceCount) using triangle-list expansion in VS
//   - vertices 0-5: vertical stem (low → high)
//   - vertices 6-11: open tick (left of center)
//   - vertices 12-17: close tick (right of center)

struct VSUniforms {
  transform: mat4x4<f32>,
  stemWidth: f32,       // domain X
  tickThicknessY: f32,  // domain Y (full thickness; half applied in VS)
  logBaseX: f32,
  logBaseY: f32,
  // bit0 = log X, bit1 = log Y
  logFlags: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  @location(0) x: f32,
  @location(1) open: f32,
  @location(2) close: f32,
  @location(3) low: f32,
  @location(4) high: f32,
  @location(5) tickLength: f32,
  @location(6) bodyColor: vec4<f32>,
};

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

fn quadCorners(idx: u32) -> vec2<f32> {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0)
  );
  return corners[idx];
}

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  let stemHalf = vsUniforms.stemWidth * 0.5;
  // Horizontal tick thickness in **Y** domain (not stemWidth / domain X).
  let tickHalfH = vsUniforms.tickThicknessY * 0.5;

  var pos: vec2<f32>;

  if (vertexIndex < 6u) {
    // Vertical stem: (x ± stemHalf, low → high)
    let corner = quadCorners(vertexIndex);
    let minP = vec2<f32>(in.x - stemHalf, in.low);
    let maxP = vec2<f32>(in.x + stemHalf, in.high);
    pos = minP + corner * (maxP - minP);
  } else if (vertexIndex < 12u) {
    // Open tick: left of center at y = open
    let idx = vertexIndex - 6u;
    let corner = quadCorners(idx);
    let minP = vec2<f32>(in.x - in.tickLength, in.open - tickHalfH);
    let maxP = vec2<f32>(in.x, in.open + tickHalfH);
    pos = minP + corner * (maxP - minP);
  } else {
    // Close tick: right of center at y = close
    let idx = vertexIndex - 12u;
    let corner = quadCorners(idx);
    let minP = vec2<f32>(in.x, in.close - tickHalfH);
    let maxP = vec2<f32>(in.x + in.tickLength, in.close + tickHalfH);
    pos = minP + corner * (maxP - minP);
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
