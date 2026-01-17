# Getting Started with ChartGPU

This guide will help you get started with ChartGPU, a GPU-accelerated charting library built with WebGPU.

## Prerequisites

Before you begin, ensure you have:

1. **A WebGPU-compatible browser:**
   - Chrome 113+ or Edge 113+ (WebGPU enabled by default)
   - Safari 18+ (WebGPU enabled by default)
   - Firefox (WebGPU support in development)

2. **Node.js 18+** installed on your system

3. **Basic knowledge** of TypeScript/JavaScript and WebGPU concepts

## Installation

Install ChartGPU using npm or yarn:

- Install with `npm install chartgpu`
- Install with `yarn add chartgpu`

## Your First GPU Context

The first step in using ChartGPU is initializing a GPU context. This gives you access to the WebGPU device for rendering operations.

Import `GPUContext` and call `GPUContext.create()` to create and initialize a context. Access the device through the `device` property, and always call `destroy()` when finished.

See [GPUContext.ts](../src/core/GPUContext.ts) for the implementation.

### Error Handling

Wrap initialization in try-catch to handle errors gracefully. The error messages indicate the specific failure reason and provide guidance on resolution.

## Checking Browser Support

Before attempting to initialize, check if WebGPU is available by verifying `'gpu' in navigator`. The `initialize()` method performs this check automatically and throws a descriptive error if WebGPU is unavailable.

## Common Patterns

### Singleton GPU Context

For applications that need a single GPU context throughout their lifetime, implement a singleton pattern that creates one context and reuses it.

### Context Reuse

You can reuse a context after destroying it by calling `initialize()` again. The context must be destroyed before reinitializing.

### Multiple Contexts

You can create multiple GPU contexts if needed. Each context manages its own adapter and device.

## Next Steps

Now that you have a GPU context initialized, you can:

1. **Create GPU resources** - Use the device to create buffers, textures, and pipelines
2. **Set up rendering** - Configure render pipelines for drawing charts
3. **Handle data** - Upload chart data to GPU buffers (internal helper: [`createDataStore.ts`](../src/data/createDataStore.ts))
4. **Render** - Execute render passes to draw your charts
5. **Themes (optional)** - Theme presets (`darkTheme`, `lightTheme`, `getTheme(name: ThemeName)`) and the `ThemeConfig` type are available from the public API. See [`src/themes/index.ts`](../src/themes/index.ts), [`types.ts`](../src/themes/types.ts), and [`API.md`](./API.md#themeconfig).
   - Theme colors are applied during rendering (background clear, grid lines, and axes); see [`createRenderCoordinator.ts`](../src/core/createRenderCoordinator.ts).
   - Theme typography/text color is also used for numeric axis tick value labels rendered above the canvas; see [`API.md`](./API.md#text-overlay-internal--contributor-notes).

## Troubleshooting

### "WebGPU is not available" Error

**Problem:** The browser doesn't support WebGPU or it's disabled.

**Solutions:**
- Use Chrome 113+, Edge 113+, or Safari 18+
- Enable WebGPU in browser flags (if using an older version)
- Check browser console for additional error messages

### "Failed to request WebGPU adapter" Error

**Problem:** No compatible GPU adapter found.

**Solutions:**
- Ensure you have a GPU available (not running in headless mode)
- Check if WebGPU is enabled in browser settings
- Try updating your graphics drivers

### Device Initialization Fails

**Problem:** Device request fails after adapter is found.

**Solutions:**
- Check browser console for detailed error messages
- Ensure sufficient GPU resources are available
- Try closing other GPU-intensive applications

## Examples

See the [examples directory](../examples/) for complete working examples.

The `hello-world` example demonstrates continuous rendering by animating the clear color through the full color spectrum, proving that the render loop is working correctly. See [hello-world/main.ts](../examples/hello-world/main.ts) for implementation.

The `basic-line` example demonstrates line series configuration, including a filled line series via `areaStyle`. See [basic-line/main.ts](../examples/basic-line/main.ts).

To run examples:

1. Start the development server: `npm run dev`
2. Navigate to `http://localhost:5176/examples/index.html`

## API Reference

For detailed API documentation, see [API.md](./API.md).

## Support

If you encounter issues:

1. Check the [troubleshooting section](#troubleshooting) above
2. Review the [API documentation](./API.md)
3. Check browser console for error messages
4. Ensure you're using a supported browser version
