import { resolveOptions } from '../../src/config/OptionResolver';
import { sampleSeriesDataPoints } from '../../src/data/sampleSeries';
import type { DataPointTuple } from '../../src/config/types';

// TypeScript-only acceptance checks for Story 5.8 (sampling config).
// This file is excluded from the library build (tsconfig excludes `examples/`).

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isTupleDataPoint: (point: unknown) => point is DataPointTuple = (point): point is DataPointTuple =>
  Array.isArray(point);

// resolveOptions should not throw for a line series without areaStyle
{
  const resolved = resolveOptions({
    series: [
      {
        type: 'line',
        data: [
          [0, 1],
          [1, 2],
        ],
      },
    ],
  });

  assert(resolved.series.length === 1, 'Expected exactly 1 resolved series.');
  assert(resolved.series[0]?.type === 'line', 'Expected resolved series[0] to be type=line.');
}

// Sampling defaults apply for non-pie series
{
  const resolved = resolveOptions({
    series: [
      {
        type: 'line',
        data: [[0, 1]],
      },
    ],
  });

  const s0 = resolved.series[0];
  if (!s0 || s0.type !== 'line') throw new Error('Expected resolved series[0] to be type=line.');
  assert(s0.sampling === 'lttb', "Expected default sampling to be 'lttb' for non-pie series.");
  assert(s0.samplingThreshold === 5000, 'Expected default samplingThreshold to be 5000 for non-pie series.');
}

// Pie series should strip sampling keys from resolved output (JS caller simulation)
{
  const resolved = resolveOptions({
    series: [
      {
        type: 'pie',
        data: [
          { name: 'A', value: 1 },
          { name: 'B', value: 2 },
        ],
        // These keys are not part of PieSeriesConfig (TS), but a JS caller could provide them.
        sampling: 'lttb',
        samplingThreshold: 1234,
      } as unknown as { readonly type: 'pie'; readonly data: ReadonlyArray<{ name: string; value: number }>; sampling: string; samplingThreshold: number },
    ],
  });

  const s0 = resolved.series[0];
  if (!s0 || s0.type !== 'pie') throw new Error('Expected resolved series[0] to be type=pie.');

  const hasSampling = Object.prototype.hasOwnProperty.call(s0, 'sampling');
  const hasSamplingThreshold = Object.prototype.hasOwnProperty.call(s0, 'samplingThreshold');

  assert(!hasSampling, "Expected pie resolved series to NOT include a 'sampling' key.");
  assert(!hasSamplingThreshold, "Expected pie resolved series to NOT include a 'samplingThreshold' key.");
}

// Average sampling should preserve per-point size semantics for scatter-style tuples.
{
  const data: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 1],
    [1, 1, 2],
    [2, 2, 3],
    [3, 3, 4],
    [4, 4, 5],
    [5, 5, 6],
    [6, 6, 7],
    [7, 7, 8],
    [8, 8, 9],
    [9, 9, 10],
  ];

  const sampled = sampleSeriesDataPoints(data, 'average', 5);
  assert(sampled.length === 5, 'Expected average sampling to return threshold-sized output.');

  const p1 = sampled[1];
  assert(isTupleDataPoint(p1), 'Expected sampled bucket average to be a tuple.');
  assert(p1.length === 3, 'Expected averaged tuple to include aggregated size when bucket contains sizes.');
  assert(p1[2] === 2.5, 'Expected avgSize for first bucket to equal average of sizes [2,3].');
}

// Average sampling should omit size when no finite sizes are present.
{
  const data: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
    [7, 7],
    [8, 8],
    [9, 9],
  ];

  const sampled = sampleSeriesDataPoints(data, 'average', 5);
  assert(sampled.length === 5, 'Expected average sampling to return threshold-sized output.');

  const p1 = sampled[1];
  assert(isTupleDataPoint(p1), 'Expected sampled bucket average to be a tuple.');
  assert(p1.length === 2, 'Expected averaged tuple to omit size when bucket contains no sizes.');
  assert(p1[2] === undefined, 'Expected tuple size to be undefined when omitted.');
}

