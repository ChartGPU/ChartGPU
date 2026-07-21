/**
 * Canvas-baked glyph atlas for 3D axis labels (ticks + titles).
 * Pure metrics packing is unit-testable; bake uses OffscreenCanvas / canvas2D.
 */

export type GlyphMetrics = Readonly<{
  /** Atlas UV [0,1], top-left origin matching canvas. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Glyph bitmap size in atlas pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Horizontal advance in atlas pixels (for layout). */
  readonly advancePx: number;
  /** Left bearing from pen position (atlas px). */
  readonly bearingXPx: number;
  /** Top of bitmap relative to baseline (positive up, atlas px). */
  readonly bearingYPx: number;
}>;

export type GlyphAtlas = Readonly<{
  readonly width: number;
  readonly height: number;
  /** RGBA8 row-major. */
  readonly pixels: Uint8ClampedArray;
  readonly glyphs: ReadonlyMap<string, GlyphMetrics>;
  /** Font size used when baking (CSS px * pixelScale). */
  readonly bakeFontPx: number;
  readonly lineHeightPx: number;
  /** Baseline from top of cell row (atlas px). */
  readonly baselineFromTopPx: number;
  readonly charset: string;
  readonly pixelScale: number;
}>;

export type BakeGlyphAtlasOptions = Readonly<{
  /** Characters to pack (duplicates ignored). Default: ASCII printable + common units. */
  readonly charset?: string;
  /** Reference CSS font size before pixelScale. Default 16. */
  readonly fontSizePx?: number;
  /** Supersample factor when baking. Default 2. */
  readonly pixelScale?: number;
  readonly fontFamily?: string;
  readonly fontWeight?: string | number;
  /** Atlas max edge (power-of-two preferred). Default 512. */
  readonly maxAtlasSize?: number;
  /** Padding around each glyph. Default 2. */
  readonly padPx?: number;
}>;

/** Latin printable + units / scientific notation punctuation used by axis ticks & titles. */
export const DEFAULT_AXES3D_GLYPH_CHARSET =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~°±µ—–…·';

export type MeasuredGlyph = Readonly<{
  readonly ch: string;
  readonly advancePx: number;
  readonly bearingXPx: number;
  readonly bearingYPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}>;

/**
 * Pack measured glyphs into atlas rects (shelf packing). Pure — no canvas.
 * Returns null if they cannot fit in maxAtlasSize².
 */
export function packGlyphRects(
  measured: readonly MeasuredGlyph[],
  options: Readonly<{
    readonly maxAtlasSize: number;
    readonly padPx: number;
    readonly lineHeightPx: number;
  }>
): {
  readonly width: number;
  readonly height: number;
  readonly glyphs: Map<string, GlyphMetrics>;
  readonly placements: ReadonlyArray<
    Readonly<{ ch: string; x: number; y: number; w: number; h: number; m: MeasuredGlyph }>
  >;
} | null {
  const maxSize = Math.max(64, Math.min(4096, Math.floor(options.maxAtlasSize) || 512));
  const pad = Math.max(0, Math.floor(options.padPx));
  const rowH = Math.max(1, Math.ceil(options.lineHeightPx) + pad * 2);

  let x = pad;
  let y = pad;
  let rowMaxH = rowH;
  let maxX = pad;
  let maxY = pad;

  const placements: Array<{ ch: string; x: number; y: number; w: number; h: number; m: MeasuredGlyph }> = [];
  const seen = new Set<string>();

  for (const m of measured) {
    if (!m.ch || seen.has(m.ch)) continue;
    seen.add(m.ch);
    const w = Math.max(1, Math.ceil(m.widthPx) + pad * 2);
    const h = Math.max(1, Math.ceil(m.heightPx) + pad * 2);
    if (w > maxSize - pad * 2 || h > maxSize - pad * 2) return null;

    if (x + w + pad > maxSize) {
      x = pad;
      y += rowMaxH;
      rowMaxH = rowH;
    }
    if (y + h + pad > maxSize) return null;

    placements.push({ ch: m.ch, x, y, w, h, m });
    maxX = Math.max(maxX, x + w + pad);
    maxY = Math.max(maxY, y + h + pad);
    rowMaxH = Math.max(rowMaxH, h);
    x += w;
  }

  // Snap atlas dims up to multiple of 4 for WebGPU writeBuffer-friendly rows;
  // bytesPerRow alignment is handled separately (256 for copy), texture size itself is fine.
  const width = Math.min(maxSize, Math.max(4, Math.ceil(maxX / 4) * 4));
  const height = Math.min(maxSize, Math.max(4, Math.ceil(maxY / 4) * 4));
  if (width > maxSize || height > maxSize) return null;

  const glyphs = new Map<string, GlyphMetrics>();
  for (const p of placements) {
    // Inner glyph bitmap without pad, for UV + layout.
    const gx = p.x + pad;
    const gy = p.y + pad;
    const gw = Math.max(1, Math.ceil(p.m.widthPx));
    const gh = Math.max(1, Math.ceil(p.m.heightPx));
    glyphs.set(p.ch, {
      u0: gx / width,
      v0: gy / height,
      u1: (gx + gw) / width,
      v1: (gy + gh) / height,
      widthPx: gw,
      heightPx: gh,
      advancePx: p.m.advancePx,
      bearingXPx: p.m.bearingXPx,
      bearingYPx: p.m.bearingYPx,
    });
  }

  return { width, height, glyphs, placements };
}

type CanvasLike = {
  width: number;
  height: number;
  getContext(type: '2d', attrs?: { willReadFrequently?: boolean }): CanvasRenderingContext2D | null;
};

const createBakeCanvas = (w: number, h: number): CanvasLike | null => {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(w, h) as unknown as CanvasLike;
    } catch {
      // fall through
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
};

/**
 * Measure + bake a white-on-transparent RGBA atlas.
 * Returns null when canvas 2D is unavailable or packing fails.
 */
export function bakeGlyphAtlas(options?: BakeGlyphAtlasOptions): GlyphAtlas | null {
  const fontSizeCss = typeof options?.fontSizePx === 'number' && options.fontSizePx > 0 ? options.fontSizePx : 16;
  const pixelScale =
    typeof options?.pixelScale === 'number' && options.pixelScale > 0 ? Math.min(4, options.pixelScale) : 2;
  const bakeFontPx = fontSizeCss * pixelScale;
  const fontFamily =
    options?.fontFamily ?? 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fontWeight = options?.fontWeight ?? '400';
  const maxAtlasSize = options?.maxAtlasSize ?? 512;
  const padPx = options?.padPx ?? 2;
  const charset = options?.charset ?? DEFAULT_AXES3D_GLYPH_CHARSET;

  // Unique chars, preserve order
  const chars: string[] = [];
  const seen = new Set<string>();
  for (const ch of charset) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    chars.push(ch);
  }
  if (chars.length === 0) return null;

  // Probe canvas for metrics (1×1 is enough; measureText does not need large surface).
  const probe = createBakeCanvas(4, 4);
  if (!probe) return null;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  if (!pctx) return null;
  pctx.font = `${fontWeight} ${bakeFontPx}px ${fontFamily}`;
  pctx.textBaseline = 'alphabetic';
  pctx.textAlign = 'left';

  const lineHeightPx = Math.ceil(bakeFontPx * 1.35);
  const baselineFromTopPx = Math.ceil(bakeFontPx * 1.05);

  const measured: MeasuredGlyph[] = [];
  for (const ch of chars) {
    const tm = pctx.measureText(ch);
    const advance = tm.width;
    // Prefer actualBoundingBox when available for tight UVs.
    const left = tm.actualBoundingBoxLeft ?? 0;
    const right = tm.actualBoundingBoxRight ?? advance;
    const ascent = tm.actualBoundingBoxAscent ?? bakeFontPx * 0.8;
    const descent = tm.actualBoundingBoxDescent ?? bakeFontPx * 0.2;
    const widthPx = Math.max(1, Math.ceil(left + right + 1));
    const heightPx = Math.max(1, Math.ceil(ascent + descent + 1));
    measured.push({
      ch,
      advancePx: advance,
      bearingXPx: -left,
      bearingYPx: ascent,
      widthPx,
      heightPx,
    });
  }

  const packed = packGlyphRects(measured, { maxAtlasSize, padPx, lineHeightPx });
  if (!packed) return null;

  const canvas = createBakeCanvas(packed.width, packed.height);
  if (!canvas) return null;
  canvas.width = packed.width;
  canvas.height = packed.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, packed.width, packed.height);
  ctx.font = `${fontWeight} ${bakeFontPx}px ${fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  // Soft edge: no stroke; linear sampling provides AA from supersample.

  for (const p of packed.placements) {
    const penX = p.x + padPx + p.m.bearingXPx;
    const penY = p.y + padPx + p.m.bearingYPx;
    ctx.fillText(p.ch, penX, penY);
  }

  let pixels: Uint8ClampedArray;
  if (typeof (ctx as CanvasRenderingContext2D).getImageData === 'function') {
    const img = (ctx as CanvasRenderingContext2D).getImageData(0, 0, packed.width, packed.height);
    pixels = img.data;
  } else {
    // OffscreenCanvas in some environments
    const img = (
      ctx as unknown as { getImageData: (x: number, y: number, w: number, h: number) => ImageData }
    ).getImageData(0, 0, packed.width, packed.height);
    pixels = img.data;
  }

  return {
    width: packed.width,
    height: packed.height,
    pixels,
    glyphs: packed.glyphs,
    bakeFontPx,
    lineHeightPx,
    baselineFromTopPx,
    charset: chars.join(''),
    pixelScale,
  };
}

/**
 * Look up a glyph; maps common missing substitutes.
 * Returns undefined when truly absent (caller may warn + skip).
 */
export function lookupGlyph(atlas: GlyphAtlas, ch: string): GlyphMetrics | undefined {
  const direct = atlas.glyphs.get(ch);
  if (direct) return direct;
  // Em/en dash → hyphen
  if (ch === '—' || ch === '–') return atlas.glyphs.get('-');
  if (ch === '…') {
    // no multi-glyph expand here
    return atlas.glyphs.get('.');
  }
  return undefined;
}
