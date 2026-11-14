import {
  getPointCount,
  hasNullGaps,
  isRingXYColumns,
  isStagingRingView,
  type CoordinatorCartesianData,
} from '../../../data/cartesianData';

export type GapScanCache = {
  readonly hasNullGaps: (data: CoordinatorCartesianData) => boolean;
  readonly clear: () => void;
};

export function createGapScanCache(): GapScanCache {
  let byData = new WeakMap<object, { pointCount: number; hasGaps: boolean }>();

  const cachedHasNullGaps = (data: CoordinatorCartesianData): boolean => {
    if (data == null || typeof data !== 'object' || isRingXYColumns(data) || isStagingRingView(data)) {
      return hasNullGaps(data);
    }
    const pointCount = getPointCount(data);
    const hit = byData.get(data);
    if (hit && hit.pointCount === pointCount) return hit.hasGaps;
    const hasGaps = hasNullGaps(data);
    byData.set(data, { pointCount, hasGaps });
    return hasGaps;
  };

  return {
    hasNullGaps: cachedHasNullGaps,
    clear: () => {
      byData = new WeakMap();
    },
  };
}
