/**
 * GPUContext - WebGPU device and adapter management
 * 
 * Handles WebGPU initialization, adapter selection, and device creation
 * following WebGPU best practices for resource management and error handling.
 * 
 * This module provides both functional and class-based APIs for maximum flexibility.
 */

/** Canvas types supported by GPUContext. */
export type SupportedCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Options for GPU context initialization. */
export interface GPUContextOptions {
  /** DPR for high-DPI displays. Auto-detects on main thread, defaults to 1.0 in workers. */
  readonly devicePixelRatio?: number;
  /** Canvas alpha mode. Default: 'opaque' (faster, no transparency). */
  readonly alphaMode?: 'opaque' | 'premultiplied';
  /** GPU power preference for adapter selection. */
  readonly powerPreference?: 'low-power' | 'high-performance';
}

/**
 * Represents the state of a GPU context.
 * All properties are readonly to ensure immutability.
 */
export interface GPUContextState {
  readonly adapter: GPUAdapter | null;
  readonly device: GPUDevice | null;
  readonly initialized: boolean;
  readonly canvas: SupportedCanvas | null;
  readonly canvasContext: GPUCanvasContext | null;
  readonly preferredFormat: GPUTextureFormat | null;
  readonly devicePixelRatio: number;
  readonly alphaMode: 'opaque' | 'premultiplied';
  readonly powerPreference: 'low-power' | 'high-performance';
}

/** Reliable type guard - instanceof works in workers where HTMLCanvasElement is undefined. */
export function isHTMLCanvasElement(canvas: SupportedCanvas): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
}

/** Gets display dimensions - clientWidth/Height for HTMLCanvasElement, width/height for OffscreenCanvas. */
function getCanvasDimensions(canvas: SupportedCanvas): { width: number; height: number } {
  if (isHTMLCanvasElement(canvas)) {
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
  // OffscreenCanvas: dimensions already set by main thread (device pixels)
  const width = canvas.width;
  const height = canvas.height;
  
  // Validate OffscreenCanvas dimensions
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(
      `GPUContext: Invalid OffscreenCanvas dimensions: width=${width}, height=${height}. ` +
      `OffscreenCanvas must be initialized with finite dimensions before GPUContext creation.`
    );
  }
  
  return { width, height };
}

/**
 * Creates a new GPUContext state with initial values.
 * 
 * @param canvas - Optional canvas element (HTMLCanvasElement or OffscreenCanvas) to configure for WebGPU rendering
 * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
 * @returns A new GPUContextState instance
 */
export function createGPUContext(
  canvas?: SupportedCanvas,
  options?: GPUContextOptions
): GPUContextState {
  // Auto-detect DPR on main thread, default to 1.0 in workers
  const dprRaw =
    options?.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1.0);
  // Be resilient: callers may pass 0/NaN/Infinity. Fall back to 1 instead of throwing.
  const dpr = Number.isFinite(dprRaw) && dprRaw > 0 ? dprRaw : 1.0;
  const alphaMode = options?.alphaMode ?? 'opaque';
  const powerPreference = options?.powerPreference ?? 'high-performance';
  
  return {
    adapter: null,
    device: null,
    initialized: false,
    canvas: canvas || null,
    canvasContext: null,
    preferredFormat: null,
    devicePixelRatio: dpr,
    alphaMode,
    powerPreference,
  };
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
export async function initializeGPUContext(
  context: GPUContextState
): Promise<GPUContextState> {
  if (context.initialized) {
    throw new Error('GPUContext is already initialized. Call destroyGPUContext() before reinitializing.');
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

  try {
    // Request adapter with power preference from context
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: context.powerPreference,
    });

    if (!adapter) {
      throw new Error(
        'Failed to request WebGPU adapter. ' +
        'No compatible adapter found. This may occur if no GPU is available or WebGPU is disabled.'
      );
    }

    // Request device from adapter
    device = await adapter.requestDevice();

    if (!device) {
      throw new Error('Failed to request WebGPU device from adapter.');
    }

    // Set up device lost handler for error recovery
    device.addEventListener('uncapturederror', (event: GPUUncapturedErrorEvent) => {
      console.error('WebGPU uncaptured error:', event.error);
    });

    let canvasContext: GPUCanvasContext | null = null;
    let preferredFormat: GPUTextureFormat | null = null;

    // Configure canvas if provided
    if (context.canvas) {
      const webgpuContext = context.canvas.getContext('webgpu') as GPUCanvasContext | null;
      
      if (!webgpuContext) {
        // Clean up device before throwing
        try {
          device.destroy();
        } catch (error) {
          console.warn('Error destroying device during canvas setup failure:', error);
        }
        throw new Error('Failed to get WebGPU context from canvas.');
      }

      // Use DPR from context state (set at context creation)
      const { width, height } = getCanvasDimensions(context.canvas);
      const dpr = sanitizedDevicePixelRatio;
      
      // Calculate target dimensions in device pixels
      // Note: width/height from getCanvasDimensions are in CSS pixels for HTMLCanvasElement,
      // or device pixels for OffscreenCanvas (already set by main thread)
      const targetWidth = Math.floor(width * dpr);
      const targetHeight = Math.floor(height * dpr);

      // Clamp to device limits (must happen after device creation)
      const maxDim = device.limits.maxTextureDimension2D;
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
    };
  } catch (error) {
    // If a device was created but initialization failed, destroy it to avoid leaks.
    if (device) {
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
    throw new Error('Canvas is not configured. Provide a canvas element when creating the context.');
  }

  if (!context.initialized || !context.canvasContext) {
    throw new Error('GPUContext is not initialized. Call initializeGPUContext() first.');
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
export function clearScreen(
  context: GPUContextState,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  // Validate color component ranges
  if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1 || a < 0 || a > 1) {
    throw new Error('Color components must be in the range [0.0, 1.0]');
  }

  if (!context.canvas) {
    throw new Error('Canvas is not configured. Provide a canvas element when creating the context.');
  }

  if (!context.initialized || !context.device || !context.canvasContext) {
    throw new Error('GPUContext is not initialized. Call initializeGPUContext() first.');
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
 * Returns a new state object with reset values.
 * After calling this, the context must be reinitialized before use.
 * 
 * @param context - The GPU context state to destroy
 * @returns A new GPUContextState with reset values
 */
export function destroyGPUContext(context: GPUContextState): GPUContextState {
  if (context.device) {
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
  };
}

/**
 * Convenience function that creates and initializes a GPU context in one step.
 * 
 * @param canvas - Optional canvas element (HTMLCanvasElement or OffscreenCanvas) to configure for WebGPU rendering
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
  canvas?: SupportedCanvas,
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
   * @param canvas - Optional canvas element (HTMLCanvasElement or OffscreenCanvas) to configure for WebGPU rendering
   * @param options - Optional configuration for device pixel ratio, alpha mode, and power preference
   */
  constructor(canvas?: SupportedCanvas, options?: GPUContextOptions) {
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
   * @param canvas - Optional canvas element (HTMLCanvasElement or OffscreenCanvas) to configure for WebGPU rendering
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
  static async create(canvas?: SupportedCanvas, options?: GPUContextOptions): Promise<GPUContext> {
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
