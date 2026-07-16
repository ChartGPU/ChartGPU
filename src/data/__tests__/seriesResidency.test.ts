import { describe, it, expect } from 'vitest';
import { resolveUploadPolicy, type SeriesResidency } from '../seriesResidency';

const baseResidency = (overrides: Partial<SeriesResidency> = {}): SeriesResidency => ({
  kind: 'dataStore',
  gpuBuffer: null,
  pointCount: 100,
  contentVersion: 1,
  lastRef: null,
  ...overrides,
});

describe('resolveUploadPolicy (issue 3.4)', () => {
  it('prefers rangedAppend when this frame already appended', () => {
    const data = { x: [1], y: [2] };
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ lastRef: data }),
        dataRef: data,
        geometryCacheHit: true,
        appendedThisFrame: true,
        needsGrowth: false,
      })
    ).toBe('rangedAppend');
  });

  it('returns growWithGpuCopy when capacity growth is required', () => {
    expect(
      resolveUploadPolicy({
        residency: baseResidency(),
        dataRef: [],
        geometryCacheHit: false,
        appendedThisFrame: false,
        needsGrowth: true,
      })
    ).toBe('growWithGpuCopy');
  });

  it('returns skip on geometry cache hit with matching lastRef', () => {
    const data = [[0, 1]] as const;
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ lastRef: data, kind: 'privateInstance' }),
        dataRef: data,
        geometryCacheHit: true,
        appendedThisFrame: false,
        needsGrowth: false,
      })
    ).toBe('skip');
  });

  it('returns fullRewrite on cache miss', () => {
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ lastRef: null }),
        dataRef: [[0, 1]],
        geometryCacheHit: false,
        appendedThisFrame: false,
        needsGrowth: false,
      })
    ).toBe('fullRewrite');
  });

  it('prefers rangedAppend over growth when both flagged', () => {
    expect(
      resolveUploadPolicy({
        residency: baseResidency(),
        dataRef: [],
        geometryCacheHit: false,
        appendedThisFrame: true,
        needsGrowth: true,
      })
    ).toBe('rangedAppend');
  });

  it('does not skip when geometry hit but lastRef mismatches dataRef', () => {
    const a = [[0, 1]] as const;
    const b = [[0, 2]] as const;
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ lastRef: a }),
        dataRef: b,
        geometryCacheHit: true,
        appendedThisFrame: false,
        needsGrowth: false,
      })
    ).toBe('fullRewrite');
  });

  it('returns yOnlyRewrite when equal-N y path is flagged (issue 2.2)', () => {
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ kind: 'privateInstance', lastRef: null }),
        dataRef: [[0, 2]],
        geometryCacheHit: false,
        appendedThisFrame: false,
        needsGrowth: false,
        yOnlyRewrite: true,
      })
    ).toBe('yOnlyRewrite');
  });

  it('prefers skip over yOnlyRewrite when geometry identity hits', () => {
    const data = [[0, 1]] as const;
    expect(
      resolveUploadPolicy({
        residency: baseResidency({ kind: 'privateInstance', lastRef: data }),
        dataRef: data,
        geometryCacheHit: true,
        appendedThisFrame: false,
        needsGrowth: false,
        yOnlyRewrite: true,
      })
    ).toBe('skip');
  });
});
