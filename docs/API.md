# API Reference

## Chart API (Phase 1)

See [ChartGPU.ts](../src/ChartGPU.ts) for the chart instance implementation.

### `ChartGPU.create(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>`

Creates a chart instance bound to a container element.

### `ChartGPUInstance`

Returned by `ChartGPU.create(...)`.

See [ChartGPU.ts](../src/ChartGPU.ts) for the full interface and lifecycle behavior.

**Properties (essential):**

- `options: Readonly<ChartGPUOptions>`: the last user-provided options object (unresolved).
- `disposed: boolean`

**Methods (essential):**

- `setOption(options: ChartGPUOptions): void`: replaces the current user options, resolves them against defaults via [`resolveOptions`](../src/config/OptionResolver.ts), updates internal render state, and schedules a single on-demand render on the next `requestAnimationFrame` tick (coalesces multiple calls).
- `appendData(seriesIndex: number, newPoints: DataPoint[]): void`: appends new points to a **cartesian** series at runtime (streaming), updates internal runtime bounds, and schedules a render (coalesces). Internally, streaming appends are flushed via a unified scheduler (rAF-first with a small timeout fallback) and only do resampling work when zoom is active or a zoom change debounce matures. When `ChartGPUOptions.autoScroll === true`, this may also adjust the x-axis percent zoom window (see **Auto-scroll (streaming)** below). Pie series are not supported by streaming append. See [`ChartGPU.ts`](../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts). For an end-to-end example, see [`examples/live-streaming/`](../examples/live-streaming/).
- `resize(): void`: recomputes the canvas backing size / WebGPU canvas configuration from the container size; if anything changes, schedules a render.
- `dispose(): void`: cancels any pending frame, disposes internal render resources, destroys the WebGPU context, and removes the canvas.
- `on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: registers an event listener. See [Event handling](#event-handling) below.
- `off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void`: unregisters an event listener. See [Event handling](#event-handling) below.
- `getInteractionX(): number | null`: returns the current “interaction x” in domain units (or `null` when inactive). See [`ChartGPU.ts`](../src/ChartGPU.ts).
- `setInteractionX(x: number | null, source?: unknown): void`: drives the chart’s crosshair/tooltip interaction from a domain x value; pass `null` to clear. See [`ChartGPU.ts`](../src/ChartGPU.ts) and the internal implementation in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
- `setCrosshairX(x: number | null, source?: unknown): void`: alias for `setInteractionX(...)` with chart-sync semantics (external crosshair/tooltip control); `x` is in domain units and `null` clears. See [`ChartGPU.ts`](../src/ChartGPU.ts).
- `onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void`: subscribes to interaction x updates and returns an unsubscribe function. See [`ChartGPU.ts`](../src/ChartGPU.ts).
- `getZoomRange(): { start: number; end: number } | null`: returns the current percent-space zoom window in \([0, 100]\), or `null` when data zoom is disabled. See [`ChartGPU.ts`](../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../src/interaction/createZoomState.ts).
- `setZoomRange(start: number, end: number): void`: sets the percent-space zoom window (ordered/clamped to \([0, 100]\)); no-op when data zoom is disabled. See [`ChartGPU.ts`](../src/ChartGPU.ts) and percent-space semantics in [`createZoomState.ts`](../src/interaction/createZoomState.ts).

Data upload and scale/bounds derivation occur during [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) `RenderCoordinator.render()` (not during `setOption(...)` itself).

**Event handling:**

Chart instances expose `on()` and `off()` methods for subscribing to user interaction events. See [ChartGPU.ts](../src/ChartGPU.ts) for the implementation.

- **`on(eventName, callback): void`**: registers a callback for the specified event name. Callbacks are stored in a closure and persist until explicitly removed via `off()` or until the instance is disposed.
- **`off(eventName, callback): void`**: removes a previously registered callback. Safe to call even if the callback was never registered or was already removed.

**Supported events:**

- **`'click'`**: fires on tap/click gestures (mouse left-click, touch tap, pen tap). When you register a click listener via `on('click', ...)`, it fires whenever a click occurs on the canvas, even if not on a chart item. For clicks not on a chart item, the callback receives `seriesIndex: null`, `dataIndex: null`, `value: null`, and `seriesName: null`, but includes the original `PointerEvent` as `event`.
- **`'mouseover'`**: fires when the pointer enters a chart item (or transitions from one chart item to another). Chart items include cartesian hits (points/bars) and pie slices. Only fires when listeners are registered (`on('mouseover', ...)` or `on('mouseout', ...)`).
- **`'mouseout'`**: fires when the pointer leaves a chart item (or transitions from one chart item to another). Chart items include cartesian hits (points/bars) and pie slices. Only fires when listeners are registered (`on('mouseover', ...)` or `on('mouseout', ...)`).
- **`'crosshairMove'`**: fires when the chart’s “interaction x” changes (domain units). This includes pointer movement inside the plot area, pointer leaving the plot area (emits `x: null`), programmatic calls to `setInteractionX(...)` / `setCrosshairX(...)`, and updates received via `connectCharts(...)` sync. See [`ChartGPU.ts`](../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

**Event callback payload:**

For `'click' | 'mouseover' | 'mouseout'`, callbacks receive a `ChartGPUEventPayload` object with:
- `seriesIndex: number | null`: zero-based series index, or `null` if not on a chart item
- `dataIndex: number | null`: zero-based item index within the series (for cartesian series: data point index; for pie series: slice index), or `null` if not on a chart item
- `value: readonly [number, number] | null`: item value tuple.
  - For cartesian series, this is the data point coordinates `[x, y]` (domain units).
  - For pie series, this is `[0, sliceValue]` (pie is non-cartesian; the y-slot contains the numeric slice value). See [`ChartGPU.ts`](../src/ChartGPU.ts).
- `seriesName: string | null`: series name from `series[i].name` (trimmed), or `null` if not on a chart item or name is empty. Note: for pie slices this is still the series `name` (slice `name` is not included in event payload).
- `event: PointerEvent`: the original browser `PointerEvent` for access to client coordinates, timestamps, etc.

For `'crosshairMove'`, callbacks receive a `ChartGPUCrosshairMovePayload` object with:
- `x: number | null`: current interaction x in domain units (`null` clears/hides crosshair + tooltip)
- `source?: unknown`: optional token identifying the origin of the update (useful for sync loop prevention; passed through `setInteractionX(...)` / `setCrosshairX(...)` and forwarded by `connectCharts(...)`)

**Behavioral notes:**

- Click events fire when you have registered a click listener via `on('click', ...)`. For clicks not on a chart item, point-related fields (`seriesIndex`, `dataIndex`, `value`, `seriesName`) are `null`, but `event` always contains the original `PointerEvent`.
- Hover events (`mouseover` / `mouseout`) only fire when at least one hover listener is registered. They fire on transitions: `mouseover` when entering a chart item (or moving between items), `mouseout` when leaving a chart item (or moving between items).
- Crosshair move events (`crosshairMove`) fire on interaction-x changes. When the pointer leaves the plot area, the chart clears interaction-x to `null` so synced charts do not “stick”.
- All event listeners are automatically cleaned up when `dispose()` is called. No manual cleanup required.

**Legend (automatic):**

ChartGPU currently mounts a small legend panel as an internal HTML overlay alongside the canvas. The legend is created and managed by the render pipeline in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) (default position: `'right'`), updates when `setOption(...)` is called, and is disposed with the chart.

- **Non-pie series**: one legend row per series (swatch + label). Labels come from `series[i].name` (trimmed), falling back to `Series N`. Swatch colors come from `series[i].color` when provided, otherwise the resolved theme palette.
- **Pie series**: one legend row per slice (swatch + label). Labels come from `series[i].data[j].name` (trimmed), falling back to `Slice N`. Swatch colors come from `series[i].data[j].color` when provided, otherwise a palette fallback.

See the internal legend implementation in [`createLegend.ts`](../src/components/createLegend.ts).

### Chart sync (interaction)

ChartGPU supports a small “connect API” for syncing interaction between multiple charts (crosshair x-position + tooltip x-value). This is driven by the chart instance’s interaction-x APIs (`getInteractionX()` + `setCrosshairX(...)`) and the `'crosshairMove'` event.

`connectCharts` is exported from the public entrypoint [`src/index.ts`](../src/index.ts) and implemented in [`createChartSync.ts`](../src/interaction/createChartSync.ts).

For a concrete usage example with two stacked charts, see [`examples/interactive/main.ts`](../examples/interactive/main.ts).

#### `connectCharts(charts: ChartGPUInstance[]): () => void`

Connects charts so interaction-x updates in one chart drive `setCrosshairX(...)` on the other charts. Returns a `disconnect()` function that removes listeners and clears any synced interaction state.

### `ChartGPUOptions`

Chart configuration options.

See [`types.ts`](../src/config/types.ts) for the full type definition.

**Theme (essential):**

- **`ChartGPUOptions.theme`**: accepts `'dark' | 'light'` or a [`ThemeConfig`](../src/themes/types.ts) object. See [`ChartGPUOptions`](../src/config/types.ts) and [`ThemeName` / `getTheme`](../src/themes/index.ts).

**Data points (essential):**

- **`DataPoint`**: a series data point is either a tuple (`readonly [x, y, size?]`) or an object (`Readonly<{ x, y, size? }>`). See [`types.ts`](../src/config/types.ts).

**Auto-scroll (streaming):**

- **`ChartGPUOptions.autoScroll?: boolean`**: when `true`, calls to `ChartGPUInstance.appendData(...)` may automatically keep the visible x-range “anchored” to the newest data **only when x-axis data zoom is enabled** (i.e. there is a percent-space zoom window `{ start, end }` in \([0, 100]\)) and `xAxis.min`/`xAxis.max` are not set. Default: `false` (see [`defaults.ts`](../src/config/defaults.ts)).
  - **Pinned-to-end behavior**: when the current zoom window is effectively “at the end” (`end` near `100`), ChartGPU preserves the current window span and keeps `end` pinned at `100` as new data arrives.
  - **Panned-away behavior**: when the user has panned away from the end (`end` meaningfully less than `100`), ChartGPU preserves the previous visible domain instead of yanking the view back to the newest data.
  - **Limitations**: auto-scroll is applied on streaming append (not on `setOption(...)`). See the runtime implementation in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts). For a working demo (including a toggle and slider), see [`examples/live-streaming/`](../examples/live-streaming/).

**Series configuration (essential):**

- **`SeriesType`**: `'line' | 'area' | 'bar' | 'scatter' | 'pie'`. See [`types.ts`](../src/config/types.ts).
- **`SeriesConfig`**: `LineSeriesConfig | AreaSeriesConfig | BarSeriesConfig | ScatterSeriesConfig | PieSeriesConfig` (discriminated by `series.type`). See [`types.ts`](../src/config/types.ts).
- **Sampling (cartesian series only)**: cartesian series support optional `sampling?: 'none' | 'lttb' | 'average' | 'max' | 'min'` and optional `samplingThreshold?: number` (applied when the input series data length exceeds the threshold). When omitted, defaults are `sampling: 'lttb'` and `samplingThreshold: 5000` via [`resolveOptions`](../src/config/OptionResolver.ts) and baseline defaults in [`defaults.ts`](../src/config/defaults.ts). Sampling affects rendering and cartesian hit-testing only; axis auto-bounds are derived from raw (unsampled) series data unless you set `xAxis.min`/`xAxis.max` or `yAxis.min`/`yAxis.max` (see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts)). When x-axis data zoom is enabled, sampling is re-applied against the **visible x-range** (from the percent-space zoom window in \([0, 100]\)) using raw data; resampling is **debounced (~100ms)** during zoom changes (see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts)). Pie series (`type: 'pie'`) do not support these fields (pie is non-cartesian).
- **`LineSeriesConfig`**: extends the shared series fields with `type: 'line'`, optional `lineStyle?: LineStyleConfig`, and optional `areaStyle?: AreaStyleConfig`.
  - When a line series includes `areaStyle`, ChartGPU renders a filled area behind the line (area fills then line strokes). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
- **`AreaSeriesConfig`**: extends the shared series fields with `type: 'area'`, optional `baseline?: number`, and optional `areaStyle?: AreaStyleConfig`.
  - **`baseline`** is a data-space “filled area floor”. If omitted, ChartGPU defaults it to the y-axis minimum.
  - **`areaStyle.opacity`** controls the fill opacity.
- **`BarSeriesConfig`**: extends the shared series fields with `type: 'bar'` and bar-specific layout/styling. See [`types.ts`](../src/config/types.ts).
  - **`barWidth?: number | string`**: bar width in CSS pixels or as a percentage string (relative to the category width).
  - **`barGap?: number`**: gap between bars in the same category (ratio in \([0, 1]\)).
  - **`barCategoryGap?: number`**: gap between categories (ratio in \([0, 1]\)).
  - **`stack?: string`**: stack group id (bars with the same id may be stacked).
  - **`itemStyle?: BarItemStyleConfig`**: per-bar styling.
  - **Rendering (current)**: bar series render as clustered bars per x-category via an instanced draw path. If multiple bar series share the same **non-empty** `stack` id, they render as stacked segments within the same cluster slot (positive values stack upward from the baseline; negative values stack downward). See [`createBarRenderer.ts`](../src/renderers/createBarRenderer.ts), shader source [`bar.wgsl`](../src/shaders/bar.wgsl), and coordinator wiring in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts). For an example, see [`examples/grouped-bar/`](../examples/grouped-bar/).
    - Note: y-axis auto bounds are currently derived from raw series y-values (not stacked totals). If stacked bars clip, set `yAxis.min` / `yAxis.max`.
- **`ScatterSeriesConfig`**: extends the shared series fields with `type: 'scatter'`, optional `symbol?: ScatterSymbol`, and optional `symbolSize?: number | ((value: ScatterPointTuple) => number)`. See [`types.ts`](../src/config/types.ts).
  - Scatter point tuples may include an optional third `size` value (`readonly [x, y, size?]`).
  - **Rendering (current)**: scatter series render as instanced circles (SDF + alpha blending). Size is treated as a **radius in CSS pixels** from either the per-point `size` (when provided) or `series.symbolSize` as a fallback. See the internal renderer [`createScatterRenderer.ts`](../src/renderers/createScatterRenderer.ts) and shader [`scatter.wgsl`](../src/shaders/scatter.wgsl).
- **`PieSeriesConfig`**: extends the shared series fields with `type: 'pie'`. See [`types.ts`](../src/config/types.ts).
  - **Behavior notes (important)**: pie series are **non-cartesian** and are rendered as pie/donut slices by the render coordinator (see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and [`createPieRenderer.ts`](../src/renderers/createPieRenderer.ts)).
  - **Interaction + bounds notes (important)**:
    - Pie series do **not** participate in cartesian x/y bounds derivation (they do not affect `xAxis`/`yAxis` min/max auto-derivation).
    - Pie series do **not** participate in cartesian hit-testing utilities (see [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts) and [`findPointsAtX.ts`](../src/interaction/findPointsAtX.ts)).
    - Pie slices **do** support hover hit-testing for ChartGPU’s internal tooltip and ChartGPU instance events (`'click'`, `'mouseover'`, `'mouseout'`) via [`findPieSlice.ts`](../src/interaction/findPieSlice.ts) (wired in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and [`ChartGPU.ts`](../src/ChartGPU.ts)).
  - **Pie-only charts**: when `series` contains only `type: 'pie'`, the render coordinator skips cartesian x/y axis rendering and does not render the DOM tick value labels. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - **Slice colors**: each `PieDataItem` supports `color?: string`. Color precedence is **`item.color`** when provided, otherwise a palette fallback (see [`resolveOptions`](../src/config/OptionResolver.ts)). For a working example, see [`examples/pie/`](../examples/pie/).
- **`BarItemStyleConfig`**: bar styling options. See [`types.ts`](../src/config/types.ts).
  - **`borderRadius?: number`**
  - **`borderWidth?: number`**
  - **`borderColor?: string`**

**Axis configuration (essential):**

- **`AxisConfig`**: configuration for `xAxis` / `yAxis`. See [`types.ts`](../src/config/types.ts).
- **`AxisConfig.name?: string`**: renders an axis title for cartesian charts when provided (and non-empty after `trim()`): x-axis titles are centered below x-axis tick labels, and y-axis titles are rotated \(-90°\) and placed left of y-axis tick labels; titles can be clipped if `grid.bottom` / `grid.left` margins are too small. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
- **Axis title styling**: titles are rendered via the internal DOM text overlay and use the resolved theme’s `textColor` and `fontFamily` with slightly larger, bold text (label elements also set `dir='auto'`).

**Data zoom (type definitions):**

- **`ChartGPUOptions.dataZoom?: ReadonlyArray<DataZoomConfig>`**: optional data-zoom configuration list. See [`ChartGPUOptions`](../src/config/types.ts) and [`DataZoomConfig`](../src/config/types.ts).
- **Runtime behavior (current)**: data zoom controls a shared percent-space zoom window `{ start, end }` in \([0, 100]\) that is applied to the effective x-domain for both rendering and pointer interaction. See the x-domain application in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and percent-space semantics in [`createZoomState.ts`](../src/interaction/createZoomState.ts).
  - **Zoom-aware sampling (cartesian)**: when a cartesian series has sampling enabled, ChartGPU resamples from raw (unsampled) series data over the current visible x-range; resampling is debounced (~100ms) to avoid churn during wheel/drag zoom updates. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - **Inside zoom**: when `ChartGPUOptions.dataZoom` includes `{ type: 'inside' }`, ChartGPU enables an internal wheel/drag interaction. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and [`createInsideZoom.ts`](../src/interaction/createInsideZoom.ts).
  - **Zoom gesture**: mouse wheel zoom, centered on the current cursor x-position (only when the pointer is inside the plot grid).
  - **Pan gesture**: shift+left-drag or middle-mouse drag pans left/right (only when the pointer is inside the plot grid).
  - **Scope**: x-axis only (the zoom window is applied to the x-domain; y-domain is unchanged).
  - **Grid-only**: input is ignored outside the plot grid (respects `grid` margins).
  - **Slider UI**: when `ChartGPUOptions.dataZoom` includes `{ type: 'slider' }`, ChartGPU mounts a slider-style UI that manipulates the same percent zoom window. See [`ChartGPU.ts`](../src/ChartGPU.ts) and the internal UI helper [`createDataZoomSlider.ts`](../src/components/createDataZoomSlider.ts).
  - **Coexistence**: multiple data-zoom configs can coexist (e.g. inside + slider) and drive the same x-zoom window.
  - **Config fields (current)**: `start` / `end` are used as the initial percent window (defaulting to `0` / `100` when omitted). Other fields (`xAxisIndex`, `minSpan`, `maxSpan`) are currently accepted by the type and preserved by option resolution, but are not yet applied by the runtime zoom path.
- **`DataZoomConfig`**: data zoom configuration type. See [`DataZoomConfig`](../src/config/types.ts).
  - **`type: 'inside' | 'slider'`**
  - **`xAxisIndex?: number`**
  - **`start?: number`**: start percent in \([0, 100]\)
  - **`end?: number`**: end percent in \([0, 100]\)
  - **`minSpan?: number`**
  - **`maxSpan?: number`**

**Tooltip configuration (type definitions):**

- **`ChartGPUOptions.tooltip?: TooltipConfig`**: optional tooltip configuration. See [`types.ts`](../src/config/types.ts).
- **Enablement**: when `tooltip.show !== false`, ChartGPU creates an internal DOM tooltip overlay and updates it on hover; when `tooltip.show === false`, the tooltip is not shown.
- **Hover behavior**: tooltip updates on pointer movement within the plot grid and hides on pointer leave. For cartesian series it uses cartesian hit-testing (see [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts) and [`findPointsAtX.ts`](../src/interaction/findPointsAtX.ts)); for pie series it uses pie slice hit-testing (see [`findPieSlice.ts`](../src/interaction/findPieSlice.ts)). See the tooltip logic in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
- **`TooltipConfig.trigger?: 'item' | 'axis'`**: tooltip trigger mode.
- **`TooltipConfig.formatter?: (params: TooltipParams | TooltipParams[]) => string`**: custom formatter function. Receives a single `TooltipParams` when `trigger` is `'item'`, or an array of `TooltipParams` when `trigger` is `'axis'`. See [`types.ts`](../src/config/types.ts) for `TooltipParams` fields (`seriesName`, `seriesIndex`, `dataIndex`, `value`, `color`).

**Animation (type definitions):**

- **`ChartGPUOptions.animation?: AnimationConfig | boolean`**: optional animation configuration.
  - **Default**: when omitted, animation is enabled with defaults (equivalent to `true`). See [`OptionResolver.ts`](../src/config/OptionResolver.ts).
  - **Disablement**: set to `false` to disable all animation.
  - **Defaults**: when enabled, `AnimationConfig.duration` defaults to `300`ms when omitted.
- **`AnimationConfig`**: supports optional `duration?: number` (ms), `easing?: 'linear' | 'cubicOut' | 'cubicInOut' | 'bounceOut'`, and `delay?: number` (ms). See [`types.ts`](../src/config/types.ts).
  - **Built-in easing implementations (internal)**: see [`easing.ts`](../src/utils/easing.ts) and the name→function helper `getEasing(...)`.
- **Initial-load intro animation**: when animation is enabled, series marks animate on first render. Axes, grid lines, and labels render immediately (not animated). Per-series effects: line/area series reveal left-to-right via plot scissor; bar series grow upward from baseline; pie slices expand radius; scatter points fade in. The intro animation requests frames internally during the transition. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts). Streaming demos may prefer disabling animation (`animation: false`).
- **Data update transition animation (Story 5.17)**: when animation is enabled, subsequent calls to `ChartGPUInstance.setOption(...)` (and the internal `RenderCoordinator.setOptions(...)`) that change series data can animate transitions after the initial render has occurred. See the internal implementation in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and the visual acceptance example in [`examples/data-update-animation/`](../examples/data-update-animation/).
  - **When it triggers (high-level)**: a post-initial-render options update that changes `series[i].data` (cartesian and pie), with `ChartGPUOptions.animation` enabled.
  - **What animates (high-level)**:
    - **Cartesian series**: y-values interpolate by index while x-values come from the new series (index-aligned). Bars morph via the same y interpolation.
    - **Pie series**: slice values interpolate by index, producing animated angle changes.
    - **Derived domains/scales**: when auto-derived axis domains change (from updated data), the domain values animate to the new extents.
  - **Constraints / notes (high-level)**:
    - **Match-by-index**: interpolation is index-based; length changes and type/shape mismatches may skip interpolation and apply the new series immediately.
    - **Large-series safeguard**: very large series may skip per-point interpolation while still animating derived domains (internal safeguard).
    - **Mid-flight updates**: a new `setOption(...)` during an active transition rebases the transition from the current displayed state (avoids a visual jump).

### Animation controller (internal)

ChartGPU includes a small internal controller for driving time-based value tweens (scalar or numeric arrays).

See [`createAnimationController.ts`](../src/core/createAnimationController.ts) for the implementation and full TypeScript types.

- **Factory**: `createAnimationController(): AnimationController`
- **`AnimationController.animate(from, to, duration, easing, onUpdate, onComplete?) => symbol`**
  - **Value types**: `from`/`to` are either `number` or `ReadonlyArray<number>` (array lengths must match).
  - **Timebase**: `duration` is in ms; easing is an [`EasingFunction`](../src/utils/easing.ts) (`(t: number) => number`) where `t` is treated as \([0, 1]\).
  - **Updates**: calls `onUpdate(interpolated)` each `update(timestamp)` tick while active.
- **`AnimationController.cancel(animationId): void`**: stops a specific animation (does not call `onComplete`).
- **`AnimationController.cancelAll(): void`**: stops all animations (does not call `onComplete`).
- **`AnimationController.update(timestamp): void`**: progresses all active animations to `timestamp` (ms), intended to be called from a frame loop (e.g. `requestAnimationFrame` timestamp).

For a minimal acceptance check (0→100 over 300ms with easing), see [`examples/acceptance/animation-controller.ts`](../examples/acceptance/animation-controller.ts).

**`TooltipParams` (public export):** exported from the public entrypoint [`src/index.ts`](../src/index.ts) and defined in [`types.ts`](../src/config/types.ts).

Default tooltip formatter helpers are available in [`formatTooltip.ts`](../src/components/formatTooltip.ts): `formatTooltipItem(params: TooltipParams): string` (item mode) and `formatTooltipAxis(params: TooltipParams[]): string` (axis mode). Both return HTML strings intended for the internal tooltip overlay’s `innerHTML` usage; the axis formatter includes an x header line.

Notes:

- For pie slice tooltips, `TooltipParams.seriesName` uses the slice `name` (not the series `name`), and `TooltipParams.value` is `[0, sliceValue]`. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

**Content safety (important)**: the tooltip overlay assigns `content` via `innerHTML`. Only return trusted/sanitized strings from `TooltipConfig.formatter`. See the internal tooltip overlay helper in [`createTooltip.ts`](../src/components/createTooltip.ts) and the default formatter helpers in [`formatTooltip.ts`](../src/components/formatTooltip.ts).

For a working configuration (including axis titles via `AxisConfig.name` and a filled line series via `areaStyle`), see [`examples/basic-line/main.ts`](../examples/basic-line/main.ts).

For an axis-trigger tooltip formatter that renders all series values at the hovered x (e.g. time-series), see [`examples/interactive/main.ts`](../examples/interactive/main.ts).

### `defaultOptions`

Default chart options used as a baseline for resolution.

See [`defaults.ts`](../src/config/defaults.ts) for the defaults (including grid, palette, and axis defaults).

**Behavior notes (essential):**

- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
- **Palette / series colors**: `ChartGPUOptions.palette` acts as an override for the resolved theme palette (`resolvedOptions.theme.colorPalette`). When `series[i].color` is missing, the default series color comes from `resolvedOptions.theme.colorPalette[i % ...]`. For backward compatibility, the resolved `palette` is the resolved theme palette. See [`resolveOptions`](../src/config/OptionResolver.ts) and [`ThemeConfig`](../src/themes/types.ts).
- **Line series color precedence**: for `type: 'line'`, effective color follows: `lineStyle.color` → `series.color` → theme palette. See [`resolveOptions`](../src/config/OptionResolver.ts).
- **Axis ticks**: `AxisConfig.tickLength` controls tick length in CSS pixels (default: 6)

### `resolveOptions(userOptions?: ChartGPUOptions)` / `OptionResolver.resolve(userOptions?: ChartGPUOptions)`

Resolves user options against defaults by deep-merging user-provided values with defaults and returning a resolved options object.

See [`OptionResolver.ts`](../src/config/OptionResolver.ts) for the resolver API and resolved option types.

**Behavior notes (essential):**

- **Theme input**: `ChartGPUOptions.theme` accepts `'dark' | 'light'` or a [`ThemeConfig`](../src/themes/types.ts); the resolved `theme` is always a concrete `ThemeConfig`. See [`ChartGPUOptions`](../src/config/types.ts) and [`resolveOptions`](../src/config/OptionResolver.ts).
- **Default theme**: when `theme` is omitted, the resolved theme defaults to `'dark'` via [`getTheme`](../src/themes/index.ts) (preset: [`darkTheme`](../src/themes/darkTheme.ts)).
- **Theme name resolution**: `resolveOptions({ theme: 'light' })` resolves `theme` to the light preset config (see [`lightTheme`](../src/themes/lightTheme.ts)).
- **Palette override**: when `ChartGPUOptions.palette` is provided (non-empty), it overrides the resolved theme palette (`resolvedOptions.theme.colorPalette`). The resolved `palette` mirrors the resolved theme palette for backward compatibility. See [`resolveOptions`](../src/config/OptionResolver.ts).

### `ThemeConfig`

Theme configuration type for describing chart theme colors, palette, and typography. Used by `ChartGPUOptions.theme` (and produced by [`resolveOptions`](../src/config/OptionResolver.ts)).

See [`types.ts`](../src/themes/types.ts).

### Theme presets

ChartGPU provides built-in theme presets and a small helper for selecting them. These are exported from the public entrypoint; see [`src/index.ts`](../src/index.ts).

- **`darkTheme: ThemeConfig`**: built-in dark preset. See [`darkTheme.ts`](../src/themes/darkTheme.ts).
- **`lightTheme: ThemeConfig`**: built-in light preset. See [`lightTheme.ts`](../src/themes/lightTheme.ts).
- **`ThemeName = 'dark' | 'light'`**: preset name union. See [`themes/index.ts`](../src/themes/index.ts).
- **`getTheme(name: ThemeName): ThemeConfig`**: returns a preset by name. See [`themes/index.ts`](../src/themes/index.ts).

## Scales (Pure utilities)

ChartGPU exports a small set of pure utilities for mapping numeric and categorical domains to numeric ranges. See [`scales.ts`](../src/utils/scales.ts).

### `createLinearScale(): LinearScale`

Creates a linear scale with an initial identity mapping (domain `[0, 1]` -> range `[0, 1]`).

**Behavior notes (essential):**

- **Chainable setters**: `domain(min, max)` and `range(min, max)` return the same scale instance for chaining.
- **`scale(value)`**: maps domain -> range with no clamping (values outside the domain extrapolate). If the domain span is zero (`min === max`), returns the midpoint of the range.
- **`invert(pixel)`**: maps range -> domain with no clamping (pixels outside the range extrapolate). If the domain span is zero (`min === max`), returns `min` for any input.

### `LinearScale`

Type definition for the scale returned by `createLinearScale()`. See [`scales.ts`](../src/utils/scales.ts).

### `createCategoryScale(): CategoryScale`

Creates a category scale for mapping an ordered set of string categories to evenly spaced x-positions across a numeric range. See [`scales.ts`](../src/utils/scales.ts).

**Behavior notes (essential):**

- **Even spacing**: categories are evenly distributed across the configured range; `scale(category)` returns the center position of the category’s band.
- **Unknown category**: `scale(category)` returns `NaN` when the category is not in the domain, and `categoryIndex(category)` returns `-1`.
- **Empty domain**: `bandwidth()` returns `0`, and `scale(category)` returns the midpoint of the range.
- **Domain uniqueness**: `domain(categories)` throws if duplicates exist (ambiguous mapping).
- **Reversed ranges**: reversed ranges are allowed (e.g. `range(max, min)`); positions decrease across the domain.

### `CategoryScale`

Type definition for the scale returned by `createCategoryScale()`. See [`scales.ts`](../src/utils/scales.ts).

## Functional API (Preferred)

The functional API provides a type-safe, immutable approach to managing WebGPU contexts.

See [GPUContext.ts](../src/core/GPUContext.ts) for the complete implementation.

### `GPUContextState`

Represents the state of a GPU context with readonly properties.

### `createGPUContext(canvas?: HTMLCanvasElement): GPUContextState`

Creates a new GPUContext state with initial values.

### `createGPUContextAsync(canvas?: HTMLCanvasElement): Promise<GPUContextState>`

Creates and initializes a GPU context in one step. Recommended for most use cases.

**Throws:** `Error` if initialization fails

### `initializeGPUContext(context: GPUContextState): Promise<GPUContextState>`

Initializes the WebGPU context by requesting an adapter and device. Returns a new state object.

**Throws:** `Error` if WebGPU unavailable, adapter/device request fails, or already initialized

### `getCanvasTexture(context: GPUContextState): GPUTexture`

Gets the current texture from the canvas context.

**Throws:** `Error` if canvas not configured or context not initialized

### `clearScreen(context: GPUContextState, r: number, g: number, b: number, a: number): void`

Clears the canvas to a solid color.

**Parameters:** `r`, `g`, `b`, `a` - Color components in range [0.0, 1.0]

**Throws:** `Error` if color components are out of range, canvas not configured, or context not initialized

See [GPUContext.ts](../src/core/GPUContext.ts) for implementation.

### `destroyGPUContext(context: GPUContextState): GPUContextState`

Destroys the WebGPU device and cleans up resources. Returns a new state object with reset values.

## Class-Based API (Backward Compatibility)

The `GPUContext` class provides a class-based interface that internally uses the functional implementation.

See [GPUContext.ts](../src/core/GPUContext.ts) for the complete implementation.

### `GPUContext.create(canvas?: HTMLCanvasElement): Promise<GPUContext>`

Factory method that creates and initializes a GPUContext instance.

**Throws:** `Error` if initialization fails

### Properties

- `adapter` - WebGPU adapter instance, or `null` if not initialized
- `device` - WebGPU device instance, or `null` if not initialized
- `initialized` - `true` if successfully initialized
- `canvas` - Canvas element, or `null` if not provided
- `canvasContext` - WebGPU canvas context, or `null` if not configured
- `preferredFormat` - Preferred canvas format, or `null` if not configured

### Methods

- `initialize(): Promise<void>` - Initializes the WebGPU context
- `getCanvasTexture(): GPUTexture` - Gets the current canvas texture
- `clearScreen(r: number, g: number, b: number, a: number): void` - Clears the canvas to a solid color
- `destroy(): void` - Destroys the device and cleans up resources

## Error Handling

All initialization functions throw descriptive errors if WebGPU is unavailable, adapter/device requests fail, or the context is already initialized. Wrap initialization in try-catch blocks.

## Best Practices

Always call `destroyGPUContext()` (functional) or `destroy()` (class) when done with a GPU context. Use try-finally blocks to ensure cleanup.

When providing a canvas element, the context automatically handles device pixel ratio and configures the canvas with the preferred format.

## RenderScheduler

Manages a 60fps render loop using requestAnimationFrame with delta time tracking.

See [RenderScheduler.ts](../src/core/RenderScheduler.ts) for the complete implementation.

### `RenderCallback`

Callback function type that receives delta time in milliseconds since the last frame.

### `RenderScheduler`

Class that manages the render loop lifecycle.

### `start(callback: RenderCallback): void`

Begins the requestAnimationFrame loop. Callback receives delta time in milliseconds.

**Throws:** `Error` if callback not provided or scheduler already running

### `stop(): void`

Stops the render loop and cancels pending frames.

### `requestRender(): void`

Marks frame as dirty for future optimization. Currently unused but prepared for frame-skipping.

### `running: boolean`

Getter that returns `true` if the scheduler is currently running.

## Type Definitions

All WebGPU types are provided by `@webgpu/types`. See [GPUContext.ts](../src/core/GPUContext.ts) and [RenderScheduler.ts](../src/core/RenderScheduler.ts) for type usage.

## Internal modules (Contributor notes)

Chart data uploads and per-series GPU vertex buffer caching are handled by the internal `createDataStore(device)` helper. See [`createDataStore.ts`](../src/data/createDataStore.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`). **Buffers grow geometrically** to reduce reallocations when data grows incrementally.

### GPU buffer streaming (internal / contributor notes)

For frequently-updated dynamic geometry (e.g. interaction overlays), ChartGPU includes an internal streaming buffer helper that uses **double-buffering** (alternates two `GPUBuffer`s) to avoid writing into a buffer the GPU may still be reading, and uses `device.queue.writeBuffer(...)` with **partial range updates when possible**.

See [`createStreamBuffer.ts`](../src/data/createStreamBuffer.ts) for the helper API (`createStreamBuffer(device, maxSizeBytes)` returning `{ write, getBuffer, getVertexCount, dispose }`) and current usage in [`createCrosshairRenderer.ts`](../src/renderers/createCrosshairRenderer.ts).

### CPU downsampling (internal / contributor notes)

ChartGPU includes a small CPU-side Largest Triangle Three Buckets (LTTB) downsampler intended for internal tooling/acceptance checks and offline preprocessing. See [`lttbSample.ts`](../src/data/lttbSample.ts). This helper is currently **internal-only** (not exported from the public entrypoint `src/index.ts`).

- **Function**: `lttbSample(data, targetPoints)`
- **Overloads (high-level)**:
  - `lttbSample(data: ReadonlyArray<DataPoint>, targetPoints: number): ReadonlyArray<DataPoint>`
  - `lttbSample(data: Float32Array, targetPoints: number): Float32Array` where the input is interleaved `[x, y]` pairs (`[x0, y0, x1, y1, ...]`)

### Interaction utilities (internal / contributor notes)

Interaction helpers live in [`src/interaction/`](../src/interaction/). These modules are currently internal (not exported from the public entrypoint `src/index.ts`).

#### Event manager (internal)

See [`createEventManager.ts`](../src/interaction/createEventManager.ts).

- **Factory**: `createEventManager(canvas: HTMLCanvasElement, initialGridArea: GridArea): EventManager`
- **Purpose**: normalizes pointer input into chart-friendly coordinates and emits `'mousemove' | 'click' | 'mouseleave'` events.
- **Canvas access**: `EventManager.canvas` exposes the canvas element the manager was created for (used by internal interaction handlers; see [`createInsideZoom.ts`](../src/interaction/createInsideZoom.ts)).
- **Coordinate contract (critical)**:
  - `payload.x` / `payload.y` are **canvas-local CSS pixels** (relative to the canvas top-left in CSS px via `getBoundingClientRect()`).
  - `payload.gridX` / `payload.gridY` are **plot-area-local CSS pixels** (canvas-local CSS px minus `GridArea` CSS-pixel margins).
  - `payload.plotWidthCss` / `payload.plotHeightCss` are the plot (grid) dimensions in **CSS pixels** (derived from `getBoundingClientRect()` minus `gridArea` margins).
  - `payload.isInGrid` is computed in **CSS pixels** against the current plot rect.
- **Layout updates**: `EventManager.updateGridArea(gridArea)` must be called when grid/layout changes (ChartGPU’s internal render coordinator updates it each render).
- **Current usage**: used internally by the render coordinator to drive the crosshair overlay and to request renders in render-on-demand systems. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

#### Hover state manager (internal)

See [`createHoverState.ts`](../src/interaction/createHoverState.ts).

- **Factory**: `createHoverState(): HoverState`
- **Purpose**: tracks the currently hovered `{ seriesIndex, dataIndex }` pair and notifies listeners when it changes.
- **Debounce**: updates are coalesced with an internal debounce of ~16ms to avoid spamming downstream work during rapid pointer movement.
- **Change-only notifications**: listeners fire only when the hovered target actually changes (including `null`).
- **Listener management**: `onChange(callback)` returns an unsubscribe function; emissions iterate a snapshot of listeners so subscription changes during emit don’t affect the current flush.
- **Lifecycle**: `HoverState` includes an optional `destroy?: () => void`; `createHoverState()` currently returns a `destroy()` implementation that cancels any pending debounce timer and clears all listeners/state.

#### Zoom state manager (internal)

See [`createZoomState.ts`](../src/interaction/createZoomState.ts).

- **Factory**: `createZoomState(initialStart: number, initialEnd: number): ZoomState`
- **Purpose**: tracks a zoom window in percent space as `{ start, end }` in \([0, 100]\) and notifies listeners when it changes.
- **Clamping**: `start` / `end` are clamped to \([0, 100]\) and ordered (`start <= end`).
- **Span constraints**: `minSpan` / `maxSpan` are enforced (currently internal defaults); when a span clamp is required during zooming, the zoom anchor is preserved as much as possible.
- **Pan**: `pan(delta)` shifts the window by percent points while preserving span (clamped to bounds).
- **Listener management**: `onChange(callback)` returns an unsubscribe function; emissions iterate a snapshot of listeners so subscription changes during emit don’t affect the current emission.

#### Inside zoom handler (internal / Story 5.3)

See [`createInsideZoom.ts`](../src/interaction/createInsideZoom.ts) and the enablement/wiring in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

- **Purpose**: implements “inside” x-zoom and x-pan behavior (wheel zoom centered on cursor-x; drag pan) for cartesian charts.
- **Enablement**: enabled when resolved options include `dataZoom` with an entry where `type === 'inside'` (option normalization/preservation happens in [`OptionResolver.ts`](../src/config/OptionResolver.ts)).
- **Scope**: plot grid only and x-axis only (it updates the percent zoom window and the coordinator applies that window to the x-domain for both rendering scales and interaction scales).

#### Nearest point detection (internal)

See [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts).

- **Function**: `findNearestPoint(series: ReadonlyArray<ResolvedSeriesConfig>, x: number, y: number, xScale: LinearScale, yScale: LinearScale, maxDistance?: number): NearestPointMatch | null`
- **Returns**: `null` or `{ seriesIndex, dataIndex, point, distance }`
- **Pie note (Story 4.14)**: pie series are **ignored** by this helper. Pie slices use a separate hit-test helper; see [`findPieSlice.ts`](../src/interaction/findPieSlice.ts).
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **Scatter hit-testing (Story 4.10)**:
  - Scatter series use distance-based hit-testing but **expand the effective hit radius** based on symbol size so larger markers are easier to hover.
  - Size uses the same precedence as the scatter renderer (per-point `size` → `series.symbolSize` → default), and is interpreted as a **radius in CSS pixels** when your `xScale`/`yScale` range-space is in CSS pixels.
- **Bar hit-testing (Story 4.6)**:
  - Bar series use **bounding-box (rect) hit detection** in `xScale`/`yScale` range-space (not point distance).
  - A bar is only considered a match when the cursor is **inside** its rect bounds (`isPointInBar(...)` in [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts)).
  - **Stacked bars**: when multiple segments exist at the same x-category, the match is the **topmost segment under the cursor** (with deterministic tie-breaking on shared edges).
- **Coordinate system contract (critical)**:
  - `x` / `y` must be in the same units as `xScale` / `yScale` **range-space**.
  - If you pass **grid-local CSS pixels** (e.g. `gridX` / `gridY` from [`createEventManager.ts`](../src/interaction/createEventManager.ts)), then `xScale.range(...)` / `yScale.range(...)` must also be in **CSS pixels**.
  - If you pass **clip-space coordinates**, then the scales must also output clip space (and `maxDistance` is interpreted in clip-space units).
- **Performance**: per-series lower-bound binary search on x with outward expansion based on x-distance pruning; uses squared distances internally and computes `sqrt` only for the final match.

#### Points-at-x lookup (internal)

See [`findPointsAtX.ts`](../src/interaction/findPointsAtX.ts).

- **Function**: `findPointsAtX(series: ReadonlyArray<ResolvedSeriesConfig>, xValue: number, xScale: LinearScale, tolerance?: number): ReadonlyArray<PointsAtXMatch>`
- **Return type**: `ReadonlyArray<PointsAtXMatch>` where `PointsAtXMatch = { seriesIndex, dataIndex, point }`
- **Pie note (Story 4.14)**: pie series are **ignored** by this helper (pie is non-cartesian and not queryable by x). For pie hover hit-testing, see [`findPieSlice.ts`](../src/interaction/findPieSlice.ts).
- **Bar lookup (Story 4.6)**:
  - Bar series treat each bar as an x-interval in range-space and can return a match when `xValue` falls inside the bar interval (see [`findPointsAtX.ts`](../src/interaction/findPointsAtX.ts)).
  - When `tolerance` is finite, the effective interval is expanded by `tolerance` (range-space units) on both sides.
- **Coordinate system contract (critical)**:
  - `xValue` and `tolerance` MUST be in the same units as `xScale` **range-space**.
  - Note: ChartGPU’s internal render scales are currently in clip space (NDC, typically \[-1, 1\]); in that case, convert pointer x into clip space before calling this helper.
- **Tolerance behavior**: when `tolerance` is finite, matches with \(|xScale.scale(point.x) - xValue|\) beyond tolerance are omitted; when `tolerance` is omitted or non-finite, returns the nearest point per series when possible.
- **Sorted-x requirement**: each series must be sorted by increasing `x` in domain space for the binary search path to be correct.
- **NaN-x fallback**: if a series contains any `NaN` x values, this helper falls back to an O(n) scan for correctness (NaN breaks total ordering for binary search).

#### Pie slice hit-testing (internal)

See [`findPieSlice.ts`](../src/interaction/findPieSlice.ts).

- **Function**: `findPieSlice(x: number, y: number, pieConfig: PieHitTestConfig, center: PieCenterCssPx, radius: PieRadiusCssPx): PieSliceMatch | null`
- **Purpose**: finds the pie slice under a pointer position and returns `{ seriesIndex, dataIndex, slice }` when hit.
- **Coordinate contract (critical)**: `x`/`y` are plot/grid-local CSS pixels (as produced by `payload.gridX`/`payload.gridY` from [`createEventManager.ts`](../src/interaction/createEventManager.ts)), `center` is plot-local CSS pixels, and `radius` is in CSS pixels.
- **Non-cartesian note**: pie slices are detected using polar angle + radius checks; they do not use `xScale`/`yScale` and do not affect cartesian bounds.

### Text overlay (internal / contributor notes)

An internal DOM helper for rendering text labels above the canvas using an absolutely-positioned HTML overlay. See [`createTextOverlay.ts`](../src/components/createTextOverlay.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTextOverlay(container: HTMLElement): TextOverlay`
- **`TextOverlay` methods (essential)**:
  - `clear(): void`
  - `addLabel(text: string, x: number, y: number, options?: TextOverlayLabelOptions): HTMLSpanElement`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container’s top-left corner.
- **Pointer events**: the overlay uses `pointer-events: none` so it won’t intercept mouse/touch input.
- **Current usage**: used by the render coordinator to render numeric cartesian axis tick value labels above the canvas (pie-only charts skip these labels). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

### Legend (internal / contributor notes)

An internal DOM helper for rendering a legend above the canvas using an absolutely-positioned HTML overlay. See [`createLegend.ts`](../src/components/createLegend.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createLegend(container: HTMLElement, position?: 'top' | 'bottom' | 'left' | 'right')`
- **`Legend` methods (essential)**:
  - `update(series: ReadonlyArray<SeriesConfig>, theme: ThemeConfig): void`
  - `dispose(): void`
- **Legend rows (Story 4.15)**:
  - Non-pie: one row per series (`series[i].name`, `series[i].color` / palette fallback)
  - Pie: one row per slice (`series[i].data[j].name`, `series[i].data[j].color` / palette fallback)
- **Current usage**: created and updated by the render coordinator (default position `'right'`), using the resolved series list (`resolvedOptions.series`). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

### Tooltip overlay (internal / contributor notes)

An internal DOM helper for rendering an HTML tooltip above the canvas. See [`createTooltip.ts`](../src/components/createTooltip.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **Factory**: `createTooltip(container: HTMLElement): Tooltip`
- **`Tooltip` methods (essential)**:
  - `show(x: number, y: number, content: string): void`
  - `hide(): void`
  - `dispose(): void`
- **Coordinates**: `x` / `y` are in CSS pixels relative to the container’s top-left corner (container-local CSS px).
- **Positioning behavior**: positions the tooltip near the cursor with flip/clamp logic so it stays within the container bounds.
- **Content**: `content` is treated as HTML and assigned via `innerHTML`. Only pass trusted/sanitized strings.
- **Pointer events**: the tooltip uses `pointer-events: none` so it won’t intercept mouse/touch input.

For default `innerHTML`-safe tooltip content formatting helpers (item + axis trigger modes), see [`formatTooltip.ts`](../src/components/formatTooltip.ts).

### Data zoom slider (internal / contributor notes)

A standalone internal DOM helper for rendering a slider-style x-zoom UI. See [`createDataZoomSlider.ts`](../src/components/createDataZoomSlider.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`); ChartGPU uses it internally when `ChartGPUOptions.dataZoom` includes `{ type: 'slider' }` (see [`ChartGPU.ts`](../src/ChartGPU.ts)).

- **Factory**: `createDataZoomSlider(container: HTMLElement, zoomState: ZoomState, options?: DataZoomSliderOptions): DataZoomSlider`
- **`DataZoomSlider` methods (essential)**:
  - `update(theme: ThemeConfig): void`
  - `dispose(): void`
- **Inputs (zoom window semantics)**: `zoomState` is a percent-space window `{ start, end }` in \([0, 100]\) (ordered and clamped by the zoom state manager). See [`createZoomState.ts`](../src/interaction/createZoomState.ts).

### Render coordinator (internal / contributor notes)

A small orchestration layer for “resolved options → render pass submission”.

See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) for the complete implementation (including `GPUContextLike` and `RenderCoordinator` types).

- **Factory**: `createRenderCoordinator(gpuContext: GPUContextLike, options: ResolvedChartGPUOptions, callbacks?: RenderCoordinatorCallbacks): RenderCoordinator`

- **Callbacks (optional)**: `RenderCoordinatorCallbacks` currently supports `onRequestRender?: () => void` for render-on-demand integration (e.g. schedule a render on pointer-driven interaction state changes). See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).

**`RenderCoordinator` methods (essential):**

- **`setOptions(resolvedOptions: ResolvedChartGPUOptions): void`**: updates the current resolved chart options; adjusts per-series renderer/buffer allocations when series count changes.
- **`render(): void`**: performs a full frame by computing layout (`GridArea`), deriving clip-space scales (`xScale`, `yScale`), preparing renderers, uploading series data via the internal data store, and recording/submitting a render pass.
- **`dispose(): void`**: destroys renderer resources and the internal data store; safe to call multiple times.

**Responsibilities (essential):**

- **Layout**: computes `GridArea` from resolved grid margins and canvas size.
- **Scales**: derives `xScale`/`yScale` in clip space; respects explicit axis `min`/`max` overrides and otherwise falls back to global series bounds.
- **Orchestration order**: clear → grid → area fills → bars → scatter → line strokes → hover highlight → axes → crosshair.
- **Interaction overlays (internal)**: the render coordinator creates an internal [event manager](#event-manager-internal), an internal [crosshair renderer](#crosshair-renderer-internal--contributor-notes), and an internal [highlight renderer](#highlight-renderer-internal--contributor-notes). Pointer `mousemove`/`mouseleave` updates interaction state and toggles overlay visibility; when provided, `callbacks.onRequestRender?.()` is used so pointer movement schedules renders in render-on-demand systems (e.g. `ChartGPU`).
- **Pointer coordinate contract (high-level)**: the crosshair `prepare(...)` path expects **canvas-local CSS pixels** (`EventManager` payload `x`/`y`). See [`createEventManager.ts`](../src/interaction/createEventManager.ts) and [`createCrosshairRenderer.ts`](../src/renderers/createCrosshairRenderer.ts).
- **Target format**: uses `gpuContext.preferredFormat` (fallback `'bgra8unorm'`) for renderer pipelines; must match the render pass color attachment format.
- **Theme application (essential)**: see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - Background clear uses `resolvedOptions.theme.backgroundColor`.
  - Grid lines use `resolvedOptions.theme.gridLineColor`.
  - Axes use `resolvedOptions.theme.axisLineColor` (baseline) and `resolvedOptions.theme.axisTickColor` (ticks).
  - Axis tick value labels are rendered as DOM text (via the internal [text overlay](#text-overlay-internal--contributor-notes)) and styled using `resolvedOptions.theme.textColor`, `resolvedOptions.theme.fontSize`, and `resolvedOptions.theme.fontFamily` (see [`ThemeConfig`](../src/themes/types.ts)).

### Renderer utilities (Contributor notes)

Shared WebGPU renderer helpers live in [`rendererUtils.ts`](../src/renderers/rendererUtils.ts). These are small, library-friendly utilities intended to reduce repeated boilerplate when building renderers.

- **`createShaderModule(device, code, label?)`**: creates a `GPUShaderModule` from WGSL source.
- **`createRenderPipeline(device, config)`**: creates a `GPURenderPipeline` from either existing shader modules or WGSL code.
  - **Defaults**: `layout: 'auto'`, `vertex.entryPoint: 'vsMain'`, `fragment.entryPoint: 'fsMain'`, `primitive.topology: 'triangle-list'`, `multisample.count: 1`
  - **Fragment targets convenience**: provide `fragment.formats` (one or many formats) instead of full `fragment.targets` to generate `GPUColorTargetState[]` (optionally with shared `blend` / `writeMask`).
- **`createUniformBuffer(device, size, options?)`**: creates a `GPUBuffer` with usage `UNIFORM | COPY_DST`, aligning size (defaults to 16-byte alignment).
- **`writeUniformBuffer(device, buffer, data)`**: writes `BufferSource` data at offset 0 via `device.queue.writeBuffer(...)`.
- **Uniform packing (perf)**: several renderers reuse small scratch typed arrays for uniform packing to avoid per-frame allocations; see [`createLineRenderer.ts`](../src/renderers/createLineRenderer.ts), [`createAreaRenderer.ts`](../src/renderers/createAreaRenderer.ts), [`createScatterRenderer.ts`](../src/renderers/createScatterRenderer.ts), and [`createPieRenderer.ts`](../src/renderers/createPieRenderer.ts).

#### Line renderer (internal / contributor notes)

A minimal line-strip renderer factory lives in [`createLineRenderer.ts`](../src/renderers/createLineRenderer.ts). It’s intended as a reference implementation for renderer structure (pipeline setup, uniforms, and draw calls) and is not part of the public API exports.

- **`createLineRenderer(device: GPUDevice): LineRenderer`**
- **`createLineRenderer(device: GPUDevice, options?: LineRendererOptions): LineRenderer`**
- **`LineRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so per-series `lineStyle.opacity` composites as expected over an opaque cleared background.
- **`LineRenderer.prepare(seriesConfig: ResolvedLineSeriesConfig, dataBuffer: GPUBuffer, xScale: LinearScale, yScale: LinearScale): void`**: updates per-series uniforms and binds the current vertex buffer
- **`LineRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`LineRenderer.dispose(): void`**

Shader sources: [`line.wgsl`](../src/shaders/line.wgsl) and [`area.wgsl`](../src/shaders/area.wgsl) (triangle-strip filled area under a line).

Bar renderer implementation: [`createBarRenderer.ts`](../src/renderers/createBarRenderer.ts). Shader source: [`bar.wgsl`](../src/shaders/bar.wgsl) (instanced rectangle expansion; per-instance `vec4<f32>(x, y, width, height)`; intended draw call uses 6 vertices per instance for 2 triangles).

Pie slice shader source: [`pie.wgsl`](../src/shaders/pie.wgsl) (instanced quad + SDF mask for pie/donut slices; wired via [`createPieRenderer.ts`](../src/renderers/createPieRenderer.ts) and orchestrated by [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts)).

#### Scatter renderer (internal / contributor notes)

An instanced scatter circle renderer factory lives in [`createScatterRenderer.ts`](../src/renderers/createScatterRenderer.ts). It uses [`scatter.wgsl`](../src/shaders/scatter.wgsl) to expand a point instance into a quad in the vertex stage and render an anti-aliased circle in the fragment stage.

- **`createScatterRenderer(device: GPUDevice, options?: ScatterRendererOptions): ScatterRenderer`**
- **`ScatterRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`ScatterRenderer.prepare(seriesConfig, data, xScale, yScale, gridArea?)`**:
  - **Scale contract**: `xScale` / `yScale` are expected to output **clip space** (as produced by the render coordinator).
  - **Viewport uniform (`viewportPx`)**: when `gridArea` is provided, the renderer writes `viewportPx = vec2<f32>(gridArea.canvasWidth, gridArea.canvasHeight)` (device pixels). The shader uses this to convert `radiusPx` into a clip-space offset.
  - **Size semantics (important)**:
    - Per-point `size` (tuple third value or object `size`) takes precedence when present and finite.
    - Otherwise, `series.symbolSize` is used (number or function) as a fallback.
    - Sizes are interpreted as a **radius in CSS pixels** and are multiplied by `window.devicePixelRatio` before being written as `radiusPx` (device pixels) for the shader.
  - **Clipping**: when `gridArea` is provided, the renderer applies a plot-area scissor rect (device pixels) for the draw and resets scissor afterward.
- **Current symbol**: the WGSL implementation renders circles; `ScatterSeriesConfig.symbol` is currently not used by the renderer.

- **Area strip vertex convention (essential)**: `area.wgsl` expects CPU-expanded vertices as `p0,p0,p1,p1,...` (triangle-strip), using `@builtin(vertex_index)` parity to choose between the original y and a uniform `baseline`.
- **Area uniforms (essential)**: vertex uniform includes `transform` and `baseline`; fragment uniform includes solid `color: vec4<f32>`.

#### Area renderer (internal / contributor notes)

A minimal filled-area renderer factory lives in [`createAreaRenderer.ts`](../src/renderers/createAreaRenderer.ts). It renders a triangle-strip fill under a series using [`area.wgsl`](../src/shaders/area.wgsl) and is exercised by the filled line-series configuration (`areaStyle`) in [`examples/basic-line/main.ts`](../examples/basic-line/main.ts).

- **`createAreaRenderer(device: GPUDevice): AreaRenderer`**
- **`createAreaRenderer(device: GPUDevice, options?: AreaRendererOptions): AreaRenderer`**
- **`AreaRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **Alpha blending**: the pipeline enables standard alpha blending so `areaStyle.opacity` composites as expected over an opaque cleared background.
- **`AreaRenderer.prepare(seriesConfig: ResolvedAreaSeriesConfig, data: ResolvedAreaSeriesConfig['data'], xScale: LinearScale, yScale: LinearScale, baseline?: number): void`**: uploads an expanded triangle-strip vertex buffer (`p0,p0,p1,p1,...`) and updates uniforms (transform + baseline + RGBA color)
- **`AreaRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`AreaRenderer.dispose(): void`**

#### Grid renderer (internal / contributor notes)

A minimal grid-line renderer factory lives in [`createGridRenderer.ts`](../src/renderers/createGridRenderer.ts). It renders horizontal/vertical grid lines directly in clip space and is exercised by the interactive example in [`examples/grid-test/main.ts`](../examples/grid-test/main.ts). Shader source: [`grid.wgsl`](../src/shaders/grid.wgsl).

The factory supports `createGridRenderer(device, options?)` where `options.targetFormat?: GPUTextureFormat` must match the canvas context format used for the render pass color attachment (usually `GPUContextState.preferredFormat`) to avoid a WebGPU validation error caused by a pipeline/attachment format mismatch.

Grid line color is supplied from the resolved theme (`theme.gridLineColor`) by the render coordinator and passed via `prepare(gridArea, { color })`. See [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts) and [`createGridRenderer.ts`](../src/renderers/createGridRenderer.ts).

#### Axis renderer (internal / contributor notes)

A minimal axis (baseline + ticks) renderer factory lives in [`createAxisRenderer.ts`](../src/renderers/createAxisRenderer.ts). It is currently internal (not part of the public API exports) and is exercised by [`examples/grid-test/main.ts`](../examples/grid-test/main.ts).

- **`createAxisRenderer(device: GPUDevice, options?: AxisRendererOptions): AxisRenderer`**
- **`AxisRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`AxisRenderer.prepare(axisConfig: AxisConfig, scale: LinearScale, orientation: 'x' | 'y', gridArea: GridArea, axisLineColor?: string, axisTickColor?: string): void`**
  - **`orientation`**: `'x'` renders the baseline along the bottom edge of the plot area (ticks extend outward/down); `'y'` renders along the left edge (ticks extend outward/left).
  - **Ticks**: placed at regular intervals across the axis domain.
  - **Tick labels**: numeric tick value labels are rendered for each tick mark (label count matches tick count). The current tick count is fixed at 5; see [`createAxisRenderer.ts`](../src/renderers/createAxisRenderer.ts) and [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
  - **Tick length**: `AxisConfig.tickLength` is in CSS pixels (default: 6).
  - **Baseline vs ticks**: the baseline and tick segments can be styled with separate colors (`axisLineColor` vs `axisTickColor`).

#### Crosshair renderer (internal / contributor notes)

A crosshair overlay renderer factory lives in [`createCrosshairRenderer.ts`](../src/renderers/createCrosshairRenderer.ts). It is currently internal (not exported from the public entrypoint `src/index.ts`).

- **`createCrosshairRenderer(device: GPUDevice, options?: CrosshairRendererOptions): CrosshairRenderer`**
- **`CrosshairRendererOptions.targetFormat?: GPUTextureFormat`**: must match the render pass color attachment format (typically `GPUContextState.preferredFormat`). Defaults to `'bgra8unorm'` for backward compatibility.
- **`CrosshairRenderer.prepare(x: number, y: number, gridArea: GridArea, options: CrosshairRenderOptions): void`**
  - **Coordinate contract (critical)**:
    - `x` / `y` are **canvas-local CSS pixels** (e.g. pointer coordinates produced by [`createEventManager.ts`](../src/interaction/createEventManager.ts)).
    - `gridArea` margins (`left/right/top/bottom`) are **CSS pixels**, while `gridArea.canvasWidth` / `gridArea.canvasHeight` are **device pixels**.
  - **Clipping**: the renderer computes a scissor rect for the plot area (in device pixels) and clips the crosshair to it; `render(...)` resets scissor to the full canvas after drawing.
  - **Line width (best-effort)**: `options.lineWidth` is in CSS pixels; thickness is approximated by drawing multiple parallel 1px lines in device-pixel offsets (clamped to a small deterministic maximum).
  - **Dash fallback**: segments are CPU-generated into a `line-list` vertex buffer to approximate a dashed line; if segmentation would exceed a hard vertex cap, it falls back to a single solid segment per enabled axis.
- **`CrosshairRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`CrosshairRenderer.setVisible(visible: boolean): void`**: toggles visibility without destroying GPU resources.
- **`CrosshairRenderer.dispose(): void`**: destroys internal buffers (best-effort).

- **`CrosshairRenderOptions`**: `{ showX: boolean, showY: boolean, color: string, lineWidth: number }`

Shader source: [`crosshair.wgsl`](../src/shaders/crosshair.wgsl) (`line-list` pipeline; fragment outputs a uniform RGBA color with alpha blending enabled).

#### Highlight renderer (internal / contributor notes)

A point highlight overlay renderer factory lives in [`createHighlightRenderer.ts`](../src/renderers/createHighlightRenderer.ts). It is currently internal (not exported from the public entrypoint `src/index.ts`).

- **Factory**: `createHighlightRenderer(device: GPUDevice, options?: HighlightRendererOptions): HighlightRenderer`
- **`HighlightRenderer.prepare(point: HighlightPoint, color: string, size: number): void`**: prepares a ring highlight for a single point.
  - **Coordinate contract (high-level)**: `HighlightPoint.centerDeviceX/centerDeviceY` are **device pixels** (same coordinate space as fragment `@builtin(position)`), `HighlightPoint.scissor` is a **device-pixel scissor rect** for the plot area, and `size` is specified in **CSS pixels** (scaled by DPR internally).
- **`HighlightRenderer.render(passEncoder: GPURenderPassEncoder): void`**
- **`HighlightRenderer.setVisible(visible: boolean): void`**
- **`HighlightRenderer.dispose(): void`**

Shader source: [`highlight.wgsl`](../src/shaders/highlight.wgsl) (fullscreen triangle; fragment draws a soft-edged ring around the prepared center position with alpha blending enabled).

Hover highlight behavior is orchestrated by the render coordinator in [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts): when the pointer is inside the plot grid, it finds the nearest data point (via [`findNearestPoint.ts`](../src/interaction/findNearestPoint.ts)) and prepares the highlight ring at that point, clipped to the plot rect; otherwise the highlight is hidden.

**WGSL imports:** renderers may import WGSL as a raw string via Vite’s `?raw` query (e.g. `*.wgsl?raw`). TypeScript support for this pattern is provided by [`wgsl-raw.d.ts`](../src/wgsl-raw.d.ts).

Notes:

- **Scatter point symbol shader**: [`scatter.wgsl`](../src/shaders/scatter.wgsl) expands instanced points into quads in the vertex stage and draws anti-aliased circles in the fragment stage using an SDF + `smoothstep`. It expects per-instance `center` + `radiusPx`, plus uniforms for `transform`, `viewportPx`, and `color` (see the shader source).
- **Example shader compilation smoke-check**: the hello-world example imports `line.wgsl`, `area.wgsl`, `scatter.wgsl`, and `pie.wgsl` via `?raw` and (when supported) uses `GPUShaderModule.getCompilationInfo()` to fail fast on shader compilation errors. See [`examples/hello-world/main.ts`](../examples/hello-world/main.ts).
- **Render target format**: a renderer pipeline’s target format must match the render pass color attachment format (otherwise WebGPU raises a pipeline/attachment format mismatch validation error). `createAxisRenderer`, `createGridRenderer`, and `createLineRenderer` each accept `options.targetFormat` (typically `GPUContextState.preferredFormat`) and default to `'bgra8unorm'` for backward compatibility.
- **Scale output space**: `prepare(...)` treats scales as affine and uses `scale(...)` samples to build a clip-space transform. Scales that output pixels (or non-linear scales) will require a different transform strategy.
- **Line width and alpha**: line primitives are effectively 1px-class across implementations; wide lines require triangle-based extrusion. `createLineRenderer` enables standard alpha blending so `lineStyle.opacity` composites as expected.

**Caveats (important):**

- **4-byte write rule**: `queue.writeBuffer(...)` requires byte offsets and write sizes to be multiples of 4. `writeUniformBuffer(...)` enforces this (throws if misaligned).
- **Uniform sizing/alignment**: WGSL uniform layout is typically 16-byte aligned; `createUniformBuffer(...)` defaults to 16-byte size alignment (you can override via `options.alignment`).
- **Dynamic offsets**: if you bind uniform buffers with *dynamic offsets*, you must additionally align *offsets* to `device.limits.minUniformBufferOffsetAlignment` (commonly 256). These helpers do not enforce dynamic-offset alignment.

## Related Resources

- [WebGPU Specification](https://www.w3.org/TR/webgpu/)
- [WebGPU Samples](https://webgpu.github.io/webgpu-samples/)
- [MDN WebGPU Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
