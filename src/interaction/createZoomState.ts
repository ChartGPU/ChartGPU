export type ZoomRange = Readonly<{ start: number; end: number }>;

export type ZoomRangeChangeCallback = (range: ZoomRange) => void;

export interface ZoomState {
  /**
   * Returns the current zoom window in percent space, clamped to [0, 100].
   */
  getRange(): ZoomRange;
  /**
   * Sets the zoom window in percent space.
   */
  setRange(start: number, end: number): void;
  /**
   * Zooms in around `center` by shrinking the span by `factor`.
   *
   * `factor <= 1` is treated as a no-op.
   */
  zoomIn(center: number, factor: number): void;
  /**
   * Zooms out around `center` by growing the span by `factor`.
   *
   * `factor <= 1` is treated as a no-op.
   */
  zoomOut(center: number, factor: number): void;
  /**
   * Pans the zoom window by `delta` percent points (preserving span).
   */
  pan(delta: number): void;
  /**
   * Subscribes to changes. Returns an unsubscribe function.
   */
  onChange(callback: ZoomRangeChangeCallback): () => void;
}

export type ZoomSpanConstraints = Readonly<{
  /**
   * Minimum allowed span (percent points in [0, 100]).
   */
  readonly minSpan?: number;
  /**
   * Maximum allowed span (percent points in [0, 100]).
   */
  readonly maxSpan?: number;
}>;

export type ZoomRangeAnchor =
  | 'start'
  | 'end'
  | 'center'
  | Readonly<{ center: number; ratio: number }>;

export interface ZoomStateWithConstraints extends ZoomState {
  /**
   * Updates span constraints at runtime (used by coordinator on setOption/appendData).
   *
   * Passing `undefined` leaves that constraint unchanged.
   */
  setSpanConstraints(minSpan?: number, maxSpan?: number): void;
  /**
   * Sets a range with an explicit anchor for clamping (used by slider handles).
   */
  setRangeAnchored(start: number, end: number, anchor: ZoomRangeAnchor): void;
}

// Minimum span of 0.5% prevents zooming beyond what can be reasonably visualized
// and prevents the slider UI from becoming unusably collapsed.
// At 0.5% span, a 500px track shows a 2.5px window, which with 10px handles
// is still somewhat distinguishable. Below 0.5% the UI becomes meaningless.
const DEFAULT_MIN_SPAN = 0.5;
const DEFAULT_MAX_SPAN = 100;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

const normalizeZero = (v: number): number => (Object.is(v, -0) ? 0 : v);

const copyRange = (r: ZoomRange): ZoomRange => ({ start: r.start, end: r.end });

export function createZoomState(
  initialStart: number,
  initialEnd: number,
  constraints?: ZoomSpanConstraints,
): ZoomStateWithConstraints {
  let start = 0;
  let end = 100;
  let lastEmitted: ZoomRange | null = null;

  const listeners = new Set<ZoomRangeChangeCallback>();

  let minSpan = (() => {
    const v = Number.isFinite(constraints?.minSpan) ? (constraints!.minSpan as number) : DEFAULT_MIN_SPAN;
    return clamp(Number.isFinite(v) ? v : 0, 0, 100);
  })();

  let maxSpan = (() => {
    const v = Number.isFinite(constraints?.maxSpan) ? (constraints!.maxSpan as number) : DEFAULT_MAX_SPAN;
    return clamp(Number.isFinite(v) ? v : 100, 0, 100);
  })();

  let normalizedMinSpan = Math.min(minSpan, maxSpan);
  let normalizedMaxSpan = Math.max(minSpan, maxSpan);

  const emit = (): void => {
    const next: ZoomRange = { start, end };
    if (
      lastEmitted !== null &&
      lastEmitted.start === next.start &&
      lastEmitted.end === next.end
    ) {
      return;
    }

    lastEmitted = copyRange(next);

    // Emit to a snapshot so additions/removals during emit don't affect this flush.
    const snapshot = Array.from(listeners);
    for (const cb of snapshot) cb({ start, end });
  };

  const toAnchor = (nextStart: number, nextEnd: number, spec?: ZoomRangeAnchor): { readonly center: number; readonly ratio: number } | undefined => {
    if (!spec) return undefined;
    if (typeof spec === 'string') {
      switch (spec) {
        case 'start':
          return { center: nextStart, ratio: 0 };
        case 'end':
          return { center: nextEnd, ratio: 1 };
        case 'center':
          return { center: (nextStart + nextEnd) * 0.5, ratio: 0.5 };
      }
    }
    if (spec && Number.isFinite(spec.center) && Number.isFinite(spec.ratio)) {
      return { center: spec.center, ratio: spec.ratio };
    }
    return undefined;
  };

  const applyNextRange = (
    nextStart: number,
    nextEnd: number,
    options?: { readonly emit?: boolean; readonly anchor?: { readonly center: number; readonly ratio: number } },
  ): void => {
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return;

    let s = nextStart;
    let e = nextEnd;

    if (s > e) {
      const t = s;
      s = e;
      e = t;
    }

    // Enforce span constraints by resizing around the proposed midpoint.
    let span = e - s;
    if (!Number.isFinite(span) || span < 0) return;

    const targetSpan = clamp(span, normalizedMinSpan, normalizedMaxSpan);
    if (targetSpan !== span) {
      const anchorCenter =
        options?.anchor && Number.isFinite(options.anchor.center)
          ? clamp(options.anchor.center, 0, 100)
          : (s + e) * 0.5;
      const anchorRatio =
        options?.anchor && Number.isFinite(options.anchor.ratio)
          ? clamp01(options.anchor.ratio)
          : 0.5;

      // Resize around the anchor so zoom operations preserve the cursor location.
      s = anchorCenter - anchorRatio * targetSpan;
      e = s + targetSpan;
      span = targetSpan;
    }

    // If span exceeds bounds (shouldn't happen with normalizedMaxSpan <= 100), clamp to full extent.
    if (span > 100) {
      s = 0;
      e = 100;
      span = 100;
    }

    // Shift into bounds without changing span.
    if (s < 0) {
      const shift = -s;
      s += shift;
      e += shift;
    }
    if (e > 100) {
      const shift = e - 100;
      s -= shift;
      e -= shift;
    }

    // Final clamp for tiny floating point drift.
    s = clamp(s, 0, 100);
    e = clamp(e, 0, 100);

    s = normalizeZero(s);
    e = normalizeZero(e);

    if (s === start && e === end) return;
    start = s;
    end = e;

    if (options?.emit === false) return;
    emit();
  };

  // Initialize state (no emit by default).
  applyNextRange(initialStart, initialEnd, { emit: false });

  const getRange: ZoomState['getRange'] = () => ({ start, end });

  const setRange: ZoomState['setRange'] = (nextStart, nextEnd) => {
    applyNextRange(nextStart, nextEnd);
  };

  const setRangeAnchored: ZoomStateWithConstraints['setRangeAnchored'] = (nextStart, nextEnd, anchor) => {
    applyNextRange(nextStart, nextEnd, { anchor: toAnchor(nextStart, nextEnd, anchor) });
  };

  const setSpanConstraints: ZoomStateWithConstraints['setSpanConstraints'] = (nextMinSpan, nextMaxSpan) => {
    // Undefined => leave unchanged (lets coordinator reapply dynamically computed values explicitly).
    const nextMin =
      typeof nextMinSpan === 'number' && Number.isFinite(nextMinSpan) ? clamp(nextMinSpan, 0, 100) : minSpan;
    const nextMax =
      typeof nextMaxSpan === 'number' && Number.isFinite(nextMaxSpan) ? clamp(nextMaxSpan, 0, 100) : maxSpan;

    if (nextMin === minSpan && nextMax === maxSpan) return;

    minSpan = nextMin;
    maxSpan = nextMax;
    normalizedMinSpan = Math.min(minSpan, maxSpan);
    normalizedMaxSpan = Math.max(minSpan, maxSpan);

    // If the current range violates the new constraints, clamp it.
    // Heuristic anchors keep "pinned to start/end" views stable (auto-scroll and common UX).
    const s = start;
    const e = end;
    const eps = 1e-6;
    const anchor: ZoomRangeAnchor =
      e >= 100 - eps ? 'end' : s <= 0 + eps ? 'start' : 'center';
    applyNextRange(s, e, { anchor: toAnchor(s, e, anchor) });
  };

  const zoomIn: ZoomState['zoomIn'] = (center, factor) => {
    if (!Number.isFinite(center) || !Number.isFinite(factor)) return;
    if (factor <= 1) return;

    const c = clamp(center, 0, 100);
    const span = end - start;
    const r = span === 0 ? 0.5 : clamp01((c - start) / span);
    const nextSpan = span / factor;
    const nextStart = c - r * nextSpan;
    const nextEnd = nextStart + nextSpan;
    applyNextRange(nextStart, nextEnd, { anchor: { center: c, ratio: r } });
  };

  const zoomOut: ZoomState['zoomOut'] = (center, factor) => {
    if (!Number.isFinite(center) || !Number.isFinite(factor)) return;
    if (factor <= 1) return;

    const c = clamp(center, 0, 100);
    const span = end - start;
    const r = span === 0 ? 0.5 : clamp01((c - start) / span);
    const nextSpan = span * factor;
    const nextStart = c - r * nextSpan;
    const nextEnd = nextStart + nextSpan;
    applyNextRange(nextStart, nextEnd, { anchor: { center: c, ratio: r } });
  };

  const pan: ZoomState['pan'] = (delta) => {
    if (!Number.isFinite(delta)) return;
    applyNextRange(start + delta, end + delta);
  };

  const onChange: ZoomState['onChange'] = (callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  };

  return { getRange, setRange, setRangeAnchored, setSpanConstraints, zoomIn, zoomOut, pan, onChange };
}

