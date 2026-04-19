# Phase 4 WebGPU Correctness Audit

Audit of the Phase 4 implementation (render bundles for grid/axes + collapsed 3→2 render passes with MSAA promotion) against the WebGPU spec and the webgpufundamentals lessons, fetched via `nia`.

## Sources

- **WebGPU Spec (gpuweb)** — `https://gpuweb.github.io/gpuweb/` (fetched via `npx nia-docs`)
- **Multisampling lesson** — `https://webgpufundamentals.org/webgpu/lessons/webgpu-multisampling.html`
- **Bind-group-layouts lesson (dynamic offsets)** — `https://webgpufundamentals.org/webgpu/lessons/webgpu-bind-group-layouts.html`
- **Optimization lesson (render bundles)** — `https://webgpufundamentals.org/webgpu/lessons/webgpu-optimization.html` §"Render Bundles"

## Scope


| Task | Summary                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4a   | `GPURenderBundle` caching in `createGridRenderer.ts` and `createAxisRenderer.ts`; per-coordinator `OverlayPrepareMemo` in `renderOverlays.ts`; grid uses a single fs uniform with `hasDynamicOffset: true` at 256-byte-aligned slots (`ensureFsUniformCapacity`). |
| 4b   | 3 passes → 2. Axis/crosshair/highlight pipelines promoted to `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT = 4` and now draw into `overlayPass`. Overlay pass uses `loadOp: "clear"`, `storeOp: "discard"` with `resolveTarget: swapchainView`.                           |


Severity legend: **Blocker** (spec-violation / UB), **Major** (correctness bug under realistic conditions), **Minor** (spec-compliant but fragile or wasteful), **Info** (verified correct, recorded for traceability).

## Findings

### 1. Render-bundle vs render-pass layout compatibility — Verified

**Spec requirement** (gpuweb §17.1.1.4 "Render Pass Layout", §17.2.4 "Bundles"): A render pass and a render bundle are compatible when their `GPURenderPassLayout` values match — `colorFormats` (ignoring trailing `null`s), `depthStencilFormat`, and `sampleCount` all equal. For a pass, `sampleCount` is derived from `colorAttachment.view.[[texture]].sampleCount`, and `colorFormats` from `colorAttachment.view.[[descriptor]].format`. Critically, `**sampleCount` is taken from the MSAA `view`, not from the `resolveTarget`**.

**Implementation**:

- Main pass attachment ([src/core/createRenderCoordinator.ts:4176-4187](../../src/core/createRenderCoordinator.ts)): `view = mainColorView` (sampleCount 4, format `targetFormat`), `resolveTarget = mainResolveView` (sampleCount 1, format `targetFormat`).
- Overlay pass attachment ([src/core/createRenderCoordinator.ts:4227-4238](../../src/core/createRenderCoordinator.ts)): `view = overlayMsaaView` (sampleCount 4, format `targetFormat`), `resolveTarget = swapchainView` (sampleCount 1, format `targetFormat`).
- Grid bundle encoder ([src/renderers/createGridRenderer.ts:488-492](../../src/renderers/createGridRenderer.ts)): `colorFormats: [targetFormat]`, `sampleCount: sampleCount` where `sampleCount = MAIN_SCENE_MSAA_SAMPLE_COUNT = 4` ([src/core/createRenderCoordinator.ts:1823-1827](../../src/core/createRenderCoordinator.ts)).
- Axis bundle encoder ([src/renderers/createAxisRenderer.ts:452-456](../../src/renderers/createAxisRenderer.ts)): `colorFormats: [targetFormat]`, `sampleCount: sampleCount` where `sampleCount = ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT = 4` ([src/core/createRenderCoordinator.ts:1831-1839](../../src/core/createRenderCoordinator.ts)).

Grid executes in the main pass (both 4×MSAA, same format). Axes execute in the overlay pass (both 4×MSAA, same format). Neither pass has a depth-stencil attachment, so both the pass-derived and bundle-declared `depthStencilFormat` are absent → layouts match.

**Verdict**: **Correct**.

### 2. `executeBundles` state-leak safety — Verified

**Spec requirement** (gpuweb §17.2.4): "After a `GPURenderBundle` has executed, the render pass's pipeline, bind group, and vertex/index buffer state is cleared (to the initial, empty values). … This occurs even if zero `GPURenderBundles` are executed." (See also "Reset the render pass binding state" steps.)

Consequence: any draw that runs **after** `executeBundles(...)` must explicitly re-set pipeline / bind groups / vertex+index buffers. It may **not** inherit them from a prior encoder call.

**Implementation — main pass order** ([src/core/createRenderCoordinator.ts:4198-4222](../../src/core/createRenderCoordinator.ts)):

1. `gridRenderer.render(mainPass)` → `executeBundles([bundle])` → clears state.
2. `renderSeriesPass(...)` → every series renderer (`createLineRenderer.ts`, `createAreaRenderer.ts`, `createScatterRenderer.ts`, `createBarRenderer.ts`, `createCandlestickRenderer.ts`, `createPieRenderer.ts`, `createScatterDensityRenderer.ts`) re-sets its own pipeline, bind group, and vertex buffer inside `render()` — confirmed by grep for `setPipeline|setBindGroup|setVertexBuffer` across `src/renderers/`.

**Implementation — overlay pass order** ([src/core/createRenderCoordinator.ts:4227-4272](../../src/core/createRenderCoordinator.ts)):

1. Blit: `overlayPass.setPipeline(texState.overlayBlitPipeline); overlayPass.setBindGroup(0, ...); overlayPass.draw(3);`
2. `renderAboveSeriesAnnotations(...)` — sets its own pipelines.
3. `highlightRenderer.render(overlayPass)` — sets pipeline + bindgroup ([src/renderers/createHighlightRenderer.ts:277-278](../../src/renderers/createHighlightRenderer.ts)).
4. `xAxisRenderer.render(overlayPass)` → `executeBundles` → **clears state**.
5. `yAxisRenderer.render(overlayPass)` → `executeBundles` → **clears state** (but axis bundles are self-contained, see §3).
6. `crosshairRenderer.render(overlayPass)` — sets pipeline + bindgroup + vertex buffer ([src/renderers/createCrosshairRenderer.ts:521-523](../../src/renderers/createCrosshairRenderer.ts)).

Every draw after an `executeBundles` call re-sets the state it needs. No leakage.

**Verdict**: **Correct**.

### 3. Bundle self-containment — Verified

**Spec requirement** (gpuweb §17.2.4): "When a `GPURenderBundle` is executed, it does not inherit the render pass's pipeline, bind groups, or vertex and index buffers."

**Implementation**:

- Grid `encodeDraws` ([src/renderers/createGridRenderer.ts:469-478](../../src/renderers/createGridRenderer.ts)): sets pipeline → per-batch `setBindGroup(0, bindGroup, [batch.fsDynamicOffset])` → `setVertexBuffer(0, vertexBuffer, batch.vertexOffsetBytes)` → `draw(...)`. Self-contained.
- Axis `encodeDraws` ([src/renderers/createAxisRenderer.ts:430-445](../../src/renderers/createAxisRenderer.ts)): sets pipeline → `setVertexBuffer(0, vertexBuffer)` → `setBindGroup(0, bindGroupLine)` → `draw(2)` → `setBindGroup(0, bindGroupTick)` → `draw(count-2, 1, 2, 0)`. Self-contained.

**Verdict**: **Correct**.

### 4. Viewport/scissor inheritance through bundles — Verified

**Spec requirement** (gpuweb §17.1 `GPURenderPassEncoder` IDL, §17.2 `GPURenderCommandsMixin` IDL): `setViewport`, `setScissorRect`, `setBlendConstant`, `setStencilReference`, and occlusion-query commands exist **only on `GPURenderPassEncoder`**, not on `GPURenderBundleEncoder` (which only includes `GPURenderCommandsMixin` + `GPUBindingCommandsMixin`). These pass-level states are **inherited** by executing bundles (they are not reset by `executeBundles`) — only pipeline/bindgroups/vertex+index buffers are reset.

**Implementation**:

- Grid runs **first** in the main pass, before any scissor is set ([src/core/createRenderCoordinator.ts:4198-4200](../../src/core/createRenderCoordinator.ts)). Default scissor = full attachment extent. ✓
- Axes run in the overlay pass **after** `renderAboveSeriesAnnotations`, which always resets the scissor back to `(0, 0, canvasWidth, canvasHeight)` at its final step ([src/core/renderCoordinator/render/renderSeries.ts:683-688](../../src/core/renderCoordinator/render/renderSeries.ts)). ✓
- Neither renderer's bundle attempts to call `setScissorRect`/`setViewport` (which would be a compile-time error — the methods do not exist on `GPURenderBundleEncoder`).

**Verdict**: **Correct**.

### 5. Bundle lifetime vs. destroyed GPU resources — Verified (fragile)

**Spec requirement** (gpuweb §17.2.4 and bundle finish steps): The bundle's `[[command_list]]` holds captured references to the bind groups, buffers, and pipelines that were set at encode time. If any of those resources are `destroy()`-ed before `executeBundles` runs, the bundle references invalid resources and becomes invalid.

**Implementation — grid**:

- `prepare()` nulls `bundle` at [src/renderers/createGridRenderer.ts:383](../../src/renderers/createGridRenderer.ts) **before** any of the following can happen:
  - `ensureFsUniformCapacity(...)` at line 403 may call `fsUniformBuffer.destroy()` (line 295) and rebuild `bindGroup` (line 307).
  - vertex buffer reallocation at lines 441-455.
- `render()` only builds a bundle if `bundle === null`; on next render the bundle is re-encoded against the current buffers + bindGroup. ✓

**Implementation — axis**:

- `prepare()` nulls `bundle` at [src/renderers/createAxisRenderer.ts:362](../../src/renderers/createAxisRenderer.ts) before any `vertexBuffer.destroy()` / reallocation at lines 373-387. ✓

**Verdict**: **Correct**. **Minor fragility**: `ensureFsUniformCapacity` is currently only reachable from `prepare()`, which nulls the bundle as its first side-effecting step. If a future change ever called `ensureFsUniformCapacity` from outside `prepare()` — or reordered `prepare()` to grow before nulling — the bundle would silently retain a reference to a destroyed buffer and UB on the next frame. Consider moving `bundle = null` into `ensureFsUniformCapacity` itself and/or co-locating the invalidation next to the destroy call. Tracked as **Minor**.

### 6. Dynamic-offset alignment — Verified (over-aligned)

**Spec requirement** (gpuweb §14.1 setBindGroup validation): `dynamicOffset` must be a multiple of `minUniformBufferOffsetAlignment` for `"uniform"` bindings. The default value of this limit is 256 bytes (gpuweb §3.6.2 "Limits"); devices may advertise a **smaller** value.

**Bind-group-layouts lesson** (webgpufundamentals): "Offset must be a multiple of 256 [unless your device supports smaller; see `minUniformBufferOffsetAlignment`]."

**Implementation** ([src/renderers/createGridRenderer.ts:177-181](../../src/renderers/createGridRenderer.ts)):

```ts
const dynamicOffsetAlignment = Math.max(
  256,
  device.limits.minUniformBufferOffsetAlignment,
);
```

Because `device.limits.minUniformBufferOffsetAlignment` is by definition ≤ 256 on a conforming device (a device may *only* advertise a value ≤ the default limit for "alignment" class limits), this expression always resolves to 256. It is safe (trivially satisfies the spec requirement) but **over-aligns on devices that permit smaller offsets** — the fs uniform buffer uses up to 4× more GPU memory per slot than necessary on some hardware.

**Verdict**: **Minor**. Swap to `device.limits.minUniformBufferOffsetAlignment` directly (or keep the `Math.max` but clamp to the advertised value instead of the default 256) for tighter packing. Not a correctness issue.

### 7. Dynamic-offset slot writes — Verified (fixed latent bug)

**AGENTS.md learned fact (line 180)** records that reusing a single fs uniform buffer with per-batch `writeBuffer` calls collapses to the last value because the queue coalesces writes to the same `(buffer, offset)` region before any submitted command buffer executes.

**Implementation**: Phase 4a uses a single fs uniform buffer with **distinct 256-byte-aligned slots** per batch ([src/renderers/createGridRenderer.ts:319-333](../../src/renderers/createGridRenderer.ts)). Each batch's color is written via `queue.writeBuffer(fsUniformBuffer, slotIndex * dynamicOffsetAlignment, ...)` — each write targets a different memory region, so no aliasing. The 16-byte color satisfies `queue.writeBuffer`'s 4-byte length/offset alignment requirement (comment at line 324).

**Verdict**: **Correct**. The latent multi-batch color collapse bug noted in AGENTS.md is correctly fixed by this design. The `ensureFsUniformCapacity` growth path rebuilds the bindGroup and (via `prepare()`) invalidates the bundle, so stale references cannot survive.

### 8. Memoization signature completeness — Verified (linear-scale-only)

**Spec requirement**: N/A — this is an application-level cache correctness question. A memoization key must capture every input that can change GPU state generated by `prepare()`, otherwise stale bundles produce incorrect output.

`**gridSignature*`* ([src/core/renderCoordinator/render/renderOverlays.ts:59-68](../../src/core/renderCoordinator/render/renderOverlays.ts)) captures: gridArea (left/right/top/bottom/canvasWidth/canvasHeight/devicePixelRatio), horizontal+vertical line counts, horizontal+vertical colors.

Cross-check against `generateGridVertices` and `prepare()` consumption ([src/renderers/createGridRenderer.ts:104-162, 335-467](../../src/renderers/createGridRenderer.ts)): the only inputs that affect generated vertices/uniforms are gridArea + counts + color. Tick count, scale, and axisConfig do not feed into grid geometry (grid lines are evenly-spaced by index, not by domain value). ✓

`**axisSignature**` ([src/core/renderCoordinator/render/renderOverlays.ts:75-96](../../src/core/renderCoordinator/render/renderOverlays.ts)) captures: orientation, axisConfig (min, max, tickLength), `scale.scale(0)`, `scale.scale(1)`, gridArea, axisLineColor, axisTickColor, tickCount.

Cross-check against `generateAxisVertices` ([src/renderers/createAxisRenderer.ts:113-240](../../src/renderers/createAxisRenderer.ts)):

- The scale enters via `scale.scale(v)` and `scale.invert(plotLeftClip/plotBottomClip)`. For `LinearScale` (which is the only implementation — [src/utils/scales.ts](../../src/utils/scales.ts) `createLinearScale`), the full affine is determined by any two output values. `scale(0)` gives the intercept; `scale(1) - scale(0)` gives the slope; `invert` is the inverse affine, also fully determined. ✓
- axisConfig.min/max/tickLength are captured. ✓
- gridArea, orientation, tickCount, colors captured. ✓

**Verdict**: **Correct for the current scale contract** (linear-only). **Info (future-proofing)**: If a non-linear scale (log, sqrt, etc.) is introduced, the two-sample affine recovery trick will silently produce false-positive cache hits — two distinct curves can agree at x=0 and x=1 but differ elsewhere. A forward-compatible alternative is to expose a `scale.signature()` method that returns a stable string (e.g. `"linear|slope|intercept"` or `"log|base|min|max"`). Recorded as **Info** since the current implementation is typed against `LinearScale`.

### 9. Grid memo invalidation across hidden/non-cartesian frames — Verified

The memo for axes is reset to `null` on frames where `hasCartesianSeries === false` ([src/core/renderCoordinator/render/renderOverlays.ts:272-277](../../src/core/renderCoordinator/render/renderOverlays.ts)). This is correct: on such frames axis `prepare()` is not called and the vertex buffer is untouched, but on a future cartesian frame the bundle must be re-encoded because earlier axis state might belong to a prior geometry.

The grid memo is **not** reset in the non-cartesian branch. That's fine because grid `prepare()` is still called unconditionally (the `if (!memo || memo.grid !== gridSig)` branch at line 188). Grid geometry depends only on gridArea + counts + colors, not on cartesian-ness.

**Verdict**: **Correct**.

### 10. MSAA + `storeOp: "discard"` + `resolveTarget` interplay — Verified

**Spec requirement** (gpuweb §17.3.3 "End of pass" pseudocode):

```
If colorAttachment.resolveTarget is not null:
  Resolve the multiple samples of every texel of colorSubregion to a single
  sample and copy to colorAttachment.resolveTarget.
If colorAttachment.storeOp is "discard":
  Set every texel of colorSubregion to zero.
```

The resolve step runs **before** the storeOp is applied. Therefore `storeOp: "discard"` + non-null `resolveTarget` is legal and commonly used for MSAA attachments: the MSAA source is discarded, but the resolved single-sample target retains the resolved pixels.

**Additional validation** (gpuweb §17.1.1.1 GPURenderPassColorAttachment Valid Usage item 6):

- `renderTexture.sampleCount` must be > 1 (✓ 4).
- `resolveTexture.sampleCount` must be 1 (✓ 1 — swapchain & `mainResolveTexture` are single-sample).
- `resolveViewDescriptor.format` must equal `renderViewDescriptor.format` (✓ both `targetFormat`).
- `resolveTexture.format` must equal `renderTexture.format` (✓ both `targetFormat`).
- `resolveTarget.[[renderExtent]]` must match `view.[[renderExtent]]` (✓ both sized to canvas dimensions via `textureManager.ensureTextures`).
- `resolveViewDescriptor.format` must support resolve per §26.1.1 (✓ `bgra8unorm` / `rgba8unorm` support resolve).

**Implementation confirmed**:

- Main pass ([src/core/createRenderCoordinator.ts:4176-4187](../../src/core/createRenderCoordinator.ts)): MSAA view + single-sample resolveTarget, `storeOp: "discard"`.
- Overlay pass ([src/core/createRenderCoordinator.ts:4227-4238](../../src/core/createRenderCoordinator.ts)): MSAA view + swapchain resolveTarget, `storeOp: "discard"`.

**Multisampling lesson note**: "Setting `colorAttachment[0].resolveTarget` says to WebGPU, 'when all the drawing in this render pass has finished, downscale the multisample texture into the texture set on `resolveTarget`'. If you have multiple render passes you probably don't want to resolve until the last pass." ChartGPU resolves at the **end of both passes** — the main pass resolves into `mainResolveView` specifically so the **next** pass (overlay) can sample it via the blit pipeline. The overlay pass resolves into the swapchain. This is the "empty last render pass to do nothing but resolve" pattern generalized.

**Verdict**: **Correct**.

### 11. No post-pass reads of MSAA views — Verified

**Spec consequence**: after `storeOp: "discard"`, the attachment view's texels are zero. Reading them (via sampling, copying, or attaching to a later pass with `loadOp: "load"`) yields zeros.

**Implementation**: grep for `overlayMsaaView`/`mainColorView` usage shows they are used **only** as the `view` field of their respective color attachments, never bound to a bind group, copied from, or attached to a later pass with `loadOp: "load"`. The one inter-pass read — the overlay blit sampling `mainResolveView` — targets the **resolve** texture, which is populated by the resolve step and is not affected by the MSAA `storeOp: "discard"`.

**Verdict**: **Correct**.

### 12. Pipeline `sampleCount` promotion matches attachment `sampleCount` — Verified

**Spec requirement** (gpuweb §23.5 "Render Pipeline Encoding / Rendering" — multisample state validation): `GPURenderPipeline.[[descriptor]].multisample.count` must equal the render pass's `sampleCount` (derived from the color attachment's `view.[[texture]].sampleCount`). Mismatch invalidates the command encoder.

**Multisampling lesson**: "Adding the `multisample` setting above makes this pipeline able to render to a multisample texture. … `count` must be `4`."

**Implementation** ([src/core/createRenderCoordinator.ts:1823-1884](../../src/core/createRenderCoordinator.ts)):


| Renderer                               | sampleCount                                                                                                                                                 | Runs in pass         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `gridRenderer`                         | `MAIN_SCENE_MSAA_SAMPLE_COUNT` (4)                                                                                                                          | `mainPass` (4×) ✓    |
| `xAxisRenderer`                        | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `yAxisRenderer`                        | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `crosshairRenderer`                    | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `highlightRenderer`                    | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `referenceLineRenderer` (below)        | `MAIN_SCENE_MSAA_SAMPLE_COUNT` (4)                                                                                                                          | `mainPass` (4×) ✓    |
| `annotationMarkerRenderer` (below)     | `MAIN_SCENE_MSAA_SAMPLE_COUNT` (4)                                                                                                                          | `mainPass` (4×) ✓    |
| `referenceLineRendererMsaa` (above)    | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `annotationMarkerRendererMsaa` (above) | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4)                                                                                                                  | `overlayPass` (4×) ✓ |
| `overlayBlitPipeline`                  | `ANNOTATION_OVERLAY_MSAA_SAMPLE_COUNT` (4) ([src/core/renderCoordinator/gpu/textureManager.ts:203](../../src/core/renderCoordinator/gpu/textureManager.ts)) | `overlayPass` (4×) ✓ |


All overlay-pass pipelines are 4×; all main-pass pipelines are 4×. No stale 1× leftovers.

**Verdict**: **Correct**.

### 13. Texture format + usage flags — Verified

**Spec requirements** (gpuweb §6.1 GPUTextureUsage, §17.1.1.1 Valid Usage):

- `view.usage` must include `RENDER_ATTACHMENT` for color attachments.
- A texture sampled in a later pass must include `TEXTURE_BINDING`.
- A multisampled texture cannot include `TEXTURE_BINDING` (multi-sample cannot be directly sampled as a `texture_2d<f32>`).

**Implementation** ([src/core/renderCoordinator/gpu/textureManager.ts:244-271](../../src/core/renderCoordinator/gpu/textureManager.ts)):


| Texture                                  | `sampleCount` | `usage`                                 |
| ---------------------------------------- | ------------- | --------------------------------------- |
| `mainColorTexture` (MSAA src)            | 4             | `RENDER_ATTACHMENT` only ✓              |
| `mainResolveTexture` (resolve → sampled) | 1             | `RENDER_ATTACHMENT | TEXTURE_BINDING` ✓ |
| `overlayMsaaTexture` (MSAA src)          | 4             | `RENDER_ATTACHMENT` only ✓              |


Formats: all three share `targetFormat` (canvas preferred format). Resolve format match (§17.1.1.1 item 6.7) is satisfied.

**Verdict**: **Correct**.

### 14. Render bundle + blended pipelines — Verified

**Spec note**: Blending state is part of the pipeline (and thus is captured into the bundle via `setPipeline`). There is no restriction on using blended pipelines inside render bundles — `setBlendConstant`, however, can only be called on the outer pass encoder. ChartGPU's grid/axis pipelines use `src-alpha, one-minus-src-alpha` blend factors (no `constant` factor), so `setBlendConstant` is not required.

**Verdict**: **Correct**.

## Summary of verdicts


| #   | Finding                                                          | Severity                                         |
| --- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Render-bundle vs pass layout compatibility                       | Verified                                         |
| 2   | `executeBundles` state-leak safety                               | Verified                                         |
| 3   | Bundle self-containment (pipeline + bindgroups + vertex buffers) | Verified                                         |
| 4   | Viewport/scissor inheritance                                     | Verified                                         |
| 5   | Bundle lifetime vs. destroyed GPU resources                      | Verified (**Minor** fragility — see remediation) |
| 6   | Dynamic-offset alignment                                         | **Minor** (over-aligned, non-blocking)           |
| 7   | Dynamic-offset slot writes (color aliasing)                      | Verified                                         |
| 8   | Memo signature completeness                                      | Verified (linear-scale-only)                     |
| 9   | Memo invalidation across non-cartesian frames                    | Verified                                         |
| 10  | MSAA + `storeOp: "discard"` + `resolveTarget`                    | Verified                                         |
| 11  | No post-pass reads of MSAA views                                 | Verified                                         |
| 12  | Pipeline `sampleCount` promotion                                 | Verified                                         |
| 13  | Texture format + usage flags                                     | Verified                                         |
| 14  | Render bundle + blended pipelines                                | Verified                                         |


**No Blocker or Major findings.** Two Minor items and one Info.

## Remediation checklist

### Minor (safe to defer)

- **§5 fragility** — co-locate `bundle = null` with the buffer-destroying code in `ensureFsUniformCapacity` (or at least assert the invariant) so a future refactor that calls the growth function outside `prepare()` cannot silently create a bundle referencing a destroyed buffer. Suggested: add `bundle = null;` as the first line of `ensureFsUniformCapacity` when the early-return does not trigger.
- **§6 over-alignment** — replace `Math.max(256, device.limits.minUniformBufferOffsetAlignment)` with `device.limits.minUniformBufferOffsetAlignment` in [src/renderers/createGridRenderer.ts:177-181](../../src/renderers/createGridRenderer.ts). Saves up to ~4× uniform buffer memory on devices that advertise a smaller alignment (common on integrated GPUs with 64-byte alignment). Zero correctness risk — the advertised limit is always sufficient by definition.

### Info (future-proofing)

- **§8 scale signature** — if ChartGPU ever introduces non-linear scales, replace the `scale.scale(0), scale.scale(1)` two-sample trick in `axisSignature` with a stable-string representation exposed by the scale itself (e.g. `scale.cacheKey()`). Until then, the `LinearScale`-only typing guarantees correctness.

## Validation done

- Read the full Phase 4 diff across `createGridRenderer.ts`, `createAxisRenderer.ts`, `createRenderCoordinator.ts`, `renderOverlays.ts`, `textureManager.ts`.
- Cross-referenced the diff against gpuweb spec sections §17 (Render Passes), §18 (Bundles), §14 (Bind Groups), §6 (Textures), §23.5 (pipeline compat), and the multisampling, bind-group-layouts, and optimization lessons.
- Verified ordering invariants (bundle null before destroy, scissor reset before axes, state re-set after executeBundles) by reading the coordinator render loop end-to-end.
- Did not run benchmarks — perf claims are out of scope for this correctness audit.

