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
- **`'zoomRangeChange'`**: fires when the chart’s percent-space zoom window changes (\([0, 100]\)). This includes inside-zoom gestures, slider updates, programmatic calls to `setZoomRange(...)`, auto-scroll adjustments from streaming with `autoScroll: true`, and updates received via `connectCharts(..., { syncZoom: true })`.

### Event callback payload

For `'click' | 'mouseover' | 'mouseout'`, callbacks receive a `ChartGPUEventPayload` object with:
- `seriesIndex: number | null`: zero-based series index, or `null` if not on a chart item
- `dataIndex: number | null`: zero-based item index within the series (for cartesian series: data point index; for pie series: slice index), or `null` if not on a chart item
- `value: readonly [number, number] | null`: item value tuple.
  - For cartesian series, this is the data point coordinates `[x, y]` (domain units).
  - For pie series, this is `[0, sliceValue]` (pie is non-cartesian; the y-slot contains the numeric slice value). See [`ChartGPU.ts`](../../src/ChartGPU.ts).
- `seriesName: string | null`: series name from `series[i].name` (trimmed), or `null` if not on a chart item or name is empty. Note: for pie slices this is still the series `name` (slice `name` is not included in event payload).
- `event: PointerEvent`: the original browser `PointerEvent` for access to client coordinates, timestamps, etc.

### Series visibility and hit-testing

- When a series is hidden (via `visible: false` or legend toggle), it does **not** participate in hit-testing for hovering, tooltips, or click events.
- Hit-testing functions handle visibility filtering internally and always return correct series indices (relative to the original series array, not filtered arrays).
- This means:
  - Hovering over visible series works correctly regardless of other series being hidden
  - Tooltips display the correct series name and index
  - Click events report the correct series index
  - Multi-series interactions (axis-trigger tooltips, crosshair sync) only include visible series

For `'crosshairMove'`, callbacks receive a `ChartGPUCrosshairMovePayload` object with:
- `x: number | null`: current interaction x in domain units (`null` clears/hides crosshair + tooltip)
- `source?: unknown`: optional token identifying the origin of the update (useful for sync loop prevention; passed through `setInteractionX(...)` / `setCrosshairX(...)` and forwarded by `connectCharts(...)`)

For `'zoomRangeChange'`, callbacks receive a `ChartGPUZoomRangeChangePayload` object with:
- `start: number`: zoom window start in percent space \([0, 100]\)
- `end: number`: zoom window end in percent space \([0, 100]\)
- `sourceKind?: 'user' | 'auto-scroll' | 'api'`: optional string categorizing the origin of the zoom change:
  - `'auto-scroll'`: internal adjustment from streaming data append with `autoScroll: true`
  - `'api'`: programmatic call to `setZoomRange(...)`
  - `'user'`: reserved for future use (user gestures like inside-zoom, slider drag); not currently emitted
  - `undefined`: may occur for internal changes not explicitly categorized (e.g., constraint clamping during `setOptions`); do not assume all changes are tagged
- `source?: unknown`: optional token identifying the origin of the update (useful for sync loop prevention; forwarded by `connectCharts(..., { syncZoom: true })`)

### Behavioral notes

- Click events fire when you have registered a click listener via `on('click', ...)`. For clicks not on a chart item, point-related fields (`seriesIndex`, `dataIndex`, `value`, `seriesName`) are `null`, but `event` always contains the original `PointerEvent`.
- Hover events (`mouseover` / `mouseout`) only fire when at least one hover listener is registered. They fire on transitions: `mouseover` when entering a chart item (or moving between items), `mouseout` when leaving a chart item (or moving between items).
- Crosshair move events (`crosshairMove`) fire on interaction-x changes. When the pointer leaves the plot area, the chart clears interaction-x to `null` so synced charts do not "stick".
- Event payload objects should be treated as **ephemeral** (read values inside the callback; if you need to persist them, copy the primitive fields you care about rather than storing the payload object itself).
- All event listeners are automatically cleaned up when `dispose()` is called. No manual cleanup required.

## Right-click / context menu interactions

ChartGPU does not emit a built-in `'contextmenu'` event. Consumers implement right-click interactions directly using DOM events and `ChartGPUInstance.hitTest(...)`.

- Use the DOM `contextmenu` event on the chart canvas (or container).
- Call `chart.hitTest(e)` (accepts a `MouseEvent`) to get plot coordinates (`gridX` / `gridY`) and an optional `match` for snap-to-data behavior.

Example:

```ts
const canvas = container.querySelector('canvas')!;
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hit = chart.hitTest(e);
  // hit.isInGrid, hit.gridX/hit.gridY (CSS px), and hit.match (optional)
});
```

For a ready-made main-thread helper that wires `contextmenu` + `hitTest(...)` into an annotation authoring UI (with undo/redo + JSON export), see `createAnnotationAuthoring(...)` and [`examples/annotation-authoring/`](../../examples/annotation-authoring/). Full documentation available in the [Annotations API](./annotations.md).

## Zoom and Pan APIs

See [ChartGPUInstance](chart.md#chartgpuinstance) for zoom-related methods:

- `getZoomRange(): { start: number; end: number } | null`
- `setZoomRange(start: number, end: number, source?: unknown): void`

For data zoom configuration, see [Data Zoom Configuration](options.md#data-zoom-configuration).
