export interface LinearScale {
  /**
   * Sets the scale domain (data range). Returns self for chaining.
   */
  domain(min: number, max: number): LinearScale;

  /**
   * Sets the scale range (pixel range). Returns self for chaining.
   */
  range(min: number, max: number): LinearScale;

  /**
   * Maps a domain value to a range value.
   *
   * Notes:
   * - No clamping (will extrapolate outside the domain).
   * - If the domain span is 0 (min === max), returns the midpoint of the range.
   */
  scale(value: number): number;

  /**
   * Maps a range value (pixel) back to a domain value.
   *
   * Notes:
   * - No clamping (will extrapolate outside the range).
   * - If the domain span is 0 (min === max), returns domain min for any input.
   */
  invert(pixel: number): number;
}

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

/**
 * Creates a linear scale for mapping a numeric domain to a numeric range.
 *
 * Defaults to an identity mapping:
 * domain [0, 1] -> range [0, 1]
 */
export function createLinearScale(): LinearScale {
  let domainMin = 0;
  let domainMax = 1;
  let rangeMin = 0;
  let rangeMax = 1;

  const self: LinearScale = {
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
