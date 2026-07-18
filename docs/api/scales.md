# Scales (Pure utilities)

ChartGPU exports a small set of pure utilities for mapping numeric and categorical domains to numeric ranges. See [`scales.ts`](../../src/utils/scales.ts).

## `ContinuousScale`

Shared interface for linear and logarithmic continuous scales:

- **`kind: 'linear' | 'log'`** — discriminator for GPU projection
- **`base?: number`** — present when `kind === 'log'`
- **`domain` / `range` / `scale` / `invert`** — chainable mapping
- **`getDomain()` / `getRange()`** — current endpoints

`LinearScale` is a type alias of `ContinuousScale` (backward compatible).

## `createLinearScale(): ContinuousScale`

Creates a linear scale with an initial identity mapping (domain `[0, 1]` -> range `[0, 1]`). Instances have `kind: 'linear'`.

**Behavior notes (essential):**

- **Chainable setters**: `domain(min, max)` and `range(min, max)` return the same scale instance for chaining.
- **`scale(value)`**: maps domain -> range with no clamping (values outside the domain extrapolate). If the domain span is zero (`min === max`), returns the midpoint of the range.
- **`invert(pixel)`**: maps range -> domain with no clamping (pixels outside the range extrapolate). If the domain span is zero (`min === max`), returns `min` for any input.

## `createLogScale(base?: number): ContinuousScale`

Creates a logarithmic continuous scale (`kind: 'log'`). Default base is **10**. Invalid bases (non-finite, ≤0, or 1) fall back to 10.

**Behavior notes (essential):**

- Mapping is linear in \(\log_b(value)\): equal decades occupy equal pixel spans.
- **`scale(value)`** returns `NaN` for non-positive inputs (log is undefined).
- **`domain(min, max)`** requires strictly positive endpoints; non-positive values are clamped to a safe positive fallback.
- **GPU path**: ChartGPU keeps DataStore buffers in **data space** and applies `log` in the vertex shader before the clip affine. Toggling `type: 'log'` does not re-upload series buffers.
- Exported helpers: `generateLogTicks`, `generateLogTicksForVisibleDomain` (zoom-aware densified ticks), `formatLogTickValue` (via package entry).

## `createAxisScale(axis): ContinuousScale`

Factory used by the render coordinator: returns `createLogScale(axis.logBase)` when `axis.type === 'log'`, otherwise `createLinearScale()`.

## `LinearScale`

Type alias of `ContinuousScale` for backward compatibility. See [`scales.ts`](../../src/utils/scales.ts).

## `createCategoryScale(): CategoryScale`

Creates a category scale for mapping an ordered set of string categories to evenly spaced x-positions across a numeric range. See [`scales.ts`](../../src/utils/scales.ts).

**Behavior notes (essential):**

- **Even spacing**: categories are evenly distributed across the configured range; `scale(category)` returns the center position of the category's band.
- **Unknown category**: `scale(category)` returns `NaN` when the category is not in the domain, and `categoryIndex(category)` returns `-1`.
- **Empty domain**: `bandwidth()` returns `0`, and `scale(category)` returns the midpoint of the range.
- **Domain uniqueness**: `domain(categories)` throws if duplicates exist (ambiguous mapping).
- **Reversed ranges**: reversed ranges are allowed (e.g. `range(max, min)`); positions decrease across the domain.

## `CategoryScale`

Type definition for the scale returned by `createCategoryScale()`. See [`scales.ts`](../../src/utils/scales.ts).
