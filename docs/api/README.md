# ChartGPU API Reference

**LLM/agent:** start with [llm-context.md](llm-context.md). **Human:** pick a section below.

## Public API

- [Chart API](chart.md) — `ChartGPU.create()`, instance methods, sync, shared device, pipeline cache
- [Options](options.md) — `ChartGPUOptions`, series, axes (incl. candle-primary price axis / `priceLabel`), zoom, tooltip, animation
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
