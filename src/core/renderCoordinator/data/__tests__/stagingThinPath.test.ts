/**
 * Unit tests for staging thin-path eligibility and rebind-failure demote.
 */

import { describe, it, expect } from 'vitest';
import { demoteStagingViewAfterRebindFailure, isStagingThinPathEligible } from '../stagingThinPath';
import { createStagingRingView, createRingXYColumns } from '../../../../data/cartesianData';

describe('isStagingThinPathEligible', () => {
  it('is true for GPU fast path with maxPoints (FIFO, tooltip-independent)', () => {
    expect(isStagingThinPathEligible(true, true, false)).toBe(true);
    expect(isStagingThinPathEligible(true, true, true)).toBe(true);
    expect(isStagingThinPathEligible(true, true, undefined)).toBe(true);
  });

  it('is true for GPU fast path without maxPoints (unbounded compression / LTTB)', () => {
    // Multi-chart line slots + series compression: dual number[] growth was the tax.
    expect(isStagingThinPathEligible(true, false, false)).toBe(true);
    expect(isStagingThinPathEligible(true, false, true)).toBe(true);
  });

  it('is false without GPU append fast path', () => {
    expect(isStagingThinPathEligible(false, true, false)).toBe(false);
    expect(isStagingThinPathEligible(false, false, false)).toBe(false);
  });
});

describe('demoteStagingViewAfterRebindFailure', () => {
  it('nulls a live StagingRingView so fallthrough can dual-pack', () => {
    const view = createStagingRingView(new Float32Array(4), 0, 2, 2, 0);
    expect(demoteStagingViewAfterRebindFailure(view)).toBeNull();
  });

  it('leaves non-staging raw unchanged', () => {
    const ring = createRingXYColumns(8);
    ring.count = 2;
    expect(demoteStagingViewAfterRebindFailure(ring)).toBe(ring);
    const cols = { x: [1], y: [2] };
    expect(demoteStagingViewAfterRebindFailure(cols)).toBe(cols);
  });

  it('passes through null', () => {
    expect(demoteStagingViewAfterRebindFailure(null)).toBeNull();
  });
});
