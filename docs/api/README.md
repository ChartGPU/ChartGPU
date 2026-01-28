# ChartGPU API Reference

The API documentation has been split into smaller, task-focused files to reduce context bloat (especially for LLM-assisted development).

## Start here

- If you’re an LLM / agent: start with [`llm-context.md`](./llm-context.md).
- If you’re a human: pick the section that matches what you’re doing:

## Public API

- [Chart API](./chart.md): `ChartGPU.create(...)`, `ChartGPUInstance`, chart sync
- [Options](./options.md): `ChartGPUOptions`, series/axes/tooltip/dataZoom/animation, `defaultOptions`, `resolveOptions(...)` (includes scatter density/heatmap mode via [`ScatterSeriesConfig`](./options.md#scatterseriesconfig); see [`examples/scatter-density-1m/`](../../examples/scatter-density-1m/))
- [Themes](./themes.md): `ThemeConfig`, presets (`dark` / `light`)
- [Scales](./scales.md): `createLinearScale`, `createCategoryScale`

## Low-level APIs

- [GPU context](./gpu-context.md): `GPUContext` functional + class APIs
- [Render scheduler](./render-scheduler.md): `RenderScheduler` render-on-demand loop

## Interaction, animation, workers, internals

- [Interaction](./interaction.md): events, interaction-x, zoom range APIs
- [Animation](./animation.md): animation controller notes (internal)
- [Worker API](./worker.md): `ChartGPUWorkerController`, worker module API, utilities
- [Worker Protocol](./worker-protocol.md): worker thread communication protocol (messages, types, patterns)
- [Internals (contributors)](./INTERNALS.md): internal modules and renderer notes
- [Troubleshooting](./troubleshooting.md): common errors and best practices

