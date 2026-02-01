# API Reference

**Note:** The API documentation has been reorganized for better navigation. Please refer to the new modular documentation below.

## Documentation Hub

**➡️ [Complete API Documentation](api/README.md)**

For AI assistants and LLM context: **[LLM Entrypoint](api/llm-context.md)**

## Quick Links

- **[Chart API](api/chart.md)** - Chart creation, instance methods, legend, sync, performance monitoring
- **[Options](api/options.md)** - Series, axes, zoom, tooltip, animation, performance metrics types
- **[Scatter density/heatmap mode](api/options.md#scatterseriesconfig)** - Scatter density rendering (`mode: 'density'`) options and notes; see [`examples/scatter-density-1m/`](../examples/scatter-density-1m/) for a working demo
- **[Themes](api/themes.md)** - Theme configuration and presets
- **[Scales](api/scales.md)** - Linear and category scale utilities
- **[GPU Context](api/gpu-context.md)** - WebGPU context management (functional + class APIs)
- **[RenderScheduler](api/render-scheduler.md)** - Render loop management
- **[Interaction](api/interaction.md)** - Event handling, zoom, and pan APIs
- **[Animation](api/animation.md)** - Animation controller
- **[Internals](api/INTERNALS.md)** - Internal modules (contributors)
- **[Troubleshooting](api/troubleshooting.md)** - Error handling and best practices

## Migration Notes

The monolithic API.md has been split into focused modules for easier navigation:
- Chart creation and instance methods → `api/chart.md`
- Configuration options → `api/options.md`
- Themes → `api/themes.md`
- Scale utilities → `api/scales.md`
- GPU/WebGPU → `api/gpu-context.md` and `api/render-scheduler.md`
- Event handling → `api/interaction.md`
- Animation → `api/animation.md`
- Internal contributor notes → `api/INTERNALS.md`
