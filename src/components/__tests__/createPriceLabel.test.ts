// @vitest-environment jsdom
/**
 * createPriceLabel DOM badge — layout, textContent, countdown, dispose, identity skip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPriceLabel } from '../createPriceLabel';
import type { PriceLabelUpdateState } from '../createPriceLabel';

function getRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function baseState(overrides: Partial<PriceLabelUpdateState> = {}): PriceLabelUpdateState {
  return {
    visible: true,
    x: 100,
    y: 50,
    priceText: '42.50',
    countdownText: null,
    background: '#22c55e',
    color: '#ffffff',
    side: 'right',
    ...overrides,
  };
}

describe('createPriceLabel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '400px';
    container.style.height = '300px';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('creates absolute root with z-index 12 and pointer-events none', () => {
    const label = createPriceLabel(container);
    const root = getRoot(container);
    expect(root.style.position).toBe('absolute');
    expect(root.style.zIndex).toBe('12');
    expect(root.style.pointerEvents).toBe('none');
    expect(Number(root.style.zIndex)).toBeGreaterThan(10); // above TextOverlay
    expect(Number(root.style.zIndex)).toBeLessThan(15); // below legend
    label.dispose();
  });

  it('uses textContent for price (never HTML)', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ priceText: '<b>hack</b>' }));
    const root = getRoot(container);
    const priceEl = root.firstElementChild as HTMLElement;
    expect(priceEl.textContent).toBe('<b>hack</b>');
    expect(priceEl.innerHTML).toBe('&lt;b&gt;hack&lt;/b&gt;');
    label.dispose();
  });

  it('uses textContent for countdown (setCountdown never HTML)', () => {
    const label = createPriceLabel(container);
    label.update(baseState());
    label.setCountdown('<img src=x onerror=alert(1)>');
    const countdownEl = getRoot(container).children[1] as HTMLElement;
    expect(countdownEl.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(countdownEl.querySelector('img')).toBeNull();
    expect(countdownEl.innerHTML).toContain('&lt;img');
    label.dispose();
  });

  it('uses textContent for countdown via update countdownText', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ countdownText: '<script>alert(1)</script>' }));
    const countdownEl = getRoot(container).children[1] as HTMLElement;
    expect(countdownEl.textContent).toBe('<script>alert(1)</script>');
    expect(countdownEl.querySelector('script')).toBeNull();
    expect(countdownEl.innerHTML).toContain('&lt;script&gt;');
    label.dispose();
  });

  it('applies direction color as background and text color', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ background: '#ef4444', color: '#ffffff' }));
    const root = getRoot(container);
    expect(root.style.background).toBe('rgb(239, 68, 68)');
    expect(root.style.color).toBe('rgb(255, 255, 255)');
    label.dispose();
  });

  it('side right: left edge at x, translateY(-50%) only', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ side: 'right', x: 320, y: 80 }));
    const root = getRoot(container);
    expect(root.style.left).toBe('320px');
    expect(root.style.top).toBe('80px');
    expect(root.style.transform).toBe('translateY(-50%)');
    label.dispose();
  });

  it('side left: right edge at x via translate(-100%, -50%)', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ side: 'left', x: 20, y: 90 }));
    const root = getRoot(container);
    expect(root.style.left).toBe('20px');
    expect(root.style.top).toBe('90px');
    expect(root.style.transform).toBe('translate(-100%, -50%)');
    label.dispose();
  });

  it('K14: no ellipsis / text-overflow truncation styles', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ priceText: '1234567890.123456' }));
    const root = getRoot(container);
    expect(root.style.whiteSpace).toBe('nowrap');
    expect(root.style.textOverflow).not.toBe('ellipsis');
    expect(root.style.overflow).not.toBe('hidden');
    label.dispose();
  });

  it('hides when visible=false and shows when visible=true', () => {
    const label = createPriceLabel(container);
    const root = getRoot(container);
    expect(root.style.display).toBe('none');

    label.update(baseState({ visible: true }));
    expect(root.style.display).toBe('block');
    expect(root.style.visibility).toBe('visible');

    label.update(baseState({ visible: false }));
    expect(root.style.display).toBe('none');
    label.dispose();
  });

  it('setCountdown updates secondary line via textContent', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ countdownText: null }));
    const root = getRoot(container);
    const countdownEl = root.children[1] as HTMLElement;
    expect(countdownEl.style.display).toBe('none');

    label.setCountdown('00:01:30');
    expect(countdownEl.textContent).toBe('00:01:30');
    expect(countdownEl.style.display).toBe('block');

    label.setCountdown(null);
    expect(countdownEl.textContent).toBe('');
    expect(countdownEl.style.display).toBe('none');
    label.dispose();
  });

  it('update with countdownText shows secondary line', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ countdownText: '00:00:05' }));
    const root = getRoot(container);
    const countdownEl = root.children[1] as HTMLElement;
    expect(countdownEl.textContent).toBe('00:00:05');
    expect(countdownEl.style.display).toBe('block');
    label.dispose();
  });

  it('applies out-of-domain opacity when provided', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ opacity: 0.85 }));
    expect(getRoot(container).style.opacity).toBe('0.85');
    label.dispose();
  });

  it('identity skip: identical update does not rewrite price text node', () => {
    const label = createPriceLabel(container);
    const state = baseState({ priceText: '1.23' });
    label.update(state);
    const root = getRoot(container);
    const priceEl = root.firstElementChild as HTMLElement;
    const before = priceEl.textContent;
    // Mutate DOM to detect whether update re-assigns textContent
    priceEl.textContent = 'MUTATED';
    label.update(state);
    // Same state → skip path leaves mutated text
    expect(priceEl.textContent).toBe('MUTATED');
    // Different price forces rewrite
    label.update({ ...state, priceText: '9.99' });
    expect(priceEl.textContent).toBe('9.99');
    expect(before).toBe('1.23');
    label.dispose();
  });

  it('setCountdown identity skip: same text is a no-op', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ countdownText: '00:00:10' }));
    const countdownEl = getRoot(container).children[1] as HTMLElement;
    countdownEl.textContent = 'MUTATED';
    label.setCountdown('00:00:10');
    expect(countdownEl.textContent).toBe('MUTATED');
    label.setCountdown('00:00:09');
    expect(countdownEl.textContent).toBe('00:00:09');
    label.dispose();
  });

  it('normalizes empty countdown to null so identity skip stays consistent', () => {
    const label = createPriceLabel(container);
    const state = baseState({ countdownText: null });
    label.update(state);
    const root = getRoot(container);
    const priceEl = root.firstElementChild as HTMLElement;
    priceEl.textContent = 'MUTATED';
    // '' is treated as null — sameLayout must hold
    label.update({ ...state, countdownText: '' });
    expect(priceEl.textContent).toBe('MUTATED');
    // setCountdown('') after null is also a no-op
    const countdownEl = root.children[1] as HTMLElement;
    countdownEl.textContent = 'STILL_HIDDEN';
    label.setCountdown('');
    label.setCountdown(null);
    expect(countdownEl.style.display).toBe('none');
    label.dispose();
  });

  it('side switch right → left updates transform on same instance', () => {
    const label = createPriceLabel(container);
    label.update(baseState({ side: 'right', x: 300, y: 40 }));
    const root = getRoot(container);
    expect(root.style.transform).toBe('translateY(-50%)');
    label.update(baseState({ side: 'left', x: 20, y: 40 }));
    expect(root.style.transform).toBe('translate(-100%, -50%)');
    expect(root.style.left).toBe('20px');
    label.dispose();
  });

  it('re-show after hide restores layout even with identical fields', () => {
    const label = createPriceLabel(container);
    const state = baseState({ x: 100, y: 50, priceText: '1.00' });
    label.update(state);
    const root = getRoot(container);
    expect(root.style.display).toBe('block');
    label.update({ ...state, visible: false });
    expect(root.style.display).toBe('none');
    // Re-show with identical layout fields must leave identity skip and show again
    label.update(state);
    expect(root.style.display).toBe('block');
    expect(root.style.visibility).toBe('visible');
    expect(root.style.left).toBe('100px');
    expect((root.firstElementChild as HTMLElement).textContent).toBe('1.00');
    label.dispose();
  });

  it('dispose removes DOM and is idempotent', () => {
    const label = createPriceLabel(container);
    label.update(baseState());
    expect(container.childElementCount).toBe(1);
    label.dispose();
    expect(container.childElementCount).toBe(0);
    label.dispose();
    expect(container.childElementCount).toBe(0);
  });

  it('update/setCountdown after dispose are no-ops', () => {
    const label = createPriceLabel(container);
    label.dispose();
    expect(() => label.update(baseState())).not.toThrow();
    expect(() => label.setCountdown('00:00:01')).not.toThrow();
    expect(container.childElementCount).toBe(0);
  });

  it('sets container position relative when static/empty and restores on dispose', () => {
    const staticContainer = document.createElement('div');
    document.body.appendChild(staticContainer);
    const label = createPriceLabel(staticContainer);
    expect(staticContainer.style.position).toBe('relative');
    expect((staticContainer.firstElementChild as HTMLElement).style.position).toBe('absolute');
    label.dispose();
    expect(staticContainer.style.position).toBe('');
    expect(staticContainer.childElementCount).toBe(0);
    staticContainer.remove();
  });

  it('uses tabular-nums for stable digit width', () => {
    const label = createPriceLabel(container);
    label.update(baseState());
    expect(getRoot(container).style.fontVariantNumeric).toBe('tabular-nums');
    label.dispose();
  });
});
