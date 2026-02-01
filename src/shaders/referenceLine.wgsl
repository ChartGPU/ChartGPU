// Reference line renderer (axis-aligned, instanced quads).
//
// Coordinate conventions:
// - Instance position is provided in CANVAS-LOCAL CSS pixels (same coordinate space as pointer events).
// - Plot rect is provided in DEVICE pixels (computed from grid margins + DPR).
// - Line width and dash lengths are provided in CSS pixels and converted in-shader using DPR.
//
// Scissoring/clipping:
// - The render coordinator is expected to set a scissor rect for the plot area before drawing.
// - This shader simply draws full-height/full-width quads; clipping is handled by scissor.
//
// Dash semantics:
// - lineDash is a repeating on/off sequence in CSS pixels, starting with "on" at t=0.
// - Up to 8 dash entries are supported per line (truncated on CPU).
//
// Performance:
// - Vertex stage expands each instance into a quad (2 triangles, 6 vertices).
// - We intentionally avoid snapping to integer device pixels to prevent visible stepping/jiggle
//   while zooming; edge AA is handled in the fragment stage.

struct VSUniforms {
  canvasSize : vec2<f32>,     // device pixels (canvas.width, canvas.height)
  plotOrigin : vec2<f32>,     // device pixels (plotLeft, plotTop)
  plotSize : vec2<f32>,       // device pixels (plotWidth, plotHeight)
  devicePixelRatio : f32,
  _pad0 : f32,
};

@group(0) @binding(0) var<uniform> u : VSUniforms;

struct VSIn {
  // axisPos.x = axis (0 = vertical, 1 = horizontal)
  // axisPos.y = position in CANVAS-LOCAL CSS pixels (x for vertical, y for horizontal)
  @location(0) axisPos : vec2<f32>,

  // widthDashCount.x = lineWidth in CSS px
  // widthDashCount.y = dashCount (float, cast to u32)
  @location(1) widthDashCount : vec2<f32>,

  // dashMeta.x = dashTotal (CSS px)
  // dashMeta.y = reserved (unused)
  @location(2) dashMeta : vec2<f32>,

  @location(3) dash0_3 : vec4<f32>,
  @location(4) dash4_7 : vec4<f32>,

  // Premultiplied or straight alpha is fine; blending is handled by pipeline state.
  @location(5) color : vec4<f32>,
};

struct VSOut {
  @builtin(position) position : vec4<f32>,

  // Distance along the line in CSS pixels (0..plotLengthCss).
  @location(0) alongCss : f32,

  // Packed dash metadata to avoid extra varyings.
  // dashInfo.x = dashCount (float, cast to u32)
  // dashInfo.y = dashTotal (CSS px)
  @location(1) @interpolate(flat) dashInfo : vec2<f32>,

  @location(2) @interpolate(flat) dash0_3 : vec4<f32>,
  @location(3) @interpolate(flat) dash4_7 : vec4<f32>,
  @location(4) @interpolate(flat) color : vec4<f32>,

  // Axis-aligned quad anti-aliasing (device pixels).
  // acrossDevice ranges [0..widthDevice] across the stroke thickness.
  @location(5) acrossDevice : f32,
  @location(6) @interpolate(flat) widthDevice : f32,
};

fn quadUv(vid : u32) -> vec2<f32> {
  // Two triangles covering [0,1]x[0,1].
  // 0: (0,0) 1:(1,0) 2:(0,1) 3:(0,1) 4:(1,0) 5:(1,1)
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
fn vsMain(in : VSIn, @builtin(vertex_index) vid : u32) -> VSOut {
  let uv = quadUv(vid);
  let dpr = max(1e-6, u.devicePixelRatio);
  // IMPORTANT: Do NOT snap reference lines to integer device pixels.
  // Snapping looks crisp at rest but causes visible "jiggle" / stepping while zooming because
  // the line position is continuously changing (data-space → screen-space), and rounding
  // quantizes that motion to adjacent pixels. We rely on analytic AA in the fragment stage
  // to keep strokes stable and reasonably crisp across DPRs.

  let axis = in.axisPos.x;
  let posCss = in.axisPos.y;
  let widthCss = max(0.0, in.widthDashCount.x);
  let widthDevice = max(1.0, widthCss * dpr);

  var xDevice : f32;
  var yDevice : f32;
  var alongCss : f32;
  var acrossDevice : f32;

  if (axis < 0.5) {
    // Vertical line at x = posCss (canvas-local CSS px), spanning plot height.
    let centerX = posCss * dpr;
    let startX = centerX - 0.5 * widthDevice;
    xDevice = startX + uv.x * widthDevice;
    yDevice = u.plotOrigin.y + uv.y * u.plotSize.y;
    alongCss = (uv.y * u.plotSize.y) / dpr;
    acrossDevice = uv.x * widthDevice;
  } else {
    // Horizontal line at y = posCss (canvas-local CSS px), spanning plot width.
    let centerY = posCss * dpr;
    let startY = centerY - 0.5 * widthDevice;
    xDevice = u.plotOrigin.x + uv.x * u.plotSize.x;
    yDevice = startY + uv.y * widthDevice;
    alongCss = (uv.x * u.plotSize.x) / dpr;
    acrossDevice = uv.y * widthDevice;
  }

  let clipX = (xDevice / u.canvasSize.x) * 2.0 - 1.0;
  let clipY = 1.0 - (yDevice / u.canvasSize.y) * 2.0;

  var out : VSOut;
  out.position = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.alongCss = alongCss;
  out.dashInfo = vec2<f32>(in.widthDashCount.y, in.dashMeta.x);
  out.dash0_3 = in.dash0_3;
  out.dash4_7 = in.dash4_7;
  out.color = in.color;
  out.acrossDevice = acrossDevice;
  out.widthDevice = widthDevice;
  return out;
}

fn dashValue(i : u32, d0 : vec4<f32>, d1 : vec4<f32>) -> f32 {
  switch (i) {
    case 0u: { return d0.x; }
    case 1u: { return d0.y; }
    case 2u: { return d0.z; }
    case 3u: { return d0.w; }
    case 4u: { return d1.x; }
    case 5u: { return d1.y; }
    case 6u: { return d1.z; }
    default: { return d1.w; }
  }
}

@fragment
fn fsMain(in : VSOut) -> @location(0) vec4<f32> {
  // Analytic edge anti-aliasing for axis-aligned quads (reduces shimmering during zoom).
  // This is a lightweight alternative to full MSAA for thin strokes.
  let edgeDist = min(in.acrossDevice, in.widthDevice - in.acrossDevice);
  // Slightly widen AA to reduce temporal shimmer on moving 1-2px strokes.
  // Keep conservative so lines remain reasonably crisp.
  let aa = max(fwidth(in.acrossDevice), 1e-3) * 1.25;
  let edgeCoverage = smoothstep(0.0, aa, edgeDist);
  var color = in.color;
  color.a = color.a * edgeCoverage;

  let dashCount = u32(round(in.dashInfo.x));
  let dashTotal = in.dashInfo.y;

  // IMPORTANT: derivative ops (fwidth) must execute in uniform control flow.
  // So compute the dash parameterization unconditionally (using a safe total) BEFORE any early-return.
  let dashTotalSafe = max(dashTotal, 1.0);
  let t = in.alongCss - floor(in.alongCss / dashTotalSafe) * dashTotalSafe;
  // Anti-alias dash edges along the line axis (CSS pixels).
  // This reduces shimmer during zoom for dashed reference lines without requiring MSAA.
  let dashAa = max(fwidth(t), 1e-3);

  // Solid line (no dash pattern).
  if (dashCount == 0u || dashTotal <= 0.0) {
    return color;
  }

  var acc = 0.0;
  var on = true;

  for (var i : u32 = 0u; i < 8u; i = i + 1u) {
    if (i >= dashCount) { break; }
    let seg = dashValue(i, in.dash0_3, in.dash4_7);
    if (seg <= 0.0) { continue; }

    if (t < acc + seg) {
      // IMPORTANT: Avoid `discard` for off segments.
      // Discard can cause temporal popping on moving dashed edges; prefer a smooth alpha mask.
      //
      // Fade in/out near dash boundaries for smooth edges. This produces coverage in [0..1]
      // within the current segment, going to 0 at segment boundaries.
      let inFromStart = smoothstep(0.0, dashAa, t - acc);
      let inFromEnd = smoothstep(0.0, dashAa, (acc + seg) - t);
      let segCoverage = min(inFromStart, inFromEnd);

      // On segments contribute alpha; off segments contribute 0 alpha (no discard).
      let dashMask = select(0.0, segCoverage, on);
      color.a = color.a * dashMask;
      return color;
    }

    acc = acc + seg;
    on = !on;
  }

  // Defensive fallback if the dash list is degenerate.
  // If we didn't find a segment (shouldn't happen), default to transparent (safer than solid).
  color.a = 0.0;
  return color;
}
