/**
 * Annotation trigger management that wires detectors to chart annotations.
 */

import type { AnnotationConfig, ChartGPUInstance } from '../../src/index';
import {
  ZScoreDetector,
  HysteresisDetector,
  RateOfChangeDetector,
} from './detectors';
import type { DashboardMetrics } from './dataGenerator';

interface AnnotationTrigger {
  readonly id: string;
  readonly chartIndex: number; // which chart (0-4) to annotate
  readonly detector:
    | ZScoreDetector
    | HysteresisDetector
    | RateOfChangeDetector;
  readonly getMetricValue: (metrics: DashboardMetrics) => number;
  readonly createAnnotation: (timestamp: number, value: number) => AnnotationConfig;
}

const LABEL_BACKGROUND = {
  color: '#000000',
  opacity: 0.7,
  padding: [2, 6, 2, 6] as const,
  borderRadius: 4,
} as const;

/**
 * Create an annotation manager that processes metrics and triggers annotations.
 */
export function createAnnotationManager(charts: ChartGPUInstance[]): {
  processTick: (metrics: DashboardMetrics) => void;
  getAnnotationCounts: () => Record<string, number>;
} {
  const MAX_ANNOTATIONS_PER_CHART = 30;
  const annotationCounts: Record<string, number> = {};

  // Define annotation triggers with their detectors
  const triggers: readonly AnnotationTrigger[] = [
    // 1. P95 Warning (chart 0 – latency)
    //    P95 exceeds 100 around t≈94s (memory ~62%).  Fire every 5s while above.
    {
      id: 'p95-warning',
      chartIndex: 0,
      detector: new HysteresisDetector({
        threshold: 100,
        consecutiveTicks: 2,
        cooldownMs: 5000,
      }),
      getMetricValue: (m) => m.p95,
      createAnnotation: (_timestamp: number, value: number): AnnotationConfig => ({
        type: 'lineY',
        y: value,
        layer: 'belowSeries',
        style: { color: '#eab308', lineWidth: 2, lineDash: [8, 6], opacity: 0.9 },
        label: {
          text: `P95 Warning: ${Math.round(value)}ms`,
          offset: [8, -8] as const,
          anchor: 'start',
          background: LABEL_BACKGROUND,
        },
      }),
    },

    // 2. P99 Critical (chart 0 – latency)
    //    P99 exceeds 300 around t≈124s (early Phase 3).  Fire every 8s while above.
    {
      id: 'p99-critical',
      chartIndex: 0,
      detector: new HysteresisDetector({
        threshold: 300,
        consecutiveTicks: 1,
        cooldownMs: 8000,
      }),
      getMetricValue: (m) => m.p99,
      createAnnotation: (timestamp: number, value: number): AnnotationConfig => ({
        type: 'lineX',
        x: timestamp,
        layer: 'aboveSeries',
        style: { color: '#ef4444', lineWidth: 2 },
        label: {
          text: `P99 CRITICAL: ${Math.round(value)}ms`,
          offset: [8, -8] as const,
          anchor: 'start',
          background: LABEL_BACKGROUND,
        },
      }),
    },

    // 3. Memory Warning (chart 2 – resources)
    //    Memory exceeds 55% around t≈80s.  Fires every 8s while above.
    {
      id: 'memory-warning',
      chartIndex: 2,
      detector: new HysteresisDetector({
        threshold: 55,
        consecutiveTicks: 3,
        cooldownMs: 8000,
      }),
      getMetricValue: (m) => m.memory,
      createAnnotation: (timestamp: number, value: number): AnnotationConfig => ({
        type: 'lineX',
        x: timestamp,
        style: { color: '#f97316', lineWidth: 2, lineDash: [4, 4], opacity: 0.9 },
        label: {
          text: `Mem ${value.toFixed(0)}%`,
          offset: [8, 10] as const,
          anchor: 'start',
          background: LABEL_BACKGROUND,
        },
      }),
    },

    // 4. Error Anomaly (chart 3 – errors)
    //    Smaller window (15 = 3s warmup) + lower z-score threshold for quicker detection.
    {
      id: 'error-anomaly',
      chartIndex: 3,
      detector: new ZScoreDetector({
        windowSize: 15,
        threshold: 1.5,
        cooldownMs: 5000,
      }),
      getMetricValue: (m) => m.errors5xx,
      createAnnotation: (timestamp: number, value: number): AnnotationConfig => ({
        type: 'point',
        x: timestamp,
        y: value,
        layer: 'aboveSeries',
        marker: {
          symbol: 'circle',
          size: 10,
          style: { color: '#ef4444' },
        },
        label: {
          text: `Anomaly: ${value.toFixed(1)}`,
          offset: [10, -10] as const,
          anchor: 'start',
          background: LABEL_BACKGROUND,
        },
      }),
    },

    // 5. Throughput Drop (chart 1 – throughput)
    //    Smaller window (25 = 5s warmup) + lower threshold (10% drop).
    {
      id: 'throughput-drop',
      chartIndex: 1,
      detector: new RateOfChangeDetector({
        windowSize: 25,
        dropThresholdPct: 0.10,
        cooldownMs: 8000,
      }),
      getMetricValue: (m) => m.throughput,
      createAnnotation: (timestamp: number, value: number): AnnotationConfig => ({
        type: 'lineX',
        x: timestamp,
        style: { color: '#ef4444', lineWidth: 2 },
        label: {
          text: `Drop: ${Math.round(value)} req/s`,
          offset: [8, 10] as const,
          anchor: 'start',
          background: LABEL_BACKGROUND,
        },
      }),
    },

    // 6. Pool Saturated (chart 4 – connections)
    //    Fires when active connections exceed 100 (Phase 2, t≈112s).  Every 6s.
    {
      id: 'pool-saturated',
      chartIndex: 4,
      detector: new HysteresisDetector({
        threshold: 100,
        consecutiveTicks: 2,
        cooldownMs: 6000,
      }),
      getMetricValue: (m) => m.activeConnections,
      createAnnotation: (timestamp: number, value: number): AnnotationConfig => ({
        type: 'text',
        position: { space: 'data', x: timestamp, y: value + 5 },
        text: `POOL: ${Math.round(value)}`,
        layer: 'aboveSeries',
        style: { color: '#ec4899', opacity: 1 },
      }),
    },
  ];

  // Initialize annotation counts
  for (const trigger of triggers) {
    annotationCounts[trigger.id] = 0;
  }

  /**
   * Process a single metrics tick and trigger annotations as needed.
   */
  function processTick(metrics: DashboardMetrics): void {
    for (const trigger of triggers) {
      const chart = charts[trigger.chartIndex];
      if (!chart) continue;

      const value = trigger.getMetricValue(metrics);
      const fired = trigger.detector.check(value, metrics.timestamp);

      if (fired) {
        const newAnnotation = trigger.createAnnotation(metrics.timestamp, value);
        const currentAnnotations = chart.options.annotations ?? [];

        // Cap annotations at MAX_ANNOTATIONS_PER_CHART (remove oldest)
        const updatedAnnotations =
          currentAnnotations.length >= MAX_ANNOTATIONS_PER_CHART
            ? [...currentAnnotations.slice(1), newAnnotation]
            : [...currentAnnotations, newAnnotation];

        chart.setOption({
          ...chart.options,
          annotations: updatedAnnotations,
        });

        annotationCounts[trigger.id]++;
      }
    }
  }

  /**
   * Get annotation counts per trigger ID.
   */
  function getAnnotationCounts(): Record<string, number> {
    return { ...annotationCounts };
  }

  return {
    processTick,
    getAnnotationCounts,
  };
}
