# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Horizontal scroll panning** - Touchpad users can now pan the chart view by scrolling left/right. The zoom handler now detects horizontal scroll dominance and performs pan operations accordingly.

### Changed
- **Render-on-demand performance** - Charts no longer re-render continuously at 60fps when idle. Rendering now only occurs when `requestRender()` is called (triggered automatically by chart interactions and data changes), significantly reducing CPU and GPU usage to near 0% when idle. The Million Points example now includes a "Benchmark mode" toggle to switch between continuous rendering (for performance measurement) and render-on-demand (for idle efficiency).

### Deprecated

### Removed

### Fixed
- **Scissor rect clipping during zoom** - Fixed visual bug where chart data extended past axis boundaries during zoom interactions. Scissor rects are now applied consistently to line and area renderers during all rendering operations, not just intro animations.

### Security

## [0.1.0] - YYYY-MM-DD

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

[Unreleased]: https://github.com/hunterg325/ChartGPU/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hunterg325/ChartGPU/releases/tag/v0.1.0
