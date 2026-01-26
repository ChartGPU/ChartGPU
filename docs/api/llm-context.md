# ChartGPU API Documentation (LLM Entrypoint)

This is a guide for AI assistants working with ChartGPU. Use this document to quickly navigate to the right documentation for your task.

## Quick Navigation by Task

### Working with Charts
- **Creating charts**: [chart.md](chart.md#chartgpucreate)
- **Chart instance methods**: [chart.md](chart.md#chartgpuinstance)
- **Chart events (click, hover, crosshair)**: [interaction.md](interaction.md#event-handling)
- **Chart sync (multi-chart interaction)**: [chart.md](chart.md#chart-sync-interaction)
- **Legend**: [chart.md](chart.md#legend-automatic)

### Configuration
- **Options overview**: [options.md](options.md#chartgpuoptions)
- **Series configuration** (line, area, bar, scatter, pie, candlestick): [options.md](options.md#series-configuration)
- **Axis configuration**: [options.md](options.md#axis-configuration)
- **Data zoom (pan/zoom)**: [options.md](options.md#data-zoom-configuration)
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
- **GPU buffer streaming**: [INTERNALS.md](INTERNALS.md#gpu-buffer-streaming-internal--contributor-notes)
- **CPU downsampling (LTTB)**: [INTERNALS.md](INTERNALS.md#cpu-downsampling-internal--contributor-notes)
- **Interaction utilities**: [INTERNALS.md](INTERNALS.md#interaction-utilities-internal--contributor-notes)
- **Renderer utilities**: [INTERNALS.md](INTERNALS.md#renderer-utilities-contributor-notes)

### Troubleshooting
- **Error handling**: [troubleshooting.md](troubleshooting.md#error-handling)
- **Best practices**: [troubleshooting.md](troubleshooting.md#best-practices)
- **Common issues**: [troubleshooting.md](troubleshooting.md#common-issues)

## File Map

| File | Contents |
|------|----------|
| [README.md](README.md) | API documentation navigation hub |
| [chart.md](chart.md) | Chart API (create, instance methods, legend, sync) |
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

## Architecture Overview

ChartGPU follows a **functional-first architecture**:
- **Core rendering**: Functional APIs in `GPUContext`, `RenderScheduler`
- **Chart API**: `ChartGPU.create()` factory pattern
- **Options**: Deep-merge resolution via `resolveOptions()`
- **Renderers**: Internal pipeline-based renderers for each series type
- **Interaction**: Event-driven with render-on-demand scheduling

For detailed architecture notes, see [INTERNALS.md](INTERNALS.md).
