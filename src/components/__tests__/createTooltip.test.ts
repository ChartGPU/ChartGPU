// @vitest-environment jsdom
/**
 * Tooltip stacking vs legend / axis text overlay (issue #149).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTooltip } from '../createTooltip';

describe('createTooltip z-index stacking', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('defaults z-index above legend (15) and axis text overlay (10)', () => {
    const tooltip = createTooltip(container);
    const root = container.firstElementChild as HTMLElement;
    // Inline style retains the CSS var expression with fallback 20.
    expect(root.style.zIndex).toBe('var(--chartgpu-tooltip-z, 20)');
    const fallbackMatch = root.style.zIndex.match(/,\s*(\d+)\s*\)/);
    expect(fallbackMatch).not.toBeNull();
    const fallback = Number(fallbackMatch![1]);
    expect(fallback).toBe(20);
    expect(fallback).toBeGreaterThan(15); // legend
    expect(fallback).toBeGreaterThan(10); // createTextOverlay
    tooltip.dispose();
  });
});
