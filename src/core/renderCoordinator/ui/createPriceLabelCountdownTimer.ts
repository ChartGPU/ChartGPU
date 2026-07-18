/**
 * DOM-only bar-close countdown timer for the last-price badge.
 *
 * Ticks call `setCountdown` only — never `requestRender` / GPU frames.
 * Clock: `nowMs ?? Date.now`. Headless (no `window`) is a no-op for the
 * interval; frame sync still writes countdown text via `update()`.
 *
 * @module createPriceLabelCountdownTimer
 */

import { formatCountdown, remainingMsToBarClose } from './priceLabelHelpers';

/** Design default: ~4 Hz DOM text refresh (smooth second digits, low CPU). */
export const PRICE_LABEL_COUNTDOWN_TICK_MS = 250;

export type PriceLabelCountdownDesired = Readonly<{
  /**
   * When true, timer should run: owner series has show + showCountdown and a
   * valid intervalMs (resolved config).
   */
  readonly active: boolean;
  /** Candle period; identity compared to decide clear+restart. */
  readonly intervalMs: number | null;
  /** Injectable clock; null → Date.now at tick. Identity compared for restart. */
  readonly nowMs: (() => number) | null;
}>;

export type CreatePriceLabelCountdownTimerOptions = Readonly<{
  /** DOM-only countdown write (badge.setCountdown). */
  readonly setCountdown: (text: string | null) => void;
  /**
   * Inject for tests. Default: `window.setInterval` when `window` exists,
   * otherwise no-op (headless).
   */
  readonly setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  /** Tick period in ms (default {@link PRICE_LABEL_COUNTDOWN_TICK_MS}). */
  readonly tickMs?: number;
}>;

export type PriceLabelCountdownTimer = {
  /**
   * Idempotent config transition (setOptions / frame).
   * - inactive → clear timer + setCountdown(null)
   * - active + (no timer | intervalMs/nowMs identity change) → clear + restart
   * - active + same identities → keep timer
   */
  setDesired(desired: PriceLabelCountdownDesired | null): void;
  /**
   * Update closed-over bar end for remaining time. Keeps timer running.
   * Immediate tick when timer is active so candle rolls feel snappy.
   */
  setBarEndMs(barEndMs: number | null): void;
  /** Clear timer; optional clear of countdown text (default true). */
  clear(options?: { clearText?: boolean }): void;
  dispose(): void;
  /** Whether an interval handle is currently scheduled. */
  isRunning(): boolean;
};

const INACTIVE: PriceLabelCountdownDesired = Object.freeze({
  active: false,
  intervalMs: null,
  nowMs: null,
});

function defaultSetInterval(handler: () => void, ms: number): ReturnType<typeof setInterval> | null {
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') {
    return null;
  }
  return window.setInterval(handler, ms);
}

function defaultClearInterval(id: ReturnType<typeof setInterval>): void {
  if (typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
    window.clearInterval(id);
  } else if (typeof clearInterval === 'function') {
    clearInterval(id);
  }
}

/**
 * Create a countdown timer controller bound to a badge `setCountdown`.
 *
 * **Must never** schedule GPU renders — only DOM text updates.
 */
export function createPriceLabelCountdownTimer(
  options: CreatePriceLabelCountdownTimerOptions
): PriceLabelCountdownTimer {
  const setCountdown = options.setCountdown;
  const tickMs =
    typeof options.tickMs === 'number' && Number.isFinite(options.tickMs) && options.tickMs > 0
      ? options.tickMs
      : PRICE_LABEL_COUNTDOWN_TICK_MS;

  const setIntervalFn =
    options.setIntervalFn ??
    ((handler: () => void, ms: number) => defaultSetInterval(handler, ms) as ReturnType<typeof setInterval>);
  const clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;

  let handle: ReturnType<typeof setInterval> | null = null;
  let barEndMs: number | null = null;
  let desired: PriceLabelCountdownDesired = INACTIVE;
  let disposed = false;

  const resolveNow = (): number => {
    const clock = desired.nowMs;
    return typeof clock === 'function' ? clock() : Date.now();
  };

  const tick = (): void => {
    if (disposed) return;
    if (barEndMs == null) {
      setCountdown(null);
      return;
    }
    const remaining = remainingMsToBarClose(barEndMs, resolveNow());
    setCountdown(formatCountdown(remaining));
  };

  const stopInterval = (): void => {
    if (handle != null) {
      clearIntervalFn(handle);
      handle = null;
    }
  };

  const startInterval = (): void => {
    stopInterval();
    // Immediate tick so badge is correct before the first interval fires.
    tick();
    const id = setIntervalFn(tick, tickMs);
    // Injected/default may return null in headless — treat as not running.
    handle = id ?? null;
  };

  const setDesired = (next: PriceLabelCountdownDesired | null): void => {
    if (disposed) return;
    const d = next ?? INACTIVE;

    if (!d.active) {
      stopInterval();
      setCountdown(null);
      desired = INACTIVE;
      return;
    }

    const sameIdentities =
      handle != null && desired.active && desired.intervalMs === d.intervalMs && desired.nowMs === d.nowMs;

    desired = d;

    if (sameIdentities) {
      // Keep timer; closed-over clock/interval unchanged.
      return;
    }

    // Start or restart (intervalMs / nowMs identity change, or first start).
    startInterval();
  };

  const setBarEndMs = (ms: number | null): void => {
    if (disposed) return;
    const next = ms != null && Number.isFinite(ms) ? ms : null;
    if (barEndMs === next) return;
    barEndMs = next;
    // Design: new last candle on render → update ref; keep timer.
    // Immediate tick when running so the second line jumps on bar roll.
    if (handle != null || desired.active) {
      if (handle != null) tick();
    }
  };

  const clear = (opts?: { clearText?: boolean }): void => {
    stopInterval();
    desired = INACTIVE;
    if (opts?.clearText !== false) {
      setCountdown(null);
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopInterval();
    barEndMs = null;
    desired = INACTIVE;
    setCountdown(null);
  };

  return {
    setDesired,
    setBarEndMs,
    clear,
    dispose,
    isRunning: () => handle != null,
  };
}

/**
 * Derive timer desired state from a resolved candlestick priceLabel + ownership.
 * Pure helper for setOptions / frame wiring.
 */
export function priceLabelCountdownDesiredFromConfig(args: {
  readonly show: boolean;
  readonly showCountdown: boolean;
  readonly intervalMs: number | null;
  readonly nowMs: (() => number) | null;
}): PriceLabelCountdownDesired {
  const active =
    args.show === true &&
    args.showCountdown === true &&
    args.intervalMs != null &&
    Number.isFinite(args.intervalMs) &&
    args.intervalMs > 0;
  return {
    active,
    intervalMs: active ? args.intervalMs : null,
    nowMs: active ? args.nowMs : null,
  };
}
