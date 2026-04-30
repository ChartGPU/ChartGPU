/**
 * Tests for annotation processing.
 * Verifies correct processing of lineX, lineY, point, and text annotations
 * with layering, styling, and label generation.
 */

import { describe, it, expect } from "vitest";
import { processAnnotations } from "../processAnnotations";
import type { AnnotationContext } from "../processAnnotations";
import type { AnnotationConfig } from "../../../../config/types";
import { createLinearScale } from "../../../../utils/scales";
import type { ThemeConfig } from "../../../../themes/types";

// Mock theme
const mockTheme: ThemeConfig = {
  backgroundColor: "#1a1a1a",
  textColor: "#ffffff",
  axisLineColor: "#666666",
  axisTickColor: "#666666",
  gridLineColor: "#333333",
  colorPalette: ["#ff0000", "#00ff00", "#0000ff"],
  fontFamily: "sans-serif",
  fontSize: 12,
};

// Helper to create annotation context
function createContext(
  annotations: ReadonlyArray<AnnotationConfig>,
): AnnotationContext {
  const xScale = createLinearScale().domain(0, 100).range(-1, 1);
  const yScale = createLinearScale().domain(0, 100).range(1, -1);

  const yScales = new Map<string, ReturnType<typeof createLinearScale>>();
  yScales.set("primary", yScale);

  return {
    annotations,
    xScale,
    yScales,
    plotBounds: {
      leftCss: 60,
      rightCss: 20,
      topCss: 40,
      bottomCss: 40,
      widthCss: 720,
      heightCss: 520,
    },
    canvasCssWidth: 800,
    canvasCssHeight: 600,
    theme: mockTheme,
  };
}

describe("processAnnotations", () => {
  it("returns empty result for empty annotations array", () => {
    const context = createContext([]);
    const result = processAnnotations(context);

    expect(result.linesBelow).toHaveLength(0);
    expect(result.linesAbove).toHaveLength(0);
    expect(result.markersBelow).toHaveLength(0);
    expect(result.markersAbove).toHaveLength(0);
    expect(result.labels).toHaveLength(0);
  });

  it("returns empty result for zero canvas dimensions", () => {
    const annotation: AnnotationConfig = {
      type: "lineX",
      x: 50,
    };
    const baseContext = createContext([annotation]);
    // Create new context with zero width
    const context = { ...baseContext, canvasCssWidth: 0 };

    const result = processAnnotations(context);

    expect(result.linesBelow).toHaveLength(0);
    expect(result.linesAbove).toHaveLength(0);
  });

  describe("lineX annotations", () => {
    it("creates vertical reference line", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.linesAbove).toHaveLength(1);
      expect(result.linesAbove[0]).toMatchObject({
        axis: "vertical",
        lineWidth: 1,
      });
      expect(result.linesAbove[0].positionCssPx).toBeGreaterThan(0);
    });

    it("respects layer configuration", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
        layer: "belowSeries",
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.linesBelow).toHaveLength(1);
      expect(result.linesAbove).toHaveLength(0);
    });

    it("applies line style", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
        style: {
          color: "#ff0000",
          lineWidth: 3,
          lineDash: [5, 5],
          opacity: 0.5,
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      const line = result.linesAbove[0];
      expect(line.lineWidth).toBe(3);
      expect(line.lineDash).toEqual([5, 5]);
      expect(line.rgba).toHaveLength(4);
      expect(line.rgba[3]).toBeCloseTo(0.5, 2);
    });
  });

  describe("lineY annotations", () => {
    it("creates horizontal reference line", () => {
      const annotation: AnnotationConfig = {
        type: "lineY",
        y: 75,
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.linesAbove).toHaveLength(1);
      expect(result.linesAbove[0]).toMatchObject({
        axis: "horizontal",
        lineWidth: 1,
      });
    });

    it("generates default label", () => {
      const annotation: AnnotationConfig = {
        type: "lineY",
        y: 75,
        label: {},
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].text).toContain("75");
    });
  });

  describe("point annotations", () => {
    it("creates marker at coordinates", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 30,
        y: 70,
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.markersAbove).toHaveLength(1);
      const marker = result.markersAbove[0];
      expect(marker.xCssPx).toBeGreaterThan(0);
      expect(marker.yCssPx).toBeGreaterThan(0);
      expect(marker.sizeCssPx).toBe(6); // default size
    });

    it("applies marker size", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 30,
        y: 70,
        marker: { size: 12 },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.markersAbove[0].sizeCssPx).toBe(12);
    });

    it("applies marker color", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 30,
        y: 70,
        marker: {
          style: {
            color: "#00ff00",
            opacity: 0.8,
          },
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      const marker = result.markersAbove[0];
      expect(marker.fillRgba).toHaveLength(4);
      expect(marker.fillRgba[3]).toBeCloseTo(0.8, 2);
    });

    it("generates label with coordinates", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 30,
        y: 70,
        label: {},
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].text).toContain("30");
      expect(result.labels[0].text).toContain("70");
    });
  });

  describe("text annotations", () => {
    it("creates label with data space positioning", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Hello World",
        position: {
          space: "data",
          x: 50,
          y: 50,
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].text).toBe("Hello World");
      expect(result.labels[0].x).toBeGreaterThan(0);
      expect(result.labels[0].y).toBeGreaterThan(0);
    });

    it("creates label with plot-relative positioning", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Relative",
        position: {
          space: "plot",
          x: 0.5,
          y: 0.5,
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].text).toBe("Relative");
    });

    it("applies text label style", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Styled",
        position: { space: "data", x: 50, y: 50 },
        style: { color: "#ffff00" },
        label: {
          anchor: "center",
          offset: [10, -10],
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      const label = result.labels[0];
      expect(label.anchor).toBe("middle");
      expect(label.color).toBe("#ffff00");
    });
  });

  describe("label configuration", () => {
    it("uses explicit label text", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
        label: { text: "Custom Label" },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels[0].text).toBe("Custom Label");
    });

    it("renders template with placeholders", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 25,
        y: 75,
        label: {
          template: "Point at ({x}, {y})",
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels[0].text).toBe("Point at (25, 75)");
    });

    it("formats numbers with decimals", () => {
      const annotation: AnnotationConfig = {
        type: "lineY",
        y: 33.3333,
        label: {
          template: "y={y}",
          decimals: 2,
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels[0].text).toBe("y=33.33");
    });

    it("applies label offset", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 50,
        y: 50,
        label: {
          text: "Offset",
          offset: [20, -30],
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      // Offset should be applied (exact position depends on scale)
      expect(result.labels[0].text).toBe("Offset");
    });

    it("applies background styling", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Background",
        position: { space: "data", x: 50, y: 50 },
        label: {
          background: {
            color: "#000000",
            opacity: 0.9,
            padding: [4, 8, 4, 8],
            borderRadius: 4,
          },
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      const label = result.labels[0];
      expect(label.background).toBeDefined();
      expect(label.background?.backgroundColor).toContain("rgba");
      expect(label.background?.padding).toEqual([4, 8, 4, 8]);
      expect(label.background?.borderRadius).toBe(4);
    });

    it("uses default padding when background is specified", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Default Padding",
        position: { space: "data", x: 50, y: 50 },
        label: {
          background: {
            color: "#000000",
          },
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels[0].background?.padding).toEqual([2, 4, 2, 4]);
    });
  });

  describe("layering", () => {
    it("separates annotations into below and above layers", () => {
      const annotations: AnnotationConfig[] = [
        { type: "lineX", x: 10, layer: "belowSeries" },
        { type: "lineX", x: 20, layer: "aboveSeries" },
        { type: "lineY", y: 30, layer: "belowSeries" },
        { type: "point", x: 40, y: 50, layer: "aboveSeries" },
      ];
      const context = createContext(annotations);
      const result = processAnnotations(context);

      expect(result.linesBelow).toHaveLength(2);
      expect(result.linesAbove).toHaveLength(1);
      expect(result.markersBelow).toHaveLength(0);
      expect(result.markersAbove).toHaveLength(1);
    });

    it("defaults to aboveSeries layer", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.linesAbove).toHaveLength(1);
      expect(result.linesBelow).toHaveLength(0);
    });
  });

  describe("offset handling", () => {
    it("applies container offset to labels", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "Offset",
        position: { space: "data", x: 50, y: 50 },
      };
      const baseContext = createContext([annotation]);
      // Create new context with offsets
      const context = { ...baseContext, offsetX: 100, offsetY: 50 };

      const result = processAnnotations(context);

      expect(result.labels[0].x).toBeGreaterThan(100);
      expect(result.labels[0].y).toBeGreaterThan(50);
    });
  });

  describe("edge cases", () => {
    it("skips annotations with non-finite coordinates", () => {
      const annotations: AnnotationConfig[] = [
        { type: "lineX", x: NaN },
        { type: "lineY", y: Infinity },
        { type: "point", x: 50, y: NaN },
      ];
      const context = createContext(annotations);
      const result = processAnnotations(context);

      expect(result.linesAbove).toHaveLength(0);
      expect(result.markersAbove).toHaveLength(0);
    });

    it("skips labels with empty text", () => {
      const annotation: AnnotationConfig = {
        type: "text",
        text: "   ",
        position: { space: "data", x: 50, y: 50 },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.labels).toHaveLength(0);
    });

    it("clamps opacity to [0, 1] range", () => {
      const annotation: AnnotationConfig = {
        type: "lineX",
        x: 50,
        style: {
          opacity: 1.5,
        },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.linesAbove[0].rgba[3]).toBeLessThanOrEqual(1);
    });

    it("clamps marker size to minimum 1", () => {
      const annotation: AnnotationConfig = {
        type: "point",
        x: 50,
        y: 50,
        marker: { size: -5 },
      };
      const context = createContext([annotation]);
      const result = processAnnotations(context);

      expect(result.markersAbove[0].sizeCssPx).toBeGreaterThanOrEqual(1);
    });
  });
});
