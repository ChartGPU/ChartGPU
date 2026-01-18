import type { DataPoint, DataPointTuple, SeriesSampling } from '../config/types';
import { lttbSample } from './lttbSample';

function isTupleDataPoint(point: DataPoint): point is DataPointTuple {
  return Array.isArray(point);
}

function getXY(point: DataPoint): { readonly x: number; readonly y: number } {
  if (isTupleDataPoint(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
}

function getSize(point: DataPoint): number | undefined {
  if (isTupleDataPoint(point)) return point[2];
  return point.size;
}

function clampTargetPoints(targetPoints: number): number {
  const t = Math.floor(targetPoints);
  return Number.isFinite(t) ? t : 0;
}

type BucketMode = 'average' | 'max' | 'min';

function sampleByBuckets(
  data: ReadonlyArray<DataPoint>,
  targetPoints: number,
  mode: BucketMode
): ReadonlyArray<DataPoint> {
  const n = data.length;
  const threshold = clampTargetPoints(targetPoints);

  if (threshold <= 0 || n === 0) return [];
  if (threshold === 1) return [data[0]!];
  if (threshold === 2) return n >= 2 ? [data[0]!, data[n - 1]!] : [data[0]!];
  if (n <= threshold) return data;

  const lastIndex = n - 1;
  const out = new Array<DataPoint>(threshold);
  out[0] = data[0]!;
  out[threshold - 1] = data[lastIndex]!;

  const bucketSize = (n - 2) / (threshold - 2);

  for (let bucket = 0; bucket < threshold - 2; bucket++) {
    let rangeStart = Math.floor(bucketSize * bucket) + 1;
    let rangeEndExclusive = Math.min(Math.floor(bucketSize * (bucket + 1)) + 1, lastIndex);

    if (rangeStart >= rangeEndExclusive) {
      rangeStart = Math.min(rangeStart, lastIndex - 1);
      rangeEndExclusive = Math.min(rangeStart + 1, lastIndex);
    }

    let chosen: DataPoint | null = null;

    if (mode === 'average') {
      let sumX = 0;
      let sumY = 0;
      let sumSize = 0;
      let count = 0;
      let sizeCount = 0;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const p = data[i]!;
        const { x, y } = getXY(p);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sumX += x;
        sumY += y;
        count++;

        const size = getSize(p);
        if (typeof size === 'number' && Number.isFinite(size)) {
          sumSize += size;
          sizeCount++;
        }
      }

      if (count > 0) {
        const avgX = sumX / count;
        const avgY = sumY / count;
        if (sizeCount > 0) {
          chosen = [avgX, avgY, sumSize / sizeCount];
        } else {
          chosen = [avgX, avgY];
        }
      }
    } else {
      let bestY = mode === 'max' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (let i = rangeStart; i < rangeEndExclusive; i++) {
        const p = data[i]!;
        const { y } = getXY(p);
        if (!Number.isFinite(y)) continue;
        if (mode === 'max') {
          if (y > bestY) {
            bestY = y;
            chosen = p;
          }
        } else {
          if (y < bestY) {
            bestY = y;
            chosen = p;
          }
        }
      }
    }

    out[bucket + 1] = chosen ?? data[rangeStart]!;
  }

  return out;
}

export function sampleSeriesDataPoints(
  data: ReadonlyArray<DataPoint>,
  sampling: SeriesSampling,
  samplingThreshold: number
): ReadonlyArray<DataPoint> {
  const threshold = clampTargetPoints(samplingThreshold);

  // Disabled or already under threshold: keep original reference (avoid extra allocations).
  if (sampling === 'none') return data;
  if (!(threshold > 0)) return data;
  if (data.length <= threshold) return data;

  switch (sampling) {
    case 'lttb':
      return lttbSample(data, threshold);
    case 'average':
      return sampleByBuckets(data, threshold, 'average');
    case 'max':
      return sampleByBuckets(data, threshold, 'max');
    case 'min':
      return sampleByBuckets(data, threshold, 'min');
    default: {
      // Defensive for JS callers / widened types.
      return data;
    }
  }
}

