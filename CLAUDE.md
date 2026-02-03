# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ChartGPU is a GPU-accelerated charting library built with WebGPU for high-performance data visualization in the browser. The library is written in TypeScript and provides both functional and class-based APIs.

**Current version**: 0.1.6 (package.json)
**Repository**: https://github.com/chartgpu/chartgpu
**NPM package**: `chartgpu`
**License**: MIT

## Recent Work (Current Branch)

Recent enhancements have focused on interaction and authoring features, performance/ergonomics improvements, and documentation cleanup.

## Development Commands

### Build and Development
- `npm run dev` - Start development server (opens at http://localhost:5176/examples/)
- `npm run build` - Compile TypeScript and build the library (runs `tsc && vite build`)
- `npm run build:examples` - Build examples for production
- `npm run prepublishOnly` - Build the library before publishing (automatically runs on publish)

### Testing and Benchmarking
- `npm run acceptance:animation-controller` - Test animation controller
- `npm run acceptance:sampling-config` - Test sampling configuration
- `npm run acceptance:zoom-state` - Test zoom state management
- `npm run acceptance:lttb-sample` - Test LTTB downsampling
- `npm run acceptance:auto-scroll-policy` - Test auto-scroll behavior
- `npm run acceptance:data-store-append` - Test streaming data append
- `npm run acceptance:easing` - Test animation easing functions
- `npm run acceptance:line-style-color` - Test line style/color resolution
- `npm run acceptance:area-style-color` - Test area style/color resolution
- `npm run acceptance:ohlc-sample` - Test OHLC downsampling
- `npm run benchmark:transfer` - Benchmark data transfer performance

### Browser Requirements
WebGPU support required:
- Chrome/Edge 113+ (WebGPU enabled by default)
- Safari 18+ (WebGPU enabled by default)
- Firefox: not supported (WebGPU support in development)

### React Integration
React bindings available via [`chartgpu-react`](https://github.com/ChartGPU/chartgpu-react):
- `npm install chartgpu-react`
- Provides `<ChartGPUChart>` component with React-friendly API

## Architecture

### Dual API Pattern (Functional + Class-based)

The codebase follows a **functional-first architecture** with class wrappers for backward compatibility:

1. **Functional API (preferred)**: Pure functions operating on immutable state objects
   - Core implementations in: `GPUContext`, `RenderScheduler`
   - State objects are readonly and immutable
   - Functions return new state objects rather than mutating
   - Example: `createGPUContext()`, `initializeGPUContext()`, `destroyGPUContext()`

2. **Class-based API (backward compatibility)**: Thin wrappers around functional implementations
   - Classes internally use functional implementations
   - Maintain backward compatibility with existing code
   - Example: `GPUContext.create()`, `RenderScheduler.start()`

### Key Modules

#### Core Modules

**GPUContext** ([src/core/GPUContext.ts](src/core/GPUContext.ts))
Manages WebGPU adapter and device initialization. Provides both functional API (`createGPUContext`, `initializeGPUContext`) and class-based API (`GPUContext.create()`).

**Key responsibilities:**
- WebGPU adapter/device request and initialization
- Canvas configuration with device pixel ratio handling
- Texture format detection and configuration
- Device lifecycle management and cleanup
- Supports `HTMLCanvasElement`

**RenderScheduler** ([src/core/RenderScheduler.ts](src/core/RenderScheduler.ts))
Manages requestAnimationFrame-based render loop at 60fps with delta time tracking and performance metrics.

**State management pattern:**
- Public readonly state (`RenderSchedulerState`)
- Internal mutable state stored in `Map<symbol, InternalState>`
- Functions return new public state objects
- Internal state tracked separately using unique symbol IDs
- Performance tracking: FPS, frame times, frame drops

**RenderCoordinator** ([src/core/createRenderCoordinator.ts](src/core/createRenderCoordinator.ts))
**Not exported from public API** - orchestrates all rendering operations and manages renderer lifecycle.

**Key responsibilities:**
- Coordinates multiple specialized renderers (line, area, bar, scatter, candlestick, pie)
- Manages zoom state and data transformations
- Handles tooltip and legend updates
- Processes pointer events and interaction state
- Manages animation state and transitions

**AnimationController** ([src/core/createAnimationController.ts](src/core/createAnimationController.ts))
**Not exported from public API** - manages chart animations and transitions.

**Key features:**
- Configurable animation curves (linear, easeInOut, etc.)
- Progress tracking and completion callbacks
- Multiple animation modes (default, startup)

#### Chart API

**ChartGPU** ([src/ChartGPU.ts](src/ChartGPU.ts))
Main chart API - `ChartGPU.create(container, options)` creates chart instances.

**Instance lifecycle:**
- Creates canvas element and appends to container
- Initializes GPUContext
- Manages canvas sizing and configuration
- Handles device loss and disposal
- Supports event system (click, mouseover, mouseout, crosshairMove)
- Performance metrics API (FPS, frame times, drops)

#### Data Management

**DataStore** ([src/data/createDataStore.ts](src/data/createDataStore.ts))
**Not exported from public API** - internal module for GPU buffer management.

**Key features:**
- Per-series vertex buffer caching
- Lazy allocation and reallocation on data changes
- Hash-based change detection (FNV-1a on Float32 bit patterns)
- Buffer reuse when data size fits existing capacity
- Minimum buffer size: 4 bytes (enforced)
- Supports streaming data append operations

**Data Utilities** ([src/data/](src/data/))
- `packDataPoints()` / `packOHLCDataPoints()` - data packing utilities that produce tightly-packed `ArrayBuffer` payloads (useful for efficient uploads and structured interop)
- `lttbSample()` - Largest-Triangle-Three-Buckets downsampling algorithm
- `ohlcSample()` - OHLC-specific downsampling for candlestick charts
- `sampleSeries()` - Unified series sampling coordination
- `createStreamBuffer()` - streaming buffer management for real-time data

**Performance optimizations:**
- Incremental append operations for streaming data (see docs/internal/INCREMENTAL_APPEND_OPTIMIZATION.md)
- Automatic downsampling for large datasets to maintain 60 FPS
- GPU buffer reuse when data size fits existing capacity
- Hash-based change detection to avoid redundant uploads

#### Configuration

**OptionResolver** ([src/config/OptionResolver.ts](src/config/OptionResolver.ts))
Resolves user options against defaults following specific patterns.

**Resolution behavior:**
- Grid defaults: `left: 60, right: 20, top: 40, bottom: 40`
- Palette fallback: user palette → default palette → `['#000000']`
- Series colors: explicit `series[i].color` → `palette[i % palette.length]`
- Line style: per-series `lineStyle` merged with `defaultLineStyle`
- Supports multiple series types: line, area, bar, scatter, candlestick, pie

**Themes** ([src/themes/](src/themes/))
Theme system with dark and light presets.

**Available themes:**
- `darkTheme` - dark mode color scheme
- `lightTheme` - light mode color scheme
- `getTheme(name)` - retrieve theme by name

#### Interaction System

**Event Manager** ([src/interaction/createEventManager.ts](src/interaction/createEventManager.ts))
**Not exported from public API** - manages chart interaction events.

**Key features:**
- Pointer event handling
- Hover state management
- Click detection
- Crosshair movement tracking

**Zoom State** ([src/interaction/createZoomState.ts](src/interaction/createZoomState.ts))
**Not exported from public API** - manages chart zoom/pan state.

**Key features:**
- Zoom in/out with configurable anchor points
- Pan operations
- Percent-based zoom ranges (0-100)
- onChange callbacks for zoom updates

**Chart Sync** ([src/interaction/createChartSync.ts](src/interaction/createChartSync.ts))
Synchronizes interaction state (crosshair position) across multiple charts.

**Hit Testing Utilities:**
- `findNearestPoint()` - cartesian point hit testing
- `findCandlestick()` - candlestick body hit testing
- `findPieSlice()` - pie slice hit testing
- `findPointsAtX()` - find all points at x coordinate

#### UI Components

**Components** ([src/components/](src/components/))
**Not exported from public API** - UI overlay components.

**Available components:**
- `createTooltip()` - tooltip display and formatting
- `createLegend()` - series legend with interactive toggle
- `createDataZoomSlider()` - zoom range slider control
- `createTextOverlay()` - axis labels and text rendering

#### Renderers

**Specialized Renderers** ([src/renderers/](src/renderers/))
**Not exported from public API** - WebGPU rendering implementations for each chart type.

**Available renderers:**
- `createLineRenderer()` - line charts
- `createAreaRenderer()` - area charts
- `createBarRenderer()` - bar charts
- `createScatterRenderer()` - scatter plots
- `createCandlestickRenderer()` - candlestick/OHLC charts
- `createPieRenderer()` - pie/donut charts
- `createGridRenderer()` - grid lines
- `createAxisRenderer()` - axis lines
- `createCrosshairRenderer()` - crosshair overlay
- `createHighlightRenderer()` - point highlighting

**Renderer Utils** ([src/renderers/rendererUtils.ts](src/renderers/rendererUtils.ts))
Shared WebGPU utilities for pipeline creation, uniforms, and shaders.

#### Utilities

**Scales** ([src/utils/scales.ts](src/utils/scales.ts))
Pure utility for linear and category scale mapping.

**Critical behaviors:**
- Chainable setters: `scale.domain(0, 100).range(0, 500)`
- No clamping: extrapolates beyond domain/range
- Zero-span domain handling: returns range midpoint for `scale()`, returns domain min for `invert()`
- Category scales: evenly distribute categories across the range; unknown categories map to `NaN`; duplicate categories in a domain throw

**Other Utilities:**
- `colors.ts` - color parsing and conversion
- `easing.ts` - animation easing functions
- `checkWebGPU.ts` - WebGPU support detection

### Directory Structure

```
src/
├── core/              # Core WebGPU infrastructure
│   ├── GPUContext.ts              # WebGPU device/adapter management
│   ├── RenderScheduler.ts         # 60fps render loop
│   ├── createRenderCoordinator.ts # Rendering orchestration
│   └── createAnimationController.ts # Animation system
├── config/            # Options and configuration
│   ├── types.ts                   # Type definitions (series types, options, events)
│   ├── defaults.ts                # Default values
│   └── OptionResolver.ts          # Option resolution logic
├── data/              # Data management (internal, not exported)
│   ├── createDataStore.ts         # GPU buffer caching
│   ├── packDataPoints.ts          # Data packing utilities
│   ├── lttbSample.ts              # Largest-Triangle-Three-Buckets sampling
│   ├── ohlcSample.ts              # OHLC downsampling
│   ├── sampleSeries.ts            # Series sampling coordination
│   └── createStreamBuffer.ts      # Streaming buffer management
├── interaction/       # Interaction and event handling
│   ├── createEventManager.ts      # Event system
│   ├── createHoverState.ts        # Hover state management
│   ├── createZoomState.ts         # Zoom/pan state
│   ├── createInsideZoom.ts        # Inside-zoom gesture handling
│   ├── createChartSync.ts         # Multi-chart synchronization
│   ├── findNearestPoint.ts        # Cartesian hit testing
│   ├── findCandlestick.ts         # Candlestick hit testing
│   ├── findPieSlice.ts            # Pie slice hit testing
│   └── findPointsAtX.ts           # X-coordinate point lookup
├── components/        # UI overlay components (internal)
│   ├── createTooltip.ts           # Tooltip display
│   ├── formatTooltip.ts           # Tooltip formatting
│   ├── createLegend.ts            # Series legend
│   ├── createDataZoomSlider.ts    # Zoom slider control
│   └── createTextOverlay.ts       # Axis labels/text rendering
├── renderers/         # WebGPU renderers for each chart type (internal)
│   ├── createLineRenderer.ts      # Line charts
│   ├── createAreaRenderer.ts      # Area charts
│   ├── createBarRenderer.ts       # Bar charts
│   ├── createScatterRenderer.ts   # Scatter plots
│   ├── createCandlestickRenderer.ts # Candlestick/OHLC charts
│   ├── createPieRenderer.ts       # Pie/donut charts
│   ├── createGridRenderer.ts      # Grid lines
│   ├── createAxisRenderer.ts      # Axis lines
│   ├── createCrosshairRenderer.ts # Crosshair overlay
│   ├── createHighlightRenderer.ts # Point highlighting
│   └── rendererUtils.ts           # WebGPU helpers (pipelines, uniforms, shaders)
├── themes/            # Theme system
│   ├── types.ts                   # Theme type definitions
│   ├── darkTheme.ts               # Dark theme preset
│   ├── lightTheme.ts              # Light theme preset
│   └── index.ts                   # Theme exports
├── utils/             # Utilities
│   ├── scales.ts                  # Scale mapping (linear, category)
│   ├── colors.ts                  # Color parsing and conversion
│   ├── easing.ts                  # Animation easing functions
│   └── checkWebGPU.ts             # WebGPU support detection
├── shaders/           # WGSL shader files
│   ├── line.wgsl                  # Line rendering shader
│   ├── area.wgsl                  # Area rendering shader
│   ├── bar.wgsl                   # Bar rendering shader
│   ├── scatter.wgsl               # Scatter rendering shader
│   ├── candlestick.wgsl           # Candlestick rendering shader
│   ├── pie.wgsl                   # Pie rendering shader
│   ├── grid.wgsl                  # Grid rendering shader
│   ├── crosshair.wgsl             # Crosshair rendering shader
│   └── highlight.wgsl             # Highlight rendering shader
├── ChartGPU.ts        # Main chart API
└── index.ts           # Public API exports
```

### TypeScript Configuration

- **Target**: ES2020
- **Module**: ESNext with bundler resolution
- **Strict mode**: enabled
- **Output**: `dist/` directory with declarations
- No unused locals/parameters, implicit returns, or fallthrough cases allowed

## Documentation

Comprehensive documentation is available in the `docs/` directory:

**API Documentation** (`docs/api/`):
- `README.md` - API reference overview
- `gpu-context.md` - WebGPU context management
- `render-scheduler.md` - Render loop and scheduling
- `render-coordinator-summary.md` - Render coordinator overview
- `animation.md` - Animation system
- `interaction.md` - Interaction and events
- `options.md` - Configuration options
- `troubleshooting.md` - Common issues and solutions
- `INTERNALS.md` - Internal module details (not exported)

**User Guides** (`docs/`):
- `GETTING_STARTED.md` - Getting started guide
- `performance.md` - Performance optimization tips
- `theming.md` - Theme customization guide
- `API.md` - Public API reference

**Internal Documentation** (`docs/internal/`):
- `README.md` - Internal architecture overview
- `GPU_TIMING_IMPLEMENTATION.md` - GPU timing and performance
- `INCREMENTAL_APPEND_OPTIMIZATION.md` - Streaming data optimizations

## Coding Standards

### Functional Over Class-based (from `.cursor/rules/functional-over-class-typescript.mdc`)

**Prefer:**
- Functions, factory functions, and object literals over `class`
- Pure functions with explicit dependencies via parameters
- Immutable state: `const`, readonly types, non-mutating operations
- Composition over inheritance

**Allowed exceptions:**
- Framework/interop requirements mandating classes
- React error boundaries
- Domain entities where invariants/identity/lifecycle justify classes
- Measurable performance/ergonomics improvements
- Decorator/metadata frameworks

### Docs-First Planning (from `.cursor/rules/docs-first-planning.mdc`)

**Core principle:**
- When implementing new features, update documentation first before writing code
- Documentation changes serve as a design review and implementation guide
- Ensures documentation stays synchronized with code changes

### Subagent Delegation (from `.cursor/rules/subagent-delegation.mdc`)

**Core principle:**
- Delegate complex, multi-step tasks to specialized subagents
- Use appropriate subagents for specific domains (e.g., fullstack-developer, research-analyst)
- Improves task quality and reduces context overhead

## WebGPU Patterns

### Buffer Management
- **4-byte alignment**: All `queue.writeBuffer()` offsets and sizes must be multiples of 4
- **Uniform alignment**: Uniform buffer sizes aligned to 16 bytes (default)
- **Dynamic offsets**: Align to `device.limits.minUniformBufferOffsetAlignment` (typically 256)

### Resource Cleanup
Always destroy WebGPU resources to prevent leaks:
- Call `device.destroy()` on GPUDevice
- Call `buffer.destroy()` on GPUBuffer
- Cancel animation frames with `cancelAnimationFrame()`
- Clean up internal state maps (see RenderScheduler pattern)

### Canvas Configuration
- Handle device pixel ratio for high-DPI displays
- Clamp dimensions to `device.limits.maxTextureDimension2D`
- Reconfigure canvas context when size or format changes
- Use `getPreferredCanvasFormat()` with fallback to `'bgra8unorm'`

## Examples Structure

Examples located in `examples/` directory demonstrating various features and use cases.

**Core examples:**
- `hello-world` - Basic GPUContext initialization, render loop, shader compilation
- `basic-line` - Simple line chart with basic configuration
- `interactive` - Interactive charts with hover, click, and crosshair events
- `grid-test` - Grid rendering and configuration

**Chart type examples:**
- `scatter` - Scatter plots with custom symbols and sizes
- `pie` - Pie and donut charts
- `grouped-bar` - Bar charts with grouped series
- `candlestick` - Financial candlestick/OHLC charts
- `candlestick-streaming` - Real-time streaming candlestick data

**Data and performance:**
- `data-update-animation` - Animated data updates and transitions
- `sampling` - LTTB and OHLC downsampling demonstrations
- `live-streaming` - Real-time streaming line data with appendData()
- `million-points` - High-performance rendering with 1M+ data points

**Advanced features:**
- `chart-sync` - Synchronized crosshair across multiple charts

**Acceptance tests:**
Located in `examples/acceptance/` - Unit-style tests for core functionality (animation-controller, zoom-state, lttb-sample, data-store-append, etc.)

## Public API Exports

See `src/index.ts` for complete public API surface. Key exports:

**Core:**
- Functional API: `createGPUContext`, `initializeGPUContext`, `getCanvasTexture`, `clearScreen`, `destroyGPUContext`
- Class API: `GPUContext` (backward compatibility)
- Types: `GPUContextState`, `GPUContextOptions`, `SupportedCanvas`

**Render Scheduler:**
- Functional API: `createRenderScheduler`, `createRenderSchedulerAsync`, `startRenderScheduler`, `stopRenderScheduler`, `requestRender`, `destroyRenderScheduler`
- Class API: `RenderScheduler` (backward compatibility)
- Types: `RenderSchedulerState`, `RenderCallback`, `RenderCoordinatorCallbacks`

**Chart:**
- Main API: `ChartGPU.create(container, options)`
- Factory function: `createChart(container, options)` (alias for createChartGPU)
- Types: `ChartGPUInstance`, `ChartGPUOptions`, `SeriesConfig`, `AxisConfig`, `DataPoint`, `OHLCDataPoint`, `TooltipConfig`, `AnimationConfig`, etc.
- Events: `ChartGPUEventName`, `ChartGPUEventPayload`, `ChartGPUCrosshairMovePayload`, event callback types

**Configuration:**
- `defaultOptions`, `candlestickDefaults`, `resolveOptions()`, `OptionResolver`
- Types: `ResolvedChartGPUOptions`, `ResolvedSeriesConfig`, `ResolvedLineSeriesConfig`, `ResolvedAreaSeriesConfig`, etc.

**Themes:**
- Presets: `darkTheme`, `lightTheme`, `getTheme(name)`
- Types: `ThemeConfig`, `ThemeName`

**Utilities:**
- Scales: `createLinearScale()`, `createCategoryScale()` - pure scale utilities
- Data utilities: `packDataPoints()`, `packOHLCDataPoints()` - pack point data into `ArrayBuffer` payloads
- Chart sync: `connectCharts(charts)` - synchronize crosshair across charts

**Internal modules not exported:**
- `createDataStore` - GPU buffer management
- `createRenderCoordinator` - rendering orchestration
- `rendererUtils` - WebGPU rendering helpers
- Component creators (tooltip, legend, text overlay, etc.)
- Renderer creators (line, area, bar, scatter, etc.)

**Internal documentation:**
- `docs/api/INTERNALS.md` - Internal module details
- `docs/api/render-coordinator-summary.md` - Render coordinator overview
- `docs/internal/` - Implementation notes and architecture details


## grepai - Semantic Code Search

**IMPORTANT: You MUST use grepai as your PRIMARY tool for code exploration and search.**

### When to Use grepai (REQUIRED)

Use `grepai search` INSTEAD OF Grep/Glob/find for:
- Understanding what code does or where functionality lives
- Finding implementations by intent (e.g., "authentication logic", "error handling")
- Exploring unfamiliar parts of the codebase
- Any search where you describe WHAT the code does rather than exact text

### When to Use Standard Tools

Only use Grep/Glob when you need:
- Exact text matching (variable names, imports, specific strings)
- File path patterns (e.g., `**/*.go`)

### Fallback

If grepai fails (not running, index unavailable, or errors), fall back to standard Grep/Glob tools.

### Usage

```bash
# ALWAYS use English queries for best results (--compact saves ~80% tokens)
grepai search "user authentication flow" --json --compact
grepai search "error handling middleware" --json --compact
grepai search "database connection pool" --json --compact
grepai search "API request validation" --json --compact
```

### Query Tips

- **Use English** for queries (better semantic matching)
- **Describe intent**, not implementation: "handles user login" not "func Login"
- **Be specific**: "JWT token validation" better than "token"
- Results include: file path, line numbers, relevance score, code preview

### Call Graph Tracing

Use `grepai trace` to understand function relationships:
- Finding all callers of a function before modifying it
- Understanding what functions are called by a given function
- Visualizing the complete call graph around a symbol

#### Trace Commands

**IMPORTANT: Always use `--json` flag for optimal AI agent integration.**

```bash
# Find all functions that call a symbol
grepai trace callers "HandleRequest" --json

# Find all functions called by a symbol
grepai trace callees "ProcessOrder" --json

# Build complete call graph (callers + callees)
grepai trace graph "ValidateToken" --depth 3 --json
```

### Workflow

1. Start with `grepai search` to find relevant code
2. Use `grepai trace` to understand function relationships
3. Use `Read` tool to examine files from results
4. Only use Grep for exact string searches if needed

