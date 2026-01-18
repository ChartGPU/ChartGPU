# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ChartGPU is a GPU-accelerated charting library built with WebGPU for high-performance data visualization in the browser. The library is written in TypeScript and provides both functional and class-based APIs.

## Development Commands

### Build and Development
- `npm run dev` - Start development server (opens at http://localhost:5176/examples/)
- `npm run build` - Compile TypeScript and build the library (runs `tsc && vite build`)
- `npm run prepublishOnly` - Build the library before publishing (automatically runs on publish)

### Browser Requirements
WebGPU support required:
- Chrome/Edge 113+
- Safari 18+
- Firefox not yet supported

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

#### GPUContext (`src/core/GPUContext.ts`)
Manages WebGPU adapter and device initialization. Provides both functional API (`createGPUContext`, `initializeGPUContext`) and class-based API (`GPUContext.create()`).

**Functional API pattern:**
```typescript
const context = createGPUContext(canvas);
const initialized = await initializeGPUContext(context);
const destroyed = destroyGPUContext(initialized);
```

**Key responsibilities:**
- WebGPU adapter/device request and initialization
- Canvas configuration with device pixel ratio handling
- Texture format detection and configuration
- Device lifecycle management and cleanup

#### RenderScheduler (`src/core/RenderScheduler.ts`)
Manages requestAnimationFrame-based render loop at 60fps with delta time tracking.

**State management pattern:**
- Public readonly state (`RenderSchedulerState`)
- Internal mutable state stored in `Map<symbol, InternalState>`
- Functions return new public state objects
- Internal state tracked separately using unique symbol IDs

#### ChartGPU (`src/ChartGPU.ts`)
Main chart API - `ChartGPU.create(container, options)` creates chart instances.

**Instance lifecycle:**
- Creates canvas element and appends to container
- Initializes GPUContext
- Manages canvas sizing and configuration
- Handles device loss and disposal

#### DataStore (`src/data/createDataStore.ts`)
**Not exported from public API** - internal module for GPU buffer management.

**Key features:**
- Per-series vertex buffer caching
- Lazy allocation and reallocation on data changes
- Hash-based change detection (FNV-1a on Float32 bit patterns)
- Buffer reuse when data size fits existing capacity
- Minimum buffer size: 4 bytes (enforced)

#### OptionResolver (`src/config/OptionResolver.ts`)
Resolves user options against defaults following specific patterns:

**Resolution behavior:**
- Grid defaults: `left: 60, right: 20, top: 40, bottom: 40`
- Palette fallback: user palette → default palette → `['#000000']`
- Series colors: explicit `series[i].color` → `palette[i % palette.length]`
- Line style: per-series `lineStyle` merged with `defaultLineStyle`

#### Scales (`src/utils/scales.ts`)
Pure utility for linear and category scale mapping.

**Critical behaviors:**
- Chainable setters: `scale.domain(0, 100).range(0, 500)`
- No clamping: extrapolates beyond domain/range
- Zero-span domain handling: returns range midpoint for `scale()`, returns domain min for `invert()`
- Category scales: evenly distribute categories across the range; unknown categories map to `NaN`; duplicate categories in a domain throw

### Directory Structure

```
src/
├── core/           # Core WebGPU infrastructure
│   ├── GPUContext.ts        # WebGPU device/adapter management
│   └── RenderScheduler.ts   # 60fps render loop
├── config/         # Options and configuration
│   ├── types.ts             # Type definitions
│   ├── defaults.ts          # Default values
│   └── OptionResolver.ts    # Option resolution logic
├── data/           # Data management (internal, not exported)
│   └── createDataStore.ts   # GPU buffer caching
├── renderers/      # Rendering utilities
│   └── rendererUtils.ts     # WebGPU helpers (pipelines, uniforms, shaders)
├── utils/          # Utilities
│   └── scales.ts            # Scale mapping
├── shaders/        # WGSL shader files
└── index.ts        # Public API exports
```

### TypeScript Configuration

- **Target**: ES2020
- **Module**: ESNext with bundler resolution
- **Strict mode**: enabled
- **Output**: `dist/` directory with declarations
- No unused locals/parameters, implicit returns, or fallthrough cases allowed

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

### Documentation Standards (from `.cursor/rules/documentation-standards.mdc`)

**Core principles:**
1. **No code blocks in documentation** - link to source files instead
2. **Link to source files** - use relative paths like `[GPUContext](src/core/GPUContext.ts)`
3. **Essential information only** - avoid duplicating what's in source code

**Include:**
- Function/method signatures
- Critical parameters (only if not obvious)
- Return types
- Key error conditions (brief)
- Links to source files

**Avoid:**
- Code block examples (link to examples/ instead)
- Verbose error message listings
- Redundant descriptions
- Long property/method lists (link to source)
- Generic best practices

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

Examples located in `examples/` directory. The `hello-world` example demonstrates:
- GPUContext initialization
- Continuous render loop with requestAnimationFrame
- Canvas clear operations with animated colors
- Shader compilation and error checking
- Proper cleanup on page unload

## Public API Exports

See `src/index.ts` for complete public API surface. Key exports:

**Core:**
- Functional API: `createGPUContext`, `initializeGPUContext`, etc.
- Class API: `GPUContext` (backward compatibility)

**Chart:**
- `ChartGPU.create(container, options)`
- Types: `ChartGPUOptions`, `SeriesConfig`, `AxisConfig`, etc.

**Configuration:**
- `defaultOptions`, `resolveOptions()`, `OptionResolver`

**Utilities:**
- `createLinearScale()`, `createCategoryScale()` - pure scale utilities

**Internal modules not exported:**
- `createDataStore` - GPU buffer management
- `rendererUtils` - WebGPU rendering helpers (documented in `docs/API.md`)
