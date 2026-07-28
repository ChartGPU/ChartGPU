# Internal / Contributor Documentation

This directory contains technical implementation documentation intended for contributors and maintainers of the ChartGPU library. These documents provide deep dives into implementation details, optimization strategies, and technical decisions.

## Contents

### Performance Monitoring

- **Performance Metrics System** - ChartGPU provides comprehensive real-time performance monitoring using exact FPS measurement with circular buffer timestamps. The system tracks frame timing, CPU/GPU time, memory usage, and frame drops. See [`src/config/types.ts`](../../src/config/types.ts) for `PerformanceMetrics` and `PerformanceCapabilities` type definitions.

## Audience

These documents are intended for:

- **Contributors** implementing new features or optimizations
- **Maintainers** debugging performance issues
- **Advanced users** who need to understand internal implementation details

## Related Documentation

For end-user documentation, see:

- **[Getting Started Guide](https://chartgpu.io/docs/getting-started/)** - Quick start and first chart tutorial
- **[API Documentation](https://chartgpu.io/docs/api/)** - Complete API reference
- **[Performance Guide](https://chartgpu.io/docs/performance/)** - End-user performance optimization tips

For contributor documentation on architecture and internal APIs, see:

- **[INTERNALS.md](../api/INTERNALS.md)** - Internal modules and contributor notes
- **[CONTRIBUTING.md](../../CONTRIBUTING.md)** - Contributing guidelines
- **[CLAUDE.md](../../CLAUDE.md)** - Architecture and coding standards

## Contributing

If you're adding new technical implementation documentation, place it in this directory if it:

- Describes low-level implementation details
- Covers optimization strategies and trade-offs
- Explains technical decisions and rationale
- Requires deep knowledge of WebGPU or graphics programming
- Is primarily useful to contributors rather than end users

For documentation that serves end users (guides, tutorials, API reference), place it in the main `docs/` directory instead.
