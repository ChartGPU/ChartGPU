import { describe, it, expect } from 'vitest';
import { mapAnnotationAnchor, renderAnnotationTemplate, toCssRgba } from '../annotationLabelHelpers';

describe('annotationLabelHelpers', () => {
  describe('toCssRgba', () => {
    it('composes opacity into rgba string', () => {
      // #ff0000 with opacity 0.5 → rgba(255, 0, 0, 0.5)
      expect(toCssRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    });

    it('multiplies existing alpha from rgba color', () => {
      expect(toCssRgba('rgba(0, 128, 255, 0.5)', 0.5)).toBe('rgba(0, 128, 255, 0.25)');
    });

    it('falls back to black for unparsable color', () => {
      expect(toCssRgba('not-a-color', 1)).toBe('rgba(0, 0, 0, 1)');
    });
  });

  describe('mapAnnotationAnchor', () => {
    it('maps start/center/end to overlay anchors', () => {
      expect(mapAnnotationAnchor('start')).toBe('start');
      expect(mapAnnotationAnchor('center')).toBe('middle');
      expect(mapAnnotationAnchor('end')).toBe('end');
      expect(mapAnnotationAnchor(undefined)).toBe('start');
    });
  });

  describe('renderAnnotationTemplate', () => {
    it('substitutes x/y/value/name with optional decimals', () => {
      expect(
        renderAnnotationTemplate('Point {name}: ({x}, {y}) v={value}', {
          name: 'A',
          x: 1.2345,
          y: 2,
          value: 3.14159,
        }, 2)
      ).toBe('Point A: (1.23, 2.00) v=3.14');
    });

    it('replaces missing placeholders with empty string', () => {
      expect(renderAnnotationTemplate('{x}-{y}-{name}', {})).toBe('--');
    });
  });
});
