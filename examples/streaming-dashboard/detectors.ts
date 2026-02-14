/**
 * Incremental statistical detection algorithms for streaming data.
 * All classes use functional-style patterns where possible.
 */

/**
 * Circular buffer maintaining rolling statistics using Welford's online algorithm.
 */
export class RollingStats {
  private readonly windowSize: number;
  private readonly buffer: number[];
  private index: number = 0;
  private count: number = 0;
  private mean: number = 0;
  private m2: number = 0; // Sum of squared differences from mean

  constructor(windowSize: number = 50) {
    this.windowSize = windowSize;
    this.buffer = new Array(windowSize);
  }

  /**
   * Add a new value to the rolling window using Welford's algorithm.
   */
  push(value: number): void {
    const oldValue = this.buffer[this.index];
    const hadOldValue = this.count === this.windowSize;

    // Store new value
    this.buffer[this.index] = value;
    this.index = (this.index + 1) % this.windowSize;

    if (hadOldValue) {
      // Remove old value's contribution
      const oldDelta = oldValue - this.mean;
      this.mean -= oldDelta / this.count;
      const oldDelta2 = oldValue - this.mean;

      // Add new value's contribution
      const newDelta = value - this.mean;
      this.mean += newDelta / this.count;
      const newDelta2 = value - this.mean;

      this.m2 += newDelta * newDelta2 - oldDelta * oldDelta2;
    } else {
      // Window not full yet
      this.count++;
      const delta = value - this.mean;
      this.mean += delta / this.count;
      const delta2 = value - this.mean;
      this.m2 += delta * delta2;
    }
  }

  getMean(): number {
    return this.count > 0 ? this.mean : 0;
  }

  getStdDev(): number {
    if (this.count < 2) return 0;
    const variance = this.m2 / (this.count - 1);
    return Math.sqrt(Math.max(0, variance));
  }

  isFull(): boolean {
    return this.count === this.windowSize;
  }
}

/**
 * Detects anomalies using z-score with cooldown period.
 */
export class ZScoreDetector {
  private readonly stats: RollingStats;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private lastTriggerTime: number = -Infinity;

  constructor(config: {
    windowSize?: number;
    threshold?: number;
    cooldownMs?: number;
  } = {}) {
    this.stats = new RollingStats(config.windowSize ?? 50);
    this.threshold = config.threshold ?? 3.0;
    this.cooldownMs = config.cooldownMs ?? 10000;
  }

  /**
   * Check if current value is anomalous (|z-score| > threshold).
   * Returns true only if cooldown has elapsed since last trigger.
   */
  check(value: number, timestamp: number): boolean {
    this.stats.push(value);

    if (!this.stats.isFull()) {
      return false;
    }

    const mean = this.stats.getMean();
    const stdDev = this.stats.getStdDev();

    if (stdDev === 0) {
      return false;
    }

    const zScore = Math.abs((value - mean) / stdDev);
    const isAnomaly = zScore > this.threshold;
    const cooldownElapsed = timestamp - this.lastTriggerTime >= this.cooldownMs;

    if (isAnomaly && cooldownElapsed) {
      this.lastTriggerTime = timestamp;
      return true;
    }

    return false;
  }
}

/**
 * Detects when a metric stays above a threshold for N consecutive ticks.
 */
export class HysteresisDetector {
  private readonly threshold: number;
  private readonly consecutiveTicks: number;
  private readonly cooldownMs: number;
  private consecutiveCount: number = 0;
  private lastTriggerTime: number = -Infinity;

  constructor(config: {
    threshold: number;
    consecutiveTicks: number;
    cooldownMs?: number;
  }) {
    this.threshold = config.threshold;
    this.consecutiveTicks = config.consecutiveTicks;
    this.cooldownMs = config.cooldownMs ?? 15000;
  }

  /**
   * Check if value has been above threshold for N consecutive ticks.
   * Returns true when threshold is reached AND cooldown has elapsed.
   * Resets counter when value drops below threshold.
   */
  check(value: number, timestamp: number): boolean {
    if (value >= this.threshold) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 0;
    }

    const thresholdReached = this.consecutiveCount >= this.consecutiveTicks;
    const cooldownElapsed = timestamp - this.lastTriggerTime >= this.cooldownMs;

    if (thresholdReached && cooldownElapsed) {
      this.lastTriggerTime = timestamp;
      this.consecutiveCount = 0; // Reset after triggering
      return true;
    }

    return false;
  }
}

/**
 * Detects when a value crosses a threshold in a specific direction.
 */
export class ThresholdCrossingDetector {
  private readonly threshold: number;
  private readonly direction: 'up' | 'down';
  private readonly cooldownMs: number;
  private previousValue: number | null = null;
  private lastTriggerTime: number = -Infinity;

  constructor(config: {
    threshold: number;
    direction: 'up' | 'down';
    cooldownMs?: number;
  }) {
    this.threshold = config.threshold;
    this.direction = config.direction;
    this.cooldownMs = config.cooldownMs ?? 30000;
  }

  /**
   * Check if value has crossed threshold in specified direction.
   * Returns true on the tick where crossing happens AND cooldown has elapsed.
   */
  check(value: number, timestamp: number): boolean {
    if (this.previousValue === null) {
      this.previousValue = value;
      return false;
    }

    let crossed = false;
    if (this.direction === 'up') {
      crossed = this.previousValue < this.threshold && value >= this.threshold;
    } else {
      crossed = this.previousValue > this.threshold && value <= this.threshold;
    }

    this.previousValue = value;

    const cooldownElapsed = timestamp - this.lastTriggerTime >= this.cooldownMs;

    if (crossed && cooldownElapsed) {
      this.lastTriggerTime = timestamp;
      return true;
    }

    return false;
  }
}

/**
 * Detects when a metric drops (or rises) significantly relative to its rolling average.
 */
export class RateOfChangeDetector {
  private readonly stats: RollingStats;
  private readonly dropThresholdPct: number;
  private readonly cooldownMs: number;
  private lastTriggerTime: number = -Infinity;

  constructor(config: {
    windowSize?: number;
    dropThresholdPct?: number;
    cooldownMs?: number;
  } = {}) {
    this.stats = new RollingStats(config.windowSize ?? 150);
    this.dropThresholdPct = config.dropThresholdPct ?? 0.3;
    this.cooldownMs = config.cooldownMs ?? 20000;
  }

  /**
   * Check if current value has dropped significantly from rolling average.
   * Returns true when (rollingAvg - value) / rollingAvg > dropThresholdPct
   * AND cooldown has elapsed.
   */
  check(value: number, timestamp: number): boolean {
    this.stats.push(value);

    if (!this.stats.isFull()) {
      return false;
    }

    const rollingAvg = this.stats.getMean();

    if (rollingAvg === 0) {
      return false;
    }

    const dropPct = (rollingAvg - value) / rollingAvg;
    const significantDrop = dropPct > this.dropThresholdPct;
    const cooldownElapsed = timestamp - this.lastTriggerTime >= this.cooldownMs;

    if (significantDrop && cooldownElapsed) {
      this.lastTriggerTime = timestamp;
      return true;
    }

    return false;
  }
}
