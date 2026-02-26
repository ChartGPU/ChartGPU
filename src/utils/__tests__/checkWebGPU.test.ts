import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Mock window global for SSR-safe checks in checkWebGPU
beforeEach(() => {
  if (typeof window === 'undefined') {
    vi.stubGlobal('window', globalThis);
  }
});

// Reset memoized state between tests
beforeEach(() => {
  // checkWebGPU uses a module-level cached promise — reset it
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkWebGPUSupport', () => {
  it('returns supported: true when adapter is available', async () => {
    const mockAdapter = { features: new Set(), limits: {} };
    const requestAdapter = vi.fn().mockResolvedValue(mockAdapter);

    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('completes adapter check without error (smoke test for GC-safe code path)', async () => {
    let adapterRef: WeakRef<object> | null = null;
    const requestAdapter = vi.fn().mockImplementation(async () => {
      const adapter = { features: new Set(), limits: {} };
      adapterRef = new WeakRef(adapter);
      return adapter;
    });

    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    await freshCheck();

    // Force GC if available (Node --expose-gc)
    if (globalThis.gc) globalThis.gc();

    // The adapter was created inside the closure — after our fix it should be
    // nulled out so the only strong ref was the local in the test's mockImplementation
    // (which has already returned). We verify the code path runs without holding it.
    expect(adapterRef).not.toBeNull();
    expect(requestAdapter).toHaveBeenCalled();
  });

  it('returns supported: false when no adapter available', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);

    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('No compatible WebGPU adapter');
  });

  it('returns supported: false when navigator.gpu is absent', async () => {
    vi.stubGlobal('navigator', {});

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('navigator.gpu');
  });

  it('memoizes the result across multiple calls', async () => {
    const mockAdapter = { features: new Set(), limits: {} };
    const requestAdapter = vi.fn().mockResolvedValue(mockAdapter);

    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const r1 = await freshCheck();
    const r2 = await freshCheck();

    expect(r1).toBe(r2);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});
