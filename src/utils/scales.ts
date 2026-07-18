export interface ContinuousScale {
  /**
   * Sets the scale domain (data range). Returns self for chaining.
   */
  domain(min: number, max: number): ContinuousScale;

  /**
   * Sets the scale range (pixel / clip range). Returns self for chaining.
   */
  range(min: number, max: number): ContinuousScale;

  /**
   * Maps a domain value to a range value.
   *
   * Notes:
   * - No clamping (will extrapolate outside the domain).
   * - If the domain span is 0 (min === max), returns the midpoint of the range.
   * - Log scales return NaN for non-positive inputs.
   */
  scale(value: number): number;

  /**
   * Maps a range value (pixel) back to a domain value.
   *
   * Notes:
   * - No clamping (will extrapolate outside the range).
   * - If the domain span is 0 (min === max), returns domain min for any input.
   * - Log scales always return a positive domain value when the mapping is defined.
   */
  invert(pixel: number): number;

  /** Discriminator for GPU projection / affine helpers. */
  readonly kind: 'linear' | 'log';

  /** Present when `kind === 'log'`. Logarithm base (> 0, ≠ 1). */
  readonly base?: number;

  /** Current domain endpoints (data space). */
  getDomain(): { readonly min: number; readonly max: number };

  /** Current range endpoints (pixel / clip space). */
  getRange(): { readonly min: number; readonly max: number };
}

/**
 * Linear continuous scale. Alias of {@link ContinuousScale} for backward compatibility;
 * instances from {@link createLinearScale} always have `kind: 'linear'`.
 */
export type LinearScale = ContinuousScale;

export interface CategoryScale {
  /**
   * Sets the category domain (ordered list of unique category names).
   * Returns self for chaining.
   *
   * Throws if duplicates exist (ambiguous mapping).
   */
  domain(categories: string[]): CategoryScale;

  /**
   * Sets the scale range (pixel range). Returns self for chaining.
   */
  range(min: number, max: number): CategoryScale;

  /**
   * Returns the center x-position for a category.
   *
   * Edge cases:
   * - Unknown category: returns NaN
   * - Empty domain: returns midpoint of range
   */
  scale(category: string): number;

  /**
   * Width allocated per category (always non-negative).
   *
   * Edge cases:
   * - Empty domain: returns 0
   * - Reversed ranges allowed
   */
  bandwidth(): number;

  /**
   * Returns the index of a category in the current domain.
   *
   * Edge cases:
   * - Unknown category: returns -1
   */
  categoryIndex(category: string): number;
}

const assertFinite = (label: string, value: number): void => {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number. Received: ${String(value)}`);
  }
};

/** Default log base when omitted or invalid. */
export const DEFAULT_LOG_BASE = 10;

/**
 * Normalize a user-provided log base. Invalid bases (non-finite, ≤0, or 1) fall back to 10.
 */
export function normalizeLogBase(base: number | undefined | null): number {
  if (base == null || !Number.isFinite(base) || base <= 0 || base === 1) {
    return DEFAULT_LOG_BASE;
  }
  return base;
}

/**
 * Creates a linear scale for mapping a numeric domain to a numeric range.
 *
 * Defaults to an identity mapping:
 * domain [0, 1] -> range [0, 1]
 */
export function createLinearScale(): ContinuousScale {
  let domainMin = 0;
  let domainMax = 1;
  let rangeMin = 0;
  let rangeMax = 1;

  const self: ContinuousScale = {
    kind: 'linear',

    domain(min: number, max: number) {
      assertFinite('domain min', min);
      assertFinite('domain max', max);
      domainMin = min;
      domainMax = max;
      return self;
    },

    range(min: number, max: number) {
      assertFinite('range min', min);
      assertFinite('range max', max);
      rangeMin = min;
      rangeMax = max;
      return self;
    },

    getDomain() {
      return { min: domainMin, max: domainMax };
    },

    getRange() {
      return { min: rangeMin, max: rangeMax };
    },

    scale(value: number) {
      if (!Number.isFinite(value)) return Number.NaN;

      if (domainMin === domainMax) {
        return (rangeMin + rangeMax) / 2;
      }

      const t = (value - domainMin) / (domainMax - domainMin);
      return rangeMin + t * (rangeMax - rangeMin);
    },

    invert(pixel: number) {
      if (!Number.isFinite(pixel)) return Number.NaN;

      if (domainMin === domainMax) {
        return domainMin;
      }

      if (rangeMin === rangeMax) {
        return (domainMin + domainMax) / 2;
      }

      const t = (pixel - rangeMin) / (rangeMax - rangeMin);
      return domainMin + t * (domainMax - domainMin);
    },
  };

  return self;
}

/**
 * Creates a logarithmic continuous scale.
 *
 * Mapping: range = lerp(log_b(value), log_b(domainMin), log_b(domainMax)).
 * Non-positive inputs to `scale` return NaN. Domain endpoints must be strictly positive;
 * non-positive domain values are clamped to a safe positive fallback on `domain()`.
 *
 * Defaults:
 * - base: 10 (or normalized from argument)
 * - domain: [1, 10]
 * - range: [0, 1]
 */
export function createLogScale(base?: number): ContinuousScale {
  let logBase = normalizeLogBase(base);
  let domainMin = 1;
  let domainMax = logBase;
  let rangeMin = 0;
  let rangeMax = 1;

  const lnBase = (): number => Math.log(logBase);

  const logB = (v: number): number => Math.log(v) / lnBase();

  const self: ContinuousScale = {
    kind: 'log',

    get base() {
      return logBase;
    },

    domain(min: number, max: number) {
      assertFinite('domain min', min);
      assertFinite('domain max', max);
      // Clamp each non-positive end independently (mirrors sanitizeLogDomain):
      // preserve a valid positive partner instead of resetting both to [1, base].
      const fallbackMax = logBase > 1 ? logBase : 10;
      let lo = Number.isFinite(min) && min > 0 ? min : 1;
      let hi = Number.isFinite(max) && max > 0 ? max : fallbackMax;
      if (lo === hi) {
        hi = lo * logBase;
      } else if (lo > hi) {
        const t = lo;
        lo = hi;
        hi = t;
      }
      domainMin = lo;
      domainMax = hi;
      return self;
    },

    range(min: number, max: number) {
      assertFinite('range min', min);
      assertFinite('range max', max);
      rangeMin = min;
      rangeMax = max;
      return self;
    },

    getDomain() {
      return { min: domainMin, max: domainMax };
    },

    getRange() {
      return { min: rangeMin, max: rangeMax };
    },

    scale(value: number) {
      if (!Number.isFinite(value) || value <= 0) return Number.NaN;

      const d0 = logB(domainMin);
      const d1 = logB(domainMax);
      if (d0 === d1) {
        return (rangeMin + rangeMax) / 2;
      }

      const t = (logB(value) - d0) / (d1 - d0);
      return rangeMin + t * (rangeMax - rangeMin);
    },

    invert(pixel: number) {
      if (!Number.isFinite(pixel)) return Number.NaN;

      const d0 = logB(domainMin);
      const d1 = logB(domainMax);

      if (d0 === d1) {
        return domainMin;
      }

      if (rangeMin === rangeMax) {
        return Math.sqrt(domainMin * domainMax); // geometric midpoint
      }

      const t = (pixel - rangeMin) / (rangeMax - rangeMin);
      const logV = d0 + t * (d1 - d0);
      return logBase ** logV;
    },
  };

  return self;
}

/**
 * Factory: build a continuous scale for an axis config.
 * Log axes use {@link createLogScale}; all other continuous types use linear.
 */
export function createAxisScale(axis: { readonly type: string; readonly logBase?: number }): ContinuousScale {
  if (axis.type === 'log') {
    return createLogScale(axis.logBase);
  }
  return createLinearScale();
}

/**
 * Creates a category scale for mapping string categories to evenly spaced
 * x-positions across a numeric range.
 *
 * Defaults:
 * - domain: []
 * - range: [0, 1]
 */
export function createCategoryScale(): CategoryScale {
  let categories: readonly string[] = [];
  let indexByCategory = new Map<string, number>();
  let rangeMin = 0;
  let rangeMax = 1;

  const rebuildIndex = (nextCategories: readonly string[]) => {
    const nextIndex = new Map<string, number>();
    for (let i = 0; i < nextCategories.length; i++) {
      const c = nextCategories[i];
      // Enforce uniqueness to avoid ambiguous mapping
      if (nextIndex.has(c)) {
        throw new Error(`Category domain must not contain duplicates. Duplicate: ${JSON.stringify(c)}`);
      }
      nextIndex.set(c, i);
    }
    indexByCategory = nextIndex;
  };

  const self: CategoryScale = {
    domain(nextCategories: string[]) {
      categories = [...nextCategories];
      rebuildIndex(categories);
      return self;
    },

    range(min: number, max: number) {
      assertFinite('range min', min);
      assertFinite('range max', max);
      rangeMin = min;
      rangeMax = max;
      return self;
    },

    categoryIndex(category: string) {
      const idx = indexByCategory.get(category);
      return idx === undefined ? -1 : idx;
    },

    bandwidth() {
      const n = categories.length;
      if (n === 0) return 0;
      return Math.abs((rangeMax - rangeMin) / n);
    },

    scale(category: string) {
      const n = categories.length;
      if (n === 0) {
        return (rangeMin + rangeMax) / 2;
      }

      const i = self.categoryIndex(category);
      if (i < 0) return Number.NaN;

      const step = (rangeMax - rangeMin) / n; // can be negative (reversed range)
      return rangeMin + (i + 0.5) * step;
    },
  };

  return self;
}
