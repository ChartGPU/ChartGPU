// errorBar.wgsl
// Instanced error bars (stem + high/low whisker caps + optional center marker):
// - Per-instance vertex input is in **relative domain space** (x = domainX - packingOrigin):
//   - x, y (center), high, low (4 floats)
//   - bodyColor rgba (4 floats)
// - Geometry expanded in relative domain; VSUniforms.transform maps → clip
//   with origin baked into the translation column (bx' = bx + ax * packingOrigin).
// - Vertical: stem thickness stemWidth in domain **X**; cap thickness capThickness in domain **Y**.
// - Horizontal: stem thickness stemWidth in domain **Y**; cap thickness capThickness in domain **X**.
// - Never reuse domain-X units as Y thickness (OHLC lesson).
// - Draw: draw(24, instanceCount) triangle-list
//   - vertices 0-5: stem
//   - vertices 6-11: high cap
//   - vertices 12-17: low cap
//   - vertices 18-23: center marker (square)

struct VSUniforms {
  transform: mat4x4<f32>,
  stemWidth: f32,       // full thickness (domain cross-axis of stem)
  capThickness: f32,    // full thickness of caps (domain along stem axis)
  capHalfLength: f32,   // half tip-to-tip cap length (domain along cap)
  symbolHalf: f32,      // half center marker size (domain square)
  logBaseX: f32,
  logBaseY: f32,
  // bit0 = log X, bit1 = log Y
  logFlags: u32,
  // bit0-1: errorMode 0=both 1=high 2=low
  // bit2: drawWhiskers
  // bit3: drawConnector
  // bit4: showCenter
  // bit5: direction horizontal (0=vertical)
  drawFlags: u32,
};

@group(0) @binding(0) var<uniform> vsUniforms: VSUniforms;

struct VSIn {
  @location(0) x: f32,
  @location(1) y: f32,
  @location(2) high: f32,
  @location(3) low: f32,
  @location(4) bodyColor: vec4<f32>,
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

fn discardOut() -> VSOut {
  var outBad: VSOut;
  outBad.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  outBad.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return outBad;
}

@vertex
fn vsMain(in: VSIn, @builtin(vertex_index) vertexIndex: u32) -> VSOut {
  let flags = vsUniforms.drawFlags;
  let errorMode = flags & 3u;
  let drawWhiskers = (flags & 4u) != 0u;
  let drawConnector = (flags & 8u) != 0u;
  let showCenter = (flags & 16u) != 0u;
  let horizontal = (flags & 32u) != 0u;

  let stemHalf = vsUniforms.stemWidth * 0.5;
  let capHalfT = vsUniforms.capThickness * 0.5;
  let capHalfL = vsUniforms.capHalfLength;
  let symHalf = vsUniforms.symbolHalf;

  // Stem range by errorMode
  var stemA: f32;
  var stemB: f32;
  if (errorMode == 1u) {
    // high only: y → high
    stemA = in.y;
    stemB = in.high;
  } else if (errorMode == 2u) {
    // low only: low → y
    stemA = in.low;
    stemB = in.y;
  } else {
    stemA = in.low;
    stemB = in.high;
  }
  let stemLo = min(stemA, stemB);
  let stemHi = max(stemA, stemB);

  var pos: vec2<f32>;
  // Note: `active` is a WGSL reserved keyword — use drawPart.
  var drawPart = false;

  if (vertexIndex < 6u) {
    // Stem
    if (drawConnector) {
      drawPart = true;
      let corner = quadCorners(vertexIndex);
      if (horizontal) {
        let minP = vec2<f32>(stemLo, in.y - stemHalf);
        let maxP = vec2<f32>(stemHi, in.y + stemHalf);
        pos = minP + corner * (maxP - minP);
      } else {
        let minP = vec2<f32>(in.x - stemHalf, stemLo);
        let maxP = vec2<f32>(in.x + stemHalf, stemHi);
        pos = minP + corner * (maxP - minP);
      }
    }
  } else if (vertexIndex < 12u) {
    // High cap
    let drawHigh = drawWhiskers && (errorMode == 0u || errorMode == 1u);
    if (drawHigh) {
      drawPart = true;
      let idx = vertexIndex - 6u;
      let corner = quadCorners(idx);
      if (horizontal) {
        let minP = vec2<f32>(in.high - capHalfT, in.y - capHalfL);
        let maxP = vec2<f32>(in.high + capHalfT, in.y + capHalfL);
        pos = minP + corner * (maxP - minP);
      } else {
        let minP = vec2<f32>(in.x - capHalfL, in.high - capHalfT);
        let maxP = vec2<f32>(in.x + capHalfL, in.high + capHalfT);
        pos = minP + corner * (maxP - minP);
      }
    }
  } else if (vertexIndex < 18u) {
    // Low cap
    let drawLow = drawWhiskers && (errorMode == 0u || errorMode == 2u);
    if (drawLow) {
      drawPart = true;
      let idx = vertexIndex - 12u;
      let corner = quadCorners(idx);
      if (horizontal) {
        let minP = vec2<f32>(in.low - capHalfT, in.y - capHalfL);
        let maxP = vec2<f32>(in.low + capHalfT, in.y + capHalfL);
        pos = minP + corner * (maxP - minP);
      } else {
        let minP = vec2<f32>(in.x - capHalfL, in.low - capHalfT);
        let maxP = vec2<f32>(in.x + capHalfL, in.low + capHalfT);
        pos = minP + corner * (maxP - minP);
      }
    }
  } else {
    // Center marker (square)
    if (showCenter) {
      drawPart = true;
      let idx = vertexIndex - 18u;
      let corner = quadCorners(idx);
      let minP = vec2<f32>(in.x - symHalf, in.y - symHalf);
      let maxP = vec2<f32>(in.x + symHalf, in.y + symHalf);
      pos = minP + corner * (maxP - minP);
    }
  }

  if (!drawPart) {
    return discardOut();
  }

  let logF = vsUniforms.logFlags;
  if (logF != 0u) {
    if ((logF & 1u) != 0u) {
      if (pos.x <= 0.0) {
        return discardOut();
      }
      pos.x = log(pos.x) / log(vsUniforms.logBaseX);
    }
    if ((logF & 2u) != 0u) {
      if (pos.y <= 0.0) {
        return discardOut();
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
