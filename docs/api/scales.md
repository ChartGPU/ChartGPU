# Scales (Pure utilities)

ChartGPU exports a small set of pure utilities for mapping numeric and categorical domains to numeric ranges. See [`scales.ts`](../../src/utils/scales.ts).

## `createLinearScale(): LinearScale`

Creates a linear scale with an initial identity mapping (domain `[0, 1]` -> range `[0, 1]`).

**Behavior notes (essential):**

- **Chainable setters**: `domain(min, max)` and `range(min, max)` return the same scale instance for chaining.
- **`scale(value)`**: maps domain -> range with no clamping (values outside the domain extrapolate). If the domain span is zero (`min === max`), returns the midpoint of the range.
- **`invert(pixel)`**: maps range -> domain with no clamping (pixels outside the range extrapolate). If the domain span is zero (`min === max`), returns `min` for any input.

## `LinearScale`

Type definition for the scale returned by `createLinearScale()`. See [`scales.ts`](../../src/utils/scales.ts).

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
