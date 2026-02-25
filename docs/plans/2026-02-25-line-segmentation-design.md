# Line Segmentation via `null` Gaps

**Date**: 2026-02-25
**Issue**: [#103 — Multiple segments for a line](https://github.com/ChartGPU/chartgpu/issues/103)
**Approach**: NaN sentinel in shader

## Problem

Users with data gaps (missing values or pre-split data segments) have no way to render disconnected line/area segments. ChartGPU draws a continuous line through all points.

## Solution

Allow `null` entries in `DataPoint[]` arrays to represent gaps. Nulls are packed as `[NaN, NaN]` into GPU buffers. The vertex shader detects NaN and collapses the affected geometry to zero area, producing visible gaps.

For pre-split data, users concatenate with null separators: `[...data1, null, ...data2]`.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Gap representation | `null` in data array | Most ergonomic, partially supported in existing pipeline |
| GPU approach | NaN sentinel in shader | Minimal changes, single draw call, no CPU segment tracking |
| Gap + area fill | Both line and fill break | Consistent, expected behavior |
| Sampling + gaps | Bypass sampling, use raw data | Correct for v1; gap-aware LTTB deferred |
| `connectNulls` option | Include in v1 | Trivial to implement (filter nulls before upload) |
| Same-name series merging | Not needed | `[...data1, null, ...data2]` covers the use case with one line of user code |
| Series scope | Line + area | Scatter doesn't benefit (independent points); bar/candlestick/pie deferred |

## Data Model & Types

Allow `null` in cartesian data arrays:

```typescript
// types.ts
export type CartesianSeriesData =
  | ReadonlyArray<DataPoint | null>
  | XYArraysData
  | InterleavedXYData;
```

New option on `LineSeriesConfig` and `AreaSeriesConfig`:

```typescript
readonly connectNulls?: boolean; // default: false
```

- `connectNulls: false` (default): nulls become `[NaN, NaN]` in GPU buffer, producing gaps.
- `connectNulls: true`: nulls stripped before GPU upload, line draws through the gap.

`XYArraysData` and `InterleavedXYData` do not support gaps in v1.

## GPU Shader Changes

### `line.wgsl`

Add NaN check after reading endpoints, before any math:

```wgsl
let pA_data = points[iid];
let pB_data = points[iid + 1u];

if (pA_data.x != pA_data.x || pA_data.y != pA_data.y ||
    pB_data.x != pB_data.x || pB_data.y != pB_data.y) {
  var out: VSOut;
  out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  out.acrossDevice = 0.0;
  out.widthDevice = 0.0;
  return out;
}
```

WGSL has no `isnan()` built-in; `x != x` detects NaN. Degenerate quads produce zero-area triangles discarded by the rasterizer.

### `area.wgsl`

Same NaN detection pattern. Area uses triangle-strip topology; NaN points produce degenerate triangles that break the fill visually.

### Performance

Negligible. One branch per instance in the vertex shader. GPU wavefronts handle uniform branches efficiently.

## Data Pipeline

- **`packXYInto()`**: Already writes `[NaN, NaN]` for null entries in `DataPoint[]` path. No changes.
- **`connectNulls` filter**: In `prepareSeries()` (renderSeries.ts), when `connectNulls: true`, filter nulls from data before `dataStore.setSeries()`.
- **Sampling bypass**: When data has null entries AND sampling enabled, skip sampling and use raw data with gaps. Controlled by a `hasGaps` check.
- **Bounds computation**: Already skips non-finite values. No changes.
- **Hit testing**: Already falls back to linear scan when NaN detected. No changes.
- **Visible slice / binary search**: `isMonotonicNonDecreasingFiniteX()` returns `false` with NaN, falling back to linear scan. Acceptable for v1.
- **Streaming append**: `appendSeries()` is byte-level; nulls in appended data pack as NaN via `packXYInto()`. No changes.

## Option Resolution

`connectNulls` resolved in `OptionResolver.ts` for line and area series:

```typescript
connectNulls: seriesConfig.connectNulls ?? false
```

Added to `ResolvedLineSeriesConfig` and `ResolvedAreaSeriesConfig` as `connectNulls: boolean` (non-optional).

## Testing

- **Unit tests**: `packXYInto()` with null entries, `connectNulls` resolution, visible slice with NaN
- **Shader testing**: Visual verification via example page
- **Example**: `examples/line-gaps/` — line with gaps, `connectNulls: true`, area with gaps
- **Acceptance test**: `examples/acceptance/line-gaps.ts`

## Out of Scope

- Gap support in `XYArraysData` / `InterleavedXYData`
- Gap-aware LTTB / bucket sampling
- Optimized binary search skipping NaN sentinels
- Gaps in bar, scatter, candlestick, pie
- Per-segment styling
- Same-name series merging
