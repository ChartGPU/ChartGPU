# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Multi-axis Y-scaling** - Introduced robust support for multiple independent Y-axes via `yAxes` configuration array. Allows rendering multiple datasets with distinct numerical ranges (e.g., Price vs Volume) on the same chart, mapped via `yAxisIndex` on the series configuration. Features independent tick generation, dynamic right-left layouts via `position: "right"`, and precise hit-testing alignments.
- **Shared GPUDevice support** - Multiple `ChartGPU` instances can share a single, pre-initialized `GPUDevice` (via injected `adapter` + `device`) to reduce redundant initialization and improve dashboard ergonomics.
- **`deviceLost` event (shared device mode)** - When using an injected/shared device, charts emit a `deviceLost` event so apps can recreate chart instances without ChartGPU destroying the shared device.
- **Shared Pipeline Cache** - Opt-in `createPipelineCache(device)` deduplicates `GPUShaderModule`, `GPURenderPipeline`, and `GPUComputePipeline` across charts on the same device, reducing shader compilation overhead in multi-chart dashboards.
- **External Render Mode** - Application-driven render scheduling via `setRenderMode('external')`, `renderFrame()`, and `needsRender()` for multi-chart dashboards coordinating their own `requestAnimationFrame` loop.
- **`dataAppend` event** - Charts emit a `'dataAppend'` event when data is appended via `appendData()` for real-time data tracking and dashboard coordination.
- **4x MSAA rendering** - Render coordinator now uses 3-pass MSAA strategy (main scene @ 4x MSAA → blit → overlay @ 1x) for improved visual quality.
- **Multi-Chart Dashboard Cookbook** - Added comprehensive guide at `docs/guides/multichart-dashboard-cookbook.md` covering shared device, pipeline cache, external render mode, and chart synchronization patterns.
- **Streaming Dashboard example** - Added 5-chart APM-style dashboard with correlated metric streaming, programmatic annotations, dark theme support, and shared device + pipeline cache.
- **Acceptance: auto-scroll + zoom sync** - Added an acceptance example that covers auto-scroll behavior with zoom synchronization.
- **GPUContext shared-device tests** - Added tests covering injection/ownership semantics, conditional device destruction behavior, and validation in shared device mode.

### Changed
- **Chart creation context injection** - `ChartGPU.create(...)` supports injecting a device/adapter context for shared device mode while preserving existing initialization behavior.
- **Zoom range change events** - Enhanced zoom range change event behavior for better multi-chart synchronization.

## [0.2.5] - 2026-02-10

### Changed
- **Cartesian interpolation and data handling** - Refactored Cartesian data handling and improved interpolation logic.
- **Packaging and docs polish** - Added `.npmignore`, fixed repository links, and refined README content.

## [0.2.4] - 2026-02-09

### Added
- **Cartesian Data Formats example** - Added an example and documentation for additional Cartesian data formats.

### Changed
- **Typed-array streaming docs** - Improved docs around typed-array support in streaming updates (`appendData(...)`).
- **Chart sync docs & behavior** - Enhanced documentation and functionality for chart synchronization.
- **Worker mode removal cleanup** - Removed worker mode support and streamlined related rendering documentation.
- **Docs & examples refresh** - Updated benchmark results, images, and example data generation for consistency.

## [0.2.3] - 2026-02-06

### Added
- **Tooltips** - Added tooltip support.
- **CI** - Added GitHub Actions workflow for automated testing.
- **Coordinator utility modules + tests** - Introduced modular helper utilities (zoom/interaction/animation/tooltip/legend/axis/annotations) with tests.
- **GPU texture manager + tests** - Added a GPU texture manager implementation with tests.

### Changed
- **Render coordinator modularization** - Continued refactoring to a modular internal architecture for maintainability.

## [0.2.2] - 2026-02-04

### Added
- **Annotation authoring example** - Added an annotations example and improved annotation authoring UX.
- **Annotation color picker visual indicator** - The color picker now displays a clear selected-state indicator.

### Changed
- **GPUContext portability** - Refactored `GPUContext` to remove `OffscreenCanvas` support.
- **Annotation authoring example improvements** - Improved bell curve data generation and added explicit Y-axis bounds.

### Removed
- **Annotation authoring toolbar** - Removed undo/redo/export JSON toolbar buttons to streamline the UI.

### Fixed
- **Hover interaction with hidden series** - Fixed series-index misalignment affecting hit testing when series visibility changes.
- **Single visible pie slice rendering** - Fixed the edge case where a single visible pie slice rendered incorrectly.
- **Bar chart series visibility** - Fixed legend toggling not actually hiding bar series.
- **Animation retriggering on legend toggle** - Reset intro animation state when toggling visibility after the initial animation completes.
- **Animation interruption during legend toggle** - Avoided interrupting in-progress animations on visibility-only changes.
- **Legend toggle render delay** - Ensured an initial render occurs when starting update animations so legend toggles apply immediately.
- **Scissor rect clipping during zoom** - Applied scissor rect clipping consistently (not just during intro animations).
- **Annotation color picker selection** - Fixed selection indicator logic by using reliable data attributes.

## [0.2.1] - 2026-02-02

### Added
- **Interactive annotation authoring** - Added interactive annotation authoring features and improved the authoring UI.

## [0.2.0] - 2026-02-01

### Added
- **Ultimate Benchmark example** - Added an “Ultimate Benchmark” example and documentation.

### Changed
- **Worker mode removal** - Refactored and removed worker mode support.
- **Interaction + annotation authoring improvements** - Enhanced hit-testing and authoring ergonomics.

## [0.1.10] - 2026-02-01

> Note: This release is tagged as `v0.10`.

### Added
- **Annotations support and examples** - Added annotation support and examples, and updated README highlights.

### Changed
- **Y-axis auto-bounds behavior/performance** - Improved y-axis auto-bounds behavior and performance.
- **Time-axis precision/stability** - Improved time-axis precision and rendering stability.
- **Annotation rendering performance** - Improved annotation rendering performance.

## [0.1.9] - 2026-01-28

### Added
- **Scatter density / heatmap mode** - Added density/heatmap mode for scatter series, plus an example and README documentation.

## [0.1.8] - 2026-01-28

### Changed
- **Device pixel ratio handling** - Improved device pixel ratio handling and updated documentation.

## [0.1.7] - 2026-01-28

### Added
- **Horizontal scroll panning** - Touchpad users can pan the chart view by scrolling left/right (horizontal-scroll dominance detection).

### Changed
- **Data zoom slider improvements** - Improved slider handling, sizing/reservation behavior, and documentation.

### Fixed
- **Grouped bar layout** - Fixed grouped/clustered bar rendering so bars stay clipped and don’t overlap within a category.
- **Worker ResizeObserver behavior** - Fixed worker thread `ResizeObserver` sizing logic.

## [0.1.6] - 2026-01-21

### Changed
- **Candlestick streaming example** - Improved candlestick streaming configuration and documentation.
- **Docs restructuring** - Refined documentation structure and internal guides.

## [0.1.5] - 2026-01-21

### Changed
- **Render-on-demand performance** - Charts no longer re-render continuously at 60fps when idle; rendering occurs on demand via `requestRender()` and coalesces multiple calls.
- **Frame scheduling improvements** - Introduced improved frame scheduling (including delta-time capping) to prevent jumps after idle.
- **Benchmark mode** - Added benchmark mode toggle to the million-points example.

## [0.1.4] - 2026-01-21

### Changed
- **Zoom/pan sampling performance** - Implemented caching for sampled data and introduced a buffer zone to reduce resampling frequency while maintaining correctness.

## [0.1.3] - 2026-01-21

### Changed
- **Rendering and interaction logic** - General improvements to rendering and interaction behavior.

## [0.1.2] - 2026-01-21

### Added
- **Examples navigation** - Added a GitHub link to the examples page.

## [0.1.1] - 2026-01-20

### Added
- **Candlestick series (OHLC)** - Added candlestick series support, OHLC data handling, time-axis improvements, and tooltip support for candlesticks.

## [0.1.0] - 2026-01-20

Initial release of ChartGPU - a GPU-accelerated charting library built with WebGPU for high-performance data visualization in the browser.

### Added

#### Chart Types
- **Line charts** - GPU-accelerated line rendering with customizable styles
- **Area charts** - Filled area visualization with opacity control
- **Bar charts** - Clustered and stacked bar charts with flexible grouping
- **Scatter plots** - Point-based visualization for large datasets
- **Pie and donut charts** - Circular charts with configurable inner radius

#### Interactivity
- **Hover highlighting** - Visual feedback with highlight ring on data point hover
- **Tooltip system** - Configurable tooltips with item and axis trigger modes, custom formatters, and HTML content support (use with caution for XSS safety)
- **Crosshair** - Visual guides following cursor position
- **Event system** - Chart events including `click`, `mouseover`, `mouseout`, and `crosshairMove`
- **Hit testing** - Accurate point detection for cartesian charts (nearest point), bar charts (bounding box), and pie charts (slice detection)
- **Multi-chart synchronization** - Coordinate interactions across multiple charts using `connectCharts(...)`

#### Data Handling
- **Streaming updates** - Append new data points dynamically via `appendData(...)` for cartesian charts
- **Auto-scroll** - Automatic viewport adjustment for streaming data scenarios
- **Data sampling** - Built-in algorithms (LTTB, average, max, min, none) with zoom-aware resampling and debounce optimization
- **Large dataset support** - Examples demonstrate rendering up to 5 million candlesticks at over 100 FPS

#### Zoom & Navigation
- **X-axis data zoom** - Interactive zoom with inside gestures including wheel zoom and pan
- **Data zoom slider** - Optional UI component for zoom range selection

#### Visual Customization
- **Animation system** - Smooth initial intro animations and data update transitions with configurable easing options
- **Theme support** - Built-in dark and light themes plus custom theme creation
- **Automatic legend** - Dynamic legend generation displaying series names and colors
- **Axis and grid rendering** - GPU-rendered axes and grid with DOM text overlay for labels

#### Core Features
- **WebGPU-powered rendering** - Hardware-accelerated graphics for optimal performance
- **TypeScript support** - Full type definitions and TypeScript-first development
- **Functional API** - Immutable state management with pure functions
- **Comprehensive examples** - Working examples for all chart types and features

### Requirements

**WebGPU Browser Support:**
- Chrome/Chromium 113 or later
- Microsoft Edge 113 or later
- Safari 18 or later
- Firefox: Not yet supported

WebGPU is required to run ChartGPU. Ensure your browser supports WebGPU before using this library.

[Unreleased]: https://github.com/chartgpu/chartgpu/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/chartgpu/chartgpu/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/chartgpu/chartgpu/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/chartgpu/chartgpu/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/chartgpu/chartgpu/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/chartgpu/chartgpu/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/chartgpu/chartgpu/compare/v0.10...v0.2.0
[0.1.10]: https://github.com/chartgpu/chartgpu/compare/v0.1.9...v0.10
[0.1.9]: https://github.com/chartgpu/chartgpu/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/chartgpu/chartgpu/compare/0.1.7...v0.1.8
[0.1.7]: https://github.com/chartgpu/chartgpu/compare/v0.1.6...0.1.7
[0.1.6]: https://github.com/chartgpu/chartgpu/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/chartgpu/chartgpu/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/chartgpu/chartgpu/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/chartgpu/chartgpu/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/chartgpu/chartgpu/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/chartgpu/chartgpu/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/chartgpu/chartgpu/releases/tag/v0.1.0
