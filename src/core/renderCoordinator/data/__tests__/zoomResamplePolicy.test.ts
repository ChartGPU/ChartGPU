/**
 * M4 — period=1 zoom re-sample policy (no ~100ms debounce).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyZoomResampleScheduleAction, zoomResampleScheduleAction } from '../zoomResamplePolicy';

describe('zoomResampleScheduleAction (M4)', () => {
  it('always returns immediate (period=1 policy)', () => {
    expect(zoomResampleScheduleAction()).toEqual({ kind: 'immediate' });
  });

  it('apply immediate marks due + flush without setTimeout (behavioral lock)', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const state = { zoomResampleDue: false };
    const scheduleFlush = vi.fn();

    applyZoomResampleScheduleAction(zoomResampleScheduleAction(), state, scheduleFlush);

    expect(state.zoomResampleDue).toBe(true);
    expect(scheduleFlush).toHaveBeenCalledTimes(1);
    // Realistic debounce would call setTimeout(..., 100) — must not.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('apply debounce action throws (forbids reintroducing multi-frame lag)', () => {
    const state = { zoomResampleDue: false };
    const scheduleFlush = vi.fn();
    expect(() =>
      applyZoomResampleScheduleAction({ kind: 'debounce', ms: 100 }, state, scheduleFlush)
    ).toThrow(/period=1|forbidden|debounce/i);
    expect(state.zoomResampleDue).toBe(false);
    expect(scheduleFlush).not.toHaveBeenCalled();
  });

  it('scheduleZoomResample body has no setTimeout / no 100ms debounce arm', () => {
    const implPath = resolve(__dirname, '../../createRenderCoordinatorImpl.ts');
    const src = readFileSync(implPath, 'utf8');

    // Slice the scheduleZoomResample function only (not the whole file).
    const start = src.indexOf('const scheduleZoomResample = (): void =>');
    expect(start).toBeGreaterThanOrEqual(0);
    const after = src.slice(start);
    // Next top-level const after the arrow function body.
    const endMatch = after.match(/\n  const [a-zA-Z]/);
    expect(endMatch).toBeTruthy();
    const end = endMatch!.index!;
    const body = after.slice(0, end);

    // Must apply pure policy (not arm a timer).
    expect(body).toMatch(/applyZoomResampleScheduleAction/);
    expect(body).toMatch(/zoomResampleScheduleAction\s*\(/);
    // No setTimeout in the schedule path (covers setTimeout(() => ..., 100) forms).
    expect(body).not.toMatch(/setTimeout/);
    expect(body).not.toMatch(/100\s*\*\s*ms|100\s*,|,\s*100\b/);
    // Dead debounce scaffolding must stay gone.
    expect(src).not.toMatch(/zoomResampleDebounceTimer/);
    expect(src).not.toMatch(/cancelZoomResampleDebounce/);
  });
});
