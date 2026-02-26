# Line Segmentation (Null Gaps) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow `null` entries in data arrays to render disconnected line/area segments, with an opt-in `connectNulls` option to bridge gaps.

**Architecture:** NaN sentinel approach. `null` entries are packed as `[NaN, NaN]` into GPU buffers (already partially works). WGSL vertex shaders detect NaN and collapse affected geometry to zero area. `connectNulls: true` strips nulls before GPU upload. Sampling is bypassed when gaps are present.

**Tech Stack:** TypeScript, WGSL (WebGPU shading language), Vitest

**Design Doc:** `docs/plans/2026-02-25-line-segmentation-design.md`

---

### Task 1: Widen `CartesianSeriesData` Type to Accept `null`

**Files:**
- Modify: `src/config/types.ts:51`

**Step 1: Update the type**

Change line 51 from:

```typescript
export type CartesianSeriesData = ReadonlyArray<DataPoint> | XYArraysData | InterleavedXYData;
```

to:

```typescript
export type CartesianSeriesData = ReadonlyArray<DataPoint | null> | XYArraysData | InterleavedXYData;
```

**Step 2: Fix any TypeScript errors caused by the widened type**

Run: `npx tsc --noEmit 2>&1 | head -50`

The widened type may cause errors in places that assume non-null array entries. Fix each by narrowing with null checks where the code accesses individual data points. `getX()`, `getY()`, and `packXYInto()` in `cartesianData.ts` already handle null — so errors will likely be in other consumers that index into the array directly.

**Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```
feat(types): widen CartesianSeriesData to accept null entries

Allows null in DataPoint arrays to represent gaps in line/area series.
```

---

### Task 2: Add `connectNulls` to Series Config Types

**Files:**
- Modify: `src/config/types.ts:167-175` (LineSeriesConfig)
- Modify: `src/config/types.ts:177-185` (AreaSeriesConfig)

**Step 1: Add `connectNulls` to `LineSeriesConfig`**

```typescript
export interface LineSeriesConfig extends SeriesConfigBase {
  readonly type: 'line';
  readonly lineStyle?: LineStyleConfig;
  readonly areaStyle?: AreaStyleConfig;
  readonly connectNulls?: boolean;
}
```

**Step 2: Add `connectNulls` to `AreaSeriesConfig`**

```typescript
export interface AreaSeriesConfig extends SeriesConfigBase {
  readonly type: 'area';
  readonly baseline?: number;
  readonly areaStyle?: AreaStyleConfig;
  readonly connectNulls?: boolean;
}
```

**Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors (optional field, no consumers yet).

**Step 4: Commit**

```
feat(types): add connectNulls option to line and area series configs
```

---

### Task 3: Resolve `connectNulls` in OptionResolver

**Files:**
- Modify: `src/config/OptionResolver.ts:71-92` (ResolvedLineSeriesConfig)
- Modify: `src/config/OptionResolver.ts:94-109` (ResolvedAreaSeriesConfig)
- Modify: `src/config/OptionResolver.ts:855-891` (line resolution branch)
- Modify: `src/config/OptionResolver.ts:832-854` (area resolution branch)
- Test: `src/config/__tests__/OptionResolver.test.ts` (new file)

**Step 1: Write failing tests**

Create `src/config/__tests__/OptionResolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveOptions } from '../OptionResolver';

describe('OptionResolver - connectNulls', () => {
  it('defaults connectNulls to false for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('line');
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for line series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'line', data: [[0, 1], [1, 2]], connectNulls: true }],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(series.connectNulls).toBe(true);
    }
  });

  it('defaults connectNulls to false for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]] }],
    });
    const series = resolved.series[0];
    expect(series.type).toBe('area');
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(false);
    }
  });

  it('resolves connectNulls: true for area series', () => {
    const resolved = resolveOptions({
      series: [{ type: 'area', data: [[0, 1], [1, 2]], connectNulls: true }],
    });
    const series = resolved.series[0];
    if (series.type === 'area') {
      expect(series.connectNulls).toBe(true);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/__tests__/OptionResolver.test.ts`
Expected: FAIL — `connectNulls` property does not exist on resolved types.

**Step 3: Add `connectNulls` to resolved types**

In `src/config/OptionResolver.ts`, add `connectNulls: boolean` to `ResolvedLineSeriesConfig` (around line 71):

```typescript
export type ResolvedLineSeriesConfig = Readonly<
  Omit<LineSeriesConfig, 'color' | 'lineStyle' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'> & {
    readonly color: string;
    readonly lineStyle: ResolvedLineStyleConfig;
    readonly areaStyle?: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    readonly connectNulls: boolean;
    readonly rawData: Readonly<LineSeriesConfig['data']>;
    readonly data: Readonly<LineSeriesConfig['data']>;
    readonly rawBounds?: RawBounds;
  }
>;
```

Same for `ResolvedAreaSeriesConfig` (around line 94):

```typescript
export type ResolvedAreaSeriesConfig = Readonly<
  Omit<AreaSeriesConfig, 'color' | 'areaStyle' | 'sampling' | 'samplingThreshold' | 'data' | 'connectNulls'> & {
    readonly color: string;
    readonly areaStyle: ResolvedAreaStyleConfig;
    readonly sampling: SeriesSampling;
    readonly samplingThreshold: number;
    readonly connectNulls: boolean;
    readonly rawData: Readonly<AreaSeriesConfig['data']>;
    readonly data: Readonly<AreaSeriesConfig['data']>;
    readonly rawBounds?: RawBounds;
  }
>;
```

**Step 4: Add `connectNulls` to the resolution branches**

In the `case 'line':` branch (around line 855), add `connectNulls` to the returned object:

```typescript
return {
  ...rest,
  visible,
  connectNulls: s.connectNulls ?? false,
  rawData: s.data,
  // ... rest of existing fields
};
```

In the `case 'area':` branch (around line 832), add `connectNulls` to the returned object:

```typescript
return {
  ...s,
  visible,
  connectNulls: s.connectNulls ?? false,
  rawData: s.data,
  // ... rest of existing fields
};
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/config/__tests__/OptionResolver.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm run test`
Expected: All tests pass.

**Step 7: Commit**

```
feat(options): resolve connectNulls for line and area series

Defaults to false. When true, null entries in data arrays are stripped
before GPU upload so the line/area draws through the gap.
```

---

### Task 4: Add `connectNulls` Filter in Data Upload Path

**Files:**
- Modify: `src/core/renderCoordinator/render/renderSeries.ts:145-201`
- Test: `src/core/renderCoordinator/render/__tests__/connectNulls.test.ts` (new file)

**Step 1: Write failing test for null filtering**

Create `src/core/renderCoordinator/render/__tests__/connectNulls.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { DataPoint } from '../../../../config/types';

/**
 * Helper that mirrors the connectNulls filter logic.
 * Extracted so it can be unit-tested without GPU context.
 */
export function filterNullGaps(data: ReadonlyArray<DataPoint | null>): ReadonlyArray<DataPoint> {
  return data.filter((p): p is DataPoint => p !== null);
}

describe('filterNullGaps', () => {
  it('removes null entries from data array', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, [2, 3], null, [4, 5]];
    const result = filterNullGaps(data);
    expect(result).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it('returns unchanged array when no nulls present', () => {
    const data: DataPoint[] = [[0, 1], [1, 2], [2, 3]];
    const result = filterNullGaps(data);
    expect(result).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it('handles all-null array', () => {
    const data: (DataPoint | null)[] = [null, null, null];
    const result = filterNullGaps(data);
    expect(result).toEqual([]);
  });

  it('handles empty array', () => {
    const result = filterNullGaps([]);
    expect(result).toEqual([]);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run src/core/renderCoordinator/render/__tests__/connectNulls.test.ts`
Expected: PASS (the helper is defined inline in the test for now).

**Step 3: Extract `filterNullGaps` to a shared utility**

Create the function in `src/data/cartesianData.ts` (add near the existing helpers):

```typescript
/**
 * Removes null entries from a DataPoint array.
 * Used by connectNulls to strip gap markers before GPU upload.
 */
export function filterNullGaps(data: ReadonlyArray<DataPoint | null>): ReadonlyArray<DataPoint> {
  return data.filter((p): p is DataPoint => p !== null);
}
```

Update the test to import from the actual module.

**Step 4: Wire `connectNulls` into `prepareSeries`**

In `src/core/renderCoordinator/render/renderSeries.ts`, in the `case 'line':` branch (around line 161 where `dataStore.setSeries` is called):

```typescript
case 'line': {
  const xOffset = /* ... existing xOffset computation ... */;
  if (!appendedGpuThisFrame.has(i)) {
    // When connectNulls is true, strip null entries so the line draws through gaps.
    const uploadData = s.connectNulls && Array.isArray(s.data)
      ? filterNullGaps(s.data as ReadonlyArray<DataPoint | null>)
      : s.data;
    dataStore.setSeries(i, uploadData as ReadonlyArray<DataPoint>, { xOffset });
  }
  // ... rest unchanged
```

Add the import at the top of the file:

```typescript
import { filterNullGaps } from '../../../data/cartesianData';
```

Apply the same pattern in the `case 'area':` branch.

**Step 5: Run full test suite**

Run: `npm run test`
Expected: All tests pass.

**Step 6: Commit**

```
feat(data): add connectNulls filter in data upload path

When connectNulls is true, null entries are stripped from the data
array before GPU upload so lines/areas draw through gaps.
```

---

### Task 5: Bypass Sampling When Gaps Present

**Files:**
- Modify: `src/config/OptionResolver.ts:855-891` (line branch)
- Modify: `src/config/OptionResolver.ts:832-854` (area branch)
- Test: `src/config/__tests__/OptionResolver.test.ts` (extend)

**Step 1: Write failing test**

Add to `src/config/__tests__/OptionResolver.test.ts`:

```typescript
describe('OptionResolver - sampling bypass with gaps', () => {
  it('bypasses LTTB sampling when data contains null gaps', () => {
    const dataWithGaps: (DataPoint | null)[] = [];
    for (let i = 0; i < 10000; i++) {
      dataWithGaps.push(i === 5000 ? null : [i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [{
        type: 'line',
        data: dataWithGaps,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
    });
    const series = resolved.series[0];
    // Data should NOT be sampled — raw data with gaps preserved
    if (series.type === 'line') {
      expect(getPointCount(series.data)).toBe(10000);
    }
  });

  it('applies sampling normally when data has no null gaps', () => {
    const data: DataPoint[] = [];
    for (let i = 0; i < 10000; i++) {
      data.push([i, Math.sin(i)]);
    }
    const resolved = resolveOptions({
      series: [{
        type: 'line',
        data,
        sampling: 'lttb',
        samplingThreshold: 5000,
      }],
    });
    const series = resolved.series[0];
    if (series.type === 'line') {
      expect(getPointCount(series.data)).toBeLessThanOrEqual(5000);
    }
  });
});
```

Import `getPointCount` from `../../data/cartesianData` and `DataPoint` from types.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/__tests__/OptionResolver.test.ts`
Expected: FAIL — sampling is applied even with null gaps.

**Step 3: Add gap detection helper**

In `src/data/cartesianData.ts`, add:

```typescript
/**
 * Returns true if a DataPoint array contains any null entries (gap markers).
 */
export function hasNullGaps(data: CartesianSeriesData): boolean {
  if (!Array.isArray(data)) return false;
  return data.includes(null);
}
```

**Step 4: Skip sampling when gaps detected**

In `src/config/OptionResolver.ts`, in both the `case 'line':` and `case 'area':` branches, wrap the `sampleSeriesDataPoints` call:

```typescript
const hasGaps = hasNullGaps(s.data);
const sampledData = hasGaps
  ? s.data  // bypass sampling when gaps present
  : sampleSeriesDataPoints(s.data, sampling, samplingThreshold);
```

Import `hasNullGaps` from the cartesianData module.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/config/__tests__/OptionResolver.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm run test`
Expected: All tests pass.

**Step 7: Commit**

```
feat(sampling): bypass sampling when data contains null gaps

LTTB and bucket sampling don't handle NaN sentinels correctly,
so we skip sampling and use raw data when gaps are present.
Gap-aware sampling is deferred to a follow-up.
```

---

### Task 6: Add NaN Sentinel Detection to `line.wgsl`

> **Delegate to `webgpu-specialist` subagent.**

**Files:**
- Modify: `src/shaders/line.wgsl:65-66`

**Step 1: Add NaN check after reading endpoints**

In `line.wgsl`, after lines 65-66 (`let pA_data = points[iid]; let pB_data = points[iid + 1u];`), insert:

```wgsl
  // ── Gap detection ──────────────────────────────────────────────
  // Null entries in the data array are packed as NaN by the CPU.
  // Collapse the quad to a degenerate point so the rasterizer discards it.
  // WGSL has no isnan(); use the IEEE 754 property that NaN != NaN.
  if (pA_data.x != pA_data.x || pA_data.y != pA_data.y ||
      pB_data.x != pB_data.x || pB_data.y != pB_data.y) {
    var out: VSOut;
    out.clipPosition = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.acrossDevice = 0.0;
    out.widthDevice = 0.0;
    return out;
  }
```

This early-return produces a degenerate quad (all vertices at origin) that the rasterizer discards. No fragment shader invocations occur for gap segments.

**Step 2: Verify shader compiles**

Run: `npm run build`
Expected: Build succeeds (Vite imports WGSL via `?raw`, so compile errors surface at runtime, but syntax errors will break the build if there's a WGSL validation step).

**Step 3: Visual verification**

Start dev server: `npm run dev`
Open browser, navigate to the line-gaps example (created in Task 8).
Expected: Lines with null entries in data show visible gaps.

**Step 4: Commit**

```
feat(shader): add NaN gap detection to line vertex shader

Collapses quad to degenerate geometry when either endpoint is NaN,
producing visible gaps in line series with null data entries.
```

---

### Task 7: Add NaN Sentinel Detection to `area.wgsl` and Area Renderer

> **Delegate to `webgpu-specialist` subagent.**

**Files:**
- Modify: `src/shaders/area.wgsl:33-41`
- Modify: `src/renderers/createAreaRenderer.ts:90-107` (createAreaVertices)

The area shader uses triangle-strip topology with vertex attributes. NaN in vertex positions propagates through the transform and produces undefined clip-space coordinates. We need to handle gaps in two places:

**Step 1: Modify `createAreaVertices` to emit degenerate triangles at gaps**

In `src/renderers/createAreaRenderer.ts`, replace `createAreaVertices` (lines 90-107):

```typescript
const createAreaVertices = (data: CartesianSeriesData): Float32Array => {
  // Triangle-strip expects duplicated vertices:
  // p0,p0,p1,p1,... and WGSL uses vertex_index parity to swap y to baseline for odd indices.
  //
  // For null gaps: when a point is NaN, we emit (0,0) degenerate vertices.
  // This creates zero-area triangles at gap boundaries, visually breaking the fill.
  // We also need to emit degenerate vertices for the points adjacent to a gap
  // (the point before and after) to prevent the fill from bridging the gap.
  const n = getPointCount(data);
  const out = new Float32Array(n * 2 * 2); // n * 2 vertices * vec2<f32>

  let idx = 0;
  for (let i = 0; i < n; i++) {
    const x = getX(data, i);
    const y = getY(data, i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // Degenerate: collapse to (0,0) — produces zero-area triangles in strip
      out[idx++] = 0;
      out[idx++] = 0;
      out[idx++] = 0;
      out[idx++] = 0;
    } else {
      out[idx++] = x;
      out[idx++] = y;
      out[idx++] = x;
      out[idx++] = y;
    }
  }

  return out;
};
```

Note: Degenerate vertices at `(0,0)` create zero-area triangles in the strip. However, a single degenerate point may still produce a thin sliver triangle connecting the last valid point to `(0,0)` and then back. To cleanly break the strip, we should emit the degenerate for the gap point AND ensure adjacent triangles collapse. The `(0,0)` approach works because:
- Triangle `[lastValid_top, lastValid_bottom, gap_top=(0,0)]` has near-zero area and renders as an invisible sliver (or is clipped by scissor).
- Triangle `[lastValid_bottom, gap_top=(0,0), gap_bottom=(0,0)]` is degenerate (two identical vertices).
- Triangle `[gap_top=(0,0), gap_bottom=(0,0), nextValid_top]` is degenerate.

If visual slivers appear at gap boundaries during testing, the fix is to emit **two** degenerate point pairs (4 extra vertices) per gap to fully break the strip. Test visually first with the simple approach.

**Step 2: Verify shader still works for non-gap data**

Run: `npm run dev`, check existing area examples.
Expected: No visual regression for area series without gaps.

**Step 3: Commit**

```
feat(area): handle null gaps in area renderer vertex generation

Emits degenerate triangles at gap positions to break the
triangle-strip fill at null entries.
```

---

### Task 8: Create Example Page

**Files:**
- Create: `examples/line-gaps/index.html`
- Create: `examples/line-gaps/main.ts`

**Step 1: Create the example**

`examples/line-gaps/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Line Gaps</title>
  <style>
    body { margin: 0; background: #1a1a2e; color: #eee; font-family: system-ui; }
    .chart-container { width: 800px; height: 300px; margin: 20px auto; }
    h2 { text-align: center; margin: 10px 0 0; font-size: 14px; font-weight: normal; opacity: 0.7; }
  </style>
</head>
<body>
  <h2>Line with null gaps (connectNulls: false)</h2>
  <div id="chart1" class="chart-container"></div>
  <h2>Line with null gaps (connectNulls: true)</h2>
  <div id="chart2" class="chart-container"></div>
  <h2>Area with null gaps</h2>
  <div id="chart3" class="chart-container"></div>
  <h2>Multi-segment pattern: [...data1, null, ...data2]</h2>
  <div id="chart4" class="chart-container"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

`examples/line-gaps/main.ts`:

```typescript
import { ChartGPU } from '../../src';

const dataWithGaps = [
  [0, 2], [1, 5], [2, 3], [3, 7], [4, 4],
  null, // gap
  [6, 8], [7, 6], [8, 9], [9, 5], [10, 7],
  null, // gap
  [12, 3], [13, 6], [14, 4],
] as const;

// Chart 1: Line with gaps (default connectNulls: false)
ChartGPU.create(document.getElementById('chart1')!, {
  series: [{ type: 'line', data: dataWithGaps as any }],
  xAxis: { type: 'value' },
});

// Chart 2: Line with connectNulls: true (bridges gaps)
ChartGPU.create(document.getElementById('chart2')!, {
  series: [{ type: 'line', data: dataWithGaps as any, connectNulls: true }],
  xAxis: { type: 'value' },
});

// Chart 3: Area with gaps
ChartGPU.create(document.getElementById('chart3')!, {
  series: [{ type: 'area', data: dataWithGaps as any }],
  xAxis: { type: 'value' },
});

// Chart 4: Multi-segment via concatenation
const segment1 = [[0, 2], [1, 5], [2, 3], [3, 7]] as const;
const segment2 = [[5, 8], [6, 6], [7, 9], [8, 5]] as const;
const segment3 = [[10, 3], [11, 6], [12, 4]] as const;

ChartGPU.create(document.getElementById('chart4')!, {
  series: [{
    type: 'line',
    data: [...segment1, null, ...segment2, null, ...segment3] as any,
  }],
  xAxis: { type: 'value' },
});
```

**Step 2: Verify the example renders**

Run: `npm run dev`
Navigate to the line-gaps example.
Expected: 4 charts showing gaps, connected gaps, area gaps, and multi-segment pattern.

**Step 3: Commit**

```
feat(examples): add line-gaps example demonstrating null gap support

Shows line gaps, connectNulls bridging, area gaps, and the
multi-segment concatenation pattern from issue #103.
```

---

### Task 9: Add `packXYInto` Test for Null Entries

**Files:**
- Modify: `src/data/__tests__/cartesianData.test.ts`

**Step 1: Add test for packXYInto null handling**

Add to the existing test file:

```typescript
import { packXYInto } from '../cartesianData';

describe('packXYInto - null gap handling', () => {
  it('writes NaN for null entries in DataPoint array', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, [2, 3]];
    const out = new Float32Array(6);
    packXYInto(data as any, out, 0, 0, 3, 0);

    expect(out[0]).toBe(0); // x0
    expect(out[1]).toBe(1); // y0
    expect(Number.isNaN(out[2])).toBe(true); // x1 (null -> NaN)
    expect(Number.isNaN(out[3])).toBe(true); // y1 (null -> NaN)
    expect(out[4]).toBe(2); // x2
    expect(out[5]).toBe(3); // y2
  });

  it('handles consecutive null entries', () => {
    const data: (DataPoint | null)[] = [[0, 1], null, null, [3, 4]];
    const out = new Float32Array(8);
    packXYInto(data as any, out, 0, 0, 4, 0);

    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(Number.isNaN(out[2])).toBe(true);
    expect(Number.isNaN(out[3])).toBe(true);
    expect(Number.isNaN(out[4])).toBe(true);
    expect(Number.isNaN(out[5])).toBe(true);
    expect(out[6]).toBe(3);
    expect(out[7]).toBe(4);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run src/data/__tests__/cartesianData.test.ts`
Expected: PASS (packXYInto already handles null — this confirms it).

**Step 3: Commit**

```
test(data): add packXYInto tests for null gap entries

Confirms that null entries in DataPoint arrays are correctly
packed as NaN in the Float32Array output.
```

---

### Task 10: Add Acceptance Test

**Files:**
- Create: `examples/acceptance/line-gaps.ts`

**Step 1: Create acceptance test**

```typescript
/**
 * Acceptance test: Line segmentation via null gaps.
 *
 * Validates:
 * 1. Null entries in data arrays are preserved through option resolution
 * 2. connectNulls: true strips nulls from resolved data
 * 3. Bounds computation skips null entries
 * 4. Sampling is bypassed when gaps present
 */

import { resolveOptions } from '../../src/config/OptionResolver';
import { computeRawBoundsFromCartesianData, getPointCount, hasNullGaps, filterNullGaps } from '../../src/data/cartesianData';
import type { DataPoint } from '../../src/config/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// --- Test data ---
const dataWithGaps: (DataPoint | null)[] = [
  [0, 2], [1, 5], [2, 3],
  null,
  [4, 7], [5, 4],
  null,
  [7, 8], [8, 6],
];

// --- 1. Null gap detection ---
console.log('\n1. Null gap detection');
assert(hasNullGaps(dataWithGaps) === true, 'hasNullGaps detects null entries');
assert(hasNullGaps([[0, 1], [1, 2]]) === false, 'hasNullGaps returns false for clean data');
assert(hasNullGaps(new Float32Array([0, 1, 2, 3])) === false, 'hasNullGaps returns false for Float32Array');

// --- 2. Null filtering ---
console.log('\n2. Null filtering (connectNulls)');
const filtered = filterNullGaps(dataWithGaps);
assert(filtered.length === 8, `filterNullGaps removes nulls (got ${filtered.length}, expected 8)`);
assert(filtered.every(p => p !== null), 'filterNullGaps produces no null entries');

// --- 3. Bounds computation ---
console.log('\n3. Bounds computation with gaps');
const bounds = computeRawBoundsFromCartesianData(dataWithGaps as any);
assert(bounds !== null, 'computeRawBoundsFromCartesianData returns non-null');
if (bounds) {
  assert(bounds.xMin === 0, `xMin is 0 (got ${bounds.xMin})`);
  assert(bounds.xMax === 8, `xMax is 8 (got ${bounds.xMax})`);
  assert(bounds.yMin === 2, `yMin is 2 (got ${bounds.yMin})`);
  assert(bounds.yMax === 8, `yMax is 8 (got ${bounds.yMax})`);
}

// --- 4. Option resolution ---
console.log('\n4. Option resolution');
const resolved = resolveOptions({
  series: [{ type: 'line', data: dataWithGaps as any }],
});
const lineSeries = resolved.series[0];
assert(lineSeries.type === 'line', 'Series type is line');
if (lineSeries.type === 'line') {
  assert(lineSeries.connectNulls === false, 'connectNulls defaults to false');
  assert(getPointCount(lineSeries.data) === 10, `Point count preserved (got ${getPointCount(lineSeries.data)}, expected 10)`);
}

// --- 5. connectNulls resolution ---
console.log('\n5. connectNulls: true resolution');
const resolvedConnected = resolveOptions({
  series: [{ type: 'line', data: dataWithGaps as any, connectNulls: true }],
});
const connectedSeries = resolvedConnected.series[0];
if (connectedSeries.type === 'line') {
  assert(connectedSeries.connectNulls === true, 'connectNulls resolves to true');
}

// --- 6. Sampling bypass ---
console.log('\n6. Sampling bypass with gaps');
const bigDataWithGaps: (DataPoint | null)[] = [];
for (let i = 0; i < 10000; i++) {
  bigDataWithGaps.push(i === 5000 ? null : [i, Math.sin(i)]);
}
const resolvedSampled = resolveOptions({
  series: [{ type: 'line', data: bigDataWithGaps as any, sampling: 'lttb', samplingThreshold: 5000 }],
});
const sampledSeries = resolvedSampled.series[0];
if (sampledSeries.type === 'line') {
  const count = getPointCount(sampledSeries.data);
  assert(count === 10000, `Sampling bypassed: point count is ${count} (expected 10000)`);
}

// --- Summary ---
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

**Step 2: Add npm script**

Add to `package.json` scripts:

```json
"acceptance:line-gaps": "tsx examples/acceptance/line-gaps.ts"
```

**Step 3: Run acceptance test**

Run: `npm run acceptance:line-gaps`
Expected: All assertions pass.

**Step 4: Commit**

```
test(acceptance): add line-gaps acceptance test

Validates null gap detection, filtering, bounds computation,
option resolution, and sampling bypass.
```

---

### Task 11: Update Documentation

**Files:**
- Modify: `docs/api/options.md` (add line/area gap documentation)

**Step 1: Add gap documentation to the Line and Area sections of `docs/api/options.md`**

After the existing `LineSeriesConfig` section, add:

```markdown
#### Null Gaps (Line Segmentation)

Line and area series support `null` entries in `DataPoint[]` arrays to represent gaps (disconnected segments):

```ts
series: [{
  type: 'line',
  data: [[0, 1], [1, 3], null, [3, 5], [4, 7]],  // gap between x=1 and x=3
}]
```

- **`connectNulls?: boolean`** (default: `false`): when `true`, null entries are stripped and the line/area draws through the gap. When `false`, null entries produce visible gaps.
- **Multi-segment pattern**: concatenate pre-split data with null separators: `[...segment1, null, ...segment2]`.
- **Sampling**: when data contains null gaps and sampling is enabled, ChartGPU bypasses sampling and uses raw data to preserve gap positions. Gap-aware sampling may be added in a future release.
- **Supported formats**: `DataPoint[]` only. `XYArraysData` and `InterleavedXYData` do not support null gaps.
```

**Step 2: Commit**

```
docs: add null gaps and connectNulls documentation
```

---

### Task 12: Final Integration Test

**Step 1: Run full test suite**

Run: `npm run test`
Expected: All tests pass.

**Step 2: Run all acceptance tests**

Run the line-gaps acceptance test:

```bash
npm run acceptance:line-gaps
```

Expected: All assertions pass.

**Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Visual verification**

Run: `npm run dev`
Navigate to the line-gaps example. Verify:
- Chart 1: Three disconnected line segments with visible gaps
- Chart 2: One continuous line (gaps bridged)
- Chart 3: Three disconnected area fills with visible gaps
- Chart 4: Three line segments from concatenated data

**Step 5: Commit any final fixes, then done**
