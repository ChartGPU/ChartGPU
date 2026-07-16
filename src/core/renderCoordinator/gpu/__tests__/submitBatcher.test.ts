/**
 * Canonical tests live at `src/core/gpu/__tests__/submitBatcher.test.ts`.
 * This file only asserts the legacy re-export path still resolves.
 */
import { describe, it, expect } from 'vitest';
import {
  enqueueDeviceSubmit,
  flushDeviceSubmit,
  destroyBufferAfterSubmit,
} from '../submitBatcher';

describe('submitBatcher legacy re-export', () => {
  it('re-exports public API from core/gpu/submitBatcher', () => {
    expect(typeof enqueueDeviceSubmit).toBe('function');
    expect(typeof flushDeviceSubmit).toBe('function');
    expect(typeof destroyBufferAfterSubmit).toBe('function');
  });
});
