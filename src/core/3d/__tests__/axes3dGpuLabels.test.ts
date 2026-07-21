import { describe, it, expect, vi } from 'vitest';
import {
  buildAxes3DLabelItems,
  buildAxes3DGpuLabelInstances,
  resolveAxes3DLabelMode,
  axes3DLabelPlanSignature,
  shouldRebuildAxes3DGpuLabelInstances,
  exclusiveAxes3DLabelPaint,
  formatAxes3DMissingGlyphsWarning,
  AXES3D_GPU_LABEL_INSTANCE_FLOATS,
} from '../axes3dLabelItems';
import type { GlyphAtlas, GlyphMetrics } from '../glyphAtlas';
import type { Axes3DTickPlan } from '../../../renderers/createAxisBox3DRenderer';
import type { ResolvedAxes3D } from '../../../config/OptionResolver';
import { createAxes3DGpuLabelsRenderer } from '../../../renderers/createAxes3DGpuLabelsRenderer';
import { createMat4, type Mat4 } from '../mat4';
import type { AABB } from '../aabb';

const identityViewProj = (): Mat4 => {
  // Ortho-ish identity-ish projection: world maps near NDC for small coords
  const m = createMat4();
  // column-major identity
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
};

const makeGlyph = (u: number): GlyphMetrics => ({
  u0: u,
  v0: 0,
  u1: u + 0.05,
  v1: 0.1,
  widthPx: 10,
  heightPx: 16,
  advancePx: 11,
  bearingXPx: 0,
  bearingYPx: 12,
});

const makeAtlas = (chars: string): GlyphAtlas => {
  const glyphs = new Map<string, GlyphMetrics>();
  let i = 0;
  for (const ch of chars) {
    if (glyphs.has(ch)) continue;
    glyphs.set(ch, makeGlyph((i++ % 16) * 0.05));
  }
  return {
    width: 128,
    height: 64,
    pixels: new Uint8ClampedArray(128 * 64 * 4),
    glyphs,
    bakeFontPx: 32,
    lineHeightPx: 40,
    baselineFromTopPx: 28,
    charset: chars,
    pixelScale: 2,
  };
};

const aabb: AABB = {
  min: [0, 0, 0],
  max: [10, 10, 10],
};

const baseAxes = (over?: Partial<ResolvedAxes3D>): ResolvedAxes3D =>
  ({
    x: { name: 'X', type: 'value', tickCount: 5, visible: true },
    y: { name: 'Y', type: 'value', tickCount: 5, visible: true },
    z: { name: 'Z', type: 'value', tickCount: 5, visible: true },
    xName: 'X',
    yName: 'Y',
    zName: 'Z',
    showBox: true,
    showGrid: true,
    labelMode: 'auto',
    ...over,
  }) as ResolvedAxes3D;

const plan: Axes3DTickPlan = {
  xTicks: [0, 5, 10],
  yTicks: [0, 5, 10],
  zTicks: [0, 5, 10],
  xDomain: { min: 0, max: 10 },
  yDomain: { min: 0, max: 10 },
  zDomain: { min: 0, max: 10 },
};

describe('resolveAxes3DLabelMode', () => {
  it('dom always resolves to dom', () => {
    expect(resolveAxes3DLabelMode('dom', { atlasReady: true })).toBe('dom');
    expect(resolveAxes3DLabelMode('dom', { atlasReady: false })).toBe('dom');
  });

  it('gpu uses atlas when ready else dom', () => {
    expect(resolveAxes3DLabelMode('gpu', { atlasReady: true })).toBe('gpu');
    expect(resolveAxes3DLabelMode('gpu', { atlasReady: false })).toBe('dom');
  });

  it('auto prefers gpu when atlas ready', () => {
    expect(resolveAxes3DLabelMode('auto', { atlasReady: true })).toBe('gpu');
    expect(resolveAxes3DLabelMode('auto', { atlasReady: false })).toBe('dom');
    expect(resolveAxes3DLabelMode(undefined, { atlasReady: true })).toBe('gpu');
  });
});

describe('buildAxes3DLabelItems', () => {
  it('emits ticks + titles for visible axes', () => {
    const items = buildAxes3DLabelItems(aabb, plan, baseAxes());
    const titles = items.filter((i) => i.title);
    const ticks = items.filter((i) => !i.title);
    expect(titles.map((t) => t.text).sort()).toEqual(['X', 'Y', 'Z']);
    expect(ticks.length).toBe(9);
  });

  it('skips ticks when axis visible is false; no title instances for that axis', () => {
    const items = buildAxes3DLabelItems(
      aabb,
      plan,
      baseAxes({
        x: { name: 'X', type: 'value', tickCount: 5, visible: false },
        y: { name: 'Y', type: 'value', tickCount: 5, visible: true },
        z: { name: 'Z', type: 'value', tickCount: 5, visible: true },
      })
    );
    expect(items.some((i) => i.text === 'X')).toBe(false);
    expect(items.filter((i) => !i.title).length).toBe(6);
  });
});

describe('buildAxes3DGpuLabelInstances', () => {
  it('emits instanceCount > 0 for a known plan with full charset', () => {
    const atlas = makeAtlas('0123456789XYZ. -+eE');
    const items = buildAxes3DLabelItems(aabb, plan, baseAxes());
    const built = buildAxes3DGpuLabelInstances(items, {
      atlas,
      viewProj: identityViewProj(),
      viewportCssW: 800,
      viewportCssH: 600,
    });
    expect(built.labelCount).toBeGreaterThan(0);
    expect(built.instanceCount).toBeGreaterThan(0);
    expect(built.instances.length).toBe(built.instanceCount * AXES3D_GPU_LABEL_INSTANCE_FLOATS);
    // World positions finite
    for (let i = 0; i < built.instanceCount; i++) {
      const o = i * AXES3D_GPU_LABEL_INSTANCE_FLOATS;
      expect(Number.isFinite(built.instances[o]!)).toBe(true);
      expect(Number.isFinite(built.instances[o + 1]!)).toBe(true);
      expect(Number.isFinite(built.instances[o + 2]!)).toBe(true);
      // UV span non-empty
      expect(built.instances[o + 9]!).toBeGreaterThan(built.instances[o + 7]!);
      expect(built.instances[o + 10]!).toBeGreaterThan(built.instances[o + 8]!);
    }
  });

  it('returns 0 instances when all axes invisible', () => {
    const atlas = makeAtlas('0123456789XYZ');
    const items = buildAxes3DLabelItems(
      aabb,
      plan,
      baseAxes({
        x: { name: 'X', type: 'value', tickCount: 5, visible: false },
        y: { name: 'Y', type: 'value', tickCount: 5, visible: false },
        z: { name: 'Z', type: 'value', tickCount: 5, visible: false },
      })
    );
    expect(items.length).toBe(0);
    const built = buildAxes3DGpuLabelInstances(items, {
      atlas,
      viewProj: identityViewProj(),
      viewportCssW: 800,
      viewportCssH: 600,
    });
    expect(built.instanceCount).toBe(0);
    expect(built.labelCount).toBe(0);
  });

  it('substitutes ? and reports missing glyphs', () => {
    const atlas = makeAtlas('?AB'); // no Chinese
    const items = [{ x: 0, y: 0, z: 0, text: '你A', title: false }];
    const built = buildAxes3DGpuLabelInstances(items, {
      atlas,
      viewProj: identityViewProj(),
      viewportCssW: 400,
      viewportCssH: 300,
    });
    expect(built.missingChars).toContain('你');
    // '?' + 'A'
    expect(built.instanceCount).toBe(2);
  });

  it('clamps glyph count to maxGlyphs', () => {
    const atlas = makeAtlas('0123456789XYZ ');
    const items = buildAxes3DLabelItems(aabb, plan, baseAxes());
    const built = buildAxes3DGpuLabelInstances(items, {
      atlas,
      viewProj: identityViewProj(),
      viewportCssW: 800,
      viewportCssH: 600,
      maxGlyphs: 3,
    });
    expect(built.instanceCount).toBeLessThanOrEqual(3);
  });
});

describe('axes3DLabelPlanSignature', () => {
  it('is stable for camera-only changes (signature excludes viewProj)', () => {
    const a = axes3DLabelPlanSignature(aabb, plan, baseAxes(), 800, 600, 10, 12);
    const b = axes3DLabelPlanSignature(aabb, plan, baseAxes(), 800, 600, 10, 12);
    expect(a).toBe(b);
    const c = axes3DLabelPlanSignature(aabb, plan, baseAxes(), 801, 600, 10, 12);
    expect(c).not.toBe(a);
    const d = axes3DLabelPlanSignature(aabb, { ...plan, xTicks: [0, 2, 10] }, baseAxes(), 800, 600, 10, 12);
    expect(d).not.toBe(a);
  });
});

describe('shouldRebuildAxes3DGpuLabelInstances (camera-only gate)', () => {
  it('rebuilds on first prepare and when signature changes; sticky when same after prepare', () => {
    const sigA = axes3DLabelPlanSignature(aabb, plan, baseAxes(), 800, 600, 10, 12);
    const sigB = axes3DLabelPlanSignature(aabb, plan, baseAxes(), 801, 600, 10, 12);

    // Cold
    expect(shouldRebuildAxes3DGpuLabelInstances('', sigA, false)).toBe(true);

    // After first rebuild: same plan + different viewProj (sig unchanged) → no rebuild
    expect(shouldRebuildAxes3DGpuLabelInstances(sigA, sigA, true)).toBe(false);

    // Viewport / plan change → rebuild
    expect(shouldRebuildAxes3DGpuLabelInstances(sigA, sigB, true)).toBe(true);

    // Simulate camera-only prepare loop: rebuildCount stays 1
    let lastSig = '';
    let hasPrepared = false;
    let rebuildCount = 0;
    const prepareGate = (sig: string): void => {
      if (!shouldRebuildAxes3DGpuLabelInstances(lastSig, sig, hasPrepared)) return;
      lastSig = sig;
      rebuildCount++;
      hasPrepared = true;
    };
    prepareGate(sigA); // frame 1 geometry
    prepareGate(sigA); // orbit frame — uniforms only
    prepareGate(sigA); // orbit frame
    expect(rebuildCount).toBe(1);
    prepareGate(sigB); // resize
    expect(rebuildCount).toBe(2);
  });
});

describe('exclusiveAxes3DLabelPaint', () => {
  it('never enables both gpu and dom', () => {
    expect(exclusiveAxes3DLabelPaint('gpu')).toEqual({ gpu: true, dom: false });
    expect(exclusiveAxes3DLabelPaint('dom')).toEqual({ gpu: false, dom: true });
    // auto resolution already concrete before paint
    for (const mode of ['gpu', 'dom'] as const) {
      const p = exclusiveAxes3DLabelPaint(mode);
      expect(p.gpu && p.dom).toBe(false);
      expect(p.gpu || p.dom).toBe(true);
    }
  });
});

describe('formatAxes3DMissingGlyphsWarning', () => {
  it('formats missing glyphs and truncates long lists', () => {
    const msg = formatAxes3DMissingGlyphsWarning(['你', '好']);
    expect(msg).toContain('你');
    expect(msg).toContain("showing '?'");
    const many = Array.from({ length: 20 }, (_, i) => String.fromCharCode(0x4e00 + i));
    const long = formatAxes3DMissingGlyphsWarning(many);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('createAxes3DGpuLabelsRenderer atlas failure', () => {
  it('returns ready:false for atlas:null without touching device pipelines', () => {
    const device = {} as GPUDevice;
    const r = createAxes3DGpuLabelsRenderer(device, { atlas: null });
    expect(r.ready).toBe(false);
    expect(r.getInstanceCount()).toBe(0);
    expect(r.getInstanceRebuildCount()).toBe(0);
    // prepare/render are no-ops
    r.prepare(aabb, plan, baseAxes(), identityViewProj(), 800, 600, [1, 1, 1, 1]);
    r.render({} as GPURenderPassEncoder);
    r.dispose();
  });

  it('returns ready:false for empty glyph map', () => {
    const emptyAtlas: GlyphAtlas = {
      width: 4,
      height: 4,
      pixels: new Uint8ClampedArray(64),
      glyphs: new Map(),
      bakeFontPx: 32,
      lineHeightPx: 40,
      baselineFromTopPx: 28,
      charset: '',
      pixelScale: 2,
    };
    const r = createAxes3DGpuLabelsRenderer({} as GPUDevice, { atlas: emptyAtlas });
    expect(r.ready).toBe(false);
  });
});

describe('missing glyph warn-once contract', () => {
  it('build reports missingChars; format used for a single warn message', () => {
    const atlas = makeAtlas('?A');
    const items = [{ x: 0, y: 0, z: 0, text: '你A你', title: false }];
    const built = buildAxes3DGpuLabelInstances(items, {
      atlas,
      viewProj: identityViewProj(),
      viewportCssW: 400,
      viewportCssH: 300,
    });
    expect(built.missingChars).toEqual(['你']);
    // Caller enforces once: second format call is identical text but only first console.warn fires
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let missingWarned = false;
    const maybeWarn = (chars: readonly string[]): void => {
      if (chars.length > 0 && !missingWarned) {
        missingWarned = true;
        console.warn(formatAxes3DMissingGlyphsWarning(chars));
      }
    };
    maybeWarn(built.missingChars);
    maybeWarn(built.missingChars);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
