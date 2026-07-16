/**
 * WG-P1-5 / WG-P2-1 structural contracts: two render passes (no topOverlayPass),
 * UI overlays created at annotation MSAA sample count.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT } from '../../gpu/textureManager';

const coordinatorPath = resolve(__dirname, '../../../createRenderCoordinator.ts');
const overlaysPath = resolve(__dirname, '../renderOverlays.ts');
const renderSeriesPath = resolve(__dirname, '../renderSeries.ts');

describe('frame graph contracts (WG-P1-5 / WG-P2-1)', () => {
  const coordinatorSrc = readFileSync(coordinatorPath, 'utf8');
  const overlaysSrc = readFileSync(overlaysPath, 'utf8');
  const renderSeriesSrc = readFileSync(renderSeriesPath, 'utf8');

  it('does not open a third topOverlayPass on the swapchain', () => {
    expect(coordinatorSrc).not.toMatch(/topOverlayPass/);
    expect(overlaysSrc).not.toMatch(/topOverlayPass/);
  });

  it('creates axis/crosshair/highlight with annotation MSAA sample count', () => {
    expect(ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT).toBe(4);
    // Each of the three UI overlay creators must pass sampleCount: ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT
    expect(coordinatorSrc).toMatch(
      /createAxisRenderer\(device,\s*\{[^}]*sampleCount:\s*ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT/s
    );
    expect(coordinatorSrc).toMatch(
      /createCrosshairRenderer\(device,\s*\{[^}]*sampleCount:\s*ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT/s
    );
    expect(coordinatorSrc).toMatch(
      /createHighlightRenderer\(device,\s*\{[^}]*sampleCount:\s*ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT/s
    );
  });

  it('creates main + overlay annotation renderers when MSAA sample counts differ', () => {
    // Main and overlay both 4× (WebGPU sampleCount 1|4 only). Layer-only prepare keeps separate instances.
    const refCreates = (coordinatorSrc.match(/createReferenceLineRenderer\(/g) ?? []).length;
    const markerCreates = (coordinatorSrc.match(/createAnnotationMarkerRenderer\(/g) ?? []).length;
    expect(refCreates).toBe(2);
    expect(markerCreates).toBe(2);
    expect(coordinatorSrc).toMatch(/referenceLineRendererMsaa\s*=\s*createReferenceLineRenderer/);
    expect(coordinatorSrc).toMatch(/annotationMarkerRendererMsaa\s*=\s*createAnnotationMarkerRenderer/);
  });

  it('prepares and disposes both main and Msaa annotation instances', () => {
    // Prepare: main + msaa for both reference lines and markers (cartesian + empty branches).
    expect(coordinatorSrc).toMatch(/referenceLineRenderer\.prepare\(/);
    expect(coordinatorSrc).toMatch(/referenceLineRendererMsaa\.prepare\(/);
    expect(coordinatorSrc).toMatch(/annotationMarkerRenderer\.prepare\(/);
    expect(coordinatorSrc).toMatch(/annotationMarkerRendererMsaa\.prepare\(/);
    // Dispose both (no alias — each must be destroyed).
    expect(coordinatorSrc).toMatch(/referenceLineRenderer\.dispose\(/);
    expect(coordinatorSrc).toMatch(/referenceLineRendererMsaa\.dispose\(/);
    expect(coordinatorSrc).toMatch(/annotationMarkerRenderer\.dispose\(/);
    expect(coordinatorSrc).toMatch(/annotationMarkerRendererMsaa\.dispose\(/);
  });

  it('prepares layer-only annotation instances (below→main, above→overlay)', () => {
    // Layer-only prepare: main gets linesBelow/markersBelow; MSAA gets linesAbove/markersAbove.
    // Must not reintroduce combined-list prepare with below+above offsets.
    expect(coordinatorSrc).toMatch(
      /referenceLineRenderer\.prepare\(\s*gridArea,\s*annotationResult\.linesBelow\s*\)/
    );
    expect(coordinatorSrc).toMatch(
      /referenceLineRendererMsaa\.prepare\(\s*gridArea,\s*annotationResult\.linesAbove\s*\)/
    );
    expect(coordinatorSrc).toMatch(/instances:\s*annotationResult\.markersBelow/);
    expect(coordinatorSrc).toMatch(/instances:\s*annotationResult\.markersAbove/);
    // No combined below+above list for prepare.
    expect(coordinatorSrc).not.toMatch(/combinedReferenceLines/);
    expect(coordinatorSrc).not.toMatch(/combinedMarkers/);
  });

  it('renders above-series annotations from start 0 with aboveCount (not below offset)', () => {
    // Layer-only prepare means MSAA render starts at 0, not referenceLineBelowCount.
    expect(renderSeriesSrc).toMatch(
      /referenceLineRendererMsaa\.render\(\s*overlayPass,\s*0,\s*referenceLineAboveCount\s*\)/
    );
    expect(renderSeriesSrc).toMatch(
      /annotationMarkerRendererMsaa\.render\(\s*overlayPass,\s*0,\s*markerAboveCount\s*\)/
    );
    expect(renderSeriesSrc).not.toMatch(/firstLine\s*=\s*referenceLineBelowCount/);
    expect(renderSeriesSrc).not.toMatch(/firstMarker\s*=\s*markerBelowCount/);
  });

  it('draws UI overlays into the annotation overlay pass before it ends', () => {
    // Source uses single-quoted string literals.
    const overlayBegin = coordinatorSrc.indexOf("label: 'renderCoordinator/annotationOverlayMsaaPass'");
    const overlayEnd = coordinatorSrc.indexOf('overlayPass.end()');
    expect(overlayBegin).toBeGreaterThan(-1);
    expect(overlayEnd).toBeGreaterThan(overlayBegin);
    const overlayBlock = coordinatorSrc.slice(overlayBegin, overlayEnd);
    expect(overlayBlock).toMatch(/highlightRenderer\.render\(overlayPass\)/);
    expect(overlayBlock).toMatch(/xAxisRenderer\.render\(overlayPass\)/);
    expect(overlayBlock).toMatch(/crosshairRenderer\.render\(overlayPass\)/);
  });
});
