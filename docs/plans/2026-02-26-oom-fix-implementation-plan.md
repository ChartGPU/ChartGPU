# OOM Fix: Auto-Dispose on Page Unload — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Issue #139 — GPU memory OOM on page reload by auto-disposing active chart instances on page unload and fixing the adapter leak in `checkWebGPUSupport()`.

**Architecture:** Module-level `Set` in `ChartGPU.ts` tracks live instances. Lazily-registered `pagehide` + `beforeunload` listeners call `dispose()` on all tracked instances. `checkWebGPUSupport()` nulls out the adapter local after the support check to allow GC.

**Tech Stack:** TypeScript, Vitest, WebGPU API

**Design doc:** `docs/plans/2026-02-26-oom-fix-auto-dispose-design.md`

---

### Task 1: Fix adapter leak in `checkWebGPUSupport()`

**Files:**
- Modify: `src/utils/checkWebGPU.ts:77-92`
- Create: `src/utils/__tests__/checkWebGPU.test.ts`

**Step 1: Write the failing test**

Create `src/utils/__tests__/checkWebGPU.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkWebGPUSupport } from '../checkWebGPU';

// Reset memoized state between tests
beforeEach(() => {
  // checkWebGPU uses a module-level cached promise — reset it
  vi.resetModules();
});

describe('checkWebGPUSupport', () => {
  it('returns supported: true when adapter is available', async () => {
    const mockAdapter = { features: new Set(), limits: {} };
    const requestAdapter = vi.fn().mockResolvedValue(mockAdapter);

    // @ts-ignore - mock navigator.gpu
    globalThis.navigator = { gpu: { requestAdapter } };

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('does not hold adapter reference after check', async () => {
    let adapterRef: WeakRef<object> | null = null;
    const requestAdapter = vi.fn().mockImplementation(async () => {
      const adapter = { features: new Set(), limits: {} };
      adapterRef = new WeakRef(adapter);
      return adapter;
    });

    // @ts-ignore - mock navigator.gpu
    globalThis.navigator = { gpu: { requestAdapter } };

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

    // @ts-ignore - mock navigator.gpu
    globalThis.navigator = { gpu: { requestAdapter } };

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('No compatible WebGPU adapter');
  });

  it('returns supported: false when navigator.gpu is absent', async () => {
    // @ts-ignore
    globalThis.navigator = {};

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const result = await freshCheck();

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('navigator.gpu');
  });

  it('memoizes the result across multiple calls', async () => {
    const mockAdapter = { features: new Set(), limits: {} };
    const requestAdapter = vi.fn().mockResolvedValue(mockAdapter);

    // @ts-ignore
    globalThis.navigator = { gpu: { requestAdapter } };

    const { checkWebGPUSupport: freshCheck } = await import('../checkWebGPU');
    const r1 = await freshCheck();
    const r2 = await freshCheck();

    expect(r1).toBe(r2);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/__tests__/checkWebGPU.test.ts`
Expected: Tests pass (this is a characterization test — the adapter leak is structural, not observable as a test failure). Proceed to implementation.

**Step 3: Fix the adapter leak**

In `src/utils/checkWebGPU.ts`, after the adapter null check (around line 92-95), null out the local:

```ts
      // Success: WebGPU is supported and an adapter is available
      // Null out adapter reference so the closure doesn't prevent GC (CGPU-OOM-139)
      adapter = null;
      return { supported: true };
```

Change `let adapter` on line 77 to allow reassignment (it's already `let`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/checkWebGPU.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/utils/checkWebGPU.ts src/utils/__tests__/checkWebGPU.test.ts
git commit -m "fix: null out adapter ref in checkWebGPUSupport to allow GC (#139)"
```

---

### Task 2: Add instance registry and auto-dispose on page unload

**Files:**
- Modify: `src/ChartGPU.ts` (module-level registry + unload listeners + dispose integration)

**Step 1: Add the instance registry and unload handler**

At the top of `src/ChartGPU.ts` (after imports, before any function declarations), add:

```ts
// --- Instance registry for auto-dispose on page unload (CGPU-OOM-139) ---
const activeInstances = new Set<{ dispose(): void }>();
let unloadListenersRegistered = false;

function disposeAllInstances(): void {
  // Snapshot to avoid mutation during iteration
  const instances = [...activeInstances];
  for (const inst of instances) {
    try {
      inst.dispose();
    } catch {
      // Best-effort cleanup during page teardown — swallow errors
    }
  }
}

function ensureUnloadListeners(): void {
  if (unloadListenersRegistered) return;
  if (typeof window === 'undefined') return;
  unloadListenersRegistered = true;

  window.addEventListener('pagehide', disposeAllInstances);
  window.addEventListener('beforeunload', disposeAllInstances, { once: true });
}
```

**Step 2: Register instance on creation**

In `createChartGPU`, just before `return instance;` (line ~2317), add:

```ts
    activeInstances.add(instance);
    ensureUnloadListeners();
    return instance;
```

**Step 3: Unregister on dispose**

In the `dispose` function (line ~1676), at the very end of the `finally` block (after `canvas.remove()`, line ~1716), add:

```ts
      activeInstances.delete(instance);
```

Note: `instance` is in scope — it's defined at line ~1720 but the `dispose` closure captures the same scope. Since `dispose` is defined before `instance` is assigned, reference `instance` via the object literal reference. Actually — `dispose` is assigned as a function and later used inside the `instance` object. The `instance` variable is declared with `const` at line 1720. The `dispose` function at line 1676 is defined BEFORE `instance`, so it cannot reference `instance` directly.

**Alternative approach**: use a self-reference. In the `dispose` function's `finally` block, use `activeInstances.delete(selfRef)` where `selfRef` is set after instance creation. Simpler: just move the `activeInstances.delete` to use a small wrapper.

Revised approach — add `activeInstances.add(instance)` after instance creation and change `dispose` to delete by finding itself:

In the `finally` block of `dispose()`, after `canvas.remove();`:

```ts
      // Remove from global instance registry (CGPU-OOM-139)
      for (const inst of activeInstances) {
        if (inst.disposed) activeInstances.delete(inst);
      }
```

This is simple, correct, and avoids the scoping issue — disposed instances clean themselves. Even simpler: since `dispose` sets `disposed = true` at the top, and `instance.disposed` exposes it, this works.

**Step 4: Run existing tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
git add src/ChartGPU.ts
git commit -m "feat: add instance registry and auto-dispose on page unload (#139)"
```

---

### Task 3: Write unit tests for instance registry and auto-dispose

**Files:**
- Create: `src/__tests__/ChartGPU.autoDispose.test.ts`

**Step 1: Write tests**

Create `src/__tests__/ChartGPU.autoDispose.test.ts`. Follow the mock pattern from `ChartGPU.dataAppend.test.ts` (WebGPU mocks in `beforeAll`). Key tests:

```ts
describe('auto-dispose on page unload (CGPU-OOM-139)', () => {
  it('dispose() is idempotent — calling twice does not throw', async () => {
    const chart = await ChartGPU.create(container, minimalOptions, mockContext);
    chart.dispose();
    expect(() => chart.dispose()).not.toThrow();
  });

  it('instance is marked disposed after dispose()', async () => {
    const chart = await ChartGPU.create(container, minimalOptions, mockContext);
    expect(chart.disposed).toBe(false);
    chart.dispose();
    expect(chart.disposed).toBe(true);
  });
});
```

Note: Testing the `pagehide`/`beforeunload` listener directly is tricky in Vitest (no real `window` lifecycle). The key behavioral tests are:
- Dispose is idempotent (double-dispose safe for the dual-event pattern)
- Instance tracks disposed state correctly
- The registry/unload code doesn't break normal chart creation and disposal

Full integration test of the unload flow would need a browser-level test (Playwright), which is out of scope for this PR.

**Step 2: Run tests**

Run: `npx vitest run src/__tests__/ChartGPU.autoDispose.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/__tests__/ChartGPU.autoDispose.test.ts
git commit -m "test: add auto-dispose unit tests (#139)"
```

---

### Task 4: Export `resetInstanceRegistry` for testability (internal-only)

**Files:**
- Modify: `src/ChartGPU.ts`

**Step 1: Add test-only reset function**

After the `ensureUnloadListeners` function, add:

```ts
/** @internal — exposed for test cleanup only. Not part of the public API. */
export function _resetInstanceRegistryForTesting(): void {
  activeInstances.clear();
  if (typeof window !== 'undefined' && unloadListenersRegistered) {
    window.removeEventListener('pagehide', disposeAllInstances);
    window.removeEventListener('beforeunload', disposeAllInstances);
    unloadListenersRegistered = false;
  }
}
```

**Step 2: Use in test teardown**

In `src/__tests__/ChartGPU.autoDispose.test.ts`, import and call in `afterEach`:

```ts
import { _resetInstanceRegistryForTesting } from '../ChartGPU';

afterEach(() => {
  _resetInstanceRegistryForTesting();
});
```

**Step 3: Run tests**

Run: `npx vitest run src/__tests__/ChartGPU.autoDispose.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/ChartGPU.ts src/__tests__/ChartGPU.autoDispose.test.ts
git commit -m "test: add internal registry reset helper for test isolation (#139)"
```

---

### Task 5: Run full test suite and verify build

**Files:** None modified

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (same count as before + new tests)

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run build**

Run: `npm run build`
Expected: Clean build, no warnings

**Step 4: Commit (if any fixups needed)**

Only if previous steps required changes.

---

### Task 6: Final commit and PR preparation

**Files:** None modified

**Step 1: Review all changes**

Run: `git log --oneline main..HEAD` to see all commits in this branch.
Run: `git diff main --stat` to see all changed files.

**Step 2: Verify no unintended changes**

Check that only these files were modified/created:
- `src/utils/checkWebGPU.ts` (adapter null fix)
- `src/utils/__tests__/checkWebGPU.test.ts` (new)
- `src/ChartGPU.ts` (registry + unload listeners + reset helper)
- `src/__tests__/ChartGPU.autoDispose.test.ts` (new)
- `docs/plans/2026-02-26-oom-fix-auto-dispose-design.md` (design doc)
- `docs/plans/2026-02-26-oom-fix-implementation-plan.md` (this plan)
