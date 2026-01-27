/**
 * Worker communication protocol types for ChartGPU.
 * Defines message types for main thread ↔ worker thread communication.
 * 
 * ## Security Considerations
 * 
 * **Worker Message Validation**:
 * - All inbound messages MUST validate chartId to prevent cross-chart contamination
 * - Buffer sizes MUST be validated against expected stride × pointCount to prevent buffer overruns
 * - Numeric parameters (dimensions, indices) MUST be validated as non-negative integers
 * - Device pixel ratio MUST be validated as positive to prevent division by zero
 * 
 * **Zero-Copy Transfer Security**:
 * - ArrayBuffers are transferred (not cloned), making them inaccessible to sender after transfer
 * - Worker MUST validate received buffers are not detached (byteLength > 0) before access
 * - Buffer alignment (4-byte) MUST be enforced to prevent WebGPU validation errors
 * - Maximum buffer size (~2GB per message) is enforced by browser structured clone algorithm
 * 
 * **Resource Exhaustion Protection**:
 * - Point count validation prevents excessive memory allocation
 * - Message correlation timeouts (default 30s) prevent indefinite pending request accumulation
 * - Chart disposal MUST cancel all pending requests to prevent memory leaks
 * - Worker MUST track device.lost state to prevent operations on lost contexts
 * 
 * **Type Safety**:
 * - Branded types (StrideBytes) prevent stride/offset confusion at compile time
 * - Discriminated unions ensure exhaustive message type handling
 * - Readonly modifiers prevent accidental message mutation
 * 
 * **Error Handling**:
 * - All worker errors MUST include chartId and operation context
 * - Error messages MUST NOT include sensitive data (file paths, user data)
 * - Stack traces are optional and should be sanitized in production
 */

import type {
  ChartGPUOptions,
  AnimationConfig,
  PointerEventData,
  TooltipData,
  LegendItem,
  AxisLabel,
} from '../config/types';
import type { StrideBytes } from './types';

// =============================================================================
// INBOUND MESSAGES (Main → Worker)
// =============================================================================

/**
 * Initialize a chart instance in the worker with an OffscreenCanvas.
 * The worker will set up WebGPU context and begin render loop.
 */
export interface InitMessage {
  readonly type: 'init';
  readonly chartId: string;
  /** Message ID for request/response correlation. Required for init to match with ReadyMessage. */
  readonly messageId: string;
  /** Transferred OffscreenCanvas for GPU rendering. */
  readonly canvas: OffscreenCanvas;
  readonly devicePixelRatio: number;
  readonly options: ChartGPUOptions;
  /** Optional WebGPU initialization options (power preference, feature requirements). */
  readonly gpuOptions?: {
    readonly powerPreference?: 'low-power' | 'high-performance';
    readonly requiredFeatures?: ReadonlyArray<string>;
  };
}

/**
 * Update chart configuration options.
 * Worker will merge new options and trigger re-render if needed.
 */
export interface SetOptionMessage {
  readonly type: 'setOption';
  readonly chartId: string;
  /** Optional message ID for request/response correlation. */
  readonly messageId?: string;
  readonly options: ChartGPUOptions;
}

/**
 * Append data points to a specific series.
 * Transfers ArrayBuffer ownership to worker for zero-copy performance.
 * 
 * **Data format**:
 * - Can be created from `DataPoint[]` or `OHLCDataPoint[]` arrays
 * - Can be created from pre-packed `Float32Array` or `Float64Array` typed arrays
 * - Float64Array is automatically converted to Float32Array (GPU uses Float32 precision)
 * - Typed array's `.buffer` is transferred for zero-copy performance
 * 
 * **Stride values**:
 * - `XY_STRIDE` (8 bytes): For DataPoint format [x, y] (2 × Float32)
 * - `OHLC_STRIDE` (20 bytes): For OHLCDataPoint format [t, o, h, l, c] (5 × Float32)
 * 
 * **Buffer format**:
 * - XY data: `[x0, y0, x1, y1, ...]` as Float32Array
 * - OHLC data: `[t0, o0, h0, l0, c0, t1, ...]` as Float32Array
 * 
 * **Transfer behavior**:
 * - The ArrayBuffer is transferred (not cloned)
 * - The sender's buffer becomes detached after postMessage
 * - The worker receives full ownership of the buffer
 * 
 * @see {packDataPoints} For packing DataPoint arrays
 * @see {packOHLCDataPoints} For packing OHLCDataPoint arrays
 */
export interface AppendDataMessage {
  readonly type: 'appendData';
  readonly chartId: string;
  readonly seriesIndex: number;
  /** Transferred ArrayBuffer containing interleaved Float32 point data. */
  readonly data: ArrayBuffer;
  readonly pointCount: number;
  /** Bytes per point in the buffer (XY_STRIDE=8 for [x,y], OHLC_STRIDE=20 for OHLC). */
  readonly stride: StrideBytes;
}

/**
 * Batch append data to multiple series in a single message.
 * Reduces message overhead for synchronized multi-series updates.
 */
export interface AppendDataBatchMessage {
  readonly type: 'appendDataBatch';
  readonly chartId: string;
  readonly items: ReadonlyArray<{
    readonly seriesIndex: number;
    readonly data: ArrayBuffer;
    readonly pointCount: number;
    readonly stride: StrideBytes;
  }>;
}

/**
 * Notify worker of canvas resize.
 * Worker will reconfigure WebGPU surface and adjust viewport.
 */
export interface ResizeMessage {
  readonly type: 'resize';
  readonly chartId: string;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  /** If true, worker will immediately render after resize (default: false for batching). */
  readonly requestRender?: boolean;
}

/**
 * Forward a pointer event to worker for interaction handling.
 * Main thread pre-computes grid coordinates to reduce worker workload.
 */
export interface ForwardPointerEventMessage {
  readonly type: 'forwardPointerEvent';
  readonly chartId: string;
  readonly event: PointerEventData;
}

/**
 * Set the zoom range programmatically.
 * Start and end are in percent space [0, 100].
 */
export interface SetZoomRangeMessage {
  readonly type: 'setZoomRange';
  readonly chartId: string;
  /** Start position in percent space [0, 100]. */
  readonly start: number;
  /** End position in percent space [0, 100]. */
  readonly end: number;
}

/**
 * Set the interaction X coordinate for synchronized crosshair display.
 * Used by chart sync to broadcast crosshair position across multiple charts.
 */
export interface SetInteractionXMessage {
  readonly type: 'setInteractionX';
  readonly chartId: string;
  /** X coordinate in CSS pixels, or null to clear crosshair. */
  readonly x: number | null;
  /** Optional source identifier to prevent echo (e.g., chart instance ID). */
  readonly source?: string;
}

/**
 * Enable or disable animation, optionally updating animation configuration.
 */
export interface SetAnimationMessage {
  readonly type: 'setAnimation';
  readonly chartId: string;
  readonly enabled: boolean;
  /** Optional animation config to apply when enabling. */
  readonly config?: AnimationConfig;
}

/**
 * Dispose a chart instance in the worker.
 * Worker will clean up GPU resources and remove the chart from its registry.
 */
export interface DisposeMessage {
  readonly type: 'dispose';
  readonly chartId: string;
}

// =============================================================================
// OUTBOUND MESSAGES (Worker → Main)
// =============================================================================

/**
 * Worker has successfully initialized the chart and is ready to render.
 * Response to InitMessage with matching messageId.
 */
export interface ReadyMessage {
  readonly type: 'ready';
  readonly chartId: string;
  /** Matches the messageId from InitMessage. */
  readonly messageId: string;
  /** Optional GPU capabilities info for diagnostics. */
  readonly capabilities?: {
    readonly adapter: string;
    readonly features: ReadonlyArray<string>;
  };
}

/**
 * Worker has completed a render frame.
 * Emitted after each requestAnimationFrame render pass.
 */
export interface RenderedMessage {
  readonly type: 'rendered';
  readonly chartId: string;
  readonly frameNumber: number;
  readonly timestamp: number;
  readonly deltaTime: number;
  /** True if render was triggered by explicit request (vs. animation tick). */
  readonly renderRequested: boolean;
}

/**
 * Tooltip data update.
 * Emitted when pointer hover triggers tooltip change.
 */
export interface TooltipUpdateMessage {
  readonly type: 'tooltipUpdate';
  readonly chartId: string;
  /** Tooltip data, or null if tooltip should be hidden. */
  readonly data: TooltipData | null;
}

/**
 * Legend items update.
 * Emitted when series configuration changes affect legend display.
 */
export interface LegendUpdateMessage {
  readonly type: 'legendUpdate';
  readonly chartId: string;
  readonly items: ReadonlyArray<LegendItem>;
}

/**
 * Axis labels update.
 * Emitted when axis scale or data range changes affect label positions.
 */
export interface AxisLabelsUpdateMessage {
  readonly type: 'axisLabelsUpdate';
  readonly chartId: string;
  readonly xLabels: ReadonlyArray<AxisLabel>;
  readonly yLabels: ReadonlyArray<AxisLabel>;
}

/**
 * Worker event payload for hover and click events.
 * Note: Cannot include PointerEvent (not cloneable for postMessage).
 */
export interface WorkerEventPayload {
  readonly seriesIndex: number;
  readonly dataIndex: number;
  readonly value: readonly [number, number] | readonly [number, number, number, number, number];
  readonly x: number;
  readonly y: number;
}

/**
 * Hover state changed event.
 * Emitted when pointer moves over/away from a data point.
 */
export interface HoverChangeMessage {
  readonly type: 'hoverChange';
  readonly chartId: string;
  /** Hover payload, or null if hover cleared. */
  readonly payload: WorkerEventPayload | null;
}

/**
 * Click event on a data point.
 * Emitted when user clicks on an interactive element.
 */
export interface ClickMessage {
  readonly type: 'click';
  readonly chartId: string;
  readonly payload: WorkerEventPayload;
}

/**
 * Crosshair position changed.
 * Emitted during pointer move for synchronized crosshair display.
 */
export interface CrosshairMoveMessage {
  readonly type: 'crosshairMove';
  readonly chartId: string;
  /** X coordinate in CSS pixels. */
  readonly x: number;
  /** Optional source identifier to prevent echo in chart sync. */
  readonly source?: string;
}

/**
 * Zoom range changed event.
 * Emitted when user interacts with zoom controls or programmatic zoom occurs.
 */
export interface ZoomChangeMessage {
  readonly type: 'zoomChange';
  readonly chartId: string;
  /** Start position in percent space [0, 100]. */
  readonly start: number;
  /** End position in percent space [0, 100]. */
  readonly end: number;
}

/**
 * WebGPU device lost event.
 * Emitted when GPU context is lost (driver crash, power management, etc.).
 */
export interface DeviceLostMessage {
  readonly type: 'deviceLost';
  readonly chartId: string;
  readonly reason: 'unknown' | 'destroyed';
  readonly message?: string;
}

/**
 * Chart instance disposed in worker.
 * Response to DisposeMessage confirming cleanup completion.
 */
export interface DisposedMessage {
  readonly type: 'disposed';
  readonly chartId: string;
  /** Array of non-fatal errors encountered during cleanup. */
  readonly cleanupErrors?: ReadonlyArray<string>;
}

/**
 * Worker error event.
 * Emitted when an operation fails (initialization, render, data processing, etc.).
 */
export interface ErrorMessage {
  readonly type: 'error';
  readonly chartId: string;
  /** Optional messageId to correlate error with specific request. */
  readonly messageId?: string;
  /** Error code for programmatic handling. */
  readonly code: 'WEBGPU_INIT_FAILED' | 'DEVICE_LOST' | 'RENDER_ERROR' | 'DATA_ERROR' | 'UNKNOWN';
  readonly message: string;
  /** Optional stack trace for debugging. */
  readonly stack?: string;
  /** Operation that failed (e.g., 'init', 'render', 'appendData'). */
  readonly operation: string;
}

// =============================================================================
// DISCRIMINATED UNIONS
// =============================================================================

/**
 * All message types sent from main thread to worker.
 */
export type WorkerInboundMessage =
  | InitMessage
  | SetOptionMessage
  | AppendDataMessage
  | AppendDataBatchMessage
  | ResizeMessage
  | ForwardPointerEventMessage
  | SetZoomRangeMessage
  | SetInteractionXMessage
  | SetAnimationMessage
  | DisposeMessage;

/**
 * All message types sent from worker to main thread.
 */
export type WorkerOutboundMessage =
  | ReadyMessage
  | RenderedMessage
  | TooltipUpdateMessage
  | LegendUpdateMessage
  | AxisLabelsUpdateMessage
  | HoverChangeMessage
  | ClickMessage
  | CrosshairMoveMessage
  | ZoomChangeMessage
  | DeviceLostMessage
  | DisposedMessage
  | ErrorMessage;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Extract Transferable objects from an inbound message for efficient postMessage.
 * Returns array of objects that should be transferred (zero-copy) rather than cloned.
 *
 * Transferable types include:
 * - OffscreenCanvas: Graphics rendering context
 * - ArrayBuffer: Binary data buffers (backing typed arrays)
 *
 * @param msg - Inbound message to extract transferables from
 * @returns Array of Transferable objects (OffscreenCanvas, ArrayBuffer, etc.)
 */
export function getTransferables(msg: WorkerInboundMessage): readonly Transferable[] {
  switch (msg.type) {
    case 'init':
      return [msg.canvas];
    case 'appendData':
      return [msg.data];
    case 'appendDataBatch':
      return msg.items.map(item => item.data);
    default:
      return [];
  }
}
