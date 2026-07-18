/**
 * GPUContext - WebGPU device and adapter management
 *
 * Handles WebGPU initialization, adapter selection, and device creation
 * following WebGPU best practices for resource management and error handling.
 *
 * This module provides both functional and class-based APIs for maximum flexibility.
 */

/** Canvas types supported by GPUContext. */
export type SupportedCanvas = HTMLCanvasElement;

// Baseline requirements for ChartGPU when injecting a shared GPUDevice.
// These are intentionally conservative so ChartGPU fails early with a descriptive error
// rather than failing later during large uploads/allocations.
const MIN_REQUIRED_MAX_BUFFER_SIZE_BYTES = 32 * 1024 * 1024; // 32 MiB
const MIN_REQUIRED_MAX_STORAGE_BUFFER_BINDING_SIZE_BYTES = 32 * 1024 * 1024; // 32 MiB

// Internal ownership tracking.
// AC-2 requires ownership tracking, but this must remain internal (not a public API surface).
const ownsDeviceKey: unique symbol = Symbol('GPUContext.ownsDevice');
type GPUContextStateInternal = GPUContextState & {
  readonly [ownsDeviceKey]: boolean;
};
const getOwnsDevice = (context: GPUContextState): boolean =>
  (context as GPUContextStateInternal)[ownsDeviceKey] ?? true;

/** Options for GPU context initialization. */
export interface GPUContextOptions {
  /** DPR for high-DPI displays. Auto-detects from `window.devicePixelRatio`, defaults to 1.0. */
  readonly devicePixelRatio?: number;
  /** Canvas alpha mode. Default: 'opaque' (faster, no transparency). */
  readonly alphaMode?: 'opaque' | 'premultiplied';
  /** GPU power preference for adapter selection. */
  readonly powerPreference?: 'low-power' | 'high-performance';
  /**
   * Optional WebGPU adapter. When both device and adapter are provided, initialization skips
   * requestAdapter/requestDevice and uses these objects (shared device mode). The caller owns
   * the device lifecycle; destroyGPUContext will not call device.destroy().
   */
  readonly adapter?: GPUAdapter;
  /**
   * Optional WebGPU device. When both device and adapter are provided, initialization skips
   * requestAdapter/requestDevice and uses these objects (shared device mode). The caller owns
   * the device lifecycle; destroyGPUContext will not call device.destroy().
   */
  readonly device?: GPUDevice;
}

/**
 * Represents the state of a GPU context.
 * All properties are readonly to ensure immutability.
 */
export interface GPUContextState {
  readonly adapter: GPUAdapter | null;
  readonly device: GPUDevice | null;
  readonly initialized: boolean;
  readonly canvas: HTMLCanvasElement | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly devicePixelRatio: number;
  readonly alphaMode: 'opaque' | 'premultiplied';
  readonly powerPreference: 'low-power' | 'high-performance';
}

/** Reliable type guard for DOM canvases (safe when DOM globals are absent). */
export function isHTMLCanvasElement(canvas: HTMLCanvasElement): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
}

/** Gets display dimensions - clientWidth/Height for HTMLCanvasElement */
function getCanvasDimensions(canvas: HTMLCanvasElement): {
  width: number;
  height: number;
} {
  // Prefer clientWidth/clientHeight (CSS pixels) for HTMLCanvasElement as they reflect actual display size
  // Fall back to canvas.width/height (device pixels) if client dimensions are 0 or invalid
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;

  // Validate dimensions are finite and non-negative
  // Note: 0 dimensions are allowed here - they'll be clamped to 1 during GPUContext initialization
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(
      `GPUContext: Invalid canvas dimensions detected: width=${canvas.clientWidth || canvas.width}, ` +
        `height=${canvas.clientHeight || canvas.height}. ` +
        `Canvas must have finite dimensions. Ensure canvas is properly sized before initialization.`
    );
  }

  return { width, height };
}

/**
 * Creates a new GPUContext state with initial values.
 *
 * @param canvas - Optional canvas element (HTMLCanvasElement) to configure for WebGPU rendering
 * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
 * @returns A new GPUContextState instance
 */
export function createGPUContext(canvas?: HTMLCanvasElement, options?: GPUContextOptions): GPUContextState {
  // Auto-detect DPR when `window` is available; otherwise default to 1.0.
  const dprRaw = options?.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1.0);
  // Be resilient: callers may pass 0/NaN/Infinity. Fall back to 1 instead of throwing.
  const dpr = Number.isFinite(dprRaw) && dprRaw > 0 ? dprRaw : 1.0;
  const alphaMode = options?.alphaMode ?? 'opaque';
  const powerPreference = options?.powerPreference ?? 'high-performance';

  // Only use injected device/adapter when BOTH are provided (shared device mode)
  const hasInjected = !!(options?.device && options?.adapter);
  const injectedAdapter = hasInjected ? options!.adapter! : null;
  const injectedDevice = hasInjected ? options!.device! : null;
  const ownsDevice = !hasInjected;

  return {
    adapter: injectedAdapter,
    device: injectedDevice,
    initialized: false,
    canvas: canvas || null,
    canvasContext: null,
    preferredFormat: null,
    devicePixelRatio: dpr,
    alphaMode,
    powerPreference,
    [ownsDeviceKey]: ownsDevice,
  } as GPUContextStateInternal;
}

/**
 * Initializes the WebGPU context by requesting an adapter and device.
 * Returns a new state object with initialized values.
 *
 * @param context - The GPU context state to initialize
 * @returns A new GPUContextState with initialized adapter and device
 * @throws {Error} If WebGPU is not available in the browser
 * @throws {Error} If adapter request fails
 * @throws {Error} If device request fails
 * @throws {Error} If already initialized
 */
export async function initializeGPUContext(context: GPUContextState): Promise<GPUContextState> {
  if (context.initialized) {
    throw new Error('GPUContext: already initialized. Call destroyGPUContext() before reinitializing.');
  }

  // Be resilient: callers may construct GPUContextState manually.
  const sanitizedDevicePixelRatio =
    Number.isFinite(context.devicePixelRatio) && context.devicePixelRatio > 0 ? context.devicePixelRatio : 1.0;

  // Check for WebGPU support
  if (!navigator.gpu) {
    throw new Error(
      'WebGPU is not available in this browser. ' +
        'Please use a browser that supports WebGPU (Chrome 113+, Edge 113+, or Safari 18+). ' +
        'Ensure WebGPU is enabled in browser flags if needed.'
    );
  }

  let device: GPUDevice | null = null;
  let adapter: GPUAdapter | null = null;
  let ownsDevice = getOwnsDevice(context);

  try {
    const useInjectedDevice = context.adapter && context.device;

    if (useInjectedDevice) {
      // Shared device mode: use provided adapter and device, skip requestAdapter/requestDevice
      adapter = context.adapter;
      device = context.device;
      ownsDevice = false;

      // AC-8: Best-effort validation that getPreferredCanvasFormat is usable for canvas config.
      // WebGPU does not expose format compatibility checks on the adapter/device; validate API
      // availability and that the preferred format is one of the mandated canvas formats.
      if (typeof navigator.gpu?.getPreferredCanvasFormat !== 'function') {
        throw new Error(
          'GPUContext: Shared device requires navigator.gpu.getPreferredCanvasFormat() for canvas ' +
            'format selection, but it is not available in this environment. Use a browser with full WebGPU support.'
        );
      }

      // Validate preferred canvas format is in the mandated set for WebGPU canvases.
      // (This is as close as we can get to "adapter supports format" with current WebGPU APIs.)
      const preferred = navigator.gpu.getPreferredCanvasFormat();
      if (preferred !== 'bgra8unorm' && preferred !== 'rgba8unorm') {
        throw new Error(
          `GPUContext: Shared device preferred canvas format is not supported by ChartGPU. ` +
            `Received navigator.gpu.getPreferredCanvasFormat()="${preferred}". ` +
            `Supported formats: "bgra8unorm", "rgba8unorm".`
        );
      }

      // AC-5: Validate injected device limits against ChartGPU minimum requirements.
      const actualMaxBufferSize = device.limits.maxBufferSize;
      if (actualMaxBufferSize < MIN_REQUIRED_MAX_BUFFER_SIZE_BYTES) {
        throw new Error(
          `GPUContext: Injected device.limits.maxBufferSize is insufficient. ` +
            `Required >= ${MIN_REQUIRED_MAX_BUFFER_SIZE_BYTES} bytes, actual=${actualMaxBufferSize} bytes.`
        );
      }

      const actualMaxStorageBinding = device.limits.maxStorageBufferBindingSize;
      if (actualMaxStorageBinding < MIN_REQUIRED_MAX_STORAGE_BUFFER_BINDING_SIZE_BYTES) {
        throw new Error(
          `GPUContext: Injected device.limits.maxStorageBufferBindingSize is insufficient. ` +
            `Required >= ${MIN_REQUIRED_MAX_STORAGE_BUFFER_BINDING_SIZE_BYTES} bytes, actual=${actualMaxStorageBinding} bytes.`
        );
      }
    } else {
      // Normal mode: request adapter and device
      const requestedAdapter = await navigator.gpu.requestAdapter({
        powerPreference: context.powerPreference,
      });

      if (!requestedAdapter) {
        throw new Error(
          'GPUContext: Failed to request WebGPU adapter. ' +
            'No compatible adapter found. This may occur if no GPU is available or WebGPU is disabled.'
        );
      }

      const requestedDevice = await requestedAdapter.requestDevice();

      if (!requestedDevice) {
        throw new Error('GPUContext: Failed to request WebGPU device from adapter.');
      }

      adapter = requestedAdapter;
      device = requestedDevice;
      ownsDevice = true;

      // AC-4 (CGPU-SHARED-DEVICE): Add uncapturederror handler only for owned devices.
      // Rationale: Injected devices are caller-managed; avoid adding handlers to avoid conflicts
      // with caller's error handling strategy. Owned devices are fully managed internally.
      device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
        console.error('WebGPU uncaptured error:', event.error);
      });
    }

    let canvasContext: GPUCanvasContext | null = null;
    let preferredFormat: GPUTextureFormat | null = null;

    // Configure canvas if provided
    if (context.canvas) {
      const webgpuContext = context.canvas.getContext('webgpu') as GPUCanvasContext | null;

      if (!webgpuContext) {
        // Clean up device before throwing (only if we own it)
        if (ownsDevice && device) {
          try {
            device.destroy();
          } catch (error) {
            console.warn('Error destroying device during canvas setup failure:', error);
          }
        }
        throw new Error('GPUContext: Failed to get WebGPU context from canvas.');
      }

      // Use DPR from context state (set at context creation)
      const { width, height } = getCanvasDimensions(context.canvas);
      const dpr = sanitizedDevicePixelRatio;

      // Calculate target dimensions in device pixels
      // Note: width/height from getCanvasDimensions are in CSS pixels for HTMLCanvasElement,
      // or device pixels (already set by main thread)
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      // Clamp to device limits (must happen after device creation)
      const maxDim = device.limits.maxTextureDimension2D;
      // AC-5: For injected devices, validate the device supports the requested backing size at DPR.
      if (!ownsDevice && (targetWidth > maxDim || targetHeight > maxDim)) {
        const required = Math.max(targetWidth, targetHeight);
        throw new Error(
          `GPUContext: Injected device.limits.maxTextureDimension2D is insufficient. ` +
            `Required >= ${required} (for ${targetWidth}x${targetHeight} at devicePixelRatio=${dpr}), ` +
            `actual=${maxDim}.`
        );
      }
      const finalWidth = Math.max(1, Math.min(targetWidth, maxDim));
      const finalHeight = Math.max(1, Math.min(targetHeight, maxDim));

      context.canvas.width = finalWidth;
      context.canvas.height = finalHeight;

      // Get preferred format from navigator.gpu, fallback to bgra8unorm
      preferredFormat = navigator.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';

      // Configure the canvas context with alpha mode from context state
      webgpuContext.configure({
        device: device,
        format: preferredFormat,
        alphaMode: context.alphaMode,
      });

      canvasContext = webgpuContext;
    }

    return {
      adapter,
      device,
      initialized: true,
      canvas: context.canvas,
      canvasContext,
      preferredFormat,
      devicePixelRatio: sanitizedDevicePixelRatio,
      alphaMode: context.alphaMode,
      powerPreference: context.powerPreference,
      [ownsDeviceKey]: ownsDevice,
    } as GPUContextStateInternal;
  } catch (error) {
    // If we created the device and initialization failed, destroy it to avoid leaks.
    if (ownsDevice && device) {
      try {
        device.destroy();
      } catch (destroyError) {
        console.warn('Error destroying device during initialization failure:', destroyError);
      }
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to initialize GPUContext: ${String(error)}`);
  }
}

/**
 * Gets the current texture from the canvas context.
 *
 * @param context - The GPU context state
 * @returns The current canvas texture
 * @throws {Error} If canvas is not configured or context is not initialized
 *
 * @example
 * ```typescript
 * const texture = getCanvasTexture(context);
 * // Use texture in render pass
 * ```
 */
export function getCanvasTexture(context: GPUContextState): GPUTexture {
  if (!context.canvas) {
    throw new Error('GPUContext: Canvas is not configured. Provide a canvas element when creating the context.');
  }

  if (!context.initialized || !context.canvasContext) {
    throw new Error('GPUContext: not initialized. Call initializeGPUContext() first.');
  }

  return context.canvasContext.getCurrentTexture();
}

/**
 * Clears the canvas to a solid color.
 * Creates a command encoder, begins a render pass with the specified clear color,
 * ends the pass, and submits it to the queue.
 *
 * @param context - The GPU context state
 * @param r - Red component (0.0 to 1.0)
 * @param g - Green component (0.0 to 1.0)
 * @param b - Blue component (0.0 to 1.0)
 * @param a - Alpha component (0.0 to 1.0)
 * @throws {Error} If canvas is not configured or context is not initialized
 * @throws {Error} If device is not available
 *
 * @example
 * ```typescript
 * // Clear to dark purple (#1a1a2e)
 * clearScreen(context, 0x1a / 255, 0x1a / 255, 0x2e / 255, 1.0);
 * ```
 */
export function clearScreen(context: GPUContextState, r: number, g: number, b: number, a: number): void {
  // Validate color component ranges
  if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1 || a < 0 || a > 1) {
    throw new Error('GPUContext: Color components must be in the range [0.0, 1.0]');
  }

  if (!context.canvas) {
    throw new Error('GPUContext: Canvas is not configured. Provide a canvas element when creating the context.');
  }

  if (!context.initialized || !context.device || !context.canvasContext) {
    throw new Error('GPUContext: not initialized. Call initializeGPUContext() first.');
  }

  // Get the current texture from the canvas
  const texture = getCanvasTexture(context);

  // Create command encoder
  const encoder = context.device.createCommandEncoder();

  // Begin render pass with clear color
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        clearValue: { r, g, b, a },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });

  // End render pass
  renderPass.end();

  // Submit command buffer to queue
  context.device.queue.submit([encoder.finish()]);
}

/**
 * Destroys the WebGPU device and cleans up resources.
 *
 * AC-3 (CGPU-SHARED-DEVICE): Dispose semantics
 * - **Always** unconfigures the canvas context (releases textures from getCurrentTexture)
 * - **Conditionally** calls device.destroy():
 *   - Owned devices (created internally): destroyed
 *   - Shared devices (injected via options): NOT destroyed (caller owns lifecycle)
 *
 * AC-7 (CGPU-SHARED-DEVICE): Backwards compatibility
 * - Missing ownership metadata is treated as "owned" (preserves legacy behavior)
 *
 * Returns a new state object with reset values.
 * After calling this, the context must be reinitialized before use.
 *
 * @param context - The GPU context state to destroy
 * @returns A new GPUContextState with reset values
 */
export function destroyGPUContext(context: GPUContextState): GPUContextState {
  // Always unconfigure canvas context (releases textures from getCurrentTexture)
  if (context.canvasContext) {
    try {
      context.canvasContext.unconfigure();
    } catch (error) {
      console.warn('Error unconfiguring GPU canvas context:', error);
    }
  }

  // Only destroy device if we own it (created internally); shared devices are caller-owned.
  // Backwards compat: missing ownership metadata treated as "owned" (legacy behavior).
  if (getOwnsDevice(context) !== false && context.device) {
    try {
      context.device.destroy();
    } catch (error) {
      console.warn('Error destroying GPU device:', error);
    }
  }

  return {
    adapter: null,
    device: null,
    initialized: false,
    canvas: context.canvas,
    canvasContext: null,
    preferredFormat: null,
    devicePixelRatio: context.devicePixelRatio,
    alphaMode: context.alphaMode,
    powerPreference: context.powerPreference,
    [ownsDeviceKey]: false,
  } as GPUContextStateInternal;
}

/**
 * Convenience function that creates and initializes a GPU context in one step.
 *
 * @param canvas - Optional canvas element (HTMLCanvasElement) to configure for WebGPU rendering
 * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
 * @returns A fully initialized GPUContextState
 * @throws {Error} If initialization fails
 *
 * @example
 * ```typescript
 * const context = await createGPUContextAsync();
 * const device = context.device;
 * ```
 *
 * @example
 * ```typescript
 * const canvas = document.querySelector('canvas');
 * const context = await createGPUContextAsync(canvas);
 * const texture = getCanvasTexture(context);
 * ```
 */
export async function createGPUContextAsync(
  canvas?: HTMLCanvasElement,
  options?: GPUContextOptions
): Promise<GPUContextState> {
  const context = createGPUContext(canvas, options);
  return initializeGPUContext(context);
}

/**
 * GPUContext class wrapper for backward compatibility.
 *
 * This class provides a class-based API that internally uses the functional implementation.
 * Use the functional API directly for better type safety and immutability.
 */
export class GPUContext {
  private _state: GPUContextState;

  /**
   * Gets the WebGPU adapter, or null if not initialized.
   */
  get adapter(): GPUAdapter | null {
    return this._state.adapter;
  }

  /**
   * Gets the WebGPU device, or null if not initialized.
   */
  get device(): GPUDevice | null {
    return this._state.device;
  }

  /**
   * Checks if the context has been initialized.
   */
  get initialized(): boolean {
    return this._state.initialized;
  }

  /**
   * Gets the canvas element, or null if not provided.
   */
  get canvas(): SupportedCanvas | null {
    return this._state.canvas;
  }

  /**
   * Gets the WebGPU canvas context, or null if canvas is not configured.
   */
  get canvasContext(): GPUCanvasContext | null {
    return this._state.canvasContext;
  }

  /**
   * Gets the preferred canvas format, or null if canvas is not configured.
   */
  get preferredFormat(): GPUTextureFormat | null {
    return this._state.preferredFormat;
  }

  /**
   * Gets the device pixel ratio used for canvas sizing.
   */
  get devicePixelRatio(): number {
    return this._state.devicePixelRatio;
  }

  /**
   * Updates the device pixel ratio used by layout helpers (e.g. `computeGridArea`).
   * Called from chart resize so grid margins stay consistent with the canvas backing store
   * when live `window.devicePixelRatio` changes (page zoom) or an explicit option is applied.
   *
   * Does not reconfigure the canvas; callers size `canvas.width/height` separately.
   */
  setDevicePixelRatio(devicePixelRatio: number): void {
    const sanitized = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1.0;
    if (this._state.devicePixelRatio === sanitized) return;
    const prev = this._state as GPUContextStateInternal;
    this._state = {
      ...prev,
      devicePixelRatio: sanitized,
    } as GPUContextStateInternal;
  }

  /**
   * Gets the canvas alpha mode.
   */
  get alphaMode(): 'opaque' | 'premultiplied' {
    return this._state.alphaMode;
  }

  /**
   * Gets the GPU power preference.
   */
  get powerPreference(): 'low-power' | 'high-performance' {
    return this._state.powerPreference;
  }

  /**
   * Creates a new GPUContext instance.
   *
   * @param canvas - Optional canvas element (HTMLCanvasElement) to configure for WebGPU rendering
   * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
   */
  constructor(canvas?: HTMLCanvasElement, options?: GPUContextOptions) {
    this._state = createGPUContext(canvas, options);
  }

  /**
   * Initializes the WebGPU context by requesting an adapter and device.
   *
   * @throws {Error} If WebGPU is not available in the browser
   * @throws {Error} If adapter request fails
   * @throws {Error} If device request fails
   * @throws {Error} If already initialized
   */
  async initialize(): Promise<void> {
    this._state = await initializeGPUContext(this._state);
  }

  /**
   * Static factory method to create and initialize a GPUContext instance.
   *
   * @param canvas - Optional canvas element (HTMLCanvasElement) to configure for WebGPU rendering
   * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
   * @returns A fully initialized GPUContext instance
   * @throws {Error} If initialization fails
   *
   * @example
   * ```typescript
   * const context = await GPUContext.create();
   * const device = context.device;
   * ```
   *
   * @example
   * ```typescript
   * const canvas = document.querySelector('canvas');
   * const context = await GPUContext.create(canvas);
   * const texture = context.getCanvasTexture();
   * ```
   */
  static async create(canvas?: HTMLCanvasElement, options?: GPUContextOptions): Promise<GPUContext> {
    const context = new GPUContext(canvas, options);
    await context.initialize();
    return context;
  }

  /**
   * Gets the current texture from the canvas context.
   *
   * @returns The current canvas texture
   * @throws {Error} If canvas is not configured or context is not initialized
   *
   * @example
   * ```typescript
   * const texture = context.getCanvasTexture();
   * // Use texture in render pass
   * ```
   */
  getCanvasTexture(): GPUTexture {
    return getCanvasTexture(this._state);
  }

  /**
   * Clears the canvas to a solid color.
   * Creates a command encoder, begins a render pass with the specified clear color,
   * ends the pass, and submits it to the queue.
   *
   * @param r - Red component (0.0 to 1.0)
   * @param g - Green component (0.0 to 1.0)
   * @param b - Blue component (0.0 to 1.0)
   * @param a - Alpha component (0.0 to 1.0)
   * @throws {Error} If canvas is not configured or context is not initialized
   * @throws {Error} If device is not available
   *
   * @example
   * ```typescript
   * // Clear to dark purple (#1a1a2e)
   * context.clearScreen(0x1a / 255, 0x1a / 255, 0x2e / 255, 1.0);
   * ```
   */
  clearScreen(r: number, g: number, b: number, a: number): void {
    clearScreen(this._state, r, g, b, a);
  }

  /**
   * Destroys the WebGPU device and cleans up resources.
   * After calling destroy(), the context must be reinitialized before use.
   */
  destroy(): void {
    this._state = destroyGPUContext(this._state);
  }
}
