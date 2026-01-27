# Interaction

## Event handling

Chart instances expose `on()` and `off()` methods for subscribing to user interaction events. See [ChartGPU.ts](../../src/ChartGPU.ts) for the implementation.

- **`on(eventName, callback): void`**: registers a callback for the specified event name. Callbacks are stored in a closure and persist until explicitly removed via `off()` or until the instance is disposed.
- **`off(eventName, callback): void`**: removes a previously registered callback. Safe to call even if the callback was never registered or was already removed.

### Supported events

- **`'click'`**: fires on tap/click gestures (mouse left-click, touch tap, pen tap). When you register a click listener via `on('click', ...)`, it fires whenever a click occurs on the canvas, even if not on a chart item. For clicks not on a chart item, the callback receives `seriesIndex: null`, `dataIndex: null`, `value: null`, and `seriesName: null`, but includes the original `PointerEvent` as `event`.
- **`'mouseover'`**: fires when the pointer enters a chart item (or transitions from one chart item to another). Chart items include cartesian hits (points/bars) and pie slices. Only fires when listeners are registered (`on('mouseover', ...)` or `on('mouseout', ...)`).
- **`'mouseout'`**: fires when the pointer leaves a chart item (or transitions from one chart item to another). Chart items include cartesian hits (points/bars) and pie slices. Only fires when listeners are registered (`on('mouseover', ...)` or `on('mouseout', ...)`).
- **`'crosshairMove'`**: fires when the chart's "interaction x" changes (domain units). This includes pointer movement inside the plot area, pointer leaving the plot area (emits `x: null`), programmatic calls to `setInteractionX(...)` / `setCrosshairX(...)`, and updates received via `connectCharts(...)` sync. See [`ChartGPU.ts`](../../src/ChartGPU.ts) and [`createRenderCoordinator.ts`](../../src/core/createRenderCoordinator.ts).

### Event callback payload

For `'click' | 'mouseover' | 'mouseout'`, callbacks receive a `ChartGPUEventPayload` object with:
- `seriesIndex: number | null`: zero-based series index, or `null` if not on a chart item
- `dataIndex: number | null`: zero-based item index within the series (for cartesian series: data point index; for pie series: slice index), or `null` if not on a chart item
- `value: readonly [number, number] | null`: item value tuple.
  - For cartesian series, this is the data point coordinates `[x, y]` (domain units).
  - For pie series, this is `[0, sliceValue]` (pie is non-cartesian; the y-slot contains the numeric slice value). See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `seriesName: string | null`: series name from `series[i].name` (trimmed), or `null` if not on a chart item or name is empty. Note: for pie slices this is still the series `name` (slice `name` is not included in event payload).
- `event: PointerEvent`: the original browser `PointerEvent` for access to client coordinates, timestamps, etc.

For `'crosshairMove'`, callbacks receive a `ChartGPUCrosshairMovePayload` object with:
- `x: number | null`: current interaction x in domain units (`null` clears/hides crosshair + tooltip)
- `source?: unknown`: optional token identifying the origin of the update (useful for sync loop prevention; passed through `setInteractionX(...)` / `setCrosshairX(...)` and forwarded by `connectCharts(...)`)

### Behavioral notes

- Click events fire when you have registered a click listener via `on('click', ...)`. For clicks not on a chart item, point-related fields (`seriesIndex`, `dataIndex`, `value`, `seriesName`) are `null`, but `event` always contains the original `PointerEvent`.
- Hover events (`mouseover` / `mouseout`) only fire when at least one hover listener is registered. They fire on transitions: `mouseover` when entering a chart item (or moving between items), `mouseout` when leaving a chart item (or moving between items).
- Crosshair move events (`crosshairMove`) fire on interaction-x changes. When the pointer leaves the plot area, the chart clears interaction-x to `null` so synced charts do not "stick".
- All event listeners are automatically cleaned up when `dispose()` is called. No manual cleanup required.

## PointerEventData

`PointerEventData` is a high-level pointer event data type for worker thread communication. It pre-computes grid coordinates to eliminate redundant computation when forwarding events to worker threads.

See [types.ts](../../src/config/types.ts) for the full type definition.

### Properties

- **`type`**: `'move' | 'click' | 'leave'` — event type
- **`x`, `y`**: canvas-local CSS pixels
- **`gridX`, `gridY`**: plot-area-local CSS pixels (relative to plot area origin)
- **`plotWidthCss`, `plotHeightCss`**: plot area dimensions in CSS pixels
- **`isInGrid`**: whether the pointer is inside the plot area
- **`timestamp`**: event timestamp in milliseconds for gesture detection

### Use case

`PointerEventData` is designed for worker thread event forwarding. When rendering is offloaded to a worker thread, the main thread can normalize pointer events into this format and post them to the worker, avoiding redundant coordinate transformations.

**Note**: `NormalizedPointerEvent` is deprecated in favor of `PointerEventData` for worker thread communication.

## Zoom and Pan APIs

See [ChartGPUInstance](chart.md#chartgpuinstance) for zoom-related methods:

- `getZoomRange(): { start: number; end: number } | null`
- `setZoomRange(start: number, end: number): void`

For data zoom configuration, see [Data Zoom Configuration](options.md#data-zoom-configuration).

### Zoom Constraints

**Minimum zoom span:** The zoom window span is constrained to a minimum of 0.5% of the data range. This prevents over-zooming beyond what can be reasonably visualized and prevents the slider UI from becoming unusably collapsed. At 0.5% span, a 500px slider track shows a 2.5px window, which with 10px handles is the practical limit for visual distinguishability. Below 0.5% the UI becomes meaningless. Attempts to zoom to smaller spans (via `setZoomRange`, wheel zoom, or slider interaction) will be automatically clamped to this minimum.

**Implementation:** The minimum span is enforced in [`createZoomState`](../../src/interaction/createZoomState.ts) by the `DEFAULT_MIN_SPAN` constant. This constraint applies to both main-thread and worker-thread charts, ensuring consistent zoom behavior across rendering modes.

### Zoom Behavior and Limitations

**Minimum zoom span**: ChartGPU enforces a minimum zoom span of **0.5%** of the data range. This prevents zooming beyond what can be meaningfully visualized and ensures the slider UI remains usable.

- When the minimum span is reached, further zoom-in attempts (via mouse wheel, programmatic `setZoomRange()`, or slider interaction) have no effect
- At 0.5% span, the slider UI remains distinguishable; below this threshold the UI would become unusable
- The minimum span applies to all zoom interactions: inside zoom (mouse wheel/pan), slider UI, and programmatic zoom APIs

For implementation details, see [createZoomState.ts](../../src/interaction/createZoomState.ts). For a working example demonstrating zoom behavior, see [worker-rendering example](../../examples/worker-rendering/).
