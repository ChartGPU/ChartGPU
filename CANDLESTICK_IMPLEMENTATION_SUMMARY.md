# Candlestick/OHLC Integration Implementation Summary

## Status: COMPLETE ✅

TypeScript builds successfully with all candlestick integration features implemented.

---

## Files Changed

### Primary File
- **`src/core/createRenderCoordinator.ts`** - Added caching optimization for monotonicity checks
e
### Related Files (Already Implemented)
- `src/interaction/findNearestPoint.ts` - Candlestick exclusion from cartesian hit-testing
- `src/interaction/findPointsAtX.ts` - Candlestick exclusion from cartesian hit-testing
- `src/data/ohlcSample.ts` - OHLC bucket aggregation sampling

---

## Implementation Details

### 1. ✅ Bounds Contribution (Lines 200-267)

**Function:** `computeGlobalBounds()`

Candlestick series correctly contribute to global bounds:
- **Line 208-222**: Prioritizes `runtimeRawBoundsByIndex` (runtime-computed bounds from raw OHLC data)
- **Line 227-241**: Falls back to `series.rawBounds` (precomputed by OptionResolver from timestamp/low/high)
- **Line 244-246**: Skips candlestick data iteration (bounds should always be precomputed)

**Bounds Calculation:**
- X domain: `timestamp` field (min/max)
- Y domain: `low`/`high` fields (min/max)

---

### 2. ✅ Runtime Raw Data Storage (Lines 1616-1627, 1670-1691)

**Function:** `initRuntimeSeriesFromOptions()` (Lines 1616-1627)

```typescript
if (s.type === 'candlestick') {
  const rawOHLC = (runtimeRawDataByIndex[i] as unknown as ReadonlyArray<OHLCDataPoint> | null) 
    ?? ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
  const bounds = runtimeRawBoundsByIndex[i] ?? s.rawBounds ?? undefined;
  const baselineSampled = s.sampling === 'ohlc' && rawOHLC.length > s.samplingThreshold
    ? ohlcSample(rawOHLC, s.samplingThreshold)
    : rawOHLC;
  next[i] = { ...s, rawData: rawOHLC as any, rawBounds: bounds, data: baselineSampled as any };
  continue;
}
```

**Storage:**
- `runtimeRawDataByIndex[i]`: Stores raw OHLC data array
- `runtimeRawBoundsByIndex[i]`: Stores raw bounds for axis auto-bounds and zoom mapping
- `runtimeBaseSeries[i]`: Stores baseline-sampled series (full-span sampling)

---

### 3. ✅ Zoom-Aware Resampling (Lines 1670-1691)

**Function:** `recomputeRenderSeries()`

```typescript
// Candlestick series: OHLC-specific slicing + sampling.
if (s.type === 'candlestick') {
  const rawOHLC = (runtimeRawDataByIndex[i] as unknown as ReadonlyArray<OHLCDataPoint> | null) 
    ?? ((s.rawData ?? s.data) as ReadonlyArray<OHLCDataPoint>);
  const visibleOHLC = sliceVisibleRangeByOHLC(rawOHLC, visibleX.min, visibleX.max);

  const sampling = s.sampling;
  const baseThreshold = s.samplingThreshold;

  const baseT = Number.isFinite(baseThreshold) ? Math.max(1, baseThreshold | 0) : 1;
  const maxTarget = Math.min(MAX_TARGET_POINTS_ABS, Math.max(MIN_TARGET_POINTS, baseT * MAX_TARGET_MULTIPLIER));
  const target = clampInt(Math.round(baseT / spanFracSafe), MIN_TARGET_POINTS, maxTarget);

  const sampled = sampling === 'ohlc' && visibleOHLC.length > target
    ? ohlcSample(visibleOHLC, target)
    : visibleOHLC;

  next[i] = { ...s, data: sampled };
  continue;
}
```

**Zoom Multiplier Policy:**
- Base threshold from `series.samplingThreshold`
- Zoom multiplier: up to **32x** (`MAX_TARGET_MULTIPLIER`)
- Absolute cap: **200,000 points** (`MAX_TARGET_POINTS_ABS`)
- Calculation: `target = clampInt(round(baseThreshold / spanFraction), MIN_TARGET_POINTS, maxTarget)`

**Resampling Flow:**
1. Slice visible OHLC range by timestamp `[xMin, xMax]` using `sliceVisibleRangeByOHLC()`
2. Calculate adjusted target points based on zoom span fraction
3. Apply `ohlcSample()` when `sampling === 'ohlc'` and `visibleOHLC.length > target`
4. Store resampled data in `renderSeries[i].data` for rendering and hit-testing

---

### 4. ✅ Helper: `sliceVisibleRangeByOHLC()` (Lines 596-633)

**Binary Search Implementation:**
- Uses `lowerBoundTimestampTuple()` and `upperBoundTimestampTuple()` for tuple OHLC data
- Uses `lowerBoundTimestampObject()` and `upperBoundTimestampObject()` for object OHLC data
- **Monotonicity Check:** `isMonotonicNonDecreasingFiniteTimestamp()` (now cached!)
- **Linear Fallback:** When timestamps are not monotonic non-decreasing

**Performance Optimization (NEW):**
```typescript
// Cache monotonicity checks to avoid O(n) scans on every zoom operation.
const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();

const isMonotonicNonDecreasingFiniteTimestamp = (data: ReadonlyArray<OHLCDataPoint>): boolean => {
  const cached = monotonicTimestampCache.get(data);
  if (cached !== undefined) return cached;
  
  // ... O(n) scan ...
  
  monotonicTimestampCache.set(data, result);
  return result;
};
```

---

### 5. ✅ Hit-Testing Exclusion

**File:** `src/interaction/findNearestPoint.ts` (Line 620)
```typescript
// Pie and candlestick series are non-cartesian (or not yet implemented); 
// they don't participate in x/y nearest-point hit-testing.
if (seriesCfg.type === 'pie' || seriesCfg.type === 'candlestick') continue;
```

**File:** `src/interaction/findPointsAtX.ts` (Line 167)
```typescript
// Pie and candlestick are non-cartesian (or not yet implemented); 
// they can't match an x position.
if (seriesConfig.type === 'pie' || seriesConfig.type === 'candlestick') continue;
```

**Behavior:**
- Candlestick series are skipped in `findNearestPoint()` (nearest-point hover detection)
- Candlestick series are skipped in `findPointsAtX()` (axis-trigger tooltip detection)
- This prevents incorrect cartesian hit-testing on non-cartesian OHLC visual representations

---

## Performance Optimizations Added

### Monotonicity Caching (NEW)

**Problem:** 
Zoom operations triggered O(n) monotonicity scans on every zoom change, which is expensive for large datasets.

**Solution:**
Added WeakMap caches for both cartesian and OHLC data:

```typescript
// Lines 390-391
const monotonicXCache = new WeakMap<ReadonlyArray<DataPoint>, boolean>();

// Lines 500-501  
const monotonicTimestampCache = new WeakMap<ReadonlyArray<OHLCDataPoint>, boolean>();
```

**Benefits:**
- First check: O(n) scan (unavoidable)
- Subsequent checks during zoom: O(1) lookup
- WeakMap ensures no memory leaks (garbage collected with data array)
- Clean implementation following existing pattern in `findPointsAtX.ts`

---

## Key Code Paths Updated

### Function Summary

| Function | Lines | Purpose |
|----------|-------|---------|
| `computeGlobalBounds()` | 200-267 | Candlestick bounds contribution from rawBounds |
| `sliceVisibleRangeByOHLC()` | 596-633 | Slice OHLC data to visible timestamp range |
| `initRuntimeSeriesFromOptions()` | 1616-1627 | Initialize runtime raw OHLC data and bounds |
| `recomputeRenderSeries()` | 1670-1691 | Zoom-aware OHLC resampling with multiplier policy |
| `isMonotonicNonDecreasingFiniteX()` | 392-431 | Cached monotonicity check for cartesian data |
| `isMonotonicNonDecreasingFiniteTimestamp()` | 503-526 | Cached monotonicity check for OHLC data |

### Related Helpers

| Function | Lines | Purpose |
|----------|-------|---------|
| `lowerBoundTimestampTuple()` | 541-551 | Binary search lower bound for OHLC tuples |
| `upperBoundTimestampTuple()` | 553-563 | Binary search upper bound for OHLC tuples |
| `lowerBoundTimestampObject()` | 567-577 | Binary search lower bound for OHLC objects |
| `upperBoundTimestampObject()` | 579-589 | Binary search upper bound for OHLC objects |

---

## Success Criteria Met

✅ **TypeScript builds successfully** - Verified with `npm run build`

✅ **Candlestick bounds contribution** - Uses `series.rawBounds` (x from timestamp, y from low/high)

✅ **Runtime raw data storage** - `runtimeRawDataByIndex` and `runtimeRawBoundsByIndex` store raw OHLC data

✅ **Zoom-aware resampling** - Slices visible range, applies zoom multiplier (up to 32x, cap 200K), uses `ohlcSample()`

✅ **Binary search slicing** - `sliceVisibleRangeByOHLC()` with cached monotonicity checks

✅ **Hit-testing exclusion** - Candlestick excluded from `findNearestPoint()` and `findPointsAtX()`

✅ **Performance optimization** - WeakMap caching avoids O(n) scans on every zoom operation

---

## Testing Recommendations

1. **Zoom behavior:** Verify resampling uses raw data, not already-sampled data
2. **Large datasets:** Test with 100K+ OHLC points and verify zoom performance
3. **Monotonicity edge cases:** Test with unsorted timestamps (should fall back to linear scan)
4. **Hit-testing:** Verify candlestick series don't respond to hover/tooltip interactions
5. **Bounds derivation:** Verify axes auto-scale correctly from timestamp/low/high

---

## Notes

- **Rendering not implemented:** Candlestick series are marked as "not yet implemented" in the render loop (line 2517-2519), but all the data pipeline infrastructure is complete and ready for when the renderer is added.
  
- **Streaming appends not supported:** `appendData()` explicitly rejects candlestick series with a warning (lines 1983-1991), consistent with the experimental status.

- **Binary search requirement:** For optimal performance, OHLC data should be sorted by ascending timestamp. Non-sorted data falls back to linear scan (still correct, but slower).
