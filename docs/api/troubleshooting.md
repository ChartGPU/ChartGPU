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

### Line Series Shimmer During Zoom (Time Axis / Epoch-ms Timestamps)

If you previously noticed **line stroke shimmer/jitter while zooming** on time-based charts (especially when x-values are large **epoch-milliseconds** around \(10^{12}\)), this was caused by **Float32 precision loss** when large absolute x-values were packed into GPU vertex buffers.

ChartGPU now avoids this automatically by **rebasing** time x-values internally before upload:
- It stores \(x' = x - xOffset\) in the GPU buffer (where `xOffset` is a per-series origin), which keeps values near zero and preserves precision.
- It compensates for the origin shift when preparing the line renderer transform, so the visual result is unchanged—just more stable during zoom/pan.

**User guidance:** You can provide epoch-ms timestamps directly as documented for `xAxis.type: 'time'`. You no longer need to pre-normalize timestamps (for example, converting to seconds) purely to avoid zoom shimmer.

### Canvas Configuration Errors

Canvas configuration issues typically occur when:
- Device pixel ratio changes (call `resize()` on the chart instance)
- Canvas dimensions exceed `device.limits.maxTextureDimension2D`
- Format mismatch between canvas context and render pipeline

### Chart Initializes at 0×0 (Hidden or 0-Sized Container)

Charts can be created while their container is temporarily 0-sized (for example, `display: none` during initial layout, a collapsed panel, or a container without an explicit height). Internally, the render coordinator **clamps canvas dimensions to at least 1×1 device pixels** to avoid hard crashes and will render normally once a valid size is available.

If you see a blank chart or incorrect sizing after the container becomes visible:
- Ensure the container has a real size (e.g. set an explicit height, or use a parent with a defined height).
- After revealing the container / after layout settles, call `chart.resize()` (or recreate the chart) so the canvas and layout can be recomputed.

### Resource Cleanup

Always clean up WebGPU resources to prevent leaks:
- Call `device.destroy()` on GPUDevice
- Call `buffer.destroy()` on GPUBuffer
- Cancel animation frames with `cancelAnimationFrame()`
- Clean up internal state maps

For more information, see:
- [GPU Context](gpu-context.md)
- [RenderScheduler](render-scheduler.md)
