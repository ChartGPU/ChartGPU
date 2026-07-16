/**
 * Issue 1.6: sampling:'none' / fullRawLine any-zoom and cold unknown+none.
 * Structural + DataStore ranged-append evidence (coordinator canUseFastPath).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('canUseFastPath kind tagging (issue 1.6)', () => {
  const coordinatorSrc = readFileSync(resolve(__dirname, '../../../createRenderCoordinator.ts'), 'utf8');
  const renderSeriesSrc = readFileSync(resolve(__dirname, '../renderSeries.ts'), 'utf8');

  it('unlocks sampling none on cold unknown kind (not only GPU-eligible)', () => {
    // kind === "unknown" && (isGpuDecimationEligibleNow || s.sampling === "none")
    expect(coordinatorSrc).toMatch(/kind\s*===\s*["']unknown["']\s*&&\s*\([\s\S]*?sampling\s*===\s*["']none["']/);
  });

  it('does not require full-span zoom for sampling none ranged append', () => {
    // Can use path with sampling === "none" without isFullSpanZoomBefore
    const flushIdx = coordinatorSrc.indexOf('const canUseFastPath');
    expect(flushIdx).toBeGreaterThan(-1);
    const body = coordinatorSrc.slice(flushIdx, flushIdx + 800);
    expect(body).toMatch(/s\.sampling\s*===\s*["']none["']/);
    expect(body).not.toMatch(/isFullSpanZoomBefore/);
  });

  it('tags fullRawLine for sampling none at any zoom (not full-span gated)', () => {
    expect(renderSeriesSrc).toMatch(
      /if\s*\(\s*s\.sampling\s*===\s*["']none["']\s*\)\s*\{\s*gpuSeriesKindByIndex\[i\]\s*=\s*["']fullRawLine["']/
    );
    // No isFullSpanZoom gate on that assignment.
    // Source uses single-quoted string literals.
    const tagIdx = renderSeriesSrc.indexOf("gpuSeriesKindByIndex[i] = 'fullRawLine'");
    expect(tagIdx).toBeGreaterThan(-1);
    const before = renderSeriesSrc.slice(Math.max(0, tagIdx - 200), tagIdx);
    expect(before).not.toMatch(/isFullSpanZoom/);
  });
});
