/**
 * Worker-related types for ChartGPU worker thread support.
 */

/**
 * Branded type for stride values in bytes.
 * Ensures type safety when passing stride information for data point formats.
 */
export type StrideBytes = number & { readonly __brand: 'StrideBytes' };

/**
 * Stride for DataPoint format: [x, y] = 2 floats × 4 bytes = 8 bytes.
 */
export const XY_STRIDE: StrideBytes = 8 as StrideBytes;

/**
 * Stride for OHLCDataPoint format: [t, o, h, l, c] = 5 floats × 4 bytes = 20 bytes.
 */
export const OHLC_STRIDE: StrideBytes = 20 as StrideBytes;

/**
 * Configuration for creating a worker-based chart instance.
 */
export interface WorkerConfig {
  /** Web Worker instance to use for rendering. */
  readonly worker: Worker;
  /** Chart ID for worker communication (auto-generated if not provided). */
  readonly chartId?: string;
  /** Timeout in milliseconds for message responses (default: 30000). */
  readonly messageTimeout?: number;
  /** Optional WebGPU initialization options. */
  readonly gpuOptions?: {
    readonly powerPreference?: 'low-power' | 'high-performance';
    readonly requiredFeatures?: ReadonlyArray<string>;
  };
}

/**
 * Error thrown when worker operations fail.
 */
export class ChartGPUWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly operation: string,
    public readonly chartId?: string
  ) {
    super(message);
    this.name = 'ChartGPUWorkerError';
  }
}

/**
 * Internal pending request tracker for message correlation.
 * 
 * Generic type T represents the expected response message type.
 * This ensures type safety when resolving promises with specific message types.
 * 
 * @example
 * ```typescript
 * const pending: PendingRequest<ReadyMessage> = {
 *   resolve: (msg: ReadyMessage) => console.log(msg.capabilities),
 *   reject: (err: Error) => console.error(err),
 *   timeout: setTimeout(...),
 *   operation: 'init'
 * };
 * ```
 */
export interface PendingRequest<T = unknown> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  /** Operation name for debugging and error reporting. */
  readonly operation: string;
}

/**
 * Constants for maximum safe buffer sizes.
 * Based on browser structured clone algorithm limits (~2GB) and WebGPU buffer limits.
 */
export const MAX_BUFFER_SIZE = 2_147_483_648; // 2GB

/**
 * Maximum safe point counts for different data types.
 * Calculated based on MAX_BUFFER_SIZE and stride per point.
 */
export const MAX_XY_POINTS = Math.floor(MAX_BUFFER_SIZE / 8);     // 268,435,456 points
export const MAX_OHLC_POINTS = Math.floor(MAX_BUFFER_SIZE / 20);  // 107,374,182 points
