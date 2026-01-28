/**
 * ChartGPUWorkerProxy - Main-thread proxy for worker-based chart rendering.
 * 
 * Implements ChartGPUInstance interface while delegating rendering to a Web Worker.
 * Maintains local state cache for synchronous getters and provides message-based
 * communication with request/response correlation.
 * 
 * ## Architecture
 * 
 * - **Message Correlation**: Unique message IDs track request/response pairs
 * - **State Cache**: Local copies of options, disposed, interactionX, zoomRange
 * - **Event System**: Re-emits worker events to registered listeners
 * - **Timeout Handling**: 30s default timeout for async operations
 * 
 * ## Usage
 * 
 * ```typescript
 * const worker = new Worker('chart-worker.js');
 * const proxy = new ChartGPUWorkerProxy(worker, container, options);
 * await proxy.init(); // Wait for worker initialization
 * 
 * // Use like regular ChartGPUInstance
 * proxy.on('click', (payload) => console.log(payload));
 * proxy.setOption(newOptions);
 * proxy.dispose();
 * ```
 */

import type {
  ChartGPUInstance,
  ChartGPUEventName,
  ChartGPUEventCallback,
  ChartGPUCrosshairMoveCallback,
  ChartGPUEventPayload,
  ChartGPUCrosshairMovePayload,
} from '../ChartGPU';
import type {
  ChartGPUOptions,
  DataPoint,
  OHLCDataPoint,
  PointerEventData,
  PerformanceMetrics,
  PerformanceCapabilities,
} from '../config/types';
import type { ThemeConfig } from '../themes/types';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  ReadyMessage,
  TooltipUpdateMessage,
  LegendUpdateMessage,
  AxisLabelsUpdateMessage,
} from './protocol';
import type { WorkerConfig, PendingRequest, StrideBytes } from './types';
import { ChartGPUWorkerError, XY_STRIDE, OHLC_STRIDE } from './types';
import { createTooltip } from '../components/createTooltip';
import type { Tooltip } from '../components/createTooltip';
import { createLegend } from '../components/createLegend';
import type { Legend } from '../components/createLegend';
import { createTextOverlay } from '../components/createTextOverlay';
import type { TextOverlay } from '../components/createTextOverlay';
import { createDataZoomSlider } from '../components/createDataZoomSlider';
import type { DataZoomSlider } from '../components/createDataZoomSlider';
import { createZoomState } from '../interaction/createZoomState';
import type { ZoomState } from '../interaction/createZoomState';
import { addAxisLabelsToOverlay } from '../utils/axisLabelStyling';

type AnyChartGPUEventCallback = ChartGPUEventCallback | ChartGPUCrosshairMoveCallback;

/**
 * Generates a unique message ID for request/response correlation.
 * Uses timestamp + counter for collision resistance.
 */
let messageIdCounter = 0;
function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

/**
 * Generates a unique chart ID for worker communication.
 * Uses timestamp + random suffix for collision resistance.
 */
function generateChartId(): string {
  return `chart_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// Data zoom slider overlay reserves bottom chart space (CSS px).
// Keep in sync with ChartGPU.ts and createDataZoomSliderHost() in this file.
const DATA_ZOOM_SLIDER_RESERVE_CSS_PX = 40;

/**
 * Serializes DataPoint or OHLCDataPoint arrays to ArrayBuffer for zero-copy transfer.
 * 
 * Uses Float32Array for GPU compatibility (GPUs use Float32 precision).
 * 
 * @param points - Array of data points to serialize
 * @returns Tuple of [ArrayBuffer, stride] where stride is 8 for DataPoint, 20 for OHLCDataPoint
 */
function serializeDataPoints(
  points: ReadonlyArray<DataPoint> | ReadonlyArray<OHLCDataPoint>
): [ArrayBuffer, number] {
  if (points.length === 0) {
    return [new ArrayBuffer(0), 0];
  }

  // Detect point type from first element
  const firstPoint = points[0];
  const isOHLC = Array.isArray(firstPoint)
    ? firstPoint.length === 5
    : 'timestamp' in firstPoint && 'open' in firstPoint;

  if (isOHLC) {
    // OHLCDataPoint: [timestamp, open, close, low, high] (5 × 4 bytes = 20 bytes)
    const stride = 20;
    const buffer = new ArrayBuffer(points.length * stride);
    const view = new Float32Array(buffer);
    
    for (let i = 0, offset = 0; i < points.length; i++, offset += 5) {
      const p = points[i] as OHLCDataPoint;
      if (Array.isArray(p)) {
        view[offset] = p[0];     // timestamp
        view[offset + 1] = p[1]; // open
        view[offset + 2] = p[2]; // close
        view[offset + 3] = p[3]; // low
        view[offset + 4] = p[4]; // high
      } else {
        // Type assertion: we know it's OHLCDataPointObject at this point
        const ohlcObj = p as import('../config/types').OHLCDataPointObject;
        view[offset] = ohlcObj.timestamp;
        view[offset + 1] = ohlcObj.open;
        view[offset + 2] = ohlcObj.close;
        view[offset + 3] = ohlcObj.low;
        view[offset + 4] = ohlcObj.high;
      }
    }
    
    return [buffer, stride];
  } else {
    // DataPoint: [x, y] pairs (2 × 4 bytes = 8 bytes)
    const stride = 8;
    const buffer = new ArrayBuffer(points.length * stride);
    const view = new Float32Array(buffer);
    
    for (let i = 0, offset = 0; i < points.length; i++, offset += 2) {
      const p = points[i] as DataPoint;
      if (Array.isArray(p)) {
        view[offset] = p[0];     // x
        view[offset + 1] = p[1]; // y
      } else {
        // Type assertion: we know it's { x, y } at this point
        const dataObj = p as { x: number; y: number };
        view[offset] = dataObj.x;
        view[offset + 1] = dataObj.y;
      }
    }
    
    return [buffer, stride];
  }
}

/**
 * Pending overlay updates for RAF batching.
 */
type PendingOverlayUpdates = {
  tooltip?: TooltipUpdateMessage;
  legend?: LegendUpdateMessage;
  axisLabels?: AxisLabelsUpdateMessage;
};

/**
 * Computes PointerEventData fields from a PointerEvent and canvas element.
 * Calculates canvas-local coordinates, grid margins, plot dimensions, and isInGrid flag.
 * 
 * This function provides the same coordinate calculation logic as the main-thread
 * createEventManager.ts to ensure parity between worker and non-worker charts.
 * 
 * CRITICAL: Accounts for slider bottom-space reservation to prevent grid/isInGrid mismatch.
 * When a slider-type dataZoom is configured, the worker chart reserves additional bottom
 * space (40px) for the slider overlay. This function must apply the same reservation to
 * ensure pointer events are correctly classified as inside/outside the grid.
 * 
 * @param event - Native PointerEvent from canvas
 * @param canvas - Canvas element for getBoundingClientRect()
 * @param options - Chart options for grid margin defaults
 * @returns PointerEventData without the 'type' field (caller adds type)
 */
function computePointerEventData(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  options: ChartGPUOptions
): Omit<PointerEventData, 'type'> {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  // Compute base grid margins from options (match defaults in createEventManager.ts)
  const plotLeftCss = options.grid?.left ?? 60;
  const plotTopCss = options.grid?.top ?? 40;
  const plotRightCss = options.grid?.right ?? 20;
  let plotBottomCss = options.grid?.bottom ?? 40;
  
  // CRITICAL: Account for slider bottom-space reservation
  // When slider dataZoom exists, resolveOptionsForChart adds 40px to grid.bottom
  // to prevent x-axis labels from being overlaid by the slider. This function must
  // apply the SAME reservation to ensure pointer events are correctly classified.
  // Without this, events near the bottom edge would be incorrectly marked as isInGrid=true
  // when they're actually over the slider overlay.
  const hasSliderZoom = options.dataZoom?.some((z) => z?.type === 'slider') ?? false;
  if (hasSliderZoom) {
    plotBottomCss += DATA_ZOOM_SLIDER_RESERVE_CSS_PX;
  }
  
  // Compute plot dimensions
  const plotWidthCss = rect.width - plotLeftCss - plotRightCss;
  const plotHeightCss = rect.height - plotTopCss - plotBottomCss;
  
  // Compute grid-local coordinates
  const gridX = x - plotLeftCss;
  const gridY = y - plotTopCss;
  
  // Check if pointer is inside the grid/plot area
  const isInGrid = gridX >= 0 && gridX <= plotWidthCss && gridY >= 0 && gridY <= plotHeightCss;
  
  return {
    x,
    y,
    gridX,
    gridY,
    plotWidthCss,
    plotHeightCss,
    isInGrid,
    timestamp: event.timeStamp,
  };
}


/**
 * ChartGPUWorkerProxy - Main-thread proxy for worker-based rendering.
 * 
 * Implements ChartGPUInstance interface, delegating all rendering to a Web Worker
 * while maintaining local state cache for synchronous operations.
 */
export class ChartGPUWorkerProxy implements ChartGPUInstance {
  private readonly worker: Worker;
  private readonly chartId: string;
  private readonly messageTimeout: number;
  
  // State cache (synchronized with worker)
  private cachedOptions: ChartGPUOptions;
  private isDisposed = false;
  private isInitialized = false;
  private cachedInteractionX: number | null = null;
  private cachedZoomRange: Readonly<{ start: number; end: number }> | null = null;
  /**
   * Best-effort local series point counts used to keep dataset-aware zoom constraints
   * in sync with worker zoom behavior (especially for streaming appendData()).
   */
  private cachedSeriesPointCountsForZoom: number[] = [];
  
  // Performance metrics cache
  private cachedPerformanceMetrics: Readonly<PerformanceMetrics> | null = null;
  private cachedPerformanceCapabilities: Readonly<PerformanceCapabilities> | null = null;
  private performanceUpdateCallbacks = new Set<(metrics: Readonly<PerformanceMetrics>) => void>();
  
  // Message correlation system
  private readonly pendingRequests = new Map<string, PendingRequest>();
  
  // Event system
  private readonly listeners = new Map<ChartGPUEventName, Set<AnyChartGPUEventCallback>>();
  
  // Worker message handler (bound once)
  private readonly boundMessageHandler: (event: MessageEvent) => void;
  
  // DOM overlays
  private tooltip: Tooltip | null = null;
  private legend: Legend | null = null;
  private textOverlay: TextOverlay | null = null;
  private dataZoomSlider: DataZoomSlider | null = null;
  private dataZoomSliderHost: HTMLDivElement | null = null;
  private zoomState: ZoomState | null = null;
  
  // RAF batching for overlay updates
  private pendingOverlayUpdates: PendingOverlayUpdates = {};
  private overlayUpdateRafId: number | null = null;
  
  // Zoom echo suppression flag
  // Set to true when processing zoom changes FROM the worker to prevent sending them back
  private isProcessingWorkerZoomUpdate = false;
  
  // Event forwarding to worker
  private readonly boundEventHandlers: {
    pointerdown: ((e: PointerEvent) => void) | null;
    pointermove: ((e: PointerEvent) => void) | null;
    pointerup: ((e: PointerEvent) => void) | null;
    pointerleave: ((e: PointerEvent) => void) | null;
    wheel: ((e: WheelEvent) => void) | null;
  } = {
    pointerdown: null,
    pointermove: null,
    pointerup: null,
    pointerleave: null,
    wheel: null,
  };
  
  // RAF throttling for pointermove events
  private pendingMoveEvent: PointerEvent | null = null;
  private moveThrottleRafId: number | null = null;
  
  // Click detection state
  private tapCandidate: {
    readonly startX: number;
    readonly startY: number;
    readonly startTime: number;
  } | null = null;
  
  private readonly TAP_MAX_DISTANCE_PX = 6;
  private readonly TAP_MAX_TIME_MS = 500;
  
  // ResizeObserver and device pixel ratio monitoring
  private resizeObserver: ResizeObserver | null = null;
  private currentDpr: number = 1;
  private dprMediaQuery: MediaQueryList | null = null;
  private boundDprChangeHandler: ((e: MediaQueryListEvent) => void) | null = null;
  private pendingResize: { width: number; height: number } | null = null;
  private resizeRafId: number | null = null;
  
  /**
   * Creates a new worker-based chart proxy.
   * 
   * @param config - Worker configuration
   * @param container - HTML element to attach canvas to
   * @param options - Chart options
   */
  constructor(
    config: WorkerConfig,
    private readonly container: HTMLElement,
    options: ChartGPUOptions
  ) {
    this.worker = config.worker;
    this.chartId = config.chartId ?? generateChartId();
    this.messageTimeout = config.messageTimeout ?? 30000;
    this.cachedOptions = options;
    this.recomputeCachedSeriesPointCountsForZoom(options);
    
    // Initialize event listener maps
    this.listeners.set('click', new Set());
    this.listeners.set('mouseover', new Set());
    this.listeners.set('mouseout', new Set());
    this.listeners.set('crosshairMove', new Set());
    
    // Bind message handler once (avoid creating new function on every message)
    this.boundMessageHandler = this.handleWorkerMessage.bind(this);
    this.worker.addEventListener('message', this.boundMessageHandler);
  }

  private recomputeCachedSeriesPointCountsForZoom(options: ChartGPUOptions): void {
    const series = options.series ?? [];
    const next = new Array(series.length);
    for (let i = 0; i < series.length; i++) {
      const s: any = series[i];
      if (!s || s.type === 'pie') {
        next[i] = 0;
        continue;
      }
      const raw = (s.rawData ?? s.data) as unknown;
      next[i] = Array.isArray(raw) ? raw.length : 0;
    }
    this.cachedSeriesPointCountsForZoom = next;
  }

  private incrementCachedSeriesPointCountForZoom(seriesIndex: number, deltaPoints: number): void {
    if (!Number.isFinite(deltaPoints) || deltaPoints <= 0) return;
    const next = Math.floor(deltaPoints);
    if (next <= 0) return;

    const counts = this.cachedSeriesPointCountsForZoom;
    if (seriesIndex >= counts.length) {
      for (let i = counts.length; i <= seriesIndex; i++) counts[i] = 0;
    }
    counts[seriesIndex] = (counts[seriesIndex] ?? 0) + next;
  }
  
  /**
   * Initializes the worker chart instance.
   * Must be called before using the chart.
   * 
   * @returns Promise that resolves when worker is ready
   */
  async init(): Promise<void> {
    // Create OffscreenCanvas for worker rendering
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    // Get canvas dimensions
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    canvas.width = width;
    canvas.height = height;
    
    // Set up event listeners on canvas BEFORE transferring to worker
    this.setupEventListeners(canvas);
    
    // Set up ResizeObserver and device pixel ratio monitoring BEFORE transferring canvas
    this.setupResizeObserver(canvas);
    this.setupDevicePixelRatioMonitoring();
    
    // Create DOM overlays AFTER canvas is in DOM (overlays need container)
    this.createOverlays();
    
    // Transfer canvas to worker
    const offscreenCanvas = canvas.transferControlToOffscreen();
    
    // Send init message and wait for ready response
    await this.sendMessageWithResponse<ReadyMessage>({
      type: 'init',
      chartId: this.chartId,
      messageId: generateMessageId(),
      canvas: offscreenCanvas,
      devicePixelRatio: dpr,
      options: this.cachedOptions,
    }, [offscreenCanvas]);
  }
  
  // =============================================================================
  // Event Forwarding to Worker
  // =============================================================================
  
  /**
   * Sets up pointer and wheel event listeners on the canvas.
   * Forwards events to worker for interaction handling (hover, click, zoom, pan).
   * 
   * @param canvas - Canvas element to attach listeners to
   */
  private setupEventListeners(canvas: HTMLCanvasElement): void {
    if (this.isDisposed) return;
    
    // Pointer down handler - stores tap candidate for click detection
    // Does NOT send message yet - waits for pointer up to determine if it's a tap/click
    this.boundEventHandlers.pointerdown = (e: PointerEvent) => {
      if (this.isDisposed || !this.isInitialized) return;
      if (!e.isPrimary) return; // Only track primary pointer
      if (e.button !== 0) return; // Only left mouse button
      
      // Store tap candidate with start position and time
      this.tapCandidate = {
        startX: e.clientX,
        startY: e.clientY,
        startTime: e.timeStamp,
      };
    };
    
    // Pointer move handler - throttled to 60fps via RAF
    // 
    // PERFORMANCE: pointermove can fire at 120-500 Hz on modern devices. Without throttling,
    // this would flood the worker with messages, causing:
    // 1. Worker message queue backup (messages queued faster than processed)
    // 2. Stale hover state (processing events that are 100s of ms old)
    // 3. Excessive postMessage overhead (serialization + transfer costs)
    // 
    // RAF throttling (60fps) provides optimal balance:
    // - Smooth hover interactions (16.67ms latency is imperceptible)
    // - Reduces message rate by 2-8x (120-500 Hz → 60 Hz)
    // - Aligns with display refresh rate (no visual benefit beyond 60fps)
    // 
    // CONCURRENCY: Uses "latest event wins" strategy - only the most recent move event
    // within each RAF frame is sent. Earlier events are discarded (they're already stale).
    this.boundEventHandlers.pointermove = (e: PointerEvent) => {
      if (this.isDisposed || !this.isInitialized) return;
      
      // Store latest move event (overwrites previous if multiple events in same frame)
      this.pendingMoveEvent = e;
      
      // Schedule RAF if not already scheduled (coalesce multiple moves per frame)
      if (this.moveThrottleRafId === null) {
        this.moveThrottleRafId = requestAnimationFrame(() => {
          this.moveThrottleRafId = null;
          if (this.isDisposed || !this.isInitialized || !this.pendingMoveEvent) return;
          
          const canvas = this.container.querySelector('canvas');
          if (!canvas) return;
          
          const computed = computePointerEventData(this.pendingMoveEvent, canvas, this.cachedOptions);
          this.pendingMoveEvent = null;
          
          console.log('[ChartGPUWorkerProxy] Sending move event:', {
            gridX: computed.gridX,
            gridY: computed.gridY,
            isInGrid: computed.isInGrid,
          });
          this.sendMessage({
            type: 'forwardPointerEvent',
            chartId: this.chartId,
            event: {
              ...computed,
              type: 'move',
            },
          });
        });
      }
    };
    
    // Pointer up handler - detects clicks (taps) and sends 'click' events
    // Only sends message if tap criteria are met (distance <= 6px, time <= 500ms)
    this.boundEventHandlers.pointerup = (e: PointerEvent) => {
      if (this.isDisposed || !this.isInitialized) return;
      if (!e.isPrimary) return; // Only handle primary pointer
      
      // Check if we have a tap candidate
      if (this.tapCandidate) {
        const dt = e.timeStamp - this.tapCandidate.startTime;
        const dx = e.clientX - this.tapCandidate.startX;
        const dy = e.clientY - this.tapCandidate.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Clear tap candidate
        this.tapCandidate = null;
        
        // Check if tap criteria are met
        if (dt <= this.TAP_MAX_TIME_MS && distance <= this.TAP_MAX_DISTANCE_PX) {
          // It's a tap/click - compute coordinates and send message
          const canvas = this.container.querySelector('canvas');
          if (!canvas) return;
          
          const computed = computePointerEventData(e, canvas, this.cachedOptions);
          
          console.log('[ChartGPUWorkerProxy] Sending click event:', {
            gridX: computed.gridX,
            gridY: computed.gridY,
            isInGrid: computed.isInGrid,
          });
          this.sendMessage({
            type: 'forwardPointerEvent',
            chartId: this.chartId,
            event: {
              ...computed,
              type: 'click',
            },
          });
        }
        // If not a tap (drag or too long), ignore - don't send message
      }
    };
    
    // Pointer leave handler - clears hover state and tap candidate
    this.boundEventHandlers.pointerleave = (e: PointerEvent) => {
      if (this.isDisposed || !this.isInitialized) return;
      
      // Clear tap candidate on leave
      this.tapCandidate = null;
      
      const canvas = this.container.querySelector('canvas');
      if (!canvas) return;
      
      const computed = computePointerEventData(e, canvas, this.cachedOptions);
      
      this.sendMessage({
        type: 'forwardPointerEvent',
        chartId: this.chartId,
        event: {
          ...computed,
          type: 'leave',
        },
      });
    };
    
    // Wheel handler - for zoom interactions
    this.boundEventHandlers.wheel = (e: WheelEvent) => {
      if (this.isDisposed || !this.isInitialized) return;
      
      // Convert WheelEvent to PointerEventData with wheel-specific fields
      // Use shared logic for coordinate calculation (includes slider bottom-space)
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const plotLeftCss = this.cachedOptions.grid?.left ?? 60;
      const plotTopCss = this.cachedOptions.grid?.top ?? 40;
      const plotRightCss = this.cachedOptions.grid?.right ?? 20;
      let plotBottomCss = this.cachedOptions.grid?.bottom ?? 40;
      
      // CRITICAL: Account for slider bottom-space reservation (same as computePointerEventData)
      const hasSliderZoom = this.cachedOptions.dataZoom?.some((z) => z?.type === 'slider') ?? false;
      if (hasSliderZoom) {
        plotBottomCss += DATA_ZOOM_SLIDER_RESERVE_CSS_PX;
      }
      
      const plotWidthCss = rect.width - plotLeftCss - plotRightCss;
      const plotHeightCss = rect.height - plotTopCss - plotBottomCss;
      
      const gridX = x - plotLeftCss;
      const gridY = y - plotTopCss;
      const isInGrid = gridX >= 0 && gridX <= plotWidthCss && gridY >= 0 && gridY <= plotHeightCss;
      
      const wheelEvent: PointerEventData = {
        type: 'wheel',
        x,
        y,
        gridX,
        gridY,
        plotWidthCss,
        plotHeightCss,
        isInGrid,
        timestamp: e.timeStamp,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
      };
      
      this.sendMessage({
        type: 'forwardPointerEvent',
        chartId: this.chartId,
        event: wheelEvent,
      });
      
      // Prevent default scroll behavior when zooming
      if (isInGrid) {
        e.preventDefault();
      }
    };
    
    // Attach all event listeners
    canvas.addEventListener('pointerdown', this.boundEventHandlers.pointerdown);
    canvas.addEventListener('pointermove', this.boundEventHandlers.pointermove);
    canvas.addEventListener('pointerup', this.boundEventHandlers.pointerup);
    canvas.addEventListener('pointerleave', this.boundEventHandlers.pointerleave);
    // IMPORTANT: passive: false allows preventDefault() in wheel handler for custom zoom behavior
    // Without this, browsers may apply default scroll behavior before our handler runs
    canvas.addEventListener('wheel', this.boundEventHandlers.wheel, { passive: false });
  }
  
  /**
   * Removes all event listeners from the canvas and cleans up RAF throttling.
   */
  private cleanupEventListeners(): void {
    const canvas = this.container.querySelector('canvas');
    if (!canvas) return;
    
    // Cancel pending RAF for throttled move events
    if (this.moveThrottleRafId !== null) {
      cancelAnimationFrame(this.moveThrottleRafId);
      this.moveThrottleRafId = null;
    }
    
    // Clear pending move event
    this.pendingMoveEvent = null;
    
    // Clear tap candidate state
    this.tapCandidate = null;
    
    // Remove all event listeners
    if (this.boundEventHandlers.pointerdown) {
      canvas.removeEventListener('pointerdown', this.boundEventHandlers.pointerdown);
      this.boundEventHandlers.pointerdown = null;
    }
    if (this.boundEventHandlers.pointermove) {
      canvas.removeEventListener('pointermove', this.boundEventHandlers.pointermove);
      this.boundEventHandlers.pointermove = null;
    }
    if (this.boundEventHandlers.pointerup) {
      canvas.removeEventListener('pointerup', this.boundEventHandlers.pointerup);
      this.boundEventHandlers.pointerup = null;
    }
    if (this.boundEventHandlers.pointerleave) {
      canvas.removeEventListener('pointerleave', this.boundEventHandlers.pointerleave);
      this.boundEventHandlers.pointerleave = null;
    }
    if (this.boundEventHandlers.wheel) {
      canvas.removeEventListener('wheel', this.boundEventHandlers.wheel);
      this.boundEventHandlers.wheel = null;
    }
  }
  
  // =============================================================================
  // ResizeObserver and Device Pixel Ratio Monitoring
  // =============================================================================
  
  /**
   * Sets up ResizeObserver to monitor container size changes.
   * Uses RAF batching to throttle rapid resize events (e.g., during window drag-resize).
   * 
   * @param canvas - Canvas element to measure dimensions from
   */
  private setupResizeObserver(canvas: HTMLCanvasElement): void {
    if (this.isDisposed) return;
    
    // Track last known dimensions to avoid no-op resizes
    let lastWidth = canvas.clientWidth;
    let lastHeight = canvas.clientHeight;
    
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.isDisposed) return;
      if (!entries[0]) return;
      
      // CRITICAL: After transferControlToOffscreen(), canvas.clientWidth/Height are invalid!
      // Use contentBoxSize from ResizeObserverEntry instead
      const contentBoxSize = entries[0].contentBoxSize?.[0];
      if (!contentBoxSize) return;
      
      const newWidth = contentBoxSize.inlineSize;
      const newHeight = contentBoxSize.blockSize;
      
      // Check if dimensions actually changed (ResizeObserver can fire on layout shifts)
      if (newWidth === lastWidth && newHeight === lastHeight) {
        return; // No-op resize
      }
      
      lastWidth = newWidth;
      lastHeight = newHeight;
      
      // Store pending dimensions and schedule RAF if not already scheduled
      this.pendingResize = { width: newWidth, height: newHeight };
      
      if (this.resizeRafId === null) {
        this.resizeRafId = requestAnimationFrame(() => {
          this.resizeRafId = null;
          
          // Safety: Check disposed and pendingResize before proceeding
          if (this.isDisposed) return;
          if (!this.pendingResize) return;
          
          const { width, height } = this.pendingResize;
          this.pendingResize = null;

          // Send resize message to worker with CSS pixels
          // WorkerController will multiply by devicePixelRatio to get physical pixels
          const dpr = this.currentDpr;

          this.sendMessage({
            type: 'resize',
            chartId: this.chartId,
            width: Math.max(1, width),  // CSS pixels, minimum 1
            height: Math.max(1, height),  // CSS pixels, minimum 1
            devicePixelRatio: dpr,
            requestRender: true,
          });
        });
      }
    });
    
    // Start observing the canvas element (more precise than observing container)
    this.resizeObserver.observe(canvas);
  }
  
  /**
   * Sets up device pixel ratio monitoring using matchMedia.
   * Handles window zoom, moving between displays, and OS display scaling changes.
   */
  private setupDevicePixelRatioMonitoring(): void {
    if (this.isDisposed) return;
    
    // Initialize current DPR
    this.currentDpr = window.devicePixelRatio || 1;
    
    // Create media query for current DPR
    this.dprMediaQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);
    
    // Bind handler once to avoid creating new functions
    this.boundDprChangeHandler = (_e: MediaQueryListEvent) => {
      if (this.isDisposed) return;
      
      // DPR has changed - update tracked value
      const newDpr = window.devicePixelRatio || 1;
      if (newDpr === this.currentDpr) return;
      
      this.currentDpr = newDpr;
      
      // Recreate media query for new DPR
      if (this.dprMediaQuery && this.boundDprChangeHandler) {
        this.dprMediaQuery.removeEventListener('change', this.boundDprChangeHandler);
      }
      this.dprMediaQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);
      if (this.boundDprChangeHandler) {
        this.dprMediaQuery.addEventListener('change', this.boundDprChangeHandler);
      }
      
      // Trigger resize with new DPR
      const canvas = this.container.querySelector('canvas');
      if (!canvas) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      this.sendMessage({
        type: 'resize',
        chartId: this.chartId,
        width: Math.max(1, width),   // CSS pixels
        height: Math.max(1, height), // CSS pixels
        devicePixelRatio: this.currentDpr,
        requestRender: true,
      });
    };
    
    this.dprMediaQuery.addEventListener('change', this.boundDprChangeHandler);
  }
  
  /**
   * Cleans up ResizeObserver and device pixel ratio monitoring.
   */
  private cleanupResizeMonitoring(): void {
    // Disconnect ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // Cancel pending RAF for resize
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
    
    // Clear pending resize state
    this.pendingResize = null;
    
    // Remove DPR media query listener
    if (this.dprMediaQuery && this.boundDprChangeHandler) {
      this.dprMediaQuery.removeEventListener('change', this.boundDprChangeHandler);
      this.dprMediaQuery = null;
      this.boundDprChangeHandler = null;
    }
  }
  
  // =============================================================================
  // DOM Overlay Management
  // =============================================================================
  
  /**
   * Creates DOM overlays for tooltip, legend, text labels, and data zoom slider.
   * Called after canvas is appended to container.
   */
  private createOverlays(): void {
    if (this.isDisposed) return;
    
    // Always create tooltip (for hover interactions)
    this.tooltip = createTooltip(this.container);
    
    // Always create text overlay (for axis labels)
    this.textOverlay = createTextOverlay(this.container);
    
    // Always create legend (worker will send updates if needed)
    // Default position is 'right' - worker may override via messages
    this.legend = createLegend(this.container, 'right');
    
    // Create data zoom slider if configured
    const hasSliderZoom = this.cachedOptions.dataZoom?.some(z => z?.type === 'slider') ?? false;
    
    if (hasSliderZoom) {
      // Create zoom state that delegates to worker via setZoomRange
      const initialStart = this.cachedZoomRange?.start ?? 0;
      const initialEnd = this.cachedZoomRange?.end ?? 100;
      const constraints = this.computeZoomSpanConstraints(this.cachedOptions);
      this.zoomState = createZoomState(initialStart, initialEnd, constraints);
      
      // Sync zoom state changes to worker
      // CRITICAL: Echo suppression - only send changes to worker if they originated from UI
      // (slider drag, programmatic setZoomRange calls), NOT from worker zoom messages
      this.zoomState.onChange((range) => {
        if (this.isDisposed) return;
        
        // Prevent echo: Don't send zoom changes back to worker if they came FROM the worker
        if (this.isProcessingWorkerZoomUpdate) return;
        
        this.setZoomRange(range.start, range.end);
      });
      
      // Create slider host element with absolute positioning at bottom
      // This matches the non-worker ChartGPU implementation
      this.dataZoomSliderHost = this.createDataZoomSliderHost();
      
      // Create slider inside host with marginTop: 0 (host provides padding)
      const DATA_ZOOM_SLIDER_HEIGHT_CSS_PX = 32;
      this.dataZoomSlider = createDataZoomSlider(this.dataZoomSliderHost, this.zoomState, {
        height: DATA_ZOOM_SLIDER_HEIGHT_CSS_PX,
        marginTop: 0, // host provides vertical spacing
      });
      
      // Apply theme to slider
      const themeConfig = this.resolveThemeConfig();
      this.dataZoomSlider.update(themeConfig);
    }
  }
  
  /**
   * Creates and configures the data zoom slider host element.
   * The host is absolutely positioned at the bottom of the container.
   * 
   * @returns Host element for the data zoom slider
   */
  private createDataZoomSliderHost(): HTMLDivElement {
    // Ensure the container has a positioning context for absolute positioning
    // Only set if currently 'static' to avoid overwriting user styles
    try {
      const pos = window.getComputedStyle(this.container).position;
      if (pos === 'static') {
        this.container.style.position = 'relative';
      }
    } catch {
      // Best effort - continue even if getComputedStyle fails
    }
    
    const DATA_ZOOM_SLIDER_HEIGHT_CSS_PX = 32;
    const DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX = 8;
    const DATA_ZOOM_SLIDER_RESERVE_CSS_PX = DATA_ZOOM_SLIDER_HEIGHT_CSS_PX + DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX;
    
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.left = '0';
    host.style.right = '0';
    host.style.bottom = '0';
    host.style.height = `${DATA_ZOOM_SLIDER_RESERVE_CSS_PX}px`;
    host.style.paddingTop = `${DATA_ZOOM_SLIDER_MARGIN_TOP_CSS_PX}px`;
    host.style.boxSizing = 'border-box';
    host.style.pointerEvents = 'auto';
    host.style.zIndex = '10'; // Above canvas and other overlays
    
    this.container.appendChild(host);
    
    return host;
  }

  /**
   * Computes effective zoom span constraints for the local slider zoomState.
   *
   * This must match the worker coordinator's clamping behavior so that:
   * - slider drags clamp identically to wheel zoom in the worker
   * - UI stays perfectly in sync with worker zoomChange messages
   */
  private computeZoomSpanConstraints(
    options: ChartGPUOptions
  ): { readonly minSpan?: number; readonly maxSpan?: number } {
    const clampPercent = (v: number): number => Math.min(100, Math.max(0, v));

    // Aggregate constraints across all dataZoom configs (inside + slider share the same zoom window).
    let minSpan: number | null = null;
    let maxSpan: number | null = null;
    for (const z of options.dataZoom ?? []) {
      if (!z) continue;
      if (z.type !== 'inside' && z.type !== 'slider') continue;

      if (Number.isFinite(z.minSpan as number)) {
        const v = clampPercent(z.minSpan as number);
        minSpan = minSpan == null ? v : Math.max(minSpan, v);
      }
      if (Number.isFinite(z.maxSpan as number)) {
        const v = clampPercent(z.maxSpan as number);
        maxSpan = maxSpan == null ? v : Math.min(maxSpan, v);
      }
    }

    // Dataset-aware default: for numeric/time x axes, allow zooming to roughly one interval
    // by using 100/(N-1) where N is the densest (max-length) raw series.
    const xAxisType = options.xAxis?.type ?? 'value';
    let datasetMin: number | null = null;
    if (xAxisType !== 'category') {
      let maxPoints = 0;
      const series = options.series ?? [];
      for (let i = 0; i < series.length; i++) {
        const s: any = series[i];
        if (!s || s.type === 'pie') continue;
        const len = this.cachedSeriesPointCountsForZoom[i] ?? 0;
        maxPoints = Math.max(maxPoints, len);
      }
      if (maxPoints >= 2) {
        const v = 100 / (maxPoints - 1);
        datasetMin = Number.isFinite(v) ? clampPercent(v) : null;
      }
    }

    const effectiveMin = minSpan != null ? minSpan : datasetMin ?? 0.5;
    const effectiveMax = maxSpan != null ? maxSpan : 100;
    return { minSpan: effectiveMin, maxSpan: effectiveMax };
  }
  
  /**
   * Resolves ThemeConfig from options, handling both string presets and custom configs.
   */
  private resolveThemeConfig(): ThemeConfig {
    const theme = this.cachedOptions.theme;
    
    // Default theme values
    const defaults: ThemeConfig = {
      colorPalette: [],
      backgroundColor: '#1a1a2e',
      textColor: '#e0e0e0',
      axisLineColor: 'rgba(224,224,224,0.2)',
      axisTickColor: 'rgba(224,224,224,0.4)',
      gridLineColor: 'rgba(224,224,224,0.1)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: 12,
    };
    
    if (!theme || typeof theme === 'string') {
      // Theme is either undefined or a string preset ('dark' | 'light')
      // For now, just use defaults
      return defaults;
    }
    
    // Theme is a custom ThemeConfig object - merge with defaults
    return {
      colorPalette: theme.colorPalette ?? defaults.colorPalette,
      backgroundColor: theme.backgroundColor ?? defaults.backgroundColor,
      textColor: theme.textColor ?? defaults.textColor,
      axisLineColor: theme.axisLineColor ?? defaults.axisLineColor,
      axisTickColor: theme.axisTickColor ?? defaults.axisTickColor,
      gridLineColor: theme.gridLineColor ?? defaults.gridLineColor,
      fontFamily: theme.fontFamily ?? defaults.fontFamily,
      fontSize: theme.fontSize ?? defaults.fontSize,
    };
  }
  
  /**
   * Disposes all DOM overlays and cleans up RAF batching.
   */
  private disposeOverlays(): void {
    // Cancel any pending RAF for overlay updates
    if (this.overlayUpdateRafId !== null) {
      cancelAnimationFrame(this.overlayUpdateRafId);
      this.overlayUpdateRafId = null;
    }
    
    // Clear pending updates
    this.pendingOverlayUpdates = {};
    
    // Dispose all overlays
    this.tooltip?.dispose();
    this.tooltip = null;
    
    this.legend?.dispose();
    this.legend = null;
    
    this.textOverlay?.dispose();
    this.textOverlay = null;
    
    this.dataZoomSlider?.dispose();
    this.dataZoomSlider = null;
    
    // Remove slider host from DOM
    this.dataZoomSliderHost?.remove();
    this.dataZoomSliderHost = null;
    
    this.zoomState = null;
  }
  
  /**
   * Schedules overlay updates in the next RAF to batch multiple updates.
   * 
   * **Batching strategy**: Worker can send multiple overlay update messages per frame
   * (tooltip + legend + axis labels). By batching them in RAF, we:
   * 1. Reduce layout thrashing (DOM reads/writes grouped)
   * 2. Ensure visual consistency (all overlays update simultaneously)
   * 3. Prevent redundant style calculations (browser optimizes batched changes)
   * 
   * **Concurrency safety**: Uses overlayUpdateRafId guard to prevent duplicate RAF scheduling.
   * Multiple calls within the same frame will coalesce into a single RAF callback.
   */
  private scheduleOverlayUpdates(): void {
    if (this.isDisposed) return;
    if (this.overlayUpdateRafId !== null) return; // Already scheduled - coalesce updates
    
    this.overlayUpdateRafId = requestAnimationFrame(() => {
      this.overlayUpdateRafId = null;
      if (this.isDisposed) return;
      
      this.applyPendingOverlayUpdates();
    });
  }
  
  /**
   * Applies all pending overlay updates in a single batch.
   */
  private applyPendingOverlayUpdates(): void {
    const { tooltip: tooltipMsg, legend: legendMsg, axisLabels: axisLabelsMsg } = this.pendingOverlayUpdates;
    
    // Apply tooltip update
    if (tooltipMsg && this.tooltip) {
      if (tooltipMsg.data) {
        this.tooltip.show(tooltipMsg.data.x, tooltipMsg.data.y, tooltipMsg.data.content);
      } else {
        this.tooltip.hide();
      }
    }
    
    // Apply legend update
    if (legendMsg && this.legend) {
      // Convert LegendItem[] to minimal SeriesConfig[] for legend component
      const minimalSeries = legendMsg.items.map((item) => ({
        type: 'line' as const,
        name: item.name,
        color: item.color,
        data: [],
      }));
      
      const themeConfig = this.resolveThemeConfig();
      this.legend.update(minimalSeries, themeConfig);
    }
    
    // Apply axis labels update
    if (axisLabelsMsg && this.textOverlay) {
      // Get theme config for label styling
      const themeConfig = this.resolveThemeConfig();

      // Use shared utility for consistent styling
      addAxisLabelsToOverlay(
        this.textOverlay,
        axisLabelsMsg.xLabels,
        axisLabelsMsg.yLabels,
        themeConfig
      );
    }
    
    // Clear pending updates
    this.pendingOverlayUpdates = {};
  }
  
  // =============================================================================
  // ChartGPUInstance Interface Implementation
  // =============================================================================
  
  get options(): Readonly<ChartGPUOptions> {
    return this.cachedOptions;
  }
  
  get disposed(): boolean {
    return this.isDisposed;
  }
  
  setOption(options: ChartGPUOptions): void {
    if (this.isDisposed) {
      throw new ChartGPUWorkerError(
        'Cannot setOption on disposed chart',
        'DISPOSED',
        'setOption',
        this.chartId
      );
    }
    
    // Check if dataZoom slider needs to be added or removed
    const prevOptions = this.cachedOptions;
    const hadSliderZoom = prevOptions.dataZoom?.some(z => z?.type === 'slider') ?? false;
    const hasSliderZoom = options.dataZoom?.some(z => z?.type === 'slider') ?? false;
    
    this.cachedOptions = options;
    this.recomputeCachedSeriesPointCountsForZoom(options);
    
    // Recreate overlays if dataZoom slider presence changed
    if (hadSliderZoom !== hasSliderZoom) {
      // Dispose old overlays
      this.disposeOverlays();
      // Recreate with new configuration
      this.createOverlays();
    } else if (hasSliderZoom && this.zoomState) {
      // Update span constraints at runtime (matches worker coordinator behavior).
      const constraints = this.computeZoomSpanConstraints(options);
      const withConstraints = this.zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(
        (constraints.minSpan as number) ?? 0.5,
        (constraints.maxSpan as number) ?? 100
      );
    }
    
    this.sendMessage({
      type: 'setOption',
      chartId: this.chartId,
      options,
    });
  }
  
  /**
   * Appends data points to a series (DataPoint[] or OHLCDataPoint[] form).
   * 
   * @param seriesIndex - Index of the series to append to
   * @param newPoints - Array of data points to append
   */
  appendData(seriesIndex: number, newPoints: DataPoint[] | OHLCDataPoint[]): void;
  
  /**
   * Appends data points to a series (pre-packed typed array form for zero-copy transfer).
   * 
   * **Performance**: The typed array's underlying ArrayBuffer is transferred to the worker,
   * making the source array detached (length = 0) after the call. Use this overload when
   * you need maximum performance and can tolerate the source array becoming unusable.
   * 
   * **Usage**:
   * ```typescript
   * import { packDataPoints, XY_STRIDE } from 'chart-gpu';
   * 
   * const points = [{ x: 0, y: 10 }, { x: 1, y: 20 }];
   * const packed = packDataPoints(points);
   * chart.appendData(0, packed, 'xy');
   * // packed.length === 0 (detached after transfer)
   * ```
   * 
   * @param seriesIndex - Index of the series to append to
   * @param data - Pre-packed Float32Array or Float64Array (will be detached after call)
   * @param pointType - Type of points: 'xy' for DataPoint, 'ohlc' for OHLCDataPoint
   */
  appendData(seriesIndex: number, data: Float32Array | Float64Array, pointType: 'xy' | 'ohlc'): void;
  
  // Implementation
  appendData(
    seriesIndex: number,
    newPointsOrData: DataPoint[] | OHLCDataPoint[] | Float32Array | Float64Array,
    pointType?: 'xy' | 'ohlc'
  ): void {
    if (this.isDisposed) {
      throw new ChartGPUWorkerError(
        'Cannot appendData on disposed chart',
        'DISPOSED',
        'appendData',
        this.chartId
      );
    }
    
    if (!Number.isInteger(seriesIndex) || seriesIndex < 0) {
      throw new ChartGPUWorkerError(
        `Invalid seriesIndex: ${seriesIndex}. Must be a non-negative integer.`,
        'INVALID_ARGUMENT',
        'appendData',
        this.chartId
      );
    }
    
    // Handle typed array form (zero-copy transfer)
    if (newPointsOrData instanceof Float32Array || newPointsOrData instanceof Float64Array) {
      if (!pointType) {
        throw new ChartGPUWorkerError(
          'pointType parameter is required when passing typed arrays',
          'INVALID_ARGUMENT',
          'appendData',
          this.chartId
        );
      }
      
      const sourceArray = newPointsOrData;
      
      if (sourceArray.length === 0) {
        return; // No-op for empty arrays
      }
      
      // Determine expected format based on point type
      const floatsPerPoint = pointType === 'xy' ? 2 : 5;
      const pointCount = sourceArray.length / floatsPerPoint;
      const stride: StrideBytes = pointType === 'xy' ? XY_STRIDE : OHLC_STRIDE;
      
      // Validate that length is a multiple of floatsPerPoint
      if (sourceArray.length % floatsPerPoint !== 0) {
        throw new ChartGPUWorkerError(
          `Invalid typed array length: ${sourceArray.length}. Expected multiple of ${floatsPerPoint} for '${pointType}' points.`,
          'INVALID_ARGUMENT',
          'appendData',
          this.chartId
        );
      }
      
      // CRITICAL: GPU buffers use Float32, so convert Float64Array to Float32Array
      let typedArray: Float32Array;
      if (sourceArray instanceof Float64Array) {
        // Convert Float64Array to Float32Array (precision loss acceptable for GPU rendering)
        typedArray = new Float32Array(sourceArray);
      } else {
        // Already Float32Array - use directly
        typedArray = sourceArray;
      }
      
      // Check for detached buffer before transfer
      if (typedArray.buffer.byteLength === 0) {
        console.error(
          `ChartGPU: Cannot transfer detached ArrayBuffer. ` +
          `The buffer may have already been transferred to another context.`
        );
        return;
      }
      
      // Validate stride alignment
      const expectedBytes = pointCount * stride;
      const actualBytes = typedArray.byteLength;
      if (actualBytes !== expectedBytes) {
        console.warn(
          `ChartGPU: Data buffer size mismatch. Expected ${expectedBytes} bytes ` +
          `(${pointCount} points × ${stride} stride), got ${actualBytes} bytes.`
        );
      }
      
      // Validate buffer is 4-byte aligned (WebGPU requirement)
      if (typedArray.byteLength % 4 !== 0) {
        throw new ChartGPUWorkerError(
          `Buffer size (${typedArray.byteLength} bytes) is not 4-byte aligned (WebGPU requirement)`,
          'INVALID_ARGUMENT',
          'appendData',
          this.chartId
        );
      }
      
      // CRITICAL: Zero-copy optimization - transfer the entire underlying buffer
      // If the typed array uses the full buffer (no byteOffset), transfer directly
      // Otherwise, we must slice() to create a new buffer (creates a copy, but unavoidable)
      let buffer: ArrayBuffer;
      if (typedArray.byteOffset === 0 && typedArray.byteLength === typedArray.buffer.byteLength) {
        // Optimal path: Transfer the entire buffer without copying
        buffer = typedArray.buffer as ArrayBuffer;
      } else {
        // Subarray case: Must copy to create a transferable buffer
        // This happens when the typed array is a view into a larger buffer
        // Note: slice() returns ArrayBufferLike but will always be ArrayBuffer in practice
        buffer = typedArray.buffer.slice(typedArray.byteOffset, typedArray.byteOffset + typedArray.byteLength) as ArrayBuffer;
        
        console.warn(
          `ChartGPU: Typed array uses a subarray view (byteOffset=${typedArray.byteOffset}). ` +
          `A buffer copy is required for transfer. For best performance, ensure typed arrays ` +
          `own their entire underlying buffer.`
        );
      }
      
      // Keep dataset-aware slider constraints in sync with streaming appends.
      this.incrementCachedSeriesPointCountForZoom(seriesIndex, pointCount);
      if (this.zoomState) {
        const constraints = this.computeZoomSpanConstraints(this.cachedOptions);
        const withConstraints = this.zoomState as unknown as {
          setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
        };
        withConstraints.setSpanConstraints?.(
          (constraints.minSpan as number) ?? 0.5,
          (constraints.maxSpan as number) ?? 100
        );
      }

      this.sendMessage({
        type: 'appendData',
        chartId: this.chartId,
        seriesIndex,
        data: buffer,
        pointCount,
        stride,
      }, [buffer]);
      
      return;
    }
    
    // Handle DataPoint[] or OHLCDataPoint[] form (existing behavior)
    const newPoints = newPointsOrData as DataPoint[] | OHLCDataPoint[];
    
    if (!newPoints || newPoints.length === 0) {
      return; // No-op for empty arrays
    }
    
    // Warn about large tuple arrays for better performance
    if (Array.isArray(newPoints) && newPoints.length > 10_000) {
      console.warn(
        `ChartGPU: appendData called with ${newPoints.length.toLocaleString()} points as array. ` +
        `Consider using Float32Array for better performance:\n\n` +
        `  import { packDataPoints } from 'chart-gpu';\n` +
        `  const packed = packDataPoints(points);\n` +
        `  chart.appendData(seriesIndex, packed, 'xy');\n\n` +
        `This can reduce memory usage by 50% and eliminate serialization overhead ` +
        `(~${(newPoints.length * 0.00002).toFixed(2)}ms saved per append).`
      );
    }
    
    const [data, stride] = serializeDataPoints(newPoints);
    
    // Keep dataset-aware slider constraints in sync with streaming appends.
    this.incrementCachedSeriesPointCountForZoom(seriesIndex, newPoints.length);
    if (this.zoomState) {
      const constraints = this.computeZoomSpanConstraints(this.cachedOptions);
      const withConstraints = this.zoomState as unknown as {
        setSpanConstraints?: (minSpan: number, maxSpan: number) => void;
      };
      withConstraints.setSpanConstraints?.(
        (constraints.minSpan as number) ?? 0.5,
        (constraints.maxSpan as number) ?? 100
      );
    }

    this.sendMessage({
      type: 'appendData',
      chartId: this.chartId,
      seriesIndex,
      data,
      pointCount: newPoints.length,
      stride: stride as StrideBytes,
    }, [data]);
  }
  
  resize(): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    // Get current canvas dimensions from container
    const canvas = this.container.querySelector('canvas');
    if (!canvas) {
      console.warn('ChartGPUWorkerProxy.resize(): Canvas not found in container');
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, rect.width);   // CSS pixels
    const height = Math.max(1, rect.height); // CSS pixels

    this.sendMessage({
      type: 'resize',
      chartId: this.chartId,
      width,
      height,
      devicePixelRatio: dpr,
      requestRender: true,
    });
  }
  
  dispose(): void {
    if (this.isDisposed) {
      return; // Already disposed
    }
    
    this.isDisposed = true;
    this.isInitialized = false;
    
    // Clean up event listeners FIRST to stop event flow
    this.cleanupEventListeners();
    
    // Clean up resize monitoring (ResizeObserver and DPR monitoring)
    this.cleanupResizeMonitoring();
    
    // Dispose overlays BEFORE worker disposal to prevent memory leaks
    this.disposeOverlays();
    
    // Send dispose message to worker
    this.sendMessage({
      type: 'dispose',
      chartId: this.chartId,
    });
    
    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new ChartGPUWorkerError(
        'Chart disposed before operation completed',
        'DISPOSED',
        pending.operation,
        this.chartId
      ));
    }
    this.pendingRequests.clear();
    
    // Clear all event listeners
    for (const listeners of this.listeners.values()) {
      listeners.clear();
    }
    
    // Remove worker message handler
    this.worker.removeEventListener('message', this.boundMessageHandler);
    
    // Remove canvas from container
    const canvas = this.container.querySelector('canvas');
    if (canvas) {
      canvas.remove();
    }
  }
  
  on(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void;
  on(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void;
  on(eventName: ChartGPUEventName, callback: AnyChartGPUEventCallback): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      listeners.add(callback);
    }
  }
  
  off(eventName: 'crosshairMove', callback: ChartGPUCrosshairMoveCallback): void;
  off(eventName: ChartGPUEventName, callback: ChartGPUEventCallback): void;
  off(eventName: ChartGPUEventName, callback: AnyChartGPUEventCallback): void {
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      listeners.delete(callback);
    }
  }
  
  getInteractionX(): number | null {
    if (this.isDisposed) {
      return null;
    }
    return this.cachedInteractionX;
  }
  
  setInteractionX(x: number | null, source?: unknown): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    this.cachedInteractionX = x;
    
    this.sendMessage({
      type: 'setInteractionX',
      chartId: this.chartId,
      x,
      source: source as string | undefined,
    });
  }
  
  setCrosshairX(x: number | null, source?: unknown): void {
    // Alias for setInteractionX
    this.setInteractionX(x, source);
  }
  
  onInteractionXChange(callback: (x: number | null, source?: unknown) => void): () => void {
    // Subscribe to crosshairMove events
    const wrappedCallback = (payload: ChartGPUCrosshairMovePayload) => {
      callback(payload.x, payload.source);
    };
    
    this.on('crosshairMove', wrappedCallback as ChartGPUCrosshairMoveCallback);
    
    // Return unsubscribe function
    return () => {
      this.off('crosshairMove', wrappedCallback as ChartGPUCrosshairMoveCallback);
    };
  }
  
  getZoomRange(): Readonly<{ start: number; end: number }> | null {
    if (this.isDisposed) {
      return null;
    }
    return this.cachedZoomRange;
  }
  
  setZoomRange(start: number, end: number): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    // Validate zoom range (percent space [0, 100])
    if (start < 0 || start > 100 || end < 0 || end > 100) {
      throw new ChartGPUWorkerError(
        `Invalid zoom range: [${start}, ${end}]. Values must be in [0, 100] (percent space).`,
        'INVALID_ARGUMENT',
        'setZoomRange',
        this.chartId
      );
    }
    if (start >= end) {
      throw new ChartGPUWorkerError(
        `Invalid zoom range: start (${start}) must be less than end (${end}).`,
        'INVALID_ARGUMENT',
        'setZoomRange',
        this.chartId
      );
    }
    
    this.cachedZoomRange = { start, end };
    
    this.sendMessage({
      type: 'setZoomRange',
      chartId: this.chartId,
      start,
      end,
    });
  }

  /**
   * Gets the latest performance metrics from the worker.
   * Returns cached metrics updated every frame.
   * 
   * @returns Current performance metrics, or null if not available yet
   */
  getPerformanceMetrics(): Readonly<PerformanceMetrics> | null {
    if (this.isDisposed) {
      return null;
    }
    return this.cachedPerformanceMetrics;
  }

  /**
   * Gets the performance capabilities of the worker environment.
   * Indicates which performance features are supported.
   * 
   * @returns Performance capabilities, or null if not initialized yet
   */
  getPerformanceCapabilities(): Readonly<PerformanceCapabilities> | null {
    if (this.isDisposed) {
      return null;
    }
    return this.cachedPerformanceCapabilities;
  }

  /**
   * Registers a callback to be notified of performance metric updates.
   * Callback is invoked every frame with the latest metrics.
   * 
   * @param callback - Function to call with updated metrics
   * @returns Unsubscribe function to remove the callback
   */
  onPerformanceUpdate(callback: (metrics: Readonly<PerformanceMetrics>) => void): () => void {
    if (this.isDisposed) {
      return () => {}; // No-op unsubscribe for disposed charts
    }
    
    this.performanceUpdateCallbacks.add(callback);
    
    // Return unsubscribe function
    return () => {
      this.performanceUpdateCallbacks.delete(callback);
    };
  }

  /**
   * Enables or disables GPU timing for performance metrics.
   * GPU timing requires the 'timestamp-query' WebGPU feature.
   * 
   * @param enabled - Whether to enable GPU timing
   */
  setGPUTiming(enabled: boolean): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    this.sendMessage({
      type: 'setGPUTiming',
      chartId: this.chartId,
      enabled,
    });
  }
  
  // =============================================================================
  // Worker Communication
  // =============================================================================
  
  /**
   * Sends a message to the worker without expecting a response.
   * 
   * @param message - Message to send
   * @param transfer - Optional transferable objects
   */
  private sendMessage(message: WorkerInboundMessage, transfer?: Transferable[]): void {
    if (this.isDisposed) {
      return; // Silent no-op for disposed charts
    }
    
    try {
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    } catch (error) {
      throw new ChartGPUWorkerError(
        `Failed to send message to worker: ${error instanceof Error ? error.message : String(error)}`,
        'COMMUNICATION_ERROR',
        message.type,
        this.chartId
      );
    }
  }
  
  /**
   * Sends a message to the worker and waits for a response.
   * 
   * **Message Correlation**: Uses unique messageId to match request/response pairs.
   * The worker MUST echo the messageId in its response for correlation to work.
   * 
   * **Timeout Behavior**: 
   * - Default timeout: 30 seconds (configurable via WorkerConfig.messageTimeout)
   * - On timeout: Promise rejects with TIMEOUT error and pending request is cleaned up
   * - Prevents indefinite promise accumulation if worker hangs or message is lost
   * - Timeout starts when message is sent (not when promise is created)
   * 
   * **Error Handling**:
   * - Send failure: Immediately rejects and cleans up timeout
   * - Worker error: Rejects with error from ErrorMessage (matched by messageId)
   * - Disposal: All pending requests rejected with DISPOSED error
   * 
   * **Concurrency Safety**: Multiple concurrent requests are supported via Map-based tracking.
   * Each request has a unique messageId, preventing response cross-contamination.
   * 
   * @param message - Message to send (must have messageId)
   * @param transfer - Optional transferable objects (e.g., OffscreenCanvas, ArrayBuffer)
   * @returns Promise that resolves with the response or rejects on timeout/error
   */
  private sendMessageWithResponse<T extends WorkerOutboundMessage>(
    message: WorkerInboundMessage & { messageId: string },
    transfer?: Transferable[]
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const { messageId } = message;
      
      // Set up timeout to prevent indefinite promise accumulation
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new ChartGPUWorkerError(
          `Operation "${message.type}" timed out after ${this.messageTimeout}ms. ` +
          `Worker may be unresponsive or message was lost.`,
          'TIMEOUT',
          message.type,
          this.chartId
        ));
      }, this.messageTimeout);
      
      // Track pending request for response correlation
      this.pendingRequests.set(messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        operation: message.type,
      });
      
      // Send message (may throw if worker is terminated or message is invalid)
      try {
        this.sendMessage(message, transfer);
      } catch (error) {
        // Clean up pending request on send failure
        clearTimeout(timeout);
        this.pendingRequests.delete(messageId);
        reject(error);
      }
    });
  }
  
  /**
   * Handles incoming messages from the worker.
   * Routes messages to appropriate handlers based on type.
   * 
   * @param event - Message event from worker
   */
  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data as WorkerOutboundMessage;
    
    // Ignore messages for other chart instances
    if (message.chartId !== this.chartId) {
      return;
    }
    
    // Handle message based on type
    switch (message.type) {
      case 'ready':
        this.handleReadyMessage(message);
        break;
      
      case 'rendered':
        // No-op: rendered messages are informational only
        break;
      
      case 'performance-update':
        this.handlePerformanceUpdateMessage(message);
        break;
      
      case 'tooltipUpdate':
        this.handleTooltipUpdateMessage(message);
        break;
      
      case 'legendUpdate':
        this.handleLegendUpdateMessage(message);
        break;
      
      case 'axisLabelsUpdate':
        this.handleAxisLabelsUpdateMessage(message);
        break;
      
      case 'hoverChange':
        this.handleHoverChangeMessage(message);
        break;
      
      case 'click':
        this.handleClickMessage(message);
        break;
      
      case 'crosshairMove':
        this.handleCrosshairMoveMessage(message);
        break;
      
      case 'zoomChange':
        this.handleZoomChangeMessage(message);
        break;
      
      case 'deviceLost':
        this.handleDeviceLostMessage(message);
        break;
      
      case 'disposed':
        // Worker confirmed disposal - already handled locally
        break;
      
      case 'error':
        this.handleErrorMessage(message);
        break;
      
      default:
        // Exhaustive type check
        const exhaustive: never = message;
        console.warn('ChartGPUWorkerProxy: Unknown message type:', (exhaustive as any).type);
    }
  }
  
  /**
   * Handles ready message from worker.
   * Resolves the pending init request and caches performance capabilities.
   */
  private handleReadyMessage(message: ReadyMessage): void {
    // Mark as initialized to enable event forwarding
    this.isInitialized = true;
    
    // Cache performance capabilities from worker
    this.cachedPerformanceCapabilities = message.performanceCapabilities;
    
    // CRITICAL: Initialize zoom range from ready message
    // The ready message now includes the initial zoom range to avoid race conditions
    // where the slider is created with default [0, 100] before the worker's zoomChange message is processed
    if (message.initialZoomRange) {
      // Update cached zoom range
      this.cachedZoomRange = { start: message.initialZoomRange.start, end: message.initialZoomRange.end };
      
      // If slider exists, update it with the correct initial zoom range
      if (this.zoomState) {
        const currentRange = this.zoomState.getRange();
        // Only update if the slider is still at the default [0, 100] but actual range differs
        if ((currentRange.start === 0 && currentRange.end === 100) &&
            (message.initialZoomRange.start !== 0 || message.initialZoomRange.end !== 100)) {
          this.isProcessingWorkerZoomUpdate = true;
          try {
            this.zoomState.setRange(message.initialZoomRange.start, message.initialZoomRange.end);
          } finally {
            this.isProcessingWorkerZoomUpdate = false;
          }
        }
      }
    }
    
    const pending = this.pendingRequests.get(message.messageId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.messageId);
      pending.resolve(message);
    }
  }
  
  /**
   * Handles hover change messages from worker.
   * Emits mouseover/mouseout events to registered listeners.
   */
  private handleHoverChangeMessage(message: import('./protocol').HoverChangeMessage): void {
    if (message.payload) {
      // Hover entered
      const payload: ChartGPUEventPayload = {
        seriesIndex: message.payload.seriesIndex,
        dataIndex: message.payload.dataIndex,
        value: message.payload.value as readonly [number, number],
        seriesName: null, // Worker doesn't send series name
        event: this.createSyntheticPointerEvent(message.payload.x, message.payload.y),
      };
      this.emit('mouseover', payload);
    } else {
      // Hover cleared
      const payload: ChartGPUEventPayload = {
        seriesIndex: null,
        dataIndex: null,
        value: null,
        seriesName: null,
        event: this.createSyntheticPointerEvent(0, 0),
      };
      this.emit('mouseout', payload);
    }
  }
  
  /**
   * Handles click messages from worker.
   * Emits click events to registered listeners.
   */
  private handleClickMessage(message: import('./protocol').ClickMessage): void {
    const payload: ChartGPUEventPayload = {
      seriesIndex: message.payload.seriesIndex,
      dataIndex: message.payload.dataIndex,
      value: message.payload.value as readonly [number, number],
      seriesName: null, // Worker doesn't send series name
      event: this.createSyntheticPointerEvent(message.payload.x, message.payload.y),
    };
    this.emit('click', payload);
  }
  
  /**
   * Handles crosshair move messages from worker.
   * Updates cached interaction X and emits crosshairMove events.
   */
  private handleCrosshairMoveMessage(message: import('./protocol').CrosshairMoveMessage): void {
    this.cachedInteractionX = message.x;
    
    const payload: ChartGPUCrosshairMovePayload = {
      x: message.x,
      source: message.source,
    };
    this.emit('crosshairMove', payload);
  }
  
  /**
   * Handles zoom change messages from worker.
   * Updates cached zoom range and zoom state with echo loop prevention.
   * 
   * CRITICAL: Echo suppression strategy
   * - Sets isProcessingWorkerZoomUpdate flag before calling setRange
   * - The onChange callback checks this flag and skips sending message back to worker
   * - This prevents zoom changes originated in the worker from echoing back
   * - UI-originated changes (slider drag) still propagate normally to worker
   */
  private handleZoomChangeMessage(message: import('./protocol').ZoomChangeMessage): void {
    this.cachedZoomRange = { start: message.start, end: message.end };
    
    // Update zoom state if slider exists
    if (this.zoomState) {
      const currentRange = this.zoomState.getRange();
      
      // Only call setRange if values actually changed (avoids no-op updates)
      if (currentRange.start !== message.start || currentRange.end !== message.end) {
        // Set echo suppression flag before updating zoom state
        // This prevents the onChange callback from sending the change back to worker
        this.isProcessingWorkerZoomUpdate = true;
        
        try {
          this.zoomState.setRange(message.start, message.end);
        } finally {
          // Always clear flag in finally block to ensure cleanup even on error
          this.isProcessingWorkerZoomUpdate = false;
        }
      }
    }
  }
  
  /**
   * Handles device lost messages from worker.
   * Marks chart as disposed and cleans up resources.
   */
  private handleDeviceLostMessage(message: import('./protocol').DeviceLostMessage): void {
    console.error(
      `ChartGPU: WebGPU device lost for chart "${this.chartId}".`,
      `Reason: ${message.reason}`,
      message.message ? `Message: ${message.message}` : ''
    );
    
    // Device loss is terminal - dispose the chart
    this.dispose();
  }
  
  /**
   * Handles error messages from worker.
   * Rejects pending requests or logs errors.
   */
  private handleErrorMessage(message: import('./protocol').ErrorMessage): void {
    const error = new ChartGPUWorkerError(
      message.message,
      message.code,
      message.operation,
      this.chartId
    );
    
    // If this error is correlated with a pending request, reject it
    if (message.messageId) {
      const pending = this.pendingRequests.get(message.messageId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.messageId);
        pending.reject(error);
        return;
      }
    }
    
    // Otherwise, log the error
    console.error('ChartGPUWorkerProxy: Worker error:', error);
  }
  
  /**
   * Handles tooltip update messages from worker.
   * Batches updates via RAF to prevent layout thrashing.
   */
  private handleTooltipUpdateMessage(message: TooltipUpdateMessage): void {
    this.pendingOverlayUpdates.tooltip = message;
    this.scheduleOverlayUpdates();
  }
  
  /**
   * Handles legend update messages from worker.
   * Batches updates via RAF to prevent layout thrashing.
   */
  private handleLegendUpdateMessage(message: LegendUpdateMessage): void {
    this.pendingOverlayUpdates.legend = message;
    this.scheduleOverlayUpdates();
  }
  
  /**
   * Handles axis labels update messages from worker.
   * Batches updates via RAF to prevent layout thrashing.
   */
  private handleAxisLabelsUpdateMessage(message: AxisLabelsUpdateMessage): void {
    this.pendingOverlayUpdates.axisLabels = message;
    this.scheduleOverlayUpdates();
  }

  /**
   * Handles performance update messages from worker.
   * Updates cached metrics and notifies subscribers.
   */
  private handlePerformanceUpdateMessage(message: import('./protocol').PerformanceUpdateMessage): void {
    // Update cached metrics
    this.cachedPerformanceMetrics = message.metrics;
    
    // Notify all registered callbacks
    for (const callback of this.performanceUpdateCallbacks) {
      try {
        callback(message.metrics);
      } catch (error) {
        console.error('Error in performance update callback:', error);
      }
    }
  }
  
  /**
   * Emits an event to all registered listeners.
   * 
   * @param eventName - Event name
   * @param payload - Event payload
   */
  private emit(
    eventName: ChartGPUEventName,
    payload: ChartGPUEventPayload | ChartGPUCrosshairMovePayload
  ): void {
    const listeners = this.listeners.get(eventName);
    if (!listeners) return;
    
    for (const callback of listeners) {
      try {
        (callback as (p: typeof payload) => void)(payload);
      } catch (error) {
        console.error(`Error in ${eventName} event handler:`, error);
      }
    }
  }
  
  /**
   * Creates a synthetic PointerEvent for event payloads.
   * Worker can't transfer real PointerEvents, so we create a minimal synthetic one.
   * 
   * @param x - Canvas-local CSS pixel x coordinate
   * @param y - Canvas-local CSS pixel y coordinate
   * @returns Synthetic PointerEvent
   */
  private createSyntheticPointerEvent(x: number, y: number): PointerEvent {
    // Create a minimal synthetic PointerEvent
    // This is necessary because worker can't transfer real PointerEvents
    const canvas = this.container.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect() || { left: 0, top: 0 };
    
    return new PointerEvent('pointermove', {
      bubbles: false,
      cancelable: false,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: -1, // Synthetic event marker
      pointerType: 'mouse',
      isPrimary: true,
    });
  }
}
