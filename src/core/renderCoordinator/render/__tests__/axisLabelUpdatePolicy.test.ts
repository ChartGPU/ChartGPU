import { describe, it, expect } from 'vitest';
import { shouldUpdateAxisLabels } from '../axisLabelUpdatePolicy';

/** Keep in sync with axisLabelUpdatePolicy.ts private constant. */
const AXIS_LABEL_STRUCTURAL_THROTTLE_MS = 50;

const baseContent = (th: string, epoch = 'epoch:1|') =>
  `0,1,0,1|12|#fff|sans|${epoch}xr:100|xt:value|x:|${th}|y:y:n::left:yt:value;yb:;ar:;`;

describe('shouldUpdateAxisLabels', () => {
  it('first paint always updates', () => {
    const d = shouldUpdateAxisLabels({
      lastFullSignature: '',
      lastContentSignature: '',
      nextFullSignature: baseContent('th:1|') + 'xs:0,1|',
      nextContentSignature: baseContent('th:1|'),
      nowMs: 1000,
      lastUpdateMs: 0,
    });
    expect(d.shouldUpdate).toBe(true);
    expect(d.reason).toBe('first');
  });

  it('position-only: content same, full different → every paint', () => {
    const content = baseContent('th:abc|');
    const d = shouldUpdateAxisLabels({
      lastFullSignature: content + 'xs:0,1|',
      lastContentSignature: content,
      nextFullSignature: content + 'xs:0.1,1.1|',
      nextContentSignature: content,
      nowMs: 1000,
      lastUpdateMs: 999,
    });
    expect(d.shouldUpdate).toBe(true);
    expect(d.positionOnly).toBe(true);
    expect(d.reason).toBe('position-only');
  });

  it('tick-set change: immediate even within throttle window', () => {
    const lastC = baseContent('th:111|');
    const nextC = baseContent('th:222|');
    const d = shouldUpdateAxisLabels({
      lastFullSignature: lastC + 'xs:0,1|',
      lastContentSignature: lastC,
      nextFullSignature: nextC + 'xs:0,1|',
      nextContentSignature: nextC,
      nowMs: 1000,
      lastUpdateMs: 990, // 10ms ago < 50ms
    });
    expect(d.shouldUpdate).toBe(true);
    expect(d.tickSetChanged).toBe(true);
    expect(d.reason).toBe('tick-set');
  });

  it('epoch change forces immediate rebuild', () => {
    const lastC = baseContent('th:1|', 'epoch:1|');
    const nextC = baseContent('th:1|', 'epoch:9|');
    const d = shouldUpdateAxisLabels({
      lastFullSignature: lastC + 'xs:0,1|',
      lastContentSignature: lastC,
      nextFullSignature: nextC + 'xs:0,1|',
      nextContentSignature: nextC,
      nowMs: 1000,
      lastUpdateMs: 995,
    });
    expect(d.shouldUpdate).toBe(true);
    expect(d.epochChanged).toBe(true);
    expect(d.reason).toBe('epoch');
  });

  it('other structural without tick change: throttled', () => {
    // Same th, different name segment → content changed but tick hash same
    const lastC = baseContent('th:1|') + 'extraA';
    const nextC = baseContent('th:1|') + 'extraB';
    const blocked = shouldUpdateAxisLabels({
      lastFullSignature: lastC + 'xs:0,1|',
      lastContentSignature: lastC,
      nextFullSignature: nextC + 'xs:0,1|',
      nextContentSignature: nextC,
      nowMs: 1000,
      lastUpdateMs: 980,
    });
    expect(blocked.shouldUpdate).toBe(false);
    expect(blocked.reason).toBe('skip-throttle');

    const allowed = shouldUpdateAxisLabels({
      lastFullSignature: lastC + 'xs:0,1|',
      lastContentSignature: lastC,
      nextFullSignature: nextC + 'xs:0,1|',
      nextContentSignature: nextC,
      nowMs: 1000,
      lastUpdateMs: 1000 - AXIS_LABEL_STRUCTURAL_THROTTLE_MS,
    });
    expect(allowed.shouldUpdate).toBe(true);
    expect(allowed.reason).toBe('structural-throttle');
  });

  it('unchanged full signature skips', () => {
    const full = baseContent('th:1|') + 'xs:0,1|';
    const d = shouldUpdateAxisLabels({
      lastFullSignature: full,
      lastContentSignature: baseContent('th:1|'),
      nextFullSignature: full,
      nextContentSignature: baseContent('th:1|'),
      nowMs: 2000,
      lastUpdateMs: 1000,
    });
    expect(d.shouldUpdate).toBe(false);
    expect(d.reason).toBe('unchanged');
  });
});
