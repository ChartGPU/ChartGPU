# Checked-in performance baselines

Machine-specific FPS / CPU measurements for ChartGPU, produced by the
**Performance Baseline** harness:

[`examples/performance-baseline/`](../../examples/performance-baseline/)

## Establish or refresh `main.json`

1. Build and serve **production** examples (not Vite dev):

   ```bash
   bun run build:examples
   bun run preview:examples
   ```

2. Open the harness (adjust host/port if needed):

   ```
   http://localhost:4173/ChartGPU/examples/performance-baseline/?scenario=all&autorun=1&download=1
   ```

   Fixed canvas: **1280×720 CSS px**. Leave the tab focused; avoid thermal throttling.

3. When the run finishes, save the downloaded JSON as:

   ```
   benchmarks/baselines/main.json
   ```

4. Commit it with hardware notes in the PR description (GPU model, OS, browser version).

## Compare a candidate run

```bash
bun run benchmark:baseline:compare -- benchmarks/baselines/main.json /path/to/candidate.json
```

Optional gate:

```bash
bun run benchmark:baseline:compare -- benchmarks/baselines/main.json /path/to/candidate.json --fail-on-regression
```

## Autonomous capture (console / agents)

When a run completes, the page:

1. Sets `window.__CHARTGPU_BASELINE_DONE__ = true`
2. Sets `window.__CHARTGPU_BASELINE_REPORT__` (object) and `window.__CHARTGPU_BASELINE_JSON__` (string)
3. Logs markers for log scraping:

```text
CHARTGPU_BASELINE_DONE
CHARTGPU_BASELINE_JSON_BEGIN
{...compact JSON...}
CHARTGPU_BASELINE_JSON_END
```

See [`docs/PERFORMANCE_GOALS.md`](../../docs/PERFORMANCE_GOALS.md) for the full agent loop.

## Schema

See `kind: "chartgpu-performance-baseline"` and `schemaVersion: 1` in the report JSON.
Primary fields per scenario:

| Field | Meaning |
|-------|---------|
| `fps.p50` / `fps.mean` | Wall-clock FPS from rAF deltas during measure window |
| `cpuMs.p50` / `cpuMs.p95` | Main-thread ms around dirty + `renderFrame()` |
| `libraryFps` | Snapshot from `chart.getPerformanceMetrics()` at end |
| `environment.*` | UA, adapter, DPR, canvas size for apples-to-apples notes |

## Notes

- Numbers are **not** portable across GPUs or power states. Compare deltas on the **same machine**.
- Prefer the same Chrome/Edge build and plugged-in power for regressions.
- GPU timestamps are not required for this baseline (CPU + FPS is enough for most audit items).
