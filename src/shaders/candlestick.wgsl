// candlestick.wgsl
// GPU storage-buffer candlestick shader (bodies + wicks):
// - Raw OHLC data read from a storage buffer (binding 1)
// - Affine scale transforms applied in the vertex shader via uniforms (binding 0)
// - Draw call: draw(18, candleCount) using triangle-list expansion in VS
//   - vertices 0-5:   body quad (2 triangles)
//   - vertices 6-11:  upper wick (2 triangles)
//   - vertices 12-17: lower wick (2 triangles)
// - Hollow mode:
//   - hollowMode 0 = classic (uses upColor / downColor)
//   - hollowMode 1 = hollow pass 1 (border colors for all candles)
//   - hollowMode 2 = hollow pass 2 (bgColor punch-out for up candles; body only, draw(6, N))

struct Uniforms {
  xScaleA: f32,
  xScaleB: f32,
  yScaleA: f32,
  yScaleB: f32,
  bodyWidthClip: f32,
  wickWidthClip: f32,
  borderWidthClip: f32,
  hollowMode: u32,
  upColor: vec4<f32>,
  downColor: vec4<f32>,
  upBorderColor: vec4<f32>,
  downBorderColor: vec4<f32>,
  bgColor: vec4<f32>,
};

struct OHLCData {
  timestamp: f32,
  open: f32,
  close: f32,
  low: f32,
  high: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> ohlcData: array<OHLCData>;

struct VSOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vsMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VSOut {
  let candle = ohlcData[instanceIndex];

  // Apply affine scale transforms to get clip-space positions
  let xClip = uniforms.xScaleA * candle.timestamp + uniforms.xScaleB;
  let openClip = uniforms.yScaleA * candle.open + uniforms.yScaleB;
  let closeClip = uniforms.yScaleA * candle.close + uniforms.yScaleB;
  let lowClip = uniforms.yScaleA * candle.low + uniforms.yScaleB;
  let highClip = uniforms.yScaleA * candle.high + uniforms.yScaleB;

  let isUp = candle.close > candle.open;

  // Select color based on hollow mode
  var color: vec4<f32>;
  if (uniforms.hollowMode == 2u) {
    // Hollow pass 2: punch-out with background color (up candles only)
    color = uniforms.bgColor;
  } else if (uniforms.hollowMode == 1u) {
    // Hollow pass 1: border colors
    color = select(uniforms.downBorderColor, uniforms.upBorderColor, isUp);
  } else {
    // Classic mode: fill colors
    color = select(uniforms.downColor, uniforms.upColor, isUp);
  }

  // Compute body width (inset for hollow pass 2)
  var bodyWidth = uniforms.bodyWidthClip;
  if (uniforms.hollowMode == 2u) {
    // Only punch out UP candles; collapse down candles to zero-area body
    if (!isUp) {
      bodyWidth = 0.0;
    } else {
      bodyWidth = max(0.0, bodyWidth - 2.0 * uniforms.borderWidthClip);
    }
  }

  // Compute body bounds
  let bodyTop = max(openClip, closeClip);
  let bodyBottom = min(openClip, closeClip);
  let bodyLeft = xClip - bodyWidth * 0.5;
  let bodyRight = xClip + bodyWidth * 0.5;

  // Wick bounds
  let wickLeft = xClip - uniforms.wickWidthClip * 0.5;
  let wickRight = xClip + uniforms.wickWidthClip * 0.5;

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
    // Upper wick (vertices 6-11): from bodyTop to highClip
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
    let wickMax = vec2<f32>(wickRight, highClip);
    pos = wickMin + corner * (wickMax - wickMin);
  } else {
    // Lower wick (vertices 12-17): from lowClip to bodyBottom
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
    let wickMin = vec2<f32>(wickLeft, lowClip);
    let wickMax = vec2<f32>(wickRight, bodyBottom);
    pos = wickMin + corner * (wickMax - wickMin);
  }

  var out: VSOut;
  out.clipPosition = vec4<f32>(pos, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
