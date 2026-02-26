/**
 * WebGPU support detection and validation
 * 
 * Provides utilities to check if WebGPU is available and usable in the current environment.
 * Results are memoized to avoid redundant checks.
 */

/**
 * Result of WebGPU support check
 */
export interface WebGPUSupportResult {
  /** Whether WebGPU is supported and available */
  readonly supported: boolean;
  /** Optional reason explaining why WebGPU is not supported */
  readonly reason?: string;
}

// Memoized support check result
let cachedSupportCheck: Promise<WebGPUSupportResult> | null = null;

/**
 * Checks if WebGPU is supported and available in the current environment.
 * 
 * This function performs comprehensive checks:
 * - SSR-safe: validates that window and navigator are available
 * - Checks for navigator.gpu API presence
 * - Attempts to request a WebGPU adapter to verify actual support
 * - First tries high-performance adapter to match GPUContext behavior
 * - Falls back to default adapter if high-performance fails
 * 
 * The result is memoized for performance, so multiple calls return the same promise.
 * 
 * @returns Promise resolving to support check result with optional reason
 * 
 * @example
 * ```typescript
 * const { supported, reason } = await checkWebGPUSupport();
 * if (!supported) {
 *   console.error('WebGPU not available:', reason);
 * }
 * ```
 */
export async function checkWebGPUSupport(): Promise<WebGPUSupportResult> {
  // Return cached result if available
  if (cachedSupportCheck) {
    return cachedSupportCheck;
  }

  // Create and cache the promise
  cachedSupportCheck = (async (): Promise<WebGPUSupportResult> => {
    // SSR-safe checks: ensure we're in a browser environment
    if (typeof window === 'undefined') {
      return {
        supported: false,
        reason: 'Not running in a browser environment (window is undefined).',
      };
    }

    if (typeof navigator === 'undefined') {
      return {
        supported: false,
        reason: 'Navigator is not available in this environment.',
      };
    }

    // Check for navigator.gpu API
    if (!navigator.gpu) {
      return {
        supported: false,
        reason: 'WebGPU API (navigator.gpu) is not available. Your browser does not support WebGPU.',
      };
    }

    // Attempt to request an adapter to verify actual support
    try {
      // First attempt: high-performance adapter (aligns with GPUContext behavior)
      let adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });

      // Second attempt: default adapter if high-performance is unavailable
      if (!adapter) {
        adapter = await navigator.gpu.requestAdapter();
      }

      // If both attempts fail, WebGPU is not usable
      if (!adapter) {
        return {
          supported: false,
          reason: 'No compatible WebGPU adapter found. This may occur if: (1) no GPU is available, (2) GPU drivers are outdated or incompatible, (3) running in a VM or headless environment, or (4) WebGPU is disabled in browser settings.',
        };
      }

      // Success: WebGPU is supported and an adapter is available
      // Null out adapter reference so the closure doesn't prevent GC (CGPU-OOM-139)
      adapter = null;
      return { supported: true };
    } catch (error) {
      // Adapter request threw an error
      let reason = 'Failed to request WebGPU adapter.';

      // Try to extract useful error information
      if (error instanceof DOMException) {
        reason = `Failed to request WebGPU adapter: ${error.name}`;
        if (error.message) {
          reason += ` - ${error.message}`;
        }
      } else if (error instanceof Error) {
        reason = `Failed to request WebGPU adapter: ${error.message}`;
      } else {
        reason = `Failed to request WebGPU adapter: ${String(error)}`;
      }

      return { supported: false, reason };
    }
  })();

  return cachedSupportCheck;
}
