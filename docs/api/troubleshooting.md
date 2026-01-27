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

## Worker Mode Issues

### Tooltips Not Appearing in Worker Mode

**Symptom:** Tooltips work in main-thread charts but not in worker-based charts (created with `ChartGPU.createInWorker()`).

**Root Cause:** OffscreenCanvas lacks `getBoundingClientRect()` method, which is required for calculating grid coordinates for tooltip hit-testing.

**Solution:** ChartGPU automatically computes grid coordinates on the main thread before forwarding events to the worker.

**Verification:**
1. Check that worker-based charts are created using `ChartGPU.createInWorker()` or `createChartInWorker()` (built-in implementation handles coordinate calculation)
2. Verify events are being forwarded to worker (use browser DevTools to inspect postMessage traffic)
3. Check that `ReadyMessage` was received before events are forwarded (initialization complete)

**Custom Worker Implementation:**
If you're implementing a custom worker (not using built-in `ChartGPUWorkerProxy`), ensure:
1. Main thread computes grid coordinates using `computePointerEventData()` helper
2. `PointerEventData` includes `gridX`, `gridY`, `isInGrid` fields
3. Worker uses pre-computed grid coordinates for hit-testing (not raw canvas coordinates)

**Code reference:** See [`ChartGPUWorkerProxy.computePointerEventData()`](../../src/worker/ChartGPUWorkerProxy.ts) for reference implementation.

### Tooltip Coordinates Incorrect in Worker Mode

**Symptom:** Tooltips appear but are positioned incorrectly (far from cursor or off-screen).

**Common Causes:**
1. **Grid area mismatch:** Cached grid area on main thread doesn't match worker's grid configuration
2. **Device pixel ratio:** OffscreenCanvas dimensions not correctly converted from device pixels to CSS pixels
3. **Canvas position stale:** Canvas moved in DOM but `getBoundingClientRect()` not called again
4. **Wrong coordinate system:** Using page-global coordinates instead of canvas-local coordinates

**Solutions:**
1. **Update cached grid area on configuration changes:**
   ```typescript
   // Main thread: Update cached grid when options change
   chart.setOption({ grid: { left: 80, right: 40, top: 60, bottom: 60 } });
   // ChartGPUWorkerProxy automatically updates cached grid
   ```

2. **Ensure DPR is accounted for:**
   - Built-in `ChartGPUWorkerProxy` automatically handles DPR conversion
   - Custom implementations must divide OffscreenCanvas dimensions by DPR to get CSS pixels

3. **Call getBoundingClientRect() on every event:**
   ```typescript
   canvas.addEventListener('pointermove', (e) => {
     // Call getBoundingClientRect() fresh - canvas may have moved
     const rect = canvas.getBoundingClientRect();
     const canvasX = e.clientX - rect.left;
     const canvasY = e.clientY - rect.top;
     // ... compute grid coordinates
   });
   ```

4. **Use canvas-local coordinates:**
   - Tooltip position must be in canvas-local CSS pixels
   - Never use page-global `clientX`/`clientY` for tooltip positioning

### Tooltips Lag Behind Cursor in Worker Mode

**Symptom:** Tooltips update slowly and lag behind rapid mouse movement.

**Causes:**
1. **No RAF throttling:** Sending every pointermove event to worker overwhelms message queue
2. **No RAF batching:** Rendering tooltip to DOM on every update causes layout thrashing

**Solutions:**
1. **RAF-throttle pointermove events (built-in):**
   - `ChartGPUWorkerProxy` automatically throttles pointermove to 60fps
   - Custom implementations should implement similar throttling

2. **RAF-batch tooltip updates (built-in):**
   - `ChartGPUWorkerProxy` batches tooltip DOM updates in single RAF callback
   - Prevents multiple DOM writes per frame (layout thrashing)

**Expected performance:** Tooltips should update at 60fps max with no visible lag.

### Worker Initialization Race Condition

**Symptom:** Events sent to worker before initialization complete cause errors or crashes.

**Root Cause:** Main thread forwards events before worker sends `ReadyMessage`.

**Solution (built-in):** `ChartGPUWorkerProxy` implements `isInitialized` flag:
- Events are silently dropped until `ReadyMessage` received
- After `isInitialized = true`, all events are forwarded normally

**Custom implementations:** Implement similar guard:
```typescript
let isInitialized = false;

worker.addEventListener('message', (e) => {
  if (e.data.type === 'ready') {
    isInitialized = true;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!isInitialized) {
    return; // Silently drop event
  }
  // Safe to forward - worker is ready
  forwardEventToWorker(e);
});
```

### Debugging Worker Mode Interactions

**Enable debug logging:**

1. **Main thread (before forwarding):**
   ```typescript
   const eventData = computePointerEventData(event, canvas, gridArea);
   console.log('Forwarding event:', eventData);
   worker.postMessage({ type: 'forwardPointerEvent', event: eventData });
   ```

2. **Worker thread (after receiving):**
   ```typescript
   self.addEventListener('message', (e) => {
     if (e.data.type === 'forwardPointerEvent') {
       console.log('Received event:', e.data.event);
       console.log('interactionScales:', interactionScales); // Should not be null
       coordinator.handlePointerEvent(e.data.event);
     }
   });
   ```

3. **Worker thread (tooltip emission):**
   ```typescript
   onTooltipUpdate: (data) => {
     console.log('Emitting tooltip:', data);
     self.postMessage({ type: 'tooltipUpdate', data });
   }
   ```

4. **Main thread (tooltip rendering):**
   ```typescript
   worker.addEventListener('message', (e) => {
     if (e.data.type === 'tooltipUpdate') {
       console.log('Received tooltip update:', e.data.data);
       // Render to DOM
     }
   });
   ```

**Check coordinate systems:**
- Verify `clientX`, `clientY` are page-global coordinates
- Verify `offsetX`, `offsetY` are canvas-local coordinates (after `getBoundingClientRect()`)
- Verify `gridX`, `gridY` are grid-local coordinates (after subtracting grid offsets)
- Verify `isInGrid` is `true` for events over plot area

**Inspect WebGPU state:**
- Use browser DevTools to check if `interactionScales` is `null` (coordinate calculation failure)
- Verify canvas dimensions match expected values (device pixels vs CSS pixels)
- Check grid area configuration in worker matches main thread

### Related Documentation

- [Worker Architecture - Tooltip and Interaction Support](../internal/WORKER_ARCHITECTURE.md#tooltip-and-interaction-support) - Complete technical explanation
- [Worker Thread Integration Guide](../internal/WORKER_THREAD_INTEGRATION.md#implementing-tooltip-support-in-custom-workers) - Implementation checklist
- [Worker Protocol - forwardPointerEvent](worker-protocol.md#forwardpointerevent) - PointerEventData specification
- [Worker Protocol - tooltipUpdate](worker-protocol.md#tooltipupdate) - TooltipUpdateMessage specification

For more information, see:
- [GPU Context](gpu-context.md)
- [RenderScheduler](render-scheduler.md)
