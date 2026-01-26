# Troubleshooting

## Error Handling

All initialization functions throw descriptive errors if WebGPU is unavailable, adapter/device requests fail, or the context is already initialized. Wrap initialization in try-catch blocks.

## Best Practices

Always call `destroyGPUContext()` (functional) or `destroy()` (class) when done with a GPU context. Use try-finally blocks to ensure cleanup.

When providing a canvas element, the context automatically handles device pixel ratio and configures the canvas with the preferred format.

## Common Issues

### WebGPU Not Available

If you encounter errors about WebGPU not being available, check:
- Browser version (Chrome/Edge 113+, Safari 18+)
- Firefox is not yet supported
- Hardware compatibility (WebGPU requires modern GPU support)

### Canvas Configuration Errors

Canvas configuration issues typically occur when:
- Device pixel ratio changes (call `resize()` on the chart instance)
- Canvas dimensions exceed `device.limits.maxTextureDimension2D`
- Format mismatch between canvas context and render pipeline

### Resource Cleanup

Always clean up WebGPU resources to prevent leaks:
- Call `device.destroy()` on GPUDevice
- Call `buffer.destroy()` on GPUBuffer
- Cancel animation frames with `cancelAnimationFrame()`
- Clean up internal state maps

For more information, see:
- [GPU Context](gpu-context.md)
- [RenderScheduler](render-scheduler.md)
