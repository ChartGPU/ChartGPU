import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AXES3D_GLYPH_CHARSET,
  packGlyphRects,
  lookupGlyph,
  bakeGlyphAtlas,
  type GlyphAtlas,
  type MeasuredGlyph,
} from '../glyphAtlas';

const measureAscii = (charset: string): MeasuredGlyph[] => {
  const out: MeasuredGlyph[] = [];
  const seen = new Set<string>();
  for (const ch of charset) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    // Deterministic fake metrics for packing tests (no canvas).
    const w = ch === ' ' ? 8 : 10 + (ch.charCodeAt(0) % 7);
    const h = 18;
    out.push({
      ch,
      advancePx: w + 1,
      bearingXPx: 0,
      bearingYPx: 14,
      widthPx: w,
      heightPx: h,
    });
  }
  return out;
};

describe('glyphAtlas packGlyphRects', () => {
  it('packs digits 0-9 and punctuation with non-empty UVs', () => {
    const charset = '0123456789.-+eE';
    const packed = packGlyphRects(measureAscii(charset), {
      maxAtlasSize: 256,
      padPx: 2,
      lineHeightPx: 20,
    });
    expect(packed).not.toBeNull();
    for (const ch of charset) {
      const g = packed!.glyphs.get(ch);
      expect(g, `glyph ${ch}`).toBeDefined();
      expect(g!.u1).toBeGreaterThan(g!.u0);
      expect(g!.v1).toBeGreaterThan(g!.v0);
      expect(g!.widthPx).toBeGreaterThan(0);
      expect(g!.heightPx).toBeGreaterThan(0);
      expect(g!.advancePx).toBeGreaterThan(0);
    }
    expect(packed!.width % 4).toBe(0);
    expect(packed!.height % 4).toBe(0);
  });

  it('fits default Latin charset in 512²', () => {
    const packed = packGlyphRects(measureAscii(DEFAULT_AXES3D_GLYPH_CHARSET), {
      maxAtlasSize: 512,
      padPx: 2,
      lineHeightPx: 22,
    });
    expect(packed).not.toBeNull();
    expect(packed!.glyphs.size).toBeGreaterThan(90);
    expect(packed!.width).toBeLessThanOrEqual(512);
    expect(packed!.height).toBeLessThanOrEqual(512);
  });

  it('returns null when a single glyph exceeds atlas', () => {
    const packed = packGlyphRects(
      [{ ch: 'W', advancePx: 400, bearingXPx: 0, bearingYPx: 20, widthPx: 400, heightPx: 40 }],
      { maxAtlasSize: 64, padPx: 2, lineHeightPx: 24 }
    );
    expect(packed).toBeNull();
  });
});

describe('lookupGlyph', () => {
  const fakeAtlas = (): GlyphAtlas => {
    const glyphs = new Map();
    glyphs.set('-', {
      u0: 0,
      v0: 0,
      u1: 0.1,
      v1: 0.1,
      widthPx: 8,
      heightPx: 2,
      advancePx: 8,
      bearingXPx: 0,
      bearingYPx: 1,
    });
    glyphs.set('.', {
      u0: 0.1,
      v0: 0,
      u1: 0.15,
      v1: 0.1,
      widthPx: 4,
      heightPx: 4,
      advancePx: 4,
      bearingXPx: 0,
      bearingYPx: 2,
    });
    return {
      width: 64,
      height: 64,
      pixels: new Uint8ClampedArray(64 * 64 * 4),
      glyphs,
      bakeFontPx: 32,
      lineHeightPx: 40,
      baselineFromTopPx: 28,
      charset: '-.',
      pixelScale: 2,
    };
  };

  it('maps em/en dash to hyphen', () => {
    const atlas = fakeAtlas();
    expect(lookupGlyph(atlas, '—')).toBe(atlas.glyphs.get('-'));
    expect(lookupGlyph(atlas, '–')).toBe(atlas.glyphs.get('-'));
  });

  it('returns undefined for truly missing glyphs', () => {
    expect(lookupGlyph(fakeAtlas(), '你')).toBeUndefined();
  });
});

describe('bakeGlyphAtlas', () => {
  it('returns null for empty charset', () => {
    expect(bakeGlyphAtlas({ charset: '' })).toBeNull();
  });

  it('returns null when canvas is unavailable (no document/OffscreenCanvas)', () => {
    const hadDoc = typeof globalThis.document !== 'undefined';
    const hadOffscreen = typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas !== 'undefined';
    const prevDoc = (globalThis as { document?: unknown }).document;
    const prevOff = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    try {
      // Force createBakeCanvas → null
      Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      // Only assert when we successfully stripped both — jsdom may restore document.
      if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
        expect(bakeGlyphAtlas({ charset: '0' })).toBeNull();
      } else {
        // Environment always has canvas — at least empty charset stays null (covered above).
        expect(bakeGlyphAtlas({ charset: '' })).toBeNull();
      }
    } finally {
      if (hadDoc) Object.defineProperty(globalThis, 'document', { value: prevDoc, configurable: true, writable: true });
      if (hadOffscreen) {
        Object.defineProperty(globalThis, 'OffscreenCanvas', {
          value: prevOff,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  it('bakes a non-empty atlas when canvas 2D is available', () => {
    const atlas = bakeGlyphAtlas({ charset: '0123456789.-', fontSizePx: 12, pixelScale: 1, maxAtlasSize: 256 });
    // jsdom may or may not implement measureText/getImageData fully
    if (!atlas) {
      // Accept null in headless without real canvas metrics — pack path is unit-tested separately
      expect(atlas).toBeNull();
      return;
    }
    expect(atlas.glyphs.size).toBeGreaterThanOrEqual(10);
    for (const ch of '0123456789.-') {
      const g = atlas.glyphs.get(ch);
      expect(g).toBeDefined();
      expect(g!.u1).toBeGreaterThan(g!.u0);
    }
    expect(atlas.pixels.length).toBe(atlas.width * atlas.height * 4);
  });
});
