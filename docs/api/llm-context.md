# ChartGPU API Documentation (LLM Entrypoint)

This is a guide for AI assistants working with ChartGPU. Use this document to quickly navigate to the right documentation for your task.

## Quick Navigation by Task

### Working with Charts
- **Creating charts**: [chart.md](chart.md#chartgpucreate)
- **Chart instance methods**: [chart.md](chart.md#chartgpuinstance)
- **Chart events (click, hover, crosshair)**: [interaction.md](interaction.md#event-handling)
- **Chart sync (multi-chart interaction)**: [chart.md](chart.md#chart-sync-interaction)
- **Pipeline cache (multi-chart startup optimization)**: [chart.md](chart.md#pipeline-cache-cgpu-pipeline-cache)
- **Sync zoom/pan across charts**: `connectCharts(..., { syncZoom: true })` (see [Chart sync](chart.md#chart-sync-interaction) and [Zoom and pan APIs](interaction.md#zoom-and-pan-apis))
- **Legend**: [chart.md](chart.md#legend-automatic)
- **Performance monitoring**: [chart.md](chart.md#performance-monitoring) (FPS, frame time, memory, frame drops)

### Types and Interfaces
- **PointerEventData**: Pre-computed pointer event data for programmatic event forwarding - [src/config/types.ts](../../src/config/types.ts)
- **TooltipData, LegendItem, AxisLabel**: DOM overlay data types - [src/config/types.ts](../../src/config/types.ts)
- **PerformanceMetrics, PerformanceCapabilities**: Performance monitoring types - [options.md](options.md#performance-metrics-types)
- **PipelineCache, PipelineCacheStats**: Shared cache types for shader module, render pipeline, and compute pipeline dedupe - [chart.md](chart.md#pipeline-cache-cgpu-pipeline-cache)

### Configuration
- **Options overview**: [options.md](options.md#chartgpuoptions)
- **Series configuration** (line, area, bar, scatter, pie, candlestick, ohlc, heatmap, band, errorBar, impulse; step on line/area): [options.md](options.md#series-configuration)
- **OHLC bars** (`type: 'ohlc'`, thin stem + open/close ticks; same `OHLCDataPoint` as candlestick): [options.md](options.md#ohlcseriesconfig), [`examples/ohlc-bars/`](../../examples/ohlc-bars/)
- **Scatter density mode** (scatter series `mode: 'density'` — screen-space point-cloud bins, **not** a data-grid heatmap): [src/config/types.ts](../../src/config/types.ts), [src/renderers/createScatterDensityRenderer.ts](../../src/renderers/createScatterDensityRenderer.ts), [`examples/scatter-density-1m/`](../../examples/scatter-density-1m/)
- **Uniform heatmap / spectrogram** (`type: 'heatmap'`): [options.md](options.md#heatmapseriesconfig), streaming via `chart.updateHeatmap` ([heatmapStream.ts](../../src/data/heatmapStream.ts)), [src/renderers/createHeatmapRenderer.ts](../../src/renderers/createHeatmapRenderer.ts), [src/shaders/heatmap.wgsl](../../src/shaders/heatmap.wgsl), [src/utils/heatmapLayout.ts](../../src/utils/heatmapLayout.ts), [src/utils/colormap.ts](../../src/utils/colormap.ts), [`examples/heatmap-spectrogram/`](../../examples/heatmap-spectrogram/)
- **Band / range series** (`type: 'band'`, fill between `y` and `y1`): [options.md](options.md#bandseriesconfig), [src/renderers/createBandRenderer.ts](../../src/renderers/createBandRenderer.ts), [src/shaders/band.wgsl](../../src/shaders/band.wgsl), [src/data/bandData.ts](../../src/data/bandData.ts), [`examples/band-range/`](../../examples/band-range/)
- **Error bars** (`type: 'errorBar'`, HLC whiskers around center; not band fill / not OHLC): [options.md](options.md#errorbarseriesconfig), [src/renderers/createErrorBarRenderer.ts](../../src/renderers/createErrorBarRenderer.ts), [src/shaders/errorBar.wgsl](../../src/shaders/errorBar.wgsl), [src/data/errorBarData.ts](../../src/data/errorBarData.ts), [`examples/error-bars/`](../../examples/error-bars/)
- **Step / digital line + mountain** (`step` on line/area; `true` ≡ `'after'`): [options.md](options.md#lineseriesconfig), [src/data/stepGeometry.ts](../../src/data/stepGeometry.ts), [`examples/step-line/`](../../examples/step-line/)
- **Impulse / stem** (`type: 'impulse'`, baseline→y; not errorBar): [options.md](options.md#impulseseriesconfig), [src/renderers/createImpulseRenderer.ts](../../src/renderers/createImpulseRenderer.ts), [src/data/impulseGeometry.ts](../../src/data/impulseGeometry.ts), [`examples/impulse/`](../../examples/impulse/)
- **Stacked mountain / area** (`stack` on `line`+`areaStyle` or `type: 'area'` — multi-series composition fill; not single-series mountain; not `type: 'band'`): [options.md](options.md#stacked-mountain--area-stack-on-line-mountain-or-area), [src/data/stackedArea.ts](../../src/data/stackedArea.ts), [src/shaders/areaStacked.wgsl](../../src/shaders/areaStacked.wgsl), [`examples/stacked-mountain/`](../../examples/stacked-mountain/)
- **Axis configuration**: [options.md](options.md#axis-configuration)
- **Grid lines configuration**: [options.md](options.md#grid-lines-configuration)
- **Data zoom (pan/zoom)**: [options.md](options.md#data-zoom-configuration)
- **Custom visuals / overlays**: start with [Annotations](annotations.md#custom-visuals-beyond-built-in-annotations) (built-ins + recommended extension paths)
- **Tooltip configuration**: [options.md](options.md#tooltip-configuration)
- **Animation configuration**: [options.md](options.md#animation-configuration)
- **Default options**: [options.md](options.md#default-options)
- **Resolving options**: [options.md](options.md#resolveoptionsuseroptionschartgpuoptions--optionresolverresolveuseroptionschartgpuoptions)

### Themes
- **Theme configuration**: [themes.md](themes.md#themeconfig)
- **Built-in themes** (dark/light): [themes.md](themes.md#theme-presets)

### Utilities
- **Linear scales**: [scales.md](scales.md#createlinearscale-linearscale)
- **Category scales**: [scales.md](scales.md#createcategoryscale-categoryscale)

### Low-Level GPU/WebGPU
- **GPU context** (functional API): [gpu-context.md](gpu-context.md#functional-api-preferred)
- **GPU context** (class API): [gpu-context.md](gpu-context.md#class-based-api-backward-compatibility)
- **Render scheduler**: [render-scheduler.md](render-scheduler.md)

### Interaction
- **Event handling** (click, hover, crosshair): [interaction.md](interaction.md#event-handling)
- **Zoom and pan APIs**: [interaction.md](interaction.md#zoom-and-pan-apis)

### Animation
- **Animation controller**: [animation.md](animation.md#animation-controller-internal)
- **Animation configuration**: [options.md](options.md#animation-configuration)

### Internal/Contributors
- **Internal modules** (data store, renderers, coordinator): [INTERNALS.md](INTERNALS.md)
- **Data pipeline** (data store, uploads, streaming buffers): [INTERNALS.md](INTERNALS.md#data-pipeline-internal)
- **Interaction internals** (event manager, hit-testing): [INTERNALS.md](INTERNALS.md#interaction-internal)
- **Renderer map** (factories + shaders): [INTERNALS.md](INTERNALS.md#renderer-map-internal)

### Troubleshooting
- **Error handling**: [troubleshooting.md](troubleshooting.md#error-handling)
- **Best practices**: [troubleshooting.md](troubleshooting.md#best-practices)
- **Common issues**: [troubleshooting.md](troubleshooting.md#common-issues)

## File Map

| File | Contents |
|------|----------|
| [README.md](README.md) | API documentation navigation hub |
| [chart.md](chart.md) | Chart API (create, instance methods, render mode, sync) |
| [options.md](options.md) | Chart options (series, axes, zoom, tooltip, animation) |
| [themes.md](themes.md) | Theme configuration and presets |
| [scales.md](scales.md) | Linear and category scale utilities |
| [gpu-context.md](gpu-context.md) | GPU context (functional + class APIs) |
| [render-scheduler.md](render-scheduler.md) | Render scheduler (render-on-demand) |
| [interaction.md](interaction.md) | Event handling, zoom, and pan APIs |
| [animation.md](animation.md) | Animation controller |
| [INTERNALS.md](INTERNALS.md) | Internal modules (contributors) |
| [troubleshooting.md](troubleshooting.md) | Error handling and best practices |
| [llm-context.md](llm-context.md) | This file (LLM navigation guide) |

## Common Workflows

### Creating a Basic Chart
1. Start with [chart.md](chart.md#chartgpucreate)
2. Configure options in [options.md](options.md#chartgpuoptions)
3. Set series data in [options.md](options.md#series-configuration)

### Adding Interaction
1. Register event listeners in [interaction.md](interaction.md#event-handling)
2. Configure tooltip in [options.md](options.md#tooltip-configuration)
3. Enable zoom/pan in [options.md](options.md#data-zoom-configuration)

### Theming a Chart
1. Choose a theme preset in [themes.md](themes.md#theme-presets)
2. Or create custom theme in [themes.md](themes.md#themeconfig)

### Working with WebGPU Directly
1. Initialize GPU context in [gpu-context.md](gpu-context.md#functional-api-preferred)
2. Set up render loop in [render-scheduler.md](render-scheduler.md)

## Architecture

Functional-first: `GPUContext`, `RenderScheduler`, `ChartGPU.create()`, `resolveOptions()`. Render coordinator: 11 modules under `src/core/renderCoordinator/`. Diagram: [ARCHITECTURE.md](../../docs/ARCHITECTURE.md). Details: [INTERNALS.md](INTERNALS.md).
