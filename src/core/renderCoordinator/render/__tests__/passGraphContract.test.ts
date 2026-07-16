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

  it('optionally draws dense hairline after main resolve (sampleCount 1 load-pass, not topOverlay)', () => {
    // Group 3 DoD: high-N line-list avoids 4× MSAA overdraw via post-resolve pass.
    // Must stay off the swapchain and must not reintroduce topOverlayPass.
    expect(coordinatorSrc).toMatch(/denseHairlinePass/);
    expect(coordinatorSrc).toMatch(/hasDenseHairlineLines/);
    expect(coordinatorSrc).toMatch(/renderDenseHairlineLines/);
    const mainEnd = coordinatorSrc.indexOf('mainPass.end()');
    const hair = coordinatorSrc.indexOf("label: 'renderCoordinator/denseHairlinePass'");
    const overlay = coordinatorSrc.indexOf("label: 'renderCoordinator/annotationOverlayMsaaPass'");
    expect(mainEnd).toBeGreaterThan(-1);
    expect(hair).toBeGreaterThan(mainEnd);
    expect(overlay).toBeGreaterThan(hair);
    // Load-pass on resolved main (not swapchain); no sampleCount: 2 anywhere in block.
    const hairBlock = coordinatorSrc.slice(hair, overlay);
    expect(hairBlock).toMatch(/mainResolveView/);
    expect(hairBlock).toMatch(/loadOp:\s*'load'/);
    expect(hairBlock).not.toMatch(/sampleCount:\s*2/);
    expect(hairBlock).not.toMatch(/swapchainView/);
  });

  it('renderSeries defers dense hairline out of main pass helpers', () => {
    // Multi-layer contract: main path uses .render(); hairline uses .renderHairline().
    expect(renderSeriesSrc).toMatch(/function hasDenseHairlineLines/);
    expect(renderSeriesSrc).toMatch(/function renderDenseHairlineLines/);
    expect(renderSeriesSrc).toMatch(/isDenseHairline\(\)/);
    expect(renderSeriesSrc).toMatch(/renderHairline\(/);
    // Main series loop still calls .render( for lines (defer is inside LineRenderer).
    // Optional chaining allowed (type-aware pools may leave holes in theory).
    expect(renderSeriesSrc).toMatch(/lineRenderers\[originalIndex\]\??\.render\(/);
  });

  it('multi-series hairline budget counts only visible line series', () => {
    // Regression: lineSeriesCount must filter visible !== false so hidden lines
    // do not push the total-segment budget into denseHairline.
    expect(renderSeriesSrc).toMatch(
      /type === 'line' && [\s\S]{0,40}visible !== false/
    );
    // Equal-N approximation comment / budget wiring still present.
    expect(renderSeriesSrc).toMatch(/lineSeriesCount/);
    expect(renderSeriesSrc).toMatch(/beginLineSharedVsFrame/);
  });

  it('creates axis/crosshair/highlight with chart MSAA sample count', () => {
    expect(ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT).toBe(4);
    // UI overlays share msaaSampleCount with main (4× default, or 1 when antialias:false).
    expect(coordinatorSrc).toMatch(/const msaaSampleCount:\s*1\s*\|\s*4/);
    expect(coordinatorSrc).toMatch(
      /createAxisRenderer\(device,\s*\{[^}]*sampleCount:\s*msaaSampleCount/s
    );
    expect(coordinatorSrc).toMatch(
      /createCrosshairRenderer\(device,\s*\{[^}]*sampleCount:\s*msaaSampleCount/s
    );
    expect(coordinatorSrc).toMatch(
      /createHighlightRenderer\(device,\s*\{[^}]*sampleCount:\s*msaaSampleCount/s
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

  it('skips DOM axis-label rebuild when signature is unchanged', () => {
    // Multi-chart / scatter fixed-domain: avoid clear+rebuild every frame.
    expect(coordinatorSrc).toMatch(/lastAxisLabelDomSignature/);
    expect(coordinatorSrc).toMatch(/labelSig !== lastAxisLabelDomSignature/);
    // Must still call renderAxisLabels when signature changes (rebuild path present).
    expect(coordinatorSrc).toMatch(/renderAxisLabels\(axisLabelOverlay/);
  });

  it('direct swapchain resolve path draws UI into main when no dense hairline', () => {
    // Multi-chart / compression / axes-only: single 4× MSAA main pass resolves
    // to swapchain (no blit + second MSAA target). Must still be sampleCount 4.
    expect(coordinatorSrc).toMatch(/useDirectSwapchainResolve/);
    expect(coordinatorSrc).toMatch(/mainPassDirect/);
    expect(coordinatorSrc).toMatch(/needResolveAndOverlay:\s*!useDirectSwapchainResolve/);
    // Direct path draws UI into mainPass (not only overlayPass).
    expect(coordinatorSrc).toMatch(/highlightRenderer\.render\(mainPass\)/);
    expect(coordinatorSrc).toMatch(/xAxisRenderer\.render\(mainPass\)/);
    expect(coordinatorSrc).toMatch(/crosshairRenderer\.render\(mainPass\)/);
    // Never legal sampleCount 2.
    expect(coordinatorSrc).not.toMatch(/sampleCount:\s*2/);
  });
});
