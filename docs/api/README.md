# ChartGPU API Reference

**Hosted:** [https://chartgpu.io/docs/api/](https://chartgpu.io/docs/api/) (preferred for humans). This directory is the source markdown ported to the site.

**LLM/agent:** start with [llm-context.md](llm-context.md). **Human:** pick a section below, or use the hosted hub.

## Public API

- [Chart API](chart.md) — `ChartGPU.create()`, instance methods, sync, shared device, pipeline cache
- [Options](options.md) — `ChartGPUOptions`, series, axes (incl. candle-primary price axis / `priceLabel`), zoom, tooltip, animation
- [3D charts](3d.md) — `coordinateSystem: 'cartesian3d'`, `pointCloud3d` / `surface3d`, camera, pick
- [Annotations](annotations.md) — annotation types, interactive authoring
- [Themes](themes.md) — `ThemeConfig`, presets
- [Scales](scales.md) — `createLinearScale`, `createCategoryScale`

## Low-level

- [GPU context](gpu-context.md) — functional + class APIs
- [Render scheduler](render-scheduler.md) — render-on-demand loop

## Other

- [Interaction](interaction.md) — events, zoom/pan APIs
- [Animation](animation.md) — animation controller (internal)
- [Internals](INTERNALS.md) — contributor notes
- [Troubleshooting](troubleshooting.md) — errors, best practices
