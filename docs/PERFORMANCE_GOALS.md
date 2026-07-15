# ChartGPU Performance Goals

**Branch:** `performance-audit`  
**Sources:** [`audit.md`](../audit.md), [`benchmarks/baselines/main.json`](../benchmarks/baselines/main.json), [`examples/performance-baseline/`](../examples/performance-baseline/)  
**Purpose:** Single goal document for humans and agents — every audit finding, acceptance criteria, fix order, and **autonomous** baseline verification.

---

## Opinion: autonomous verification via console JSON

**Yes — console-logged JSON + window globals is the right verification path.**

| Approach | Autonomous? | Notes |
|----------|-------------|--------|
| Manual UI download | No | Human-only |
| `window.__CHARTGPU_BASELINE_REPORT__` | **Yes** | Agent evaluates in-page after run |
| `console.log` markers + compact JSON | **Yes** | Scrape CDP / Playwright logs without file download |
| `benchmark:baseline:compare` vs `main.json` | **Yes** | Numeric regression gate |

The harness emits:

1. `CHARTGPU_BASELINE_DONE`
2. `CHARTGPU_BASELINE_JSON_BEGIN` … one-line JSON … `CHARTGPU_BASELINE_JSON_END`
3. Globals: `__CHARTGPU_BASELINE_DONE__`, `__CHARTGPU_BASELINE_REPORT__`, `__CHARTGPU_BASELINE_JSON__`

Agents should **wait for `CHARTGPU_BASELINE_DONE`**, parse the JSON, then compare to `benchmarks/baselines/main.json` with the same thresholds as `compare.ts`.

---

## Mission

1. Establish a **repeatable FPS + CPU** baseline (done: `main.json`).
2. Fix audit findings in severity order **without regressing** the baseline on the same machine.
3. Verify each change by re-running the production harness and comparing JSON.

**Do not** claim an optimization is “done” without a candidate report vs `main.json` (or an explicit note that the finding is correctness-only / not covered by current scenarios).

---

## Baseline of record

| Field | Value |
|-------|--------|
| File | `benchmarks/baselines/main.json` |
| Generated | `2026-07-15T18:06:41.927Z` |
| Adapter | `apple / metal-3 / 0x0000` |
| Browser | Chrome 150 (macOS) |
| Canvas | **1280×720 CSS**, DPR **2** |
| Config | warmup **90**, measure **300** frames |

### Baseline numbers (p50)

| Scenario | FPS p50 | FPS mean | CPU ms p50 | CPU ms p95 | Library FPS | Drops |
|----------|---------|----------|------------|------------|-------------|-------|
| `static-1m-lttb` | 120.48 | 120.26 | 0.70 | 1.30 | 120.09 | 0 |
| `hover-1m-lttb` | 120.48 | 120.26 | 1.55 | 2.60 | 120.01 | 0 |
| `zoom-pan-1m` | 120.48 | 120.16 | 0.90 | 1.60 | 120.00 | 0 |
| `stream-append-lttb` | 120.48 | 120.10 | 1.70 | 2.10 | 119.98 | 0 |
| `stream-append-none` | 120.48 | 120.52 | 1.00 | 1.60 | 119.88 | 0 |

**Interpretation notes**

- ~120 FPS is display/rAF capped on a high-refresh display; **CPU ms p50/p95** is the primary regression signal when FPS is saturated.
- Prefer **same machine, same browser, production preview** for deltas.
- Thresholds (from `compare.ts`): FPS p50 drop **&lt; −5%** = regression; CPU p50 rise **&gt; +8%** = regression.

---

## How to run the benchmark

### A. Production preview (required for meaningful numbers)

```bash
# From repo root
bun run benchmark:baseline:preview
# = build:examples + vite preview on :4173
```

Open (full suite, auto-run, optional download):

```text
http://localhost:4173/ChartGPU/examples/performance-baseline/?scenario=all&autorun=1&download=1
```

Single scenario:

```text
http://localhost:4173/ChartGPU/examples/performance-baseline/?scenario=hover-1m-lttb&autorun=1&warmup=90&measure=300
```

| Query | Default | Meaning |
|-------|---------|---------|
| `scenario` | `all` | `all` or one of the five ids |
| `warmup` | `90` | Frames discarded before measure |
| `measure` | `300` | Frames included in stats |
| `autorun` | `1` | `0` to wait for button click |
| `download` | `0` | `1` to auto-download JSON |

**Do not** use `bun run dev` for gate numbers (dev GPU/validation overhead masks results).

### B. Browser console (manual or agent)

After the run finishes (status shows summary / JSON in the page):

```js
// 1) Wait flag
window.__CHARTGPU_BASELINE_DONE__ === true

// 2) Structured object
window.__CHARTGPU_BASELINE_REPORT__

// 3) Compact JSON string (same payload as console line)
window.__CHARTGPU_BASELINE_JSON__

// 4) Pretty-print
console.log(JSON.stringify(window.__CHARTGPU_BASELINE_REPORT__, null, 2))
```

Console log markers (for CDP / Playwright log capture):

```text
CHARTGPU_BASELINE_DONE
CHARTGPU_BASELINE_JSON_BEGIN
{...one-line JSON...}
CHARTGPU_BASELINE_JSON_END
```

### C. CLI compare (after saving candidate JSON)

```bash
bun run benchmark:baseline:compare -- \
  benchmarks/baselines/main.json \
  /path/to/candidate.json

# Exit 2 on regression:
bun run benchmark:baseline:compare -- \
  benchmarks/baselines/main.json \
  /path/to/candidate.json \
  --fail-on-regression
```

### D. Autonomous agent loop (recommended)

```text
1. bun run build:examples
2. Start preview:examples on :4173 (or use already-running server)
3. Navigate to performance-baseline/?scenario=all&autorun=1
4. Poll until console contains CHARTGPU_BASELINE_DONE
   OR until window.__CHARTGPU_BASELINE_DONE__ === true
5. Read window.__CHARTGPU_BASELINE_JSON__ (or parse between BEGIN/END markers)
6. Write candidate.json; run compare.ts vs main.json
7. Fail the goal step if compare exits 2 (unless finding is correctness-only)
8. Optionally update main.json only when intentionally re-baselining after agreed wins
```

Pseudo-code (Playwright / agent-browser):

```js
await page.goto(BASELINE_URL);
await page.waitForFunction(() => window.__CHARTGPU_BASELINE_DONE__ === true, null, {
  timeout: 600_000, // full suite can take several minutes (1M data gen + 5 scenarios)
});
const json = await page.evaluate(() => window.__CHARTGPU_BASELINE_JSON__);
// fs.writeFileSync('candidate.json', json)
// spawn compare.ts
```

**Timeouts:** Full `all` suite generates 1M points multiple times; allow **several minutes** on first scenario alone.

---

## Scenario → finding map

| Scenario | Primary findings stressed |
|----------|---------------------------|
| `static-1m-lttb` | P1-1 bind groups, P1-2 setSeries pack/hash, P1-5/6 passes/overlays, P1-7 sampling |
| `hover-1m-lttb` | **P0-4** full render on pointer, **P0-5** double hit-test, P1-8 O(n) hit-test, P3-7 DOM labels |
| `zoom-pan-1m` | P0-2 CPU LTTB, P1-3/4 area (if used), P1-7 zoom resample, P1-10 clip instances |
| `stream-append-lttb` | **P0-3** sampling defeats append, P0-2 resample |
| `stream-append-none` | Append fast path health; contrast vs LTTB stream |

Correctness-only or weakly covered by harness: **P0-1** (grid H/V colors), **P2-1/2** (startup compile), **P2-8** (resize thrash), **P2-9** (timestamps), **P2-11** (docs). Still require code review / unit / visual checks.

---

## Findings registry (complete)

Status legend: `open` | `in_progress` | `done` | `wontfix` | `deferred`

### P0 — Critical

#### P0-1 · Grid multi-batch FS uniforms via `writeBuffer` in `render()`
| | |
|--|--|
| **Status** | open |
| **Where** | `src/renderers/createGridRenderer.ts` |
| **Problem** | Per-batch `queue.writeBuffer` into one FS uniform then `draw()`; all batches can see last color (correctness) + wasted queue traffic |
| **Fix** | Dynamic uniform offsets (`minUniformBufferOffsetAlignment`, often 256) or per-batch color in vertices |
| **Verify** | Visual: distinct H/V grid colors; unit/render test; baseline not required for correctness |
| **Baseline scenario** | weak (single-color grid default) |

#### P0-2 · CPU LTTB only — GPU decimation missing from `src/`
| | |
|--|--|
| **Status** | open |
| **Where** | `createRenderCoordinator.ts`, `sampleSeries.ts`; no `decimation.wgsl` in `src/` |
| **Problem** | Large series always CPU-sample; docs/dist claim GPU path not present |
| **Fix** | Land GPU decimation + single eligibility gate at baseline/zoom/prepare |
| **Verify** | `zoom-pan-1m`, `stream-append-lttb` CPU ms ↓; functional parity with LTTB |
| **Baseline scenario** | `zoom-pan-1m`, `static-1m-lttb`, `stream-append-lttb` |

#### P0-3 · Streaming + default sampling defeats incremental append
| | |
|--|--|
| **Status** | open |
| **Where** | `canUseFastPath` requires `sampling === 'none'`; flush always resamples baseline |
| **Problem** | Live LTTB streaming is O(n) CPU + full re-upload per batch |
| **Fix** | GPU raw append + decimation, or windowed sampling; expand fast path |
| **Verify** | `stream-append-lttb` CPU → approach `stream-append-none`; no false console warn after fix |
| **Baseline scenario** | `stream-append-lttb` vs `stream-append-none` |

#### P0-4 · Pointer move triggers full chart `render()` every time
| | |
|--|--|
| **Status** | open |
| **Where** | `onMouseMove` → `requestRender()` in coordinator |
| **Problem** | Hover = full prepare/encode/DOM path |
| **Fix** | Throttle; overlay-only path; skip series prepare when data/scales stable |
| **Verify** | `hover-1m-lttb` CPU ms ↓ vs baseline without dropping interaction quality |
| **Baseline scenario** | `hover-1m-lttb` |

#### P0-5 · Duplicate `findNearestPoint` per hover frame
| | |
|--|--|
| **Status** | open |
| **Where** | tooltip in coordinator + highlight in `renderOverlays.ts` |
| **Problem** | 2× hit-test per frame |
| **Fix** | Single hit-test result shared by tooltip + highlight |
| **Verify** | `hover-1m-lttb` CPU; unit tests for shared cache |
| **Baseline scenario** | `hover-1m-lttb` |

---

### P1 — High

#### P1-1 · Line `createBindGroup` every `prepare()`
| | |
|--|--|
| **Status** | open |
| **Where** | `createLineRenderer.ts` |
| **Fix** | Cache by `dataBuffer` identity |
| **Verify** | `static-1m-lttb`, `hover-1m-lttb` CPU ↓ |
| **Baseline scenario** | static + hover |

#### P1-2 · `DataStore.setSeries` packs/hashes before skip
| | |
|--|--|
| **Status** | open |
| **Where** | `createDataStore.ts` |
| **Fix** | Cheap dirty check before pack; reuse staging |
| **Verify** | static/hover CPU when data unchanged |
| **Baseline scenario** | `static-1m-lttb` |

#### P1-3 · Area full vertex rebuild + upload every prepare
| | |
|--|--|
| **Status** | open |
| **Where** | `createAreaRenderer.ts` |
| **Fix** | Domain buffer + uniforms, or skip upload when unchanged |
| **Verify** | Add area scenario later if needed; manual area example + CPU |
| **Baseline scenario** | not in default suite (extend harness if fixing) |

#### P1-4 · Line + `areaStyle` dual data paths
| | |
|--|--|
| **Status** | open |
| **Where** | `renderSeries.ts` |
| **Fix** | Shared GPU data; fill then stroke |
| **Verify** | same as P1-3 |
| **Baseline scenario** | extend harness |

#### P1-5 · Three passes + dual 4× MSAA
| | |
|--|--|
| **Status** | open |
| **Where** | `textureManager.ts`, coordinator frame loop |
| **Fix** | Profile; collapse passes; optional 2×; skip overlay MSAA when unused |
| **Verify** | FPS if not refresh-capped; GPU memory; visual AA |
| **Baseline scenario** | all (GPU-bound changes may only show on weaker GPUs) |

#### P1-6 · No render bundles / overlay prepare memo
| | |
|--|--|
| **Status** | open |
| **Where** | `renderOverlays.ts`, grid/axis |
| **Fix** | Memo signatures; optional `GPURenderBundle` |
| **Verify** | hover/static CPU encode path |
| **Baseline scenario** | `static-1m-lttb`, `hover-1m-lttb` |

#### P1-7 · Redundant multi-stage CPU sampling
| | |
|--|--|
| **Status** | open |
| **Where** | OptionResolver + baseline + zoom recompute |
| **Fix** | Dirty flags; skip baseline when raw unchanged |
| **Verify** | setOption theme-only unit test; zoom CPU |
| **Baseline scenario** | `zoom-pan-1m` |

#### P1-8 · Non-monotonic hit-test O(n)
| | |
|--|--|
| **Status** | open |
| **Where** | `findNearestPoint.ts` |
| **Fix** | Domain grid / spatial index WeakMap |
| **Verify** | unit tests unsorted series; optional scatter baseline scenario |
| **Baseline scenario** | weak (monotonic 1M line uses binary search) |

#### P1-9 · Duplicate MSAA / non-MSAA annotation prepare
| | |
|--|--|
| **Status** | open |
| **Where** | coordinator annotation renderers |
| **Fix** | Share instance upload; dual draw only |
| **Verify** | annotation-heavy example; CPU |
| **Baseline scenario** | weak |

#### P1-10 · Clip-space instance re-upload on zoom (bar/scatter/candle/pie)
| | |
|--|--|
| **Status** | open |
| **Where** | respective renderers |
| **Fix** | Domain + uniform transform where possible |
| **Verify** | dedicated scatter/bar scenarios (extend harness) |
| **Baseline scenario** | not in default suite |

---

### P2 — Medium

| ID | Title | Status | Where | Fix (short) | Verify |
|----|-------|--------|-------|-------------|--------|
| P2-1 | Sync-only pipeline creation | open | `rendererUtils`, `PipelineCache` | `create*PipelineAsync` + warm-up | Startup hitch; not baseline FPS |
| P2-2 | No `compilationHints` | open | shader create | Hints for vs/fs entry points | Startup |
| P2-3 | Per-renderer layouts hurt pipeline cache | open | `rendererUtils` | Shared layouts at device scope | Multi-chart dashboard |
| P2-4 | Append growth: full CPU re-upload | open | `createDataStore` | `COPY_SRC` + GPU copy prefix | Stream growth spikes |
| P2-5 | Line bounds O(n) every prepare | open | `createLineRenderer` | Pass cached `rawBounds` | `sampling:none` large n |
| P2-6 | Density bins cleared via large `writeBuffer` | open | scatter density | GPU clear/compute zero | density example |
| P2-7 | Clear before full-screen blit | open | overlay pass | Profile loadOp | GPU bandwidth |
| P2-8 | Resize thrash MSAA textures | open | textureManager, ChartGPU | Hysteresis / pad | resize stress |
| P2-9 | No GPU timestamp queries | open | ChartGPU, GPUContext | Feature + pass timestamps | metrics API |
| P2-10 | Default `requestDevice` limits only | open | GPUContext | Optional large-data limits | huge series fail path |
| P2-11 | Docs / AGENTS / dist vs `src/` drift | open | docs, dist | Align or re-land | grepai / docs review |
| P2-12 | `filterGaps` alloc every frame | open | renderSeries | Cache until data changes | connectNulls series |

---

### P3 — Low

| ID | Title | Status | Fix (short) |
|----|-------|--------|-------------|
| P3-1 | No `mappedAtCreation` | open / deferred | Optional for one-shot huge static loads |
| P3-2 | PoT buffer growth VRAM | open / document | Document tradeoff |
| P3-3 | Overlay small ArrayBuffer allocs | open | Scratch buffers like line renderer |
| P3-4 | STORAGE on all DataStore buffers | open | Usage by series kind |
| P3-5 | Blit clear-then-cover | open | See P2-7 |
| P3-6 | Bar hit-test category sort | open | Cache category step |
| P3-7 | DOM labels every full render on hover | open | Skip when only pointer moved |
| P3-8 | Eager layouts on pool growth | open | Warm-up off critical path |

---

## Already-good patterns (do not regress)

Preserve while fixing findings:

- Single command encoder + single `queue.submit` per chart frame  
- MSAA `storeOp: "discard"` after resolve  
- Top overlay `loadOp: "load"` on swapchain  
- DataStore append ranged `writeBuffer` + incremental hash  
- Content-hash skip of GPU upload (after pack — see P1-2)  
- StreamBuffer double-buffer + word-diff  
- Scatter density dirty gate + bind-group cache  
- PipelineCache shader dedupe  
- Zoom resample debounce; append flush coalescing  
- Explicit `destroy()` / dispose chains  

---

## Recommended implementation order

| Phase | Items | Why |
|-------|-------|-----|
| **0** | Baseline harness + `main.json` | **Done** — measurement system of record |
| **1** | P0-1 | Correctness first (grid colors) |
| **2** | P0-5, P0-4 | Hover CPU; clear harness signal on `hover-1m-lttb` |
| **3** | P1-1, P1-2 | Cheap static-frame wins |
| **4** | P0-2, P0-3 | Large-data + streaming product path |
| **5** | P1-6, P1-7, P2-5, P2-12 | Encode/sampling churn |
| **6** | P1-3, P1-4, P1-9, P1-10 | Series-path structural |
| **7** | P1-5, P2-7 | Pass/MSAA budget (profile first) |
| **8** | P2-1, P2-2, P2-9 | Startup + observability |
| **9** | Remaining P2/P3 + P2-11 docs alignment | Cleanup |

After **each** phase (or each PR):

1. Production baseline run (`scenario=all` or the mapped scenarios).  
2. Compare to `main.json`.  
3. No unexplained CPU p50 regressions &gt; +8% or FPS p50 &lt; −5%.  
4. Update finding status in this document.  
5. Re-baseline `main.json` only when the team accepts a new reference after intentional wins.

---

## Definition of done (whole program)

- [ ] All **P0** fixed or explicitly deferred with rationale  
- [ ] All **P1** fixed or deferred with harness coverage plan  
- [ ] P2/P3 triaged (fix / defer / wontfix)  
- [ ] `AGENTS.md` / docs match `src/` (P2-11)  
- [ ] Fresh full-suite JSON compared cleanly to updated baseline  
- [ ] No correctness regressions (grid colors, sampling shape, streaming append)  

---

## Agent checklist (copy into task prompts)

```text
GOAL: ChartGPU performance (see docs/PERFORMANCE_GOALS.md)

Before coding:
- [ ] Read finding ID + acceptance verify column
- [ ] Note mapped baseline scenario(s)

After coding:
- [ ] bun run build:examples && bun run preview:examples (or reuse server)
- [ ] Open performance-baseline with autorun for mapped scenarios
- [ ] Wait for CHARTGPU_BASELINE_DONE / __CHARTGPU_BASELINE_DONE__
- [ ] Capture __CHARTGPU_BASELINE_JSON__
- [ ] bun run benchmark:baseline:compare -- benchmarks/baselines/main.json candidate.json
- [ ] Update finding Status in PERFORMANCE_GOALS.md
- [ ] Do not push unless asked
```

---

## File index

| Path | Role |
|------|------|
| `docs/PERFORMANCE_GOALS.md` | **This document** |
| `audit.md` | Full audit narrative + spec grounding |
| `examples/performance-baseline/` | Browser harness |
| `benchmarks/baselines/main.json` | Checked-in baseline of record |
| `benchmarks/baseline/compare.ts` | CLI regression compare |
| `benchmarks/baseline/README.md` | Operator docs |
| `docs/performance.md` | User-facing performance guide |

---

*Update finding statuses as work lands. Prefer editing this file over inventing parallel trackers.*
