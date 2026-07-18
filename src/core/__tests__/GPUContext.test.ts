/// <reference types="@webgpu/types" />

/**
 * Tests for GPUContext - WebGPU device and adapter management.
 * Covers device ownership, shared device injection, and proper disposal behavior.
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest';
import {
  createGPUContext,
  initializeGPUContext,
  destroyGPUContext,
  GPUContext,
  type GPUContextOptions,
  type GPUContextState,
} from '../GPUContext';

// Mock WebGPU globals before importing the module
beforeAll(() => {
  // @ts-ignore - Mock WebGPU globals
  globalThis.GPUShaderStage = {
    VERTEX: 1,
    FRAGMENT: 2,
    COMPUTE: 4,
  };
  // @ts-ignore - Mock WebGPU texture usage flags
  globalThis.GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
});

// Mock canvas element
function createMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    getContext: vi.fn((contextId: string) => {
      if (contextId === 'webgpu') {
        return {
          configure: vi.fn(),
          unconfigure: vi.fn(),
          getCurrentTexture: vi.fn(() => ({
            createView: vi.fn(() => ({})),
          })),
        };
      }
      return null;
    }),
  } as any;
  return canvas;
}

// Mock GPUDevice
function createMockDevice(): GPUDevice {
  const mockDevice = {
    limits: {
      maxTextureDimension2D: 8192,
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 268435456,
      maxBindGroups: 4,
    },
    destroy: vi.fn(),
    createBuffer: vi.fn(),
    createTexture: vi.fn(),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => ({
        end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
    queue: {
      submit: vi.fn(),
    },
    addEventListener: vi.fn(),
    // Use a never-resolving promise to avoid auto-triggering device lost handlers
    lost: new Promise(() => {}),
  } as any;
  return mockDevice;
}

// Mock GPUAdapter
function createMockAdapter(): GPUAdapter {
  const mockAdapter = {
    requestDevice: vi.fn(async () => createMockDevice()),
    features: new Set<string>(),
    limits: {
      maxTextureDimension2D: 8192,
    },
  } as any;
  return mockAdapter;
}

// Mock navigator.gpu
function setupMockNavigatorGPU(adapter: GPUAdapter | null = createMockAdapter()): void {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
    },
  });
}

describe('GPUContext - Shared Device Ownership', () => {
  let mockCanvas: HTMLCanvasElement;

  beforeEach(() => {
    mockCanvas = createMockCanvas();
    setupMockNavigatorGPU();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('Owned Device (Default Behavior)', () => {
    it('creates device internally when no device/adapter provided', async () => {
      const context = createGPUContext(mockCanvas);
      const initialized = await initializeGPUContext(context);

      expect(initialized.device).not.toBeNull();
      expect(navigator.gpu.requestAdapter).toHaveBeenCalled();
    });

    it('calls device.destroy() on dispose when device is owned', async () => {
      const context = createGPUContext(mockCanvas);
      const initialized = await initializeGPUContext(context);

      expect(initialized.device).not.toBeNull();

      const device = initialized.device!;
      destroyGPUContext(initialized);

      expect(device.destroy).toHaveBeenCalledTimes(1);
    });

    it('calls canvasContext.unconfigure() on dispose when device is owned', async () => {
      const context = createGPUContext(mockCanvas);
      const initialized = await initializeGPUContext(context);

      expect(initialized.canvasContext).not.toBeNull();
      const canvasContext = initialized.canvasContext!;

      destroyGPUContext(initialized);

      expect(canvasContext.unconfigure).toHaveBeenCalledTimes(1);
    });

    it('initializes GPUContext class (default device creation)', async () => {
      const context = await GPUContext.create(mockCanvas);

      // Access internal state through getters
      expect(context.initialized).toBe(true);
      expect(context.device).not.toBeNull();
    });
  });

  describe('Shared Device (Injected Device/Adapter)', () => {
    it('uses injected device and adapter when both provided', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = createGPUContext(mockCanvas, options);
      const initialized = await initializeGPUContext(context);

      expect(initialized.device).toBe(injectedDevice);
      expect(initialized.adapter).toBe(injectedAdapter);
      expect(navigator.gpu.requestAdapter).not.toHaveBeenCalled();
    });

    it('does NOT call device.destroy() on dispose when device is shared', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = createGPUContext(mockCanvas, options);
      const initialized = await initializeGPUContext(context);

      destroyGPUContext(initialized);

      // Device destroy should NOT be called for shared device
      expect(injectedDevice.destroy).not.toHaveBeenCalled();
    });

    it('calls canvasContext.unconfigure() on dispose when device is shared', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = createGPUContext(mockCanvas, options);
      const initialized = await initializeGPUContext(context);

      expect(initialized.canvasContext).not.toBeNull();
      const canvasContext = initialized.canvasContext!;

      destroyGPUContext(initialized);

      // Canvas context unconfigure should ALWAYS be called
      expect(canvasContext.unconfigure).toHaveBeenCalledTimes(1);
      // But device destroy should NOT be called for shared device
      expect(injectedDevice.destroy).not.toHaveBeenCalled();
    });

    it('ignores device option when adapter is not provided', async () => {
      const injectedDevice = createMockDevice();

      const options: GPUContextOptions = {
        device: injectedDevice,
        // adapter: undefined - not provided
      };

      const context = createGPUContext(mockCanvas, options);
      const initialized = await initializeGPUContext(context);

      // Should create its own device since both weren't provided
      expect(initialized.device).not.toBe(injectedDevice);
      expect(navigator.gpu.requestAdapter).toHaveBeenCalled();
    });

    it('ignores adapter option when device is not provided', async () => {
      const injectedAdapter = createMockAdapter();

      const options: GPUContextOptions = {
        adapter: injectedAdapter,
        // device: undefined - not provided
      };

      const context = createGPUContext(mockCanvas, options);
      await initializeGPUContext(context);

      // Should create its own device since both weren't provided
      expect(navigator.gpu.requestAdapter).toHaveBeenCalled();
    });

    it('works with GPUContext class constructor with shared device', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = new GPUContext(mockCanvas, options);
      await context.initialize();

      expect(context.device).toBe(injectedDevice);
      expect(context.adapter).toBe(injectedAdapter);
      expect(context.initialized).toBe(true);
    });

    it('validates getPreferredCanvasFormat availability for shared device', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      // Setup navigator without getPreferredCanvasFormat to simulate unsupported environment
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn(async () => createMockAdapter()),
          // getPreferredCanvasFormat is intentionally missing
        },
      });

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = createGPUContext(mockCanvas, options);

      await expect(initializeGPUContext(context)).rejects.toThrow(/Shared device requires.*getPreferredCanvasFormat/);
    });

    it('validates injected device.limits.maxBufferSize (throws when insufficient)', async () => {
      const injectedDevice = createMockDevice() as any;
      injectedDevice.limits.maxBufferSize = 1024 * 1024; // 1 MiB
      const injectedAdapter = createMockAdapter();

      const context = createGPUContext(mockCanvas, {
        device: injectedDevice,
        adapter: injectedAdapter,
      });
      await expect(initializeGPUContext(context)).rejects.toThrow(/maxBufferSize.*Required.*actual/i);
    });

    it('validates injected device.limits.maxStorageBufferBindingSize (throws when insufficient)', async () => {
      const injectedDevice = createMockDevice() as any;
      injectedDevice.limits.maxStorageBufferBindingSize = 1024 * 1024; // 1 MiB
      const injectedAdapter = createMockAdapter();

      const context = createGPUContext(mockCanvas, {
        device: injectedDevice,
        adapter: injectedAdapter,
      });
      await expect(initializeGPUContext(context)).rejects.toThrow(/maxStorageBufferBindingSize.*Required.*actual/i);
    });

    it('validates injected device.limits.maxTextureDimension2D against canvas size at DPR', async () => {
      // Make the canvas large enough to exceed maxTextureDimension2D when injected.
      const bigCanvas = createMockCanvas() as any;
      bigCanvas.clientWidth = 9000;
      bigCanvas.clientHeight = 600;

      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      const context = createGPUContext(bigCanvas, {
        device: injectedDevice,
        adapter: injectedAdapter,
      });
      await expect(initializeGPUContext(context)).rejects.toThrow(/maxTextureDimension2D.*Required.*actual/i);
    });

    it('validates preferred canvas format is a mandated canvas format in shared device mode', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn(async () => createMockAdapter()),
          getPreferredCanvasFormat: vi.fn(() => 'rgb10a2unorm'),
        },
      });

      const context = createGPUContext(mockCanvas, {
        device: injectedDevice,
        adapter: injectedAdapter,
      });
      await expect(initializeGPUContext(context)).rejects.toThrow(/preferred canvas format.*Supported formats/i);
    });
  });

  describe('Device Cleanup on Errors', () => {
    it('destroys owned device on canvas context error', async () => {
      const mockDevice = createMockDevice();
      const mockAdapter = createMockAdapter();

      // Make sure we track the exact device that gets created
      mockAdapter.requestDevice = vi.fn(async () => mockDevice);

      // Setup fresh navigator with this adapter
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn(async () => mockAdapter),
          getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
        },
      });

      // Make getContext fail
      mockCanvas.getContext = vi.fn(() => null);

      const context = createGPUContext(mockCanvas);

      await expect(initializeGPUContext(context)).rejects.toThrow(/Failed to get WebGPU context from canvas/);

      // Device should be destroyed on error (owned device) - at least once
      expect(mockDevice.destroy).toHaveBeenCalled();
    });

    it('does NOT destroy shared device on canvas context error', async () => {
      const injectedDevice = createMockDevice();
      const injectedAdapter = createMockAdapter();

      // Make getContext fail
      mockCanvas.getContext = vi.fn(() => null);

      const options: GPUContextOptions = {
        device: injectedDevice,
        adapter: injectedAdapter,
      };

      const context = createGPUContext(mockCanvas, options);

      await expect(initializeGPUContext(context)).rejects.toThrow(/Failed to get WebGPU context from canvas/);

      // Device should NOT be destroyed on error (shared device)
      expect(injectedDevice.destroy).not.toHaveBeenCalled();
    });
  });

  describe('Backwards Compatibility', () => {
    it('treats missing ownership metadata as owned (legacy behavior)', () => {
      // Create a legacy context without internal ownership metadata
      const legacyContext: GPUContextState = {
        adapter: createMockAdapter(),
        device: createMockDevice(),
        initialized: true,
        canvas: mockCanvas,
        canvasContext: mockCanvas.getContext('webgpu') as GPUCanvasContext,
        preferredFormat: 'bgra8unorm',
        devicePixelRatio: 1,
        alphaMode: 'opaque',
        powerPreference: 'high-performance',
      };

      destroyGPUContext(legacyContext);

      // Should destroy device for backwards compatibility (undefined treated as owned)
      expect(legacyContext.device!.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('setDevicePixelRatio', () => {
    it('updates devicePixelRatio for computeGridArea without resizing canvas', async () => {
      const { computeGridArea } = await import('../renderCoordinator/utils/axisUtils');
      const ctx = await GPUContext.create(mockCanvas, { devicePixelRatio: 1 });
      expect(ctx.devicePixelRatio).toBe(1);

      const widthBefore = mockCanvas.width;
      ctx.setDevicePixelRatio(2);
      expect(ctx.devicePixelRatio).toBe(2);
      // Caller owns canvas backing size; setDevicePixelRatio does not resize.
      expect(mockCanvas.width).toBe(widthBefore);

      // Multi-layer: layout helpers must see the updated DPR.
      mockCanvas.width = 800;
      mockCanvas.height = 600;
      const gridArea = computeGridArea(ctx, {
        grid: { left: 40, right: 20, top: 10, bottom: 30 },
      } as any);
      expect(gridArea.devicePixelRatio).toBe(2);
      expect(gridArea.canvasWidth).toBe(800);
      expect(gridArea.canvasHeight).toBe(600);

      await ctx.destroy();
    });

    it.each([
      [0, 1],
      [NaN, 1],
      [-1, 1],
      [Infinity, 1],
      [2.5, 2.5],
    ] as const)('setDevicePixelRatio(%s) → %s', async (input, expected) => {
      const ctx = await GPUContext.create(mockCanvas, { devicePixelRatio: 1 });
      ctx.setDevicePixelRatio(input);
      expect(ctx.devicePixelRatio).toBe(expected);
      await ctx.destroy();
    });
  });

  describe('canvasContext.unconfigure always called', () => {
    it('unconfigures canvas context even when device is null', () => {
      const context: GPUContextState = {
        adapter: null,
        device: null,
        initialized: false,
        canvas: mockCanvas,
        canvasContext: mockCanvas.getContext('webgpu') as GPUCanvasContext,
        preferredFormat: 'bgra8unorm',
        devicePixelRatio: 1,
        alphaMode: 'opaque',
        powerPreference: 'high-performance',
      };

      destroyGPUContext(context);

      expect(context.canvasContext!.unconfigure).toHaveBeenCalledTimes(1);
    });

    it('handles unconfigure error gracefully', () => {
      const context: GPUContextState = {
        adapter: null,
        device: createMockDevice(),
        initialized: true,
        canvas: mockCanvas,
        canvasContext: {
          unconfigure: vi.fn(() => {
            throw new Error('Unconfigure failed');
          }),
        } as any,
        preferredFormat: 'bgra8unorm',
        devicePixelRatio: 1,
        alphaMode: 'opaque',
        powerPreference: 'high-performance',
      };

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw
      expect(() => destroyGPUContext(context)).not.toThrow();

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();

      // Should still destroy device even if unconfigure fails
      expect(context.device!.destroy).toHaveBeenCalledTimes(1);
    });

    it('handles destroy error gracefully', () => {
      const mockDevice = createMockDevice();
      mockDevice.destroy = vi.fn(() => {
        throw new Error('Destroy failed');
      });

      const context: GPUContextState = {
        adapter: null,
        device: mockDevice,
        initialized: true,
        canvas: mockCanvas,
        canvasContext: mockCanvas.getContext('webgpu') as GPUCanvasContext,
        preferredFormat: 'bgra8unorm',
        devicePixelRatio: 1,
        alphaMode: 'opaque',
        powerPreference: 'high-performance',
      };

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw even if device.destroy() fails
      expect(() => destroyGPUContext(context)).not.toThrow();

      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();

      // Should still unconfigure canvas even if destroy fails
      expect(context.canvasContext!.unconfigure).toHaveBeenCalledTimes(1);
    });
  });

  describe('Device Loss Scenarios', () => {
    it('device.lost promise resolves for shared device', async () => {
      const deviceLostResolver = { resolve: null as any };
      const lostPromise = new Promise<GPUDeviceLostInfo>((resolve) => {
        deviceLostResolver.resolve = resolve;
      });

      const mockDevice = createMockDevice();
      (mockDevice as any).lost = lostPromise;

      const injectedAdapter = createMockAdapter();

      const context = createGPUContext(mockCanvas, {
        device: mockDevice,
        adapter: injectedAdapter,
      });
      const initialized = await initializeGPUContext(context);

      expect(initialized.device).toBe(mockDevice);

      // Simulate device loss
      const lostInfo = {
        reason: 'unknown',
        message: 'GPU hung',
      } as GPUDeviceLostInfo;
      deviceLostResolver.resolve(lostInfo);

      // Wait for promise to resolve
      await lostPromise;

      // Device should not be destroyed by GPUContext (caller responsibility)
      expect(mockDevice.destroy).not.toHaveBeenCalled();
    });
  });
});
