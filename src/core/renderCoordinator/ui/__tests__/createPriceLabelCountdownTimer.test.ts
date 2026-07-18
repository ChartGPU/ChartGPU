/**
 * PriceLabel countdown timer — lifecycle transitions, nowMs injection,
 * and the critical gate: never requestRender / GPU frames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPriceLabelCountdownTimer,
  priceLabelCountdownDesiredFromConfig,
  type PriceLabelCountdownDesired,
} from '../createPriceLabelCountdownTimer';

/** Must match default tick period in createPriceLabelCountdownTimer (unexported). */
const PRICE_LABEL_COUNTDOWN_TICK_MS = 250;

describe('priceLabelCountdownDesiredFromConfig', () => {
  it('active only when show + showCountdown + positive intervalMs', () => {
    expect(
      priceLabelCountdownDesiredFromConfig({
        show: true,
        showCountdown: true,
        intervalMs: 60_000,
        nowMs: null,
      }).active
    ).toBe(true);

    expect(
      priceLabelCountdownDesiredFromConfig({
        show: false,
        showCountdown: true,
        intervalMs: 60_000,
        nowMs: null,
      }).active
    ).toBe(false);

    expect(
      priceLabelCountdownDesiredFromConfig({
        show: true,
        showCountdown: false,
        intervalMs: 60_000,
        nowMs: null,
      }).active
    ).toBe(false);

    expect(
      priceLabelCountdownDesiredFromConfig({
        show: true,
        showCountdown: true,
        intervalMs: null,
        nowMs: null,
      }).active
    ).toBe(false);
  });

  it('passes through nowMs identity when active', () => {
    const nowMs = () => 1;
    const d = priceLabelCountdownDesiredFromConfig({
      show: true,
      showCountdown: true,
      intervalMs: 1000,
      nowMs,
    });
    expect(d.nowMs).toBe(nowMs);
    expect(d.intervalMs).toBe(1000);
  });
});

describe('createPriceLabelCountdownTimer', () => {
  let setCountdown: ReturnType<typeof vi.fn>;
  let handlers: Array<() => void>;
  let setIntervalFn: ReturnType<typeof vi.fn>;
  let clearIntervalFn: ReturnType<typeof vi.fn>;
  let nextHandle: number;

  beforeEach(() => {
    setCountdown = vi.fn();
    handlers = [];
    nextHandle = 1;
    setIntervalFn = vi.fn((handler: () => void, _ms: number) => {
      handlers.push(handler);
      return nextHandle++;
    });
    clearIntervalFn = vi.fn();
  });

  afterEach(() => {
    handlers = [];
  });

  function makeTimer(opts: { tickMs?: number } = {}) {
    return createPriceLabelCountdownTimer({
      setCountdown,
      setIntervalFn: setIntervalFn as unknown as (handler: () => void, ms: number) => ReturnType<typeof setInterval>,
      clearIntervalFn: clearIntervalFn as unknown as (id: ReturnType<typeof setInterval>) => void,
      tickMs: opts.tickMs,
    });
  }

  function activeDesired(overrides: Partial<PriceLabelCountdownDesired> = {}): PriceLabelCountdownDesired {
    return {
      active: true,
      intervalMs: 60_000,
      nowMs: null,
      ...overrides,
    };
  }

  it('starts timer when setDesired(active) from idle', () => {
    const timer = makeTimer();
    expect(timer.isRunning()).toBe(false);

    timer.setBarEndMs(70_000);
    timer.setDesired(activeDesired({ nowMs: () => 40_000 }));

    expect(timer.isRunning()).toBe(true);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0]![1]).toBe(PRICE_LABEL_COUNTDOWN_TICK_MS);
    // Immediate tick on start
    expect(setCountdown).toHaveBeenCalled();
    // barEnd 70000, now 40000 → remaining 30000 → 00:00:30
    expect(setCountdown).toHaveBeenLastCalledWith('00:00:30');
  });

  it('clears timer and countdown when setDesired inactive (!show / !showCountdown)', () => {
    const timer = makeTimer();
    timer.setBarEndMs(70_000);
    timer.setDesired(activeDesired({ nowMs: () => 40_000 }));
    expect(timer.isRunning()).toBe(true);
    setCountdown.mockClear();
    clearIntervalFn.mockClear();

    timer.setDesired({ active: false, intervalMs: null, nowMs: null });

    expect(timer.isRunning()).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(setCountdown).toHaveBeenCalledWith(null);
  });

  it('clears timer when setDesired(null)', () => {
    const timer = makeTimer();
    timer.setDesired(activeDesired());
    expect(timer.isRunning()).toBe(true);
    timer.setDesired(null);
    expect(timer.isRunning()).toBe(false);
    expect(setCountdown).toHaveBeenCalledWith(null);
  });

  it('restarts when intervalMs identity changes', () => {
    const timer = makeTimer();
    const nowMs = () => 0;
    timer.setBarEndMs(60_000);
    timer.setDesired(activeDesired({ intervalMs: 60_000, nowMs }));
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    clearIntervalFn.mockClear();
    setIntervalFn.mockClear();

    timer.setDesired(activeDesired({ intervalMs: 5 * 60_000, nowMs }));
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(timer.isRunning()).toBe(true);
  });

  it('restarts when nowMs function identity changes', () => {
    const timer = makeTimer();
    const nowA = () => 0;
    const nowB = () => 0;
    timer.setBarEndMs(60_000);
    timer.setDesired(activeDesired({ nowMs: nowA }));
    clearIntervalFn.mockClear();
    setIntervalFn.mockClear();

    timer.setDesired(activeDesired({ nowMs: nowB }));
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('keeps timer when same intervalMs + same nowMs identity (new last candle only)', () => {
    const timer = makeTimer();
    const nowMs = () => 10_000;
    timer.setBarEndMs(70_000);
    timer.setDesired(activeDesired({ nowMs }));
    clearIntervalFn.mockClear();
    setIntervalFn.mockClear();
    setCountdown.mockClear();

    // Same desired, new bar end (candle roll on render)
    timer.setDesired(activeDesired({ nowMs }));
    timer.setBarEndMs(130_000);

    expect(clearIntervalFn).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(timer.isRunning()).toBe(true);
    // Immediate tick on barEnd change while running
    expect(setCountdown).toHaveBeenCalled();
  });

  it('uses injectable nowMs for remaining (not Date.now when provided)', () => {
    const timer = makeTimer();
    let simulated = 50_000;
    const nowMs = () => simulated;
    timer.setBarEndMs(60_000);
    timer.setDesired(activeDesired({ intervalMs: 10_000, nowMs }));
    // remaining 10000 → 00:00:10
    expect(setCountdown).toHaveBeenLastCalledWith('00:00:10');

    simulated = 55_000;
    handlers[0]!();
    expect(setCountdown).toHaveBeenLastCalledWith('00:00:05');

    simulated = 70_000; // past end
    handlers[0]!();
    expect(setCountdown).toHaveBeenLastCalledWith('00:00:00');
  });

  it('defaults to Date.now when nowMs is null', () => {
    const timer = makeTimer();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(40_000);
    timer.setBarEndMs(70_000);
    timer.setDesired(activeDesired({ nowMs: null }));
    expect(setCountdown).toHaveBeenLastCalledWith('00:00:30');
    spy.mockRestore();
  });

  it('never invokes requestRender or requestAnimationFrame', () => {
    const raf = vi.fn();
    const requestRender = vi.fn();
    // Shadow globals that a buggy timer might call
    const g = globalThis as unknown as {
      requestAnimationFrame?: typeof requestAnimationFrame;
      requestRender?: () => void;
    };
    const prevRaf = g.requestAnimationFrame;
    g.requestAnimationFrame = raf as typeof requestAnimationFrame;
    g.requestRender = requestRender;

    const timer = makeTimer();
    timer.setBarEndMs(70_000);
    timer.setDesired(activeDesired({ nowMs: () => 40_000 }));
    handlers[0]!();
    handlers[0]!();
    timer.setBarEndMs(80_000);
    timer.setDesired({ active: false, intervalMs: null, nowMs: null });
    timer.setDesired(activeDesired({ nowMs: () => 1 }));
    timer.dispose();

    expect(raf).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    // setCountdown is the only side channel
    expect(setCountdown.mock.calls.length).toBeGreaterThan(0);

    g.requestAnimationFrame = prevRaf;
    delete g.requestRender;
  });

  it('dispose clears timer and countdown', () => {
    const timer = makeTimer();
    timer.setDesired(activeDesired());
    setCountdown.mockClear();
    clearIntervalFn.mockClear();

    timer.dispose();
    expect(timer.isRunning()).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalled();
    expect(setCountdown).toHaveBeenCalledWith(null);

    // Further ops are no-ops
    setCountdown.mockClear();
    setIntervalFn.mockClear();
    timer.setDesired(activeDesired());
    timer.setBarEndMs(1);
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(timer.isRunning()).toBe(false);
  });

  it('setCountdown(null) when barEndMs is null while active', () => {
    const timer = makeTimer();
    timer.setBarEndMs(null);
    timer.setDesired(activeDesired({ nowMs: () => 0 }));
    expect(setCountdown).toHaveBeenLastCalledWith(null);
  });

  it('tickMs override is passed to setInterval', () => {
    const timer = makeTimer({ tickMs: 1000 });
    timer.setDesired(activeDesired());
    expect(setIntervalFn.mock.calls[0]![1]).toBe(1000);
  });

  it('idempotent clear()', () => {
    const timer = makeTimer();
    timer.setDesired(activeDesired());
    timer.clear();
    timer.clear();
    expect(timer.isRunning()).toBe(false);
  });
});
