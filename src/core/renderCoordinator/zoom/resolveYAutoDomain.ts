/**
 * Pure Y auto-range domain resolution for paint (sticky / continuous / animated).
 *
 * Extracted from the coordinator so mode selection, map clear, and animated
 * settle flags are unit-testable without WebGPU.
 *
 * @module resolveYAutoDomain
 * @internal
 */

import {
  applyStickyAutoDomain,
  applyStickyAutoLogDomain,
  applyContinuousAutoDomain,
  applyContinuousAutoLogDomain,
  stepAnimatedAutoDomain,
  resolveAutoRangeMode,
  shouldApplyStickyAutoDomain,
  DEFAULT_STICKY_DOMAIN_HEADROOM,
  type StickyDomain,
} from './stickyAutoDomain';

type YAutoDomainMode = 'sticky' | 'continuous' | 'animated' | 'explicit' | 'transition';

type ResolveYAutoDomainInput = {
  readonly dataDomain: StickyDomain;
  readonly explicitMin: number | undefined;
  readonly explicitMax: number | undefined;
  readonly autoRange: unknown;
  readonly growBy: number | readonly [number, number] | undefined;
  readonly axisType: string | undefined;
  readonly logBase: number | undefined;
  /** Mid update-transition: skip auto motion; caller supplies lerped domain. */
  readonly updateTransitionActive: boolean;
  readonly transitionDomain?: StickyDomain;
  readonly sticky: StickyDomain | null;
  readonly animatedDisplay: StickyDomain | null;
  /**
   * Blend factor for animated mode [0,1]. Caller computes time-based alpha.
   * @default 0.22
   */
  readonly animatedAlpha?: number;
};

type ResolveYAutoDomainResult = {
  readonly domain: StickyDomain;
  readonly mode: YAutoDomainMode;
  /** Next sticky state (null → delete). */
  readonly nextSticky: StickyDomain | null;
  /** Next animated display (null → delete). */
  readonly nextAnimatedDisplay: StickyDomain | null;
  /** When true, coordinator should request another paint (animated not settled). */
  readonly needsFrame: boolean;
};

/**
 * Resolve paint-time Y domain under auto-range policy.
 *
 * Explicit one-sided or both ends → data domain, clear sticky/animated.
 * Continuous → pad every call; animated → lerp display toward continuous target.
 */
export function resolveYAutoDomainForPaint(input: ResolveYAutoDomainInput): ResolveYAutoDomainResult {
  if (input.updateTransitionActive) {
    const domain = input.transitionDomain ?? input.dataDomain;
    return {
      domain: { min: domain.min, max: domain.max },
      mode: 'transition',
      nextSticky: null,
      nextAnimatedDisplay: null,
      needsFrame: false,
    };
  }

  if (!shouldApplyStickyAutoDomain(input.explicitMin, input.explicitMax)) {
    return {
      domain: { min: input.dataDomain.min, max: input.dataDomain.max },
      mode: 'explicit',
      nextSticky: null,
      nextAnimatedDisplay: null,
      needsFrame: false,
    };
  }

  const isLog = input.axisType === 'log';
  const base = input.logBase ?? 10;
  const autoRangeMode = resolveAutoRangeMode(input.autoRange);

  if (autoRangeMode === 'continuous') {
    const domain = isLog
      ? applyContinuousAutoLogDomain(input.dataDomain, base, input.growBy)
      : applyContinuousAutoDomain(input.dataDomain, input.growBy);
    return {
      domain,
      mode: 'continuous',
      nextSticky: null,
      nextAnimatedDisplay: null,
      needsFrame: false,
    };
  }

  if (autoRangeMode === 'animated') {
    const target = isLog
      ? applyContinuousAutoLogDomain(input.dataDomain, base, input.growBy)
      : applyContinuousAutoDomain(input.dataDomain, input.growBy);
    const alpha =
      typeof input.animatedAlpha === 'number' && Number.isFinite(input.animatedAlpha) ? input.animatedAlpha : 0.22;
    const stepped = stepAnimatedAutoDomain(input.animatedDisplay, target, alpha);
    return {
      domain: stepped.domain,
      mode: 'animated',
      nextSticky: null,
      nextAnimatedDisplay: stepped.domain,
      needsFrame: !stepped.settled,
    };
  }

  // sticky (default)
  if (isLog) {
    const next = applyStickyAutoLogDomain(input.dataDomain, input.sticky, base, DEFAULT_STICKY_DOMAIN_HEADROOM);
    return {
      domain: next,
      mode: 'sticky',
      nextSticky: next,
      nextAnimatedDisplay: null,
      needsFrame: false,
    };
  }
  const next = applyStickyAutoDomain(input.dataDomain, input.sticky, DEFAULT_STICKY_DOMAIN_HEADROOM);
  return {
    domain: next,
    mode: 'sticky',
    nextSticky: next,
    nextAnimatedDisplay: null,
    needsFrame: false,
  };
}

/**
 * Time-based blend for animated auto-range: `1 - exp(-dtMs / tauMs)`.
 * Caps at 1; non-finite / negative dt → 1 (snap).
 */
export function animatedAlphaFromDtMs(dtMs: number, tauMs: number = 120): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return 1;
  const tau = Number.isFinite(tauMs) && tauMs > 0 ? tauMs : 120;
  const a = 1 - Math.exp(-dtMs / tau);
  return a >= 1 ? 1 : a;
}
