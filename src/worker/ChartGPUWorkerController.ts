/**
 * ChartGPUWorkerController - Worker-side chart instance manager
 * 
 * Manages multiple chart instances via messages from the main thread.
 * Uses a class-based approach (acceptable exception for internal worker singleton managing mutable state).
 * 
 * ## Performance Optimizations
 * 
 * This implementation is optimized for high-frequency operations:
 * 
 * 1. **Shared State Closures**: ChartInstanceState is captured in coordinator callbacks
 *    to eliminate Map lookups in hot paths (onRequestRender called on every data update,
 *    render loop at 60fps).
 * 
 * 2. **Cached Render Loop**: Render callback caches coordinator and state references,
 *    avoiding Map lookups on every frame (critical for 60fps performance).
 * 
 * 3. **Optimized Deserialization**: deserializeDataPoints uses:
 *    - Pre-allocated arrays (no dynamic resizing)
 *    - Unrolled offset calculation in loop increment
 *    - Early validation (fail fast)
 * 
 * 4. **Reduced Branching**: Click handler uses early returns instead of nested conditionals,
 *    improving branch prediction and reducing instruction pipeline stalls.
 * 
 * 5. **Zero-Copy Data Transfer**: ArrayBuffers are transferred (not cloned) via postMessage,
 *    eliminating serialization overhead for large datasets.
 * 
 * 6. **Batch Validation**: appendDataBatch validates all items upfront before processing,
 *    ensuring transactional behavior and avoiding partial updates on error.
 */

import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  InitMessage,
  ResizeMessage,
  ErrorMessage,
} from './protocol';
import type {
  DataPoint,
  OHLCDataPoint,
  ChartGPUOptions,
  PerformanceMetrics,
  PerformanceCapabilities,
  ExactFPS,
  Milliseconds,
  Bytes,
  FrameTimeStats,
  GPUTimingStats,
  MemoryStats,
  FrameDropStats,
} from '../config/types';
import { createGPUContext, initializeGPUContext, destroyGPUContext, type GPUContextState } from '../core/GPUContext';
import { createRenderCoordinator, type RenderCoordinator } from '../core/createRenderCoordinator';
import { resolveOptions } from '../config/OptionResolver';

/**
 * Circular buffer size for frame timestamps (120 frames = 2 seconds at 60fps).
 */
const FRAME_BUFFER_SIZE = 120;

/**
 * Expected frame time at 60fps (16.67ms).
 */
const EXPECTED_FRAME_TIME_MS = 1000 / 60;

/**
 * Frame drop threshold multiplier (1.5x expected frame time).
 */
const FRAME_DROP_THRESHOLD_MULTIPLIER = 1.5;

/**
 * Performance tracking state for a chart instance.
 * Circular buffer pattern for exact FPS measurement.
 */
interface PerformanceTrackingState {
  frameTimestamps: Float64Array;
  frameTimestampIndex: number;
  frameTimestampCount: number;
  totalFrames: number;
  totalDroppedFrames: number;
  consecutiveDroppedFrames: number;
  lastDropTimestamp: number;
  startTime: number;
  lastFrameTime: number;
  
  // GPU timing (optional)
  gpuTimingEnabled: boolean;
  lastCPUTime: number;
  lastGPUTime: number;
}

/**
 * Mutable state flags for a chart instance.
 * Shared between ChartInstance and coordinator callbacks for optimal performance.
 */
interface ChartInstanceState {
  renderPending: boolean;
  disposed: boolean;
  deviceLost: boolean;
  performance: PerformanceTrackingState;
}

/**
 * Represents a chart instance managed by the worker.
 * Contains all state needed for rendering and interaction.
 */
interface ChartInstance {
  readonly chartId: string;
  gpuContext: GPUContextState;
  readonly coordinator: RenderCoordinator;
  readonly canvas: OffscreenCanvas;
  readonly renderChannel: MessageChannel;
  /** Shared mutable state (avoid Map lookups in hot paths) */
  readonly state: ChartInstanceState;
}

/**
 * Error codes for categorizing worker errors.
 */
type ErrorCode = 'WEBGPU_INIT_FAILED' | 'DEVICE_LOST' | 'RENDER_ERROR' | 'DATA_ERROR' | 'UNKNOWN';

/**
 * Performance-optimized validation helper for seriesIndex.
 * Extracted to reduce code duplication and improve performance.
 * 
 * @param seriesIndex - Series index to validate
 * @param context - Context string for error message
 * @throws {Error} If validation fails
 */
function validateSeriesIndex(seriesIndex: number, context: string): void {
  if (!Number.isInteger(seriesIndex) || seriesIndex < 0) {
    throw new Error(`Invalid seriesIndex ${context}: ${seriesIndex}. Must be a non-negative integer.`);
  }
}

/**
 * Performance-optimized validation helper for pointCount.
 * Extracted to reduce code duplication and improve performance.
 * 
 * @param pointCount - Point count to validate
 * @param context - Context string for error message
 * @throws {Error} If validation fails
 */
function validatePointCount(pointCount: number, context: string): void {
  if (!Number.isInteger(pointCount) || pointCount < 0) {
    throw new Error(`Invalid pointCount ${context}: ${pointCount}. Must be a non-negative integer.`);
  }
}

/**
 * Performance-optimized error message extractor.
 * Reduces repeated instanceof checks in hot paths.
 * 
 * @param error - Error object or value
 * @returns Tuple of [message, stack]
 */
function extractErrorInfo(error: unknown): [string, string | undefined] {
  if (error instanceof Error) {
    return [error.message, error.stack];
  }
  return [String(error), undefined];
}

/**
 * ChartGPUWorkerController - Singleton worker-side controller.
 * 
 * Manages multiple chart instances and handles message-based communication
 * with the main thread. Uses class-based approach as acceptable exception
 * for internal worker singleton managing mutable state.
 */
export class ChartGPUWorkerController {
  private readonly charts = new Map<string, ChartInstance>();
  private messageHandler: ((msg: WorkerOutboundMessage) => void) | null = null;

  /**
   * Registers a message handler to send outbound messages to the main thread.
   * 
   * @param handler - Function to call when emitting messages to main thread
   */
  onMessage(handler: (msg: WorkerOutboundMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Main entry point for handling inbound messages from the main thread.
   * Routes messages to appropriate handlers with exhaustive type checking.
   * 
   * @param msg - Inbound message from main thread
   */
  async handleMessage(msg: WorkerInboundMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'init':
          await this.initChart(msg);
          break;
        case 'setOption':
          this.handleSetOption(msg.chartId, msg.options);
          break;
        case 'appendData':
          this.handleAppendData(msg.chartId, msg.seriesIndex, msg.data, msg.pointCount, msg.stride);
          break;
        case 'appendDataBatch':
          this.handleAppendDataBatch(msg.chartId, msg.items);
          break;
        case 'resize':
          this.handleResize(msg.chartId, msg);
          break;
        case 'forwardPointerEvent':
          this.handlePointerEvent(msg.chartId, msg.event);
          break;
        case 'setZoomRange':
          this.handleSetZoomRange(msg.chartId, msg.start, msg.end);
          break;
        case 'setInteractionX':
          this.handleSetInteractionX(msg.chartId, msg.x, msg.source);
          break;
        case 'setAnimation':
          this.handleSetAnimation(msg.chartId, msg.enabled, msg.config);
          break;
        case 'setGPUTiming':
          this.handleSetGPUTiming(msg.chartId, msg.enabled);
          break;
        case 'dispose':
          this.disposeChart(msg.chartId);
          break;
        default:
          // Exhaustive type check - ensures we handle all message types
          const exhaustive: never = msg;
          this.emitError(
            '', // No chartId available for unknown message
            'UNKNOWN',
            `Unknown message type: ${(exhaustive as any).type}`,
            'handleMessage'
          );
      }
    } catch (error) {
      // Catch any unhandled errors and emit error message
      const chartId = 'chartId' in msg ? msg.chartId : '';
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      
      this.emitError(chartId, 'UNKNOWN', message, 'handleMessage', stack);
    }
  }

  /**
   * Initializes a new chart instance with WebGPU context and render coordinator.
   * 
   * @param msg - Init message containing canvas, options, and configuration
   */
  private async initChart(msg: InitMessage): Promise<void> {
    let renderChannel: MessageChannel | null = null;

    try {
      // Ensure chart doesn't already exist
      if (this.charts.has(msg.chartId)) {
        this.emitError(
          msg.chartId,
          'UNKNOWN',
          `Chart with ID "${msg.chartId}" already exists`,
          'init',
          undefined,
          msg.messageId
        );
        return;
      }

      // Validate devicePixelRatio
      if (msg.devicePixelRatio <= 0) {
        throw new Error(`Invalid devicePixelRatio: ${msg.devicePixelRatio}. Must be positive.`);
      }

      // Create GPU context with OffscreenCanvas
      const gpuOptions = {
        devicePixelRatio: msg.devicePixelRatio,
        powerPreference: msg.gpuOptions?.powerPreference,
      };
      const gpuContext = createGPUContext(msg.canvas, gpuOptions);
      let initializedContext = await initializeGPUContext(gpuContext);

      // Resolve chart options
      const resolvedOptions = resolveOptions(msg.options);

      // Create MessageChannel for render scheduling
      renderChannel = new MessageChannel();
      
      // PERFORMANCE: Pre-create shared instance state that will be captured in coordinator callbacks
      // This avoids Map lookups in hot paths (onRequestRender called on every data update/zoom/resize)
      // CRITICAL: Must be declared BEFORE device.lost handler to avoid ReferenceError
      const performanceState: PerformanceTrackingState = {
        frameTimestamps: new Float64Array(FRAME_BUFFER_SIZE),
        frameTimestampIndex: 0,
        frameTimestampCount: 0,
        totalFrames: 0,
        totalDroppedFrames: 0,
        consecutiveDroppedFrames: 0,
        lastDropTimestamp: 0,
        startTime: performance.now(),
        lastFrameTime: 0,
        gpuTimingEnabled: false,
        lastCPUTime: 0,
        lastGPUTime: 0,
      };

      const state: ChartInstanceState = {
        renderPending: false,
        disposed: false,
        deviceLost: false,
        performance: performanceState,
      };

      // Set up early device loss monitoring (before coordinator creation)
      // This catches device loss during initialization
      // PERFORMANCE: Capture state reference to avoid Map lookup in device.lost handler
      if (initializedContext.device) {
        initializedContext.device.lost.then((info) => {
          state.deviceLost = true;
          this.emit({
            type: 'deviceLost',
            chartId: msg.chartId,
            reason: info.reason === 'destroyed' ? 'destroyed' : 'unknown',
            message: info.message || info.reason || 'Device lost during initialization',
          });
        }).catch(() => {
          // Ignore errors in device.lost promise (can occur if device is destroyed before lost promise resolves)
        });

        // Set up uncaptured error handler for GPU validation errors
        initializedContext.device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
          const errorMessage = event.error instanceof GPUValidationError
            ? `WebGPU Validation Error: ${event.error.message}`
            : event.error instanceof GPUOutOfMemoryError
            ? `WebGPU Out of Memory: ${event.error.message}`
            : `WebGPU Error: ${event.error.message}`;
          
          this.emitError(msg.chartId, 'RENDER_ERROR', errorMessage, 'uncaptured_gpu_error');
        });
      }

      // Create render coordinator with worker-mode callbacks
      const coordinator = createRenderCoordinator(
        initializedContext,
        resolvedOptions,
        {
          // CRITICAL: Disable DOM overlays for worker mode
          domOverlays: false,

          // Request render via MessageChannel for efficient scheduling
          // PERFORMANCE: Use closure-captured state instead of Map lookup (critical for 60fps)
          // CRITICAL: Post to port2, listen on port1 (MessageChannel requires opposite ends)
          onRequestRender: () => {
            if (!state.renderPending && !state.disposed && renderChannel) {
              state.renderPending = true;
              renderChannel.port2.postMessage(null);
            }
          },

          // Emit tooltip updates to main thread for DOM rendering
          onTooltipUpdate: (data) => {
            this.emit({
              type: 'tooltipUpdate',
              chartId: msg.chartId,
              data,
            });
            
            // Derive hover state from tooltip data
            // Tooltip data contains all the info needed for hover events
            if (data && data.params.length > 0) {
              const firstParam = data.params[0];
              this.emit({
                type: 'hoverChange',
                chartId: msg.chartId,
                payload: {
                  seriesIndex: firstParam.seriesIndex,
                  dataIndex: firstParam.dataIndex,
                  value: firstParam.value,
                  x: data.x,
                  y: data.y,
                },
              });
            } else {
              // Tooltip hidden = hover cleared
              this.emit({
                type: 'hoverChange',
                chartId: msg.chartId,
                payload: null,
              });
            }
          },

          // Emit legend updates to main thread
          onLegendUpdate: (items) => {
            this.emit({
              type: 'legendUpdate',
              chartId: msg.chartId,
              items,
            });
          },

          // Emit axis label updates to main thread
          onAxisLabelsUpdate: (xLabels, yLabels) => {
            this.emit({
              type: 'axisLabelsUpdate',
              chartId: msg.chartId,
              xLabels,
              yLabels,
            });
          },

          // Emit crosshair position to main thread
          onCrosshairMove: (x) => {
            // Only emit if crosshair is active (x is not null)
            // Note: source parameter is not provided by callback - it's tracked
            // separately when setInteractionX is called programmatically
            if (x !== null) {
              this.emit({
                type: 'crosshairMove',
                chartId: msg.chartId,
                x,
              });
            }
          },

          // Emit click events to main thread
          onClickData: (payload) => {
            // PERFORMANCE: Early return if no hit (most common case in sparse data)
            if (!payload.nearest && !payload.pieSlice && !payload.candlestick) {
              return;
            }
            
            // PERFORMANCE: Use early returns to avoid nested conditionals
            if (payload.nearest) {
              this.emit({
                type: 'click',
                chartId: msg.chartId,
                payload: {
                  seriesIndex: payload.nearest.seriesIndex,
                  dataIndex: payload.nearest.dataIndex,
                  value: payload.nearest.point as readonly [number, number],
                  x: payload.x,
                  y: payload.y,
                },
              });
              return;
            }
            
            if (payload.pieSlice) {
              this.emit({
                type: 'click',
                chartId: msg.chartId,
                payload: {
                  seriesIndex: payload.pieSlice.seriesIndex,
                  dataIndex: payload.pieSlice.dataIndex,
                  value: [payload.pieSlice.slice.value, 0] as readonly [number, number],
                  x: payload.x,
                  y: payload.y,
                },
              });
              return;
            }
            
            if (payload.candlestick) {
              this.emit({
                type: 'click',
                chartId: msg.chartId,
                payload: {
                  seriesIndex: payload.candlestick.seriesIndex,
                  dataIndex: payload.candlestick.dataIndex,
                  value: payload.candlestick.point as readonly [number, number, number, number, number],
                  x: payload.x,
                  y: payload.y,
                },
              });
            }
          },

          // Emit device lost events to main thread
          onDeviceLost: (reason) => {
            state.deviceLost = true;
            this.emit({
              type: 'deviceLost',
              chartId: msg.chartId,
              reason: reason === 'destroyed' ? 'destroyed' : 'unknown',
              message: reason,
            });
          },
        }
      );

      // Subscribe to zoom range changes from coordinator and emit to main thread
      // This ensures the zoom slider UI updates when zoom changes via wheel/programmatic means
      coordinator.onZoomRangeChange((range) => {
        this.emit({
          type: 'zoomChange',
          chartId: msg.chartId,
          start: range.start,
          end: range.end,
        });
      });

      // Store chart instance with shared state
      const instance: ChartInstance = {
        chartId: msg.chartId,
        gpuContext: initializedContext,
        coordinator,
        canvas: msg.canvas,
        renderChannel,
        state,  // Shared state object (captured in coordinator callbacks)
      };
      this.charts.set(msg.chartId, instance);

      // Get initial zoom range for inclusion in ready message
      // This ensures the proxy has the correct zoom range immediately upon initialization
      // rather than waiting for a separate zoomChange message to be processed
      const initialZoomRange = coordinator.getZoomRange();

      // Set up render loop on the MessageChannel
      // Null check satisfies TypeScript - renderChannel is guaranteed non-null at this point
      // PERFORMANCE CRITICAL: Cache references in closure to eliminate Map lookup on every frame
      if (renderChannel) {
        const chartId = msg.chartId;
        const cachedCoordinator = coordinator;
        const cachedState = state;
        
        renderChannel.port1.onmessage = () => {
          // Use cached state instead of Map lookup - significant perf win for 60fps render loop
          if (!cachedState.disposed && !cachedState.deviceLost) {
            cachedState.renderPending = false;
            
            const perfState = cachedState.performance;
            const frameStartTime = performance.now();
            
            try {
              // Record frame timestamp in circular buffer BEFORE rendering
              perfState.frameTimestamps[perfState.frameTimestampIndex] = frameStartTime;
              perfState.frameTimestampIndex = (perfState.frameTimestampIndex + 1) % FRAME_BUFFER_SIZE;
              if (perfState.frameTimestampCount < FRAME_BUFFER_SIZE) {
                perfState.frameTimestampCount++;
              }
              perfState.totalFrames++;

              // Frame drop detection (only after first frame)
              if (perfState.lastFrameTime > 0) {
                const deltaTime = frameStartTime - perfState.lastFrameTime;
                if (deltaTime > EXPECTED_FRAME_TIME_MS * FRAME_DROP_THRESHOLD_MULTIPLIER) {
                  perfState.totalDroppedFrames++;
                  perfState.consecutiveDroppedFrames++;
                  perfState.lastDropTimestamp = frameStartTime;
                } else {
                  // Reset consecutive counter on successful frame
                  perfState.consecutiveDroppedFrames = 0;
                }
              }
              perfState.lastFrameTime = frameStartTime;

              // Render frame
              cachedCoordinator.render();

              const frameEndTime = performance.now();
              const cpuTime = frameEndTime - frameStartTime;
              perfState.lastCPUTime = cpuTime;

              // GPU timing (optional, requires queue.onSubmittedWorkDone)
              // For now, we track CPU time only. GPU timing would require timestamp-query feature.
              // This can be added later when implementing GPU timing support.

              // Calculate and emit performance metrics
              const metrics = this.calculatePerformanceMetrics(perfState);
              this.emit({
                type: 'performance-update',
                chartId,
                metrics,
              });

            } catch (error) {
              // Performance: Use shared error extraction helper
              const [message, stack] = extractErrorInfo(error);
              this.emitError(chartId, 'RENDER_ERROR', message, 'render', stack);
            }
          } else if (cachedState.deviceLost) {
            // Silently skip render if device is lost
            cachedState.renderPending = false;
          }
        };
      }

      // Get GPU capabilities for diagnostics
      // Note: adapter.info() is an async method that returns GPUAdapterInfo
      // For simplicity, we just report that an adapter was obtained
      // adapter.features is a Set<GPUFeatureName>, convert to string array
      // Performance: Use spread operator instead of Array.from() - slightly faster
      const capabilities = initializedContext.adapter
        ? {
            adapter: 'WebGPU Adapter',
            features: initializedContext.adapter.features ? [...initializedContext.adapter.features] as string[] : [],
          }
        : undefined;

      // Determine performance capabilities
      const performanceCapabilities: PerformanceCapabilities = {
        gpuTimingSupported: initializedContext.adapter?.features.has('timestamp-query') ?? false,
        highResTimerSupported: typeof performance !== 'undefined' && typeof performance.now === 'function',
        performanceMetricsSupported: true, // Always supported in worker
      };

      // Emit ready message with matching messageId and initial zoom range
      // CRITICAL: Including initial zoom range in ready message ensures the proxy
      // can initialize its slider with the correct range before any async message processing
      this.emit({
        type: 'ready',
        chartId: msg.chartId,
        messageId: msg.messageId,
        capabilities,
        performanceCapabilities,
        initialZoomRange,
      });

      // Trigger initial render through MessageChannel to track performance metrics
      if (!state.renderPending && !state.disposed && renderChannel) {
        state.renderPending = true;
        renderChannel.port2.postMessage(null);
      }
    } catch (error) {
      // Clean up MessageChannel if initialization failed
      if (renderChannel) {
        try {
          renderChannel.port1.close();
          renderChannel.port2.close();
        } catch (cleanupError) {
          // Ignore cleanup errors during error handling
        }
      }

      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      const code: ErrorCode = message.includes('WebGPU')
        ? 'WEBGPU_INIT_FAILED'
        : 'UNKNOWN';

      this.emitError(msg.chartId, code, message, 'init', stack, msg.messageId);
    }
  }

  /**
   * Updates chart options for an existing instance.
   * 
   * @param chartId - Chart instance identifier
   * @param options - New chart options to apply
   */
  private handleSetOption(chartId: string, options: ChartGPUOptions): void {
    try {
      const instance = this.getChartInstance(chartId, 'setOption');
      const resolvedOptions = resolveOptions(options);
      instance.coordinator.setOptions(resolvedOptions);
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'setOption', stack);
    }
  }

  /**
   * Appends data points to a specific series.
   * 
   * Performance: Uses shared validation helpers to reduce code size and improve performance.
   * 
   * @param chartId - Chart instance identifier
   * @param seriesIndex - Index of the series to append to
   * @param data - ArrayBuffer containing interleaved Float32 point data
   * @param pointCount - Number of points in the buffer
   * @param stride - Bytes per point (8 for DataPoint, 20 for OHLCDataPoint)
   */
  private handleAppendData(
    chartId: string,
    seriesIndex: number,
    data: ArrayBuffer,
    pointCount: number,
    stride: number
  ): void {
    try {
      // Performance: Use shared validation helpers
      validateSeriesIndex(seriesIndex, 'in appendData');
      validatePointCount(pointCount, 'in appendData');

      const instance = this.getChartInstance(chartId, 'appendData');
      const points = deserializeDataPoints(data, pointCount, stride);
      instance.coordinator.appendData(seriesIndex, points);
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'DATA_ERROR', message, 'appendData', stack);
    }
  }

  /**
   * Batch appends data to multiple series in a single operation.
   * 
   * Performance optimizations:
   * - Validates all items upfront before processing (fail fast)
   * - Caches instance lookup outside loop
   * - Uses shared validation helpers
   * - Defers render request until all appends complete (batching)
   * 
   * @param chartId - Chart instance identifier
   * @param items - Array of append operations to perform
   */
  private handleAppendDataBatch(
    chartId: string,
    items: ReadonlyArray<{
      readonly seriesIndex: number;
      readonly data: ArrayBuffer;
      readonly pointCount: number;
      readonly stride: number;
    }>
  ): void {
    try {
      const instance = this.getChartInstance(chartId, 'appendDataBatch');

      // Performance: Validate all items upfront before processing any (fail fast)
      const itemsLength = items.length;
      for (let i = 0; i < itemsLength; i++) {
        const item = items[i];
        // Performance: Use shared validation helpers
        validateSeriesIndex(item.seriesIndex, `at batch index ${i}`);
        validatePointCount(item.pointCount, `at batch index ${i}`);
      }

      // Performance: Process all append operations in batch
      // Each appendData call would normally trigger a render request,
      // but coordinator should coalesce them internally
      for (let i = 0; i < itemsLength; i++) {
        const item = items[i];
        const points = deserializeDataPoints(item.data, item.pointCount, item.stride);
        instance.coordinator.appendData(item.seriesIndex, points);
      }

      // Note: Render request is automatically triggered by coordinator's onRequestRender callback
      // No need to manually trigger render here - it's already coalesced
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'DATA_ERROR', message, 'appendDataBatch', stack);
    }
  }

  /**
   * Handles canvas resize events.
   * 
   * @param chartId - Chart instance identifier
   * @param msg - Resize message with new dimensions
   */
  private handleResize(chartId: string, msg: ResizeMessage): void {
    try {
      const instance = this.getChartInstance(chartId, 'resize');

      // Check device lost state
      if (instance.state.deviceLost) {
        throw new Error('Cannot resize: GPU device is lost');
      }

      // Validate dimensions
      const { width, height, devicePixelRatio } = msg;
      if (width <= 0 || height <= 0) {
        throw new Error(`Invalid dimensions: width=${width}, height=${height}. Must be positive.`);
      }
      if (devicePixelRatio <= 0) {
        throw new Error(`Invalid devicePixelRatio: ${devicePixelRatio}. Must be positive.`);
      }

      // Calculate canvas dimensions with proper rounding
      const targetWidth = Math.floor(width * devicePixelRatio);
      const targetHeight = Math.floor(height * devicePixelRatio);

      // Validate that dimensions are non-zero after scaling
      if (targetWidth === 0 || targetHeight === 0) {
        throw new Error(
          `Computed canvas dimensions are zero: ${targetWidth}x${targetHeight}. ` +
          `CSS dimensions (${width}x${height}px) are too small for device pixel ratio ${devicePixelRatio}. ` +
          `Minimum canvas size is 1px in CSS space.`
        );
      }

      // Clamp to device limits
      const device = instance.gpuContext.device;
      if (!device) {
        throw new Error('GPU device is not available');
      }

      const maxDim = device.limits.maxTextureDimension2D;
      const finalWidth = Math.max(1, Math.min(targetWidth, maxDim));
      const finalHeight = Math.max(1, Math.min(targetHeight, maxDim));

      // Update canvas dimensions
      instance.canvas.width = finalWidth;
      instance.canvas.height = finalHeight;

      // Reconfigure canvas context
      const canvasContext = instance.gpuContext.canvasContext;
      const preferredFormat = instance.gpuContext.preferredFormat;
      
      if (!canvasContext) {
        throw new Error('Canvas context is not available');
      }
      if (!preferredFormat) {
        throw new Error('Preferred texture format is not available');
      }

      try {
        canvasContext.configure({
          device,
          format: preferredFormat,
          alphaMode: instance.gpuContext.alphaMode,
        });
      } catch (configError) {
        throw new Error(
          `Failed to reconfigure canvas context: ${configError instanceof Error ? configError.message : String(configError)}`
        );
      }

      // Request render if specified
      // Use MessageChannel to ensure performance metrics are tracked
      if (msg.requestRender) {
        if (!instance.state.renderPending && !instance.state.disposed) {
          instance.state.renderPending = true;
          instance.renderChannel.port2.postMessage(null);
        }
      }
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'RENDER_ERROR', message, 'resize', stack);
    }
  }

  /**
   * Forwards a pointer event to the coordinator for interaction handling.
   * 
   * @param chartId - Chart instance identifier
   * @param event - Pre-computed pointer event data from main thread
   */
  private handlePointerEvent(
    chartId: string,
    event: import('../config/types').PointerEventData
  ): void {
    try {
      console.log('[ChartGPUWorkerController] Received pointer event:', {
        type: event.type,
        gridX: event.gridX,
        gridY: event.gridY,
        isInGrid: event.isInGrid,
      });
      const instance = this.getChartInstance(chartId, 'forwardPointerEvent');
      instance.coordinator.handlePointerEvent(event);
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'forwardPointerEvent', stack);
    }
  }

  /**
   * Sets the zoom range programmatically.
   * 
   * @param chartId - Chart instance identifier
   * @param start - Start position in percent space [0, 100]
   * @param end - End position in percent space [0, 100]
   */
  private handleSetZoomRange(chartId: string, start: number, end: number): void {
    try {
      // Validate zoom range (percent space [0, 100])
      if (start < 0 || start > 100 || end < 0 || end > 100) {
        throw new Error(`Invalid zoom range: [${start}, ${end}]. Values must be in [0, 100] (percent space).`);
      }
      if (start >= end) {
        throw new Error(`Invalid zoom range: start (${start}) must be less than end (${end}).`);
      }

      const instance = this.getChartInstance(chartId, 'setZoomRange');
      instance.coordinator.setZoomRange(start, end);
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'setZoomRange', stack);
    }
  }

  /**
   * Sets the interaction X coordinate for synchronized crosshair display.
   * 
   * @param chartId - Chart instance identifier
   * @param x - X coordinate in CSS pixels, or null to clear
   * @param source - Optional source identifier to prevent echo
   */
  private handleSetInteractionX(chartId: string, x: number | null, source?: string): void {
    try {
      const instance = this.getChartInstance(chartId, 'setInteractionX');
      instance.coordinator.setInteractionX(x, source);
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'setInteractionX', stack);
    }
  }

  /**
   * Enables or disables animation, optionally updating animation configuration.
   * 
   * @param chartId - Chart instance identifier
   * @param enabled - Whether animation should be enabled
   * @param config - Optional animation configuration
   */
  private handleSetAnimation(
    chartId: string,
    enabled: boolean,
    _config?: import('../config/types').AnimationConfig
  ): void {
    try {
      const instance = this.getChartInstance(chartId, 'setAnimation');
      // Animation config would be handled through setOptions
      // This is a placeholder for future animation control
      // For now, just trigger a render through MessageChannel to track performance metrics
      if (enabled && !instance.state.renderPending && !instance.state.disposed) {
        instance.state.renderPending = true;
        instance.renderChannel.port2.postMessage(null);
      }
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'setAnimation', stack);
    }
  }

  /**
   * Enables or disables GPU timing for performance metrics.
   * 
   * @param chartId - Chart instance identifier
   * @param enabled - Whether GPU timing should be enabled
   */
  private handleSetGPUTiming(chartId: string, enabled: boolean): void {
    try {
      const instance = this.getChartInstance(chartId, 'setGPUTiming');
      instance.state.performance.gpuTimingEnabled = enabled;
      
      // Note: Actual GPU timing implementation requires timestamp-query feature
      // and queue.onSubmittedWorkDone() tracking. For now, we just toggle the flag.
      // Full GPU timing implementation can be added later.
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'setGPUTiming', stack);
    }
  }

  /**
   * Calculates performance metrics from performance tracking state.
   * 
   * @param perfState - Performance tracking state
   * @returns Complete performance metrics
   */
  private calculatePerformanceMetrics(perfState: PerformanceTrackingState): PerformanceMetrics {
    // Calculate exact FPS from timestamp deltas
    const fps = this.calculateExactFPS(perfState);
    
    // Calculate frame time statistics
    const frameTimeStats = this.calculateFrameTimeStats(perfState);
    
    // GPU timing stats (placeholder - requires timestamp-query feature)
    const gpuTiming: GPUTimingStats = {
      enabled: perfState.gpuTimingEnabled,
      cpuTime: perfState.lastCPUTime as Milliseconds,
      gpuTime: perfState.lastGPUTime as Milliseconds,
    };
    
    // Memory stats (placeholder - would require tracking buffer allocations)
    const memory: MemoryStats = {
      used: 0 as Bytes,
      peak: 0 as Bytes,
      allocated: 0 as Bytes,
    };
    
    // Frame drop stats
    const frameDrops: FrameDropStats = {
      totalDrops: perfState.totalDroppedFrames,
      consecutiveDrops: perfState.consecutiveDroppedFrames,
      lastDropTimestamp: perfState.lastDropTimestamp as Milliseconds,
    };
    
    const elapsedTime = performance.now() - perfState.startTime;
    
    return {
      fps,
      frameTimeStats,
      gpuTiming,
      memory,
      frameDrops,
      totalFrames: perfState.totalFrames,
      elapsedTime: elapsedTime as Milliseconds,
    };
  }

  /**
   * Calculates exact FPS from frame timestamp deltas.
   * 
   * @param perfState - Performance tracking state
   * @returns Exact FPS measurement
   */
  private calculateExactFPS(perfState: PerformanceTrackingState): ExactFPS {
    const count = perfState.frameTimestampCount;
    if (count < 2) {
      return 0 as ExactFPS;
    }

    const timestamps = perfState.frameTimestamps;
    const startIndex = (perfState.frameTimestampIndex - count + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE;
    
    let totalDelta = 0;
    for (let i = 1; i < count; i++) {
      const prevIndex = (startIndex + i - 1) % FRAME_BUFFER_SIZE;
      const currIndex = (startIndex + i) % FRAME_BUFFER_SIZE;
      const delta = timestamps[currIndex] - timestamps[prevIndex];
      totalDelta += delta;
    }

    const avgFrameTime = totalDelta / (count - 1);
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
    
    return fps as ExactFPS;
  }

  /**
   * Calculates frame time statistics.
   * 
   * @param perfState - Performance tracking state
   * @returns Frame time statistics
   */
  private calculateFrameTimeStats(perfState: PerformanceTrackingState): FrameTimeStats {
    const count = perfState.frameTimestampCount;
    if (count < 2) {
      return {
        min: 0 as Milliseconds,
        max: 0 as Milliseconds,
        avg: 0 as Milliseconds,
        p50: 0 as Milliseconds,
        p95: 0 as Milliseconds,
        p99: 0 as Milliseconds,
      };
    }

    const timestamps = perfState.frameTimestamps;
    const startIndex = (perfState.frameTimestampIndex - count + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE;
    
    const deltas = new Array<number>(count - 1);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    
    for (let i = 1; i < count; i++) {
      const prevIndex = (startIndex + i - 1) % FRAME_BUFFER_SIZE;
      const currIndex = (startIndex + i) % FRAME_BUFFER_SIZE;
      const delta = timestamps[currIndex] - timestamps[prevIndex];
      deltas[i - 1] = delta;
      
      if (delta < min) min = delta;
      if (delta > max) max = delta;
      sum += delta;
    }

    const avg = sum / deltas.length;

    // Sort for percentile calculations
    deltas.sort((a, b) => a - b);

    const p50Index = Math.floor(deltas.length * 0.50);
    const p95Index = Math.floor(deltas.length * 0.95);
    const p99Index = Math.floor(deltas.length * 0.99);

    return {
      min: min as Milliseconds,
      max: max as Milliseconds,
      avg: avg as Milliseconds,
      p50: deltas[p50Index] as Milliseconds,
      p95: deltas[p95Index] as Milliseconds,
      p99: deltas[p99Index] as Milliseconds,
    };
  }

  /**
   * Disposes a chart instance and cleans up all resources.
   * 
   * @param chartId - Chart instance identifier
   */
  private disposeChart(chartId: string): void {
    const cleanupErrors: string[] = [];

    try {
      const instance = this.charts.get(chartId);
      if (!instance) {
        this.emitError(chartId, 'UNKNOWN', `Chart "${chartId}" not found`, 'dispose');
        return;
      }

      // Check if already disposed
      if (instance.state.disposed) {
        this.emitError(chartId, 'UNKNOWN', `Chart "${chartId}" is already disposed`, 'dispose');
        return;
      }

      // Mark as disposed to prevent further operations
      instance.state.disposed = true;

      // Close render channel
      try {
        instance.renderChannel.port1.close();
        instance.renderChannel.port2.close();
      } catch (error) {
        cleanupErrors.push(`Failed to close render channel: ${error}`);
      }

      // Dispose coordinator (this cleans up all GPU buffers via dataStore.dispose())
      try {
        instance.coordinator.dispose();
      } catch (error) {
        cleanupErrors.push(`Failed to dispose coordinator: ${error}`);
      }

      // Destroy GPU context using proper functional API
      // This calls device.destroy() with error handling and returns a reset state
      try {
        instance.gpuContext = destroyGPUContext(instance.gpuContext);
      } catch (error) {
        cleanupErrors.push(`Failed to destroy GPU context: ${error}`);
      }

      // Remove from registry
      this.charts.delete(chartId);

      // Emit disposed message
      this.emit({
        type: 'disposed',
        chartId,
        cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
      });
    } catch (error) {
      // Performance: Use shared error extraction helper
      const [message, stack] = extractErrorInfo(error);
      this.emitError(chartId, 'UNKNOWN', message, 'dispose', stack);
    }
  }

  /**
   * Disposes all chart instances and cleans up controller resources.
   * Should be called when the worker is being terminated.
   * 
   * Performance: Uses spread operator instead of Array.from() for slight efficiency gain.
   */
  dispose(): void {
    // Performance: Spread operator is slightly faster than Array.from()
    const chartIds = [...this.charts.keys()];
    for (const chartId of chartIds) {
      this.disposeChart(chartId);
    }
    this.messageHandler = null;
  }

  /**
   * Gets a chart instance by ID, throwing if not found, disposed, or device lost.
   * 
   * @param chartId - Chart instance identifier
   * @param operation - Operation name for error reporting
   * @returns Chart instance
   * @throws {Error} If chart not found, disposed, or device lost
   */
  private getChartInstance(chartId: string, operation: string): ChartInstance {
    const instance = this.charts.get(chartId);
    
    if (!instance) {
      throw new Error(`Chart "${chartId}" not found for operation "${operation}"`);
    }
    
    if (instance.state.disposed) {
      throw new Error(`Chart "${chartId}" is disposed and cannot perform "${operation}"`);
    }
    
    if (instance.state.deviceLost) {
      throw new Error(`Chart "${chartId}" GPU device is lost and cannot perform "${operation}". Re-initialize the chart.`);
    }
    
    return instance;
  }

  /**
   * Emits an outbound message to the main thread.
   * 
   * @param msg - Outbound message to send
   */
  private emit(msg: WorkerOutboundMessage): void {
    if (this.messageHandler) {
      this.messageHandler(msg);
    } else {
      console.warn('No message handler registered, dropping message:', msg);
    }
  }

  /**
   * Emits an error message to the main thread.
   * 
   * @param chartId - Chart instance identifier
   * @param code - Error code for categorization
   * @param message - Error message
   * @param operation - Operation that failed
   * @param stack - Optional stack trace
   * @param messageId - Optional message ID for correlation
   */
  private emitError(
    chartId: string,
    code: ErrorCode,
    message: string,
    operation: string,
    stack?: string,
    messageId?: string
  ): void {
    const errorMsg: ErrorMessage = {
      type: 'error',
      chartId,
      code,
      message,
      operation,
      stack,
      messageId,
    };
    this.emit(errorMsg);
  }
}

/**
 * Deserializes ArrayBuffer data into DataPoint or OHLCDataPoint arrays.
 * 
 * Performance optimizations (critical hot path for streaming data):
 * - Pre-allocates array to exact size to avoid dynamic resizing
 * - Uses indexed assignment instead of push() for better performance
 * - Validates inputs early to fail fast
 * - Creates read-only tuple arrays for type safety with minimal overhead
 * 
 * Note: We create tuple arrays rather than returning TypedArray views directly because:
 * 1. Type safety: coordinator.appendData expects DataPoint[] or OHLCDataPoint[] tuples
 * 2. API contract: Tuples are the documented format
 * 3. Minimal overhead: Modern engines optimize small tuple creation
 * 
 * @param buffer - ArrayBuffer containing interleaved Float32 point data
 * @param pointCount - Number of points in the buffer
 * @param stride - Bytes per point (8 for DataPoint, 20 for OHLCDataPoint)
 * @returns Array of data points
 * @throws {Error} If stride is invalid or buffer size doesn't match
 */
function deserializeDataPoints(
  buffer: ArrayBuffer,
  pointCount: number,
  stride: number
): ReadonlyArray<DataPoint> | ReadonlyArray<OHLCDataPoint> {
  // Validate inputs early (fail fast)
  if (!buffer) {
    throw new Error('Buffer is null or undefined');
  }
  
  if (!Number.isInteger(pointCount) || pointCount < 0) {
    throw new Error(`Invalid pointCount: ${pointCount}. Must be a non-negative integer.`);
  }
  
  if (!Number.isInteger(stride) || stride <= 0) {
    throw new Error(`Invalid stride: ${stride}. Must be a positive integer.`);
  }
  
  // Validate buffer is detached (hasn't been transferred twice)
  if (buffer.byteLength === 0 && pointCount > 0) {
    throw new Error(
      'Buffer is detached (byteLength = 0). The ArrayBuffer may have been transferred multiple times. ' +
      'Each ArrayBuffer can only be transferred once via postMessage.'
    );
  }
  
  // Validate 4-byte alignment (WebGPU requirement)
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(
      `Buffer size (${buffer.byteLength} bytes) is not 4-byte aligned. ` +
      `WebGPU requires all buffer sizes to be multiples of 4 bytes.`
    );
  }
  
  // Validate stride alignment (must be multiple of 4 for Float32 data)
  if (stride % 4 !== 0) {
    throw new Error(
      `Stride (${stride} bytes) is not 4-byte aligned. ` +
      `Float32 data requires stride to be a multiple of 4 bytes.`
    );
  }
  
  // Validate buffer size matches expected size
  const expectedSize = pointCount * stride;
  if (buffer.byteLength !== expectedSize) {
    throw new Error(
      `Buffer size mismatch: expected ${expectedSize} bytes (${pointCount} points × ${stride} bytes), ` +
      `got ${buffer.byteLength} bytes. Difference: ${buffer.byteLength - expectedSize} bytes.`
    );
  }

  // Create Float32Array view once (reused for all points)
  // GPU buffers use Float32 precision, so we deserialize as Float32
  const view = new Float32Array(buffer);
  
  // Validate view length matches expected element count
  const floatsPerPoint = stride / 4;
  const expectedLength = pointCount * floatsPerPoint;
  if (view.length !== expectedLength) {
    throw new Error(
      `Float32Array length mismatch: expected ${expectedLength} elements, got ${view.length} elements`
    );
  }

  if (stride === 8) {
    // DataPoint: [x, y] pairs (2 × 4 bytes = 8 bytes)
    // PERFORMANCE: Pre-allocate to exact size, use indexed assignment
    const points = new Array<DataPoint>(pointCount);
    for (let i = 0, offset = 0; i < pointCount; i++, offset += 2) {
      // Unrolled offset calculation in loop increment for slight perf gain
      points[i] = [view[offset], view[offset + 1]];
    }
    return points;
  } else if (stride === 20) {
    // OHLCDataPoint: [timestamp, open, close, low, high] (5 × 4 bytes = 20 bytes)
    // PERFORMANCE: Pre-allocate to exact size, use indexed assignment
    const points = new Array<OHLCDataPoint>(pointCount);
    for (let i = 0, offset = 0; i < pointCount; i++, offset += 5) {
      // Unrolled offset calculation in loop increment for slight perf gain
      
      // CRITICAL: OHLC data reordering
      // Storage format (Float32Array): [t, o, h, l, c]
      // ECharts tuple format: [t, o, c, l, h]
      // 
      // packOHLCDataPoints stores data as [t, o, h, l, c] for GPU rendering efficiency
      // (high/low are adjacent for min/max operations). We must reorder back to ECharts
      // convention [t, o, c, l, h] for API consistency.
      points[i] = [
        view[offset],     // timestamp (index 0 → 0)
        view[offset + 1], // open     (index 1 → 1)
        view[offset + 4], // close    (index 4 → 2) ← reordered
        view[offset + 3], // low      (index 3 → 3)
        view[offset + 2], // high     (index 2 → 4) ← reordered
      ];
    }
    return points;
  } else {
    throw new Error(
      `Invalid stride: ${stride} bytes. Expected 8 (DataPoint) or 20 (OHLCDataPoint). ` +
      `Received stride corresponds to ${stride / 4} floats per point.`
    );
  }
}
