# ChartGPU

A GPU-accelerated charting library built with WebGPU for high-performance data visualization in the browser.

## Overview

ChartGPU leverages WebGPU to provide hardware-accelerated rendering for complex charts and data visualizations. Built with TypeScript and following WebGPU best practices, it offers a clean API for creating performant, interactive charts.

## Features

- **WebGPU-Powered**: Hardware-accelerated rendering using modern GPU APIs
- **TypeScript**: Full type safety and excellent IDE support
- **High Performance**: Optimized for rendering large datasets
- **Browser Support**: Works in Chrome 113+, Edge 113+, and Safari 18+

## Installation

Install with `npm install chartgpu`.

## Quick Start

Import `GPUContext` and call `GPUContext.create()` to initialize a GPU context. Access the device through the `device` property. Always call `destroy()` when finished.

See [GPUContext implementation](src/core/GPUContext.ts) for details.

## Chart API (Phase 1)

`ChartGPU.create(container, options)` creates a chart instance bound to a container element.

See [ChartGPU.ts](src/ChartGPU.ts) for the implementation.

Chart instances render on demand. `ChartGPU.create(...)` schedules an initial render on the next `requestAnimationFrame` tick. `instance.setOption(...)` and `instance.resize()` schedule a single on-demand render; multiple calls before the next frame are coalesced.

`setOption(...)` resolves the provided options against defaults via [`resolveOptions`](src/config/OptionResolver.ts) and applies the resolved result to the internal render coordinator. The per-frame work (series data upload, bounds/extents, and clip-space scales) happens inside [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts) during `RenderCoordinator.render()`.

ChartGPU also listens to pointer events on the canvas via an internal event manager to drive an internal crosshair overlay. Pointer movement may schedule on-demand renders (coalesced) so the crosshair stays in sync. This behavior is currently internal and not configurable via `ChartGPUOptions`; see [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts), [`createEventManager.ts`](src/interaction/createEventManager.ts), and [`createCrosshairRenderer.ts`](src/renderers/createCrosshairRenderer.ts).

### Options and defaults

Options are defined by [`ChartGPUOptions`](src/config/types.ts). Baseline defaults live in [`defaultOptions`](src/config/defaults.ts).

- **Themes (types + presets)**: `ThemeConfig`, presets (`darkTheme`, `lightTheme`), and `getTheme(name: ThemeName)` where `ThemeName` is `'dark' | 'light'`. See [`src/themes/types.ts`](src/themes/types.ts), [`src/themes/index.ts`](src/themes/index.ts), [`src/themes/darkTheme.ts`](src/themes/darkTheme.ts), and [`src/themes/lightTheme.ts`](src/themes/lightTheme.ts).
- **Theme resolution in options**: `ChartGPUOptions.theme` accepts `'dark' | 'light'` or a `ThemeConfig`. When resolved via [`resolveOptions`](src/config/OptionResolver.ts), the default theme is `'dark'`, and `resolveOptions({ theme: 'light' })` resolves to the light preset config. See [`ChartGPUOptions`](src/config/types.ts) and [`OptionResolver.ts`](src/config/OptionResolver.ts).
- **Default grid**: `left: 60`, `right: 20`, `top: 40`, `bottom: 40`
- **Palette / series colors**: `ChartGPUOptions.palette` overrides the resolved theme palette (`resolvedOptions.theme.colorPalette`), and default series colors come from `resolvedOptions.theme.colorPalette[i % ...]` when `series[i].color` is missing. Theme also drives background/grid/axis colors during rendering; see [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts).
- **Data points**: `series[i].data` accepts `DataPoint` as either a tuple (`[x, y]`) or an object (`{ x, y }`). See [`types.ts`](src/config/types.ts).
- **Series types**: `SeriesType` is `'line' | 'area' | 'bar' | 'scatter' | 'pie'`, and `series` is a discriminated union (`LineSeriesConfig | AreaSeriesConfig | BarSeriesConfig | ScatterSeriesConfig | PieSeriesConfig`). See [`types.ts`](src/config/types.ts). Note: pie series are currently type support only (not rendered / non-cartesian); see [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts).
  - **Line / area**: area series support `baseline?: number` (defaults to the y-axis minimum when omitted) and `areaStyle?: { opacity?: number }`. Line series can also include `areaStyle?: { opacity?: number }` to render a filled area behind the line (area fills then line strokes). See [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts) and [`examples/basic-line/main.ts`](examples/basic-line/main.ts).
  - **Bar (implemented)**: bar series render as clustered bars per x-category. If multiple bar series share the same **non-empty** `stack` id (`series[i].stack`), they render as stacked segments within the same cluster slot. Layout options include `barWidth` (CSS px or % of category width), `barGap` (ratio gap between bars within a category), and `barCategoryGap` (ratio gap between categories). See [`types.ts`](src/config/types.ts), [`createBarRenderer.ts`](src/renderers/createBarRenderer.ts), [`bar.wgsl`](src/shaders/bar.wgsl), and coordinator wiring in [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts). For an example, see [`examples/grouped-bar/`](examples/grouped-bar/).
- **Tooltip configuration**: `ChartGPUOptions.tooltip?: TooltipConfig` supports `trigger?: 'item' | 'axis'` and `formatter?: (params: TooltipParams | TooltipParams[]) => string`. `TooltipParams` includes `seriesName`, `seriesIndex`, `dataIndex`, `value`, and `color` and is exported from the public entrypoint [`src/index.ts`](src/index.ts). See [`types.ts`](src/config/types.ts) and tooltip rendering behavior in [`createRenderCoordinator.ts`](src/core/createRenderCoordinator.ts) (uses the internal DOM tooltip overlay helper [`createTooltip.ts`](src/components/createTooltip.ts)); see also [`docs/API.md`](docs/API.md).

To resolve user options against defaults, use [`OptionResolver.resolve(...)`](src/config/OptionResolver.ts) (or [`resolveOptions(...)`](src/config/OptionResolver.ts)). This merges user-provided values with defaults and returns resolved options.

## Scales (Pure utilities)

ChartGPU exports small pure scale utilities for mapping domains to numeric ranges: a linear scale (`createLinearScale()`) and a category scale (`createCategoryScale()`). See [`docs/API.md#scales-pure-utilities`](docs/API.md#scales-pure-utilities) and [`src/utils/scales.ts`](src/utils/scales.ts).

## Browser Compatibility

WebGPU is required for ChartGPU to function. Supported browsers:

- **Chrome/Edge**: 113+ (WebGPU enabled by default)
- **Safari**: 18+ (WebGPU enabled by default)
- **Firefox**: Not yet supported (WebGPU support in development)

If WebGPU is not available, `GPUContext.create()` will throw a descriptive error with guidance on enabling WebGPU or using a supported browser.

## API Reference

### GPUContext

The `GPUContext` class manages WebGPU adapter and device initialization.

See [GPUContext.ts](src/core/GPUContext.ts) for the complete implementation.

**Static Methods:**
- `GPUContext.create()` - Creates and initializes a new GPUContext instance. Returns a Promise that resolves to a fully initialized instance. Throws Error if WebGPU is unavailable or initialization fails.

**Properties:**
- `adapter` - Returns the WebGPU adapter instance, or `null` if not initialized
- `device` - Returns the WebGPU device instance, or `null` if not initialized  
- `initialized` - Returns `true` if the context has been initialized, `false` otherwise

**Instance Methods:**
- `initialize()` - Initializes the WebGPU context. Throws Error if WebGPU is unavailable, adapter/device request fails, or context is already initialized
- `getCanvasTexture()` - Gets the current texture from the canvas context
- `clearScreen(r, g, b, a)` - Clears the canvas to a solid color using a WebGPU render pass. Color components must be in the range [0.0, 1.0]
- `destroy()` - Destroys the WebGPU device and cleans up resources

For detailed API documentation, see [API.md](docs/API.md).

## Development

### Prerequisites

- Node.js 18+
- npm or yarn
- A WebGPU-compatible browser

### Building

Run `npm run build` to compile TypeScript and build the library.

### Development Mode

Run `npm run dev` to start the development server. Navigate to `http://localhost:5176/examples/index.html` to view the examples.

## Examples

See the [examples directory](examples/) for complete working examples. The `hello-world` example demonstrates continuous rendering by animating the clear color through the full color spectrum. It also imports [`line.wgsl`](src/shaders/line.wgsl) and [`area.wgsl`](src/shaders/area.wgsl) and (when supported) uses `GPUShaderModule.getCompilationInfo()` as a runtime shader compilation smoke-check; see [hello-world/main.ts](examples/hello-world/main.ts).

See [hello-world/main.ts](examples/hello-world/main.ts) for implementation.

The `grid-test` example demonstrates matching a renderer pipeline’s target format to the configured canvas format (to avoid a WebGPU validation error caused by a pipeline/attachment format mismatch). See [grid-test/main.ts](examples/grid-test/main.ts) and [`createGridRenderer.ts`](src/renderers/createGridRenderer.ts).

The `grouped-bar` example demonstrates clustered + stacked bars (via `series[i].stack`, including negative values) and bar layout options (`barWidth`, `barGap`, `barCategoryGap`). See [grouped-bar/main.ts](examples/grouped-bar/main.ts).

The `interactive` example demonstrates two stacked charts with synced crosshair/tooltip interaction (via `connectCharts(...)`), axis-trigger tooltips showing all series values at the hovered x, a custom tooltip formatter, and click logging. See [interactive/main.ts](examples/interactive/main.ts).

## License

MIT

## Contributing

Contributions are welcome! Please ensure all code follows the project's TypeScript and WebGPU best practices.

### Internal data and buffers

Chart data uploads and per-series GPU vertex buffer caching are handled by an internal `DataStore` created via `createDataStore(device)`. See [`createDataStore.ts`](src/data/createDataStore.ts). This module is intentionally not exported from the public entrypoint (`src/index.ts`).

- **`setSeries(index, data)`**: packs `DataPoint` (tuple `[x, y]` or object `{ x, y }`) into a tightly-packed `Float32Array` (x, y) and reuploads/reallocates only when the data changes
- **`getSeriesBuffer(index)`**: returns the cached GPU vertex buffer for a series (throws if the series hasn’t been set)
- **`dispose()`**: destroys all cached buffers

### Shared renderer utilities (Contributor notes)

For renderer-focused WebGPU helpers (shader modules, render pipelines, uniform buffers), see [`rendererUtils.ts`](src/renderers/rendererUtils.ts) and the “Renderer utilities” section in [`docs/API.md`](docs/API.md#renderer-utilities-contributor-notes).

For a concrete reference renderer, see [`createLineRenderer.ts`](src/renderers/createLineRenderer.ts). This implements a minimal line-strip renderer factory (currently internal and not exported from `src/index.ts`) that:

- consumes a per-series vertex buffer (typically provided by the internal [`createDataStore.ts`](src/data/createDataStore.ts))
- updates per-series uniforms in `prepare(...)` (transform + RGBA color)
- issues a simple `line-strip` draw in `render(...)`

The associated shader lives in [`line.wgsl`](src/shaders/line.wgsl).

For a crosshair overlay renderer reference, see the internal [`createCrosshairRenderer.ts`](src/renderers/createCrosshairRenderer.ts) and its shader [`crosshair.wgsl`](src/shaders/crosshair.wgsl). (This renderer is currently internal and not exported from `src/index.ts`; contributor notes live in [`docs/API.md`](docs/API.md).)

**WGSL imports (Contributor notes):** WGSL is imported as a raw string via Vite’s `?raw` query (e.g. `*.wgsl?raw`). TypeScript support for this pattern is provided by [`wgsl-raw.d.ts`](src/wgsl-raw.d.ts).

Notes for contributors:

- **Render target format**: a renderer pipeline’s target format must match the render pass color attachment format (or WebGPU raises a pipeline/attachment format mismatch validation error). `createLineRenderer` accepts `options.targetFormat` and defaults to `'bgra8unorm'` for backward compatibility.
- **Scale output space**: `prepare(...)` derives a linear transform from `xScale.scale()` / `yScale.scale()` and feeds it directly to the vertex shader’s clip-space output. This assumes your scales map data into clip/NDC-like coordinates (not pixels).
- **Line width and alpha**: `line-strip` is effectively 1px-class across implementations; “thick lines” require triangle-based extrusion. `createLineRenderer` enables standard alpha blending so `lineStyle.opacity` composites as expected.

Key caveats to keep in mind when using these helpers:

- **4-byte write rule**: `queue.writeBuffer(...)` requires offsets and write sizes to be multiples of 4 (enforced by `writeUniformBuffer(...)`).
- **Uniform alignment**: uniform buffer sizes are aligned (defaults to 16 bytes) by `createUniformBuffer(...)`.
- **Dynamic offsets**: when using dynamic offsets, align offsets to `device.limits.minUniformBufferOffsetAlignment` (commonly 256).
