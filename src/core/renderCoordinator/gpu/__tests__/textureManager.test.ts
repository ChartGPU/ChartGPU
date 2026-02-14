/**
 * Tests for GPU texture manager.
 * These tests verify texture allocation, reallocation, and disposal.
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';

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

import { createTextureManager } from '../textureManager';
import type { TextureManagerConfig } from '../textureManager';

// Mock GPUDevice and related WebGPU types
function createMockDevice(): GPUDevice {
  const mockTextures: GPUTexture[] = [];

  const mockDevice = {
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const mockTexture = {
        label: descriptor.label,
        width: (descriptor.size as GPUExtent3DDict).width,
        height: (descriptor.size as GPUExtent3DDict).height,
        format: descriptor.format,
        sampleCount: descriptor.sampleCount ?? 1,
        createView: vi.fn(() => ({
          label: `${descriptor.label}/view`,
        })),
        destroy: vi.fn(),
      };
      mockTextures.push(mockTexture as any);
      return mockTexture;
    }),
    createBindGroupLayout: vi.fn(() => ({
      label: 'mockBindGroupLayout',
    })),
    createBindGroup: vi.fn(() => ({
      label: 'mockBindGroup',
    })),
    createPipelineLayout: vi.fn(() => ({
      label: 'mockPipelineLayout',
    })),
    createShaderModule: vi.fn(() => ({
      label: 'mockShaderModule',
    })),
    createRenderPipeline: vi.fn(() => ({
      label: 'mockRenderPipeline',
    })),
  } as any;

  return mockDevice;
}

function createMockRenderPipeline(): GPURenderPipeline {
  return {
    label: 'mockPipeline',
  } as any;
}

// Mock the createRenderPipeline function
vi.mock('../../../renderers/rendererUtils', () => ({
  createRenderPipeline: vi.fn(() => createMockRenderPipeline()),
}));

describe('TextureManager', () => {
  let device: GPUDevice;
  let config: TextureManagerConfig;

  beforeEach(() => {
    device = createMockDevice();
    config = {
      device,
      targetFormat: 'bgra8unorm' as GPUTextureFormat,
    };
  });

  it('creates texture manager without errors', () => {
    expect(() => createTextureManager(config)).not.toThrow();
  });

  it('getState returns null views before ensureTextures is called', () => {
    const manager = createTextureManager(config);
    const state = manager.getState();

    expect(state.mainColorView).toBe(null);
    expect(state.overlayMsaaView).toBe(null);
    expect(state.overlayBlitBindGroup).toBe(null);
  });

  it('getState returns msaaSampleCount', () => {
    const manager = createTextureManager(config);
    const state = manager.getState();

    expect(state.msaaSampleCount).toBe(4);
  });

  it('getState returns overlayBlitPipeline', () => {
    const manager = createTextureManager(config);
    const state = manager.getState();

    expect(state.overlayBlitPipeline).toBeDefined();
  });

  it('ensureTextures allocates textures', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    const state = manager.getState();
    expect(state.mainColorView).not.toBe(null);
    expect(state.overlayMsaaView).not.toBe(null);
    expect(state.overlayBlitBindGroup).not.toBe(null);
  });

  it('ensureTextures creates main color texture with correct properties', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    // Main color texture is now 4x MSAA (RENDER_ATTACHMENT only — multisampled textures cannot have TEXTURE_BINDING).
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'textureManager/mainColorTexture',
        size: { width: 800, height: 600 },
        sampleCount: 4,
        format: 'bgra8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    );

    // Single-sample resolve target receives the MSAA resolve and is read by the overlay blit.
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'textureManager/mainResolveTexture',
        size: { width: 800, height: 600 },
        format: 'bgra8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    );
  });

  it('ensureTextures creates MSAA overlay texture with correct properties', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'textureManager/annotationOverlayMsaaTexture',
        size: { width: 800, height: 600 },
        sampleCount: 4,
        format: 'bgra8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    );
  });

  it('ensureTextures clamps dimensions to minimum 1', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(0, -5);

    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        size: { width: 1, height: 1 },
      })
    );
  });

  it('ensureTextures handles non-finite dimensions', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(NaN, Infinity);

    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        size: { width: 1, height: 1 },
      })
    );
  });

  it('ensureTextures does not reallocate if dimensions match', () => {
    const manager = createTextureManager(config);

    manager.ensureTextures(800, 600);
    const callCountAfterFirst = (device.createTexture as any).mock.calls.length;

    manager.ensureTextures(800, 600);
    const callCountAfterSecond = (device.createTexture as any).mock.calls.length;

    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it('ensureTextures reallocates if width changes', () => {
    const manager = createTextureManager(config);

    manager.ensureTextures(800, 600);
    const callCountAfterFirst = (device.createTexture as any).mock.calls.length;

    manager.ensureTextures(1024, 600);
    const callCountAfterSecond = (device.createTexture as any).mock.calls.length;

    expect(callCountAfterSecond).toBeGreaterThan(callCountAfterFirst);
  });

  it('ensureTextures reallocates if height changes', () => {
    const manager = createTextureManager(config);

    manager.ensureTextures(800, 600);
    const callCountAfterFirst = (device.createTexture as any).mock.calls.length;

    manager.ensureTextures(800, 768);
    const callCountAfterSecond = (device.createTexture as any).mock.calls.length;

    expect(callCountAfterSecond).toBeGreaterThan(callCountAfterFirst);
  });

  it('dispose destroys textures', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    // Get textures before disposal
    const texturesBefore = (device.createTexture as any).mock.results.map((r: any) => r.value);

    manager.dispose();

    // Verify destroy was called on each texture
    texturesBefore.forEach((texture: any) => {
      expect(texture.destroy).toHaveBeenCalled();
    });
  });

  it('dispose clears state', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    manager.dispose();

    const state = manager.getState();
    expect(state.mainColorView).toBe(null);
    expect(state.overlayMsaaView).toBe(null);
    expect(state.overlayBlitBindGroup).toBe(null);
  });

  it('ensureTextures can be called after dispose', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);
    manager.dispose();

    expect(() => manager.ensureTextures(800, 600)).not.toThrow();

    const state = manager.getState();
    expect(state.mainColorView).not.toBe(null);
  });

  it('creates bind group with main color view', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800, 600);

    expect(device.createBindGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'textureManager/overlayBlitBindGroup',
      })
    );
  });

  it('texture dimensions are floored to integers', () => {
    const manager = createTextureManager(config);
    manager.ensureTextures(800.7, 600.3);

    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        size: { width: 800, height: 600 },
      })
    );
  });
});
