# API Reference

Public API surface for ChartGPU.

## Chart creation

### `createChart(container, options)`

Creates a chart instance bound to a container element.

**Signature**

```ts
createChart(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>
```

**Notes**

- `createChart(...)` is the preferred functional API.
- `ChartGPU.create(...)` is an equivalent alias (backward compatibility).

**Example (basic line)**

```ts
import { createChart } from 'chartgpu';

const container = document.getElementById('chart')!;
const chart = await createChart(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

See [`examples/basic-line/`](../examples/basic-line/) for a complete runnable example.

### `ChartGPU.create(container, options)`

Alias for `createChart(container, options)`.

```ts
ChartGPU.create(container: HTMLElement, options: ChartGPUOptions): Promise<ChartGPUInstance>
```

## Chart instance

`ChartGPUInstance` is returned by `createChart(...)` / `ChartGPU.create(...)`.

See [`src/ChartGPU.ts`](../src/ChartGPU.ts) for the full interface and lifecycle behavior.

### Properties

- **`options: Readonly<ChartGPUOptions>`**: last user-provided options object (unresolved).
- **`disposed: boolean`**

### Methods

#### `setOption(options)`

Replaces current user options, resolves them against defaults, updates internal state, and schedules a render (coalesced).

```ts
setOption(options: ChartGPUOptions): void
```

Example (data update with animation):

```ts
chart.setOption({
  animation: { duration: 300, easing: 'cubicOut' },
  series: [{ type: 'line', data: [[0, 2], [1, 1], [2, 4]] }],
});
```

See [`examples/data-update-animation/`](../examples/data-update-animation/).

#### `appendData(seriesIndex, newPoints)`

Appends points to a **cartesian** series at runtime (streaming) and schedules a render (coalesced).

```ts
appendData(seriesIndex: number, newPoints: DataPoint[]): void
```

Notes:

- Pie series (`type: 'pie'`) are not supported by streaming append. Use `setOption(...)` to replace pie data.
- When `ChartGPUOptions.autoScroll === true`, appends may also adjust the x-axis percent zoom window (only when zoom is enabled and `xAxis.min/max` are not set).

Example (streaming):

```ts
chart.appendData(0, [[3, 5], [4, 8]]);
```

See [`examples/live-streaming/`](../examples/live-streaming/).

#### `resize()`

Recomputes canvas backing size from container size; if anything changes, schedules a render.

```ts
resize(): void
```

Example:

```ts
window.addEventListener('resize', () => chart.resize());
```

#### `dispose()`

Cancels pending work, disposes WebGPU resources, and removes the canvas.

```ts
dispose(): void
```

#### `on(eventName, callback)` / `off(eventName, callback)`

Registers/unregisters event listeners.

```ts
on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void
on(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void

off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void
off(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void
```

Supported events:

- `'click'`
- `'mouseover'`
- `'mouseout'`
- `'crosshairMove'`

Example (click + crosshair sync):

```ts
chart.on('click', ({ seriesIndex, dataIndex, value }) => {
  console.log({ seriesIndex, dataIndex, value });
});

chart.on('crosshairMove', ({ x }) => {
  console.log('interaction x:', x);
});
```

See [`examples/interactive/`](../examples/interactive/).

## `connectCharts(charts)`

Connects multiple charts so interaction-x updates in one chart drive crosshair/tooltip x in the other charts. Returns `disconnect()`.

```ts
connectCharts(charts: ChartGPU[]): () => void
```

Example:

```ts
import { connectCharts, createChart } from 'chartgpu';

const a = await createChart(containerA, optionsA);
const b = await createChart(containerB, optionsB);

const disconnect = connectCharts([a, b]);
// later:
disconnect();
```

See [`examples/chart-sync/`](../examples/chart-sync/) and [`src/interaction/createChartSync.ts`](../src/interaction/createChartSync.ts).

## Configuration

Type definitions live in [`src/config/types.ts`](../src/config/types.ts). Defaults live in [`src/config/defaults.ts`](../src/config/defaults.ts) and runtime resolution in [`src/config/OptionResolver.ts`](../src/config/OptionResolver.ts).

### `ChartGPUOptions`

```ts
export interface ChartGPUOptions {
  readonly grid?: GridConfig;
  readonly xAxis?: AxisConfig;
  readonly yAxis?: AxisConfig;
  readonly dataZoom?: ReadonlyArray<DataZoomConfig>;
  readonly series?: ReadonlyArray<SeriesConfig>;
  readonly autoScroll?: boolean;
  readonly theme?: 'dark' | 'light' | ThemeConfig;
  readonly palette?: ReadonlyArray<string>;
  readonly tooltip?: TooltipConfig;
  readonly animation?: AnimationConfig | boolean;
}
```

**Defaults (when omitted)**

- **`grid`**: `{ left: 60, right: 20, top: 40, bottom: 40 }`
- **`xAxis`**: `{ type: 'value' }`
- **`yAxis`**: `{ type: 'value' }`
- **`series`**: `[]`
- **`autoScroll`**: `false`
- **`theme`**: `'dark'` (resolved to [`darkTheme`](../src/themes/darkTheme.ts))
- **`palette`**: the default palette from [`src/config/defaults.ts`](../src/config/defaults.ts) (also used to override `theme.colorPalette` when provided)
- **`animation`**: `true` (enabled)
- **`tooltip.show`**: enabled by default unless you set `tooltip: { show: false }`
- **`dataZoom`**: disabled unless you provide a `dataZoom` entry

Example (custom theme + palette override):

```ts
import { createChart } from 'chartgpu';

await createChart(container, {
  theme: 'light',
  palette: ['#ff6b6b', '#4ecdc4', '#45b7d1'],
  series: [{ type: 'line', data: [[0, 1], [1, 2]] }],
});
```

### `SeriesConfig` (line / area / bar / scatter / pie)

```ts
export type SeriesConfig =
  | LineSeriesConfig
  | AreaSeriesConfig
  | BarSeriesConfig
  | ScatterSeriesConfig
  | PieSeriesConfig;
```

#### Shared fields (cartesian series)

For `type: 'line' | 'area' | 'bar' | 'scatter'`:

- **`name?: string`**
- **`data: ReadonlyArray<DataPoint>`**
- **`color?: string`**
- **`sampling?: SeriesSampling`** (default: `'lttb'`)
- **`samplingThreshold?: number`** (default: `5000`)

`DataPoint`:

```ts
export type DataPointTuple = readonly [x: number, y: number, size?: number];
export type DataPoint = DataPointTuple | Readonly<{ x: number; y: number; size?: number }>;
```

#### Line series (`type: 'line'`)

Additional fields:

- **`lineStyle?: LineStyleConfig`** (defaults: `{ width: 2, opacity: 1 }`)
  - **`color?: string`**: line color override (takes precedence over `series.color` and theme palette)
  - **`width?: number`**: line width in pixels
  - **`opacity?: number`**: line opacity (0-1)
- **`areaStyle?: AreaStyleConfig`** (optional fill under the line; default opacity when provided: `0.25`)

**Line series color precedence:**
1. `lineStyle.color` (highest priority)
2. `series.color`
3. `theme.colorPalette[i % palette.length]` (fallback)

Example:

```ts
series: [
  {
    type: 'line',
    name: 'CPU',
    data: [[0, 10], [1, 40], [2, 25]],
    lineStyle: { width: 2, opacity: 1, color: '#ff6b6b' },
    areaStyle: { opacity: 0.15 },
  },
]
```

#### Area series (`type: 'area'`)

Additional fields:

- **`baseline?: number`** (if omitted, defaults to y-axis minimum at render time)
- **`areaStyle?: AreaStyleConfig`** (defaults: `{ opacity: 0.25 }`)

#### Bar series (`type: 'bar'`)

Additional fields:

- **`barWidth?: number | string`** (CSS px or percent string like `'60%'`)
- **`barGap?: number`** (ratio in `[0, 1]`)
- **`barCategoryGap?: number`** (ratio in `[0, 1]`)
- **`stack?: string`**
- **`itemStyle?: BarItemStyleConfig`**

Example:

```ts
series: [
  { type: 'bar', name: 'A', stack: 'total', data: [[0, 10], [1, 20]] },
  { type: 'bar', name: 'B', stack: 'total', data: [[0, 5], [1, 12]] },
]
```

See [`examples/grouped-bar/`](../examples/grouped-bar/).

#### Scatter series (`type: 'scatter'`)

Additional fields:

- **`symbolSize?: number | ((value: ScatterPointTuple) => number)`**
- **`symbol?: ScatterSymbol`** (`'circle' | 'rect' | 'triangle'`)

Example:

```ts
series: [
  {
    type: 'scatter',
    data: [[0, 0, 2], [1, 2, 6], [2, 1, 3]],
    symbolSize: (p) => (p[2] ?? 3) * 2,
  },
]
```

See [`examples/scatter/`](../examples/scatter/).

#### Pie series (`type: 'pie'`)

Pie is non-cartesian.

Fields:

- **`data: ReadonlyArray<PieDataItem>`** (required)
- **`radius?: PieRadius`** (default outer radius is `0.7 * maxRadius`; tuple enables donut)
- **`center?: PieCenter`** (default `['50%', '50%']`)
- **`startAngle?: number`** (degrees; default `90`)
- **`itemStyle?: PieItemStyleConfig`**

Notes:

- Pie series do not support `sampling` / `samplingThreshold` (they’re stripped during option resolution).
- Pie series are not supported by `appendData(...)`.

Example (donut):

```ts
series: [
  {
    type: 'pie',
    radius: ['40%', '70%'],
    data: [
      { name: 'A', value: 10 },
      { name: 'B', value: 20 },
    ],
  },
]
```

See [`examples/pie/`](../examples/pie/).

### `AxisConfig`

```ts
export interface AxisConfig {
  readonly type: AxisType; // 'value' | 'time' | 'category'
  readonly min?: number;
  readonly max?: number;
  readonly tickLength?: number; // CSS px (default: 6)
  readonly name?: string;
}
```

### `ThemeConfig`

Type definition: [`src/themes/types.ts`](../src/themes/types.ts). Built-in presets: [`darkTheme`](../src/themes/darkTheme.ts), [`lightTheme`](../src/themes/lightTheme.ts).

```ts
export interface ThemeConfig {
  readonly backgroundColor: string;
  readonly textColor: string;
  readonly axisLineColor: string;
  readonly axisTickColor: string;
  readonly gridLineColor: string;
  readonly colorPalette: string[];
  readonly fontFamily: string;
  readonly fontSize: number;
}
```

### `TooltipConfig`

```ts
export interface TooltipConfig {
  readonly show?: boolean; // default: true (unless explicitly false)
  readonly trigger?: 'item' | 'axis'; // default: 'item'
  readonly formatter?:
    | ((params: TooltipParams) => string)
    | ((params: ReadonlyArray<TooltipParams>) => string);
}
```

Security note: tooltip content is assigned via `innerHTML`. Only return trusted/sanitized strings.

Example (axis trigger):

```ts
import type { TooltipParams } from 'chartgpu';

tooltip: {
  trigger: 'axis',
  formatter: (items: ReadonlyArray<TooltipParams>) => {
    const rows = items
      .map((p) => `<div>${p.seriesName}: ${p.value[1]}</div>`)
      .join('');
    return `<div>${rows}</div>`;
  },
}
```

See [`examples/interactive/`](../examples/interactive/).

### `AnimationConfig`

`ChartGPUOptions.animation` accepts:

- `false` (disable)
- `true` (enable with defaults)
- `{ duration?, easing?, delay? }`

Defaults when enabled:

- **`duration`**: `300` ms
- **`delay`**: `0` ms
- **`easing`**: `'linear'`

```ts
export interface AnimationConfig {
  readonly duration?: number;
  readonly easing?: 'linear' | 'cubicOut' | 'cubicInOut' | 'bounceOut';
  readonly delay?: number;
}
```

### `DataZoomConfig`

Zoom is enabled when `dataZoom` contains an entry of `type: 'inside'` and/or `type: 'slider'`. A single shared percent-space window `{ start, end }` in `[0, 100]` is used.

Defaults when omitted:

- **`start`**: `0`
- **`end`**: `100`

```ts
export interface DataZoomConfig {
  readonly type: 'inside' | 'slider';
  readonly xAxisIndex?: number;
  readonly start?: number; // percent in [0, 100]
  readonly end?: number;   // percent in [0, 100]
  readonly minSpan?: number;
  readonly maxSpan?: number;
}
```

Example (inside + slider):

```ts
dataZoom: [{ type: 'inside' }, { type: 'slider', start: 20, end: 80 }]
```

See [`examples/sampling/`](../examples/sampling/) and [`examples/live-streaming/`](../examples/live-streaming/).

## Source links

- Public exports: [`src/index.ts`](../src/index.ts)
- Chart implementation: [`src/ChartGPU.ts`](../src/ChartGPU.ts)
- Option types: [`src/config/types.ts`](../src/config/types.ts)
- Defaults: [`src/config/defaults.ts`](../src/config/defaults.ts)
- Option resolution: [`src/config/OptionResolver.ts`](../src/config/OptionResolver.ts)
- Themes: [`src/themes/types.ts`](../src/themes/types.ts)
- Chart sync: [`src/interaction/createChartSync.ts`](../src/interaction/createChartSync.ts)

