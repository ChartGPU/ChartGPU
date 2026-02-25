# Design: Custom Axis Tick Label Formatter (#138)

## Problem

ChartGPU has no way to customize axis tick label text. The library uses `Intl.NumberFormat` for value axes and hardcoded tier-based date strings for time axes. Users need custom formatting for durations, percentages, integers-only, units, and custom date formats.

## Decision

Add a single optional `tickFormatter` callback to `AxisConfig`.

## API

```ts
export interface AxisConfig {
  // ... existing fields ...
  readonly tickFormatter?: (value: number) => string | null;
}
```

- Works on all axis types (`'value'`, `'time'`, `'category'`)
- For time axes, `value` is epoch-ms (same unit as `new Date(ms)`)
- Returns `string` to display, or `null` to suppress that tick label
- When omitted, current behavior is preserved (no breaking change)

## Implementation Touchpoints

1. **Type definition** (`src/config/types.ts`) — add `tickFormatter` to `AxisConfig`
2. **Label rendering** (`src/core/renderCoordinator/render/renderAxisLabels.ts`) — check `tickFormatter` before falling through to internal `Intl.NumberFormat` or `formatTimeTickValue`
3. **Adaptive tick count** (`src/core/renderCoordinator/utils/timeAxisUtils.ts`) — when custom formatter is present on a time x-axis, use custom-formatted text for label width measurement in overlap avoidance
4. **Option resolution** — `tickFormatter` is a function; passes through as-is (no deep merge, no default)
5. **Documentation** (`docs/api/options.md`) — update axis configuration section

## What Does NOT Change

- Tick value computation (positions stay the same)
- GPU axis tick mark rendering (only DOM labels affected)
- Tooltip formatting (separate system)
- Grid lines (unrelated)

## Testing

- Unit tests for `renderAxisLabels` with custom formatters (value axis, time axis, null returns)
- Unit test that adaptive tick count respects custom formatter output widths
- Example page for visual verification

## Example Usage

```ts
// Duration formatting
yAxis: {
  tickFormatter: (seconds) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  }
}

// Percentage formatting
yAxis: { tickFormatter: (v) => `${(v * 100).toFixed(0)}%` }

// Custom time formatting
xAxis: {
  type: 'time',
  tickFormatter: (ms) => new Date(ms).toLocaleDateString('de-DE')
}

// Suppress specific labels (return null)
xAxis: {
  tickFormatter: (v) => v === 0 ? null : v.toFixed(1)
}
```

## Alternatives Rejected

- **Separate `timeTickFormatter`**: two fields for one concept, confusing when both are set. Users can use `new Date(ms)` inside the single callback.
- **Context object parameter**: `(value, { axis, index, min, max })` is over-engineered. Users can close over any state they need.
