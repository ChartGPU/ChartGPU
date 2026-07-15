/**
 * Performance baseline harness (FPS + CPU frame time).
 *
 * Fixed scenarios for regression tracking against audit / optimization work.
 * Prefer production examples build:
 *   bun run build:examples && bun run preview:examples
 * then open /examples/performance-baseline/
 *
 * Query params:
 *   ?scenario=all|static-1m-lttb|hover-1m-lttb|zoom-pan-1m|stream-append-lttb|stream-append-none
 *   &warmup=90 &measure=300 &autorun=1 &download=0
 */

import { ChartGPU } from "../../src/index";
import type {
  ChartGPUInstance,
  ChartGPUOptions,
  DataPoint,
  PerformanceMetrics,
  SeriesSampling,
} from "../../src/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScenarioId =
  | "static-1m-lttb"
  | "hover-1m-lttb"
  | "zoom-pan-1m"
  | "stream-append-lttb"
  | "stream-append-none";

interface PercentileStats {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

interface ScenarioResult {
  readonly id: ScenarioId;
  readonly description: string;
  readonly pointCount: number;
  readonly sampling: SeriesSampling;
  readonly warmupFrames: number;
  readonly measureFrames: number;
  readonly measuredFrames: number;
  readonly durationMs: number;
  /** Wall-clock FPS from rAF spacing during the measure window. */
  readonly fps: PercentileStats;
  /** CPU ms around dirtying + renderFrame() (JS main-thread work for that frame). */
  readonly cpuMs: PercentileStats;
  /** Library-reported FPS snapshot at end of measure (when available). */
  readonly libraryFps: number | null;
  readonly libraryFrameTimeMs: number | null;
  readonly droppedFrames: number | null;
  readonly notes: readonly string[];
}

interface BaselineReport {
  readonly schemaVersion: 1;
  readonly kind: "chartgpu-performance-baseline";
  readonly generatedAt: string;
  readonly commit: string | null;
  readonly environment: {
    readonly userAgent: string;
    readonly language: string;
    readonly hardwareConcurrency: number | null;
    readonly devicePixelRatio: number;
    readonly canvasCssWidth: number;
    readonly canvasCssHeight: number;
    readonly webgpuAdapter: string | null;
    readonly preferredFormat: string | null;
  };
  readonly config: {
    readonly warmupFrames: number;
    readonly measureFrames: number;
  };
  readonly scenarios: readonly ScenarioResult[];
}

interface ScenarioDef {
  readonly id: ScenarioId;
  readonly label: string;
  readonly description: string;
  readonly pointCount: number;
  readonly sampling: SeriesSampling;
  readonly samplingThreshold: number;
  readonly enableZoom: boolean;
}

// ---------------------------------------------------------------------------
// Constants / scenario catalog
// ---------------------------------------------------------------------------

const CANVAS_CSS_W = 1280;
const CANVAS_CSS_H = 720;
const DEFAULT_WARMUP = 90;
const DEFAULT_MEASURE = 300;
const STREAM_BATCH = 64;
const STREAM_SEED_POINTS = 50_000;

const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: "static-1m-lttb",
    label: "Static 1M line (LTTB) forced redraw",
    description:
      "1M points, sampling=lttb. Forces a full dirty render every frame via tiny interaction-x oscillation (crosshair path).",
    pointCount: 1_000_000,
    sampling: "lttb",
    samplingThreshold: 5000,
    enableZoom: true,
  },
  {
    id: "hover-1m-lttb",
    label: "Hover sweep 1M line (LTTB)",
    description:
      "1M points, sampling=lttb. Sweeps setInteractionX across the domain each frame (tooltip/highlight path).",
    pointCount: 1_000_000,
    sampling: "lttb",
    samplingThreshold: 5000,
    enableZoom: true,
  },
  {
    id: "zoom-pan-1m",
    label: "Zoom/pan 1M line (LTTB)",
    description:
      "1M points, sampling=lttb. Cycles percent zoom windows to exercise resample + re-upload.",
    pointCount: 1_000_000,
    sampling: "lttb",
    samplingThreshold: 5000,
    enableZoom: true,
  },
  {
    id: "stream-append-lttb",
    label: "Stream append (LTTB)",
    description:
      "Seed 50k, sampling=lttb, append 64 pts/frame (full resample path).",
    pointCount: STREAM_SEED_POINTS,
    sampling: "lttb",
    samplingThreshold: 2500,
    enableZoom: false,
  },
  {
    id: "stream-append-none",
    label: "Stream append (sampling=none)",
    description:
      "Seed 50k, sampling=none, append 64 pts/frame (incremental append fast path).",
    pointCount: STREAM_SEED_POINTS,
    sampling: "none",
    samplingThreshold: 5000,
    enableZoom: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Math / data helpers
// ---------------------------------------------------------------------------

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const t = idx - lo;
  return sorted[lo]! * (1 - t) + sorted[hi]! * t;
}

function statsFrom(values: readonly number[]): PercentileStats {
  if (values.length === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return {
    mean: sum / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/** Deterministic xorshift32 sine + noise series (reproducible across runs). */
function generateSeriesData(count: number, seed = 0x12345678): {
  readonly data: ReadonlyArray<DataPoint>;
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
} {
  const n = Math.max(2, count | 0);
  const out: DataPoint[] = new Array(n);
  let state = seed | 0;
  const rand01 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };

  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const freq = 0.012;
  const lowFreq = 0.0017;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y =
      Math.sin(i * freq) * 0.95 +
      Math.sin(i * lowFreq + 1.1) * 0.6 +
      (rand01() - 0.5) * 0.35;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    out[i] = [x, y] as const;
  }

  const pad = 0.05 * (yMax - yMin || 1);
  return {
    data: out,
    xMin: 0,
    xMax: n - 1,
    yMin: yMin - pad,
    yMax: yMax + pad,
  };
}

function generateAppendBatch(
  startX: number,
  count: number,
  seed: number,
): ReadonlyArray<DataPoint> {
  const out: DataPoint[] = new Array(count);
  let state = (seed ^ (startX * 2654435761)) | 0;
  const rand01 = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = startX + i;
    const y =
      Math.sin(x * 0.012) * 0.95 +
      Math.sin(x * 0.0017 + 1.1) * 0.6 +
      (rand01() - 0.5) * 0.35;
    out[i] = [x, y] as const;
  }
  return out;
}

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = Math.max(0, n | 0);
    if (left === 0) {
      resolve();
      return;
    }
    const tick = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function parseQuery(): {
  scenario: ScenarioId | "all";
  warmup: number;
  measure: number;
  autorun: boolean;
  download: boolean;
} {
  const q = new URLSearchParams(window.location.search);
  const raw = (q.get("scenario") ?? "all").trim();
  const known = SCENARIOS.some((s) => s.id === raw);
  const scenario = (raw === "all" || known ? raw : "all") as ScenarioId | "all";
  const warmup = Math.max(0, Number(q.get("warmup") ?? DEFAULT_WARMUP) || DEFAULT_WARMUP);
  const measure = Math.max(
    30,
    Number(q.get("measure") ?? DEFAULT_MEASURE) || DEFAULT_MEASURE,
  );
  const autorun = q.get("autorun") !== "0";
  const download = q.get("download") === "1";
  return { scenario, warmup, measure, autorun, download };
}

async function probeWebGpuAdapter(): Promise<{
  description: string | null;
  preferredFormat: string | null;
}> {
  try {
    if (!navigator.gpu) return { description: null, preferredFormat: null };
    const preferredFormat = navigator.gpu.getPreferredCanvasFormat?.() ?? null;
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return { description: null, preferredFormat };

    // Prefer adapter.info when present; fall back to requestAdapterInfo if available.
    let description: string | null = "adapter";
    const maybeInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    if (maybeInfo) {
      description =
        [maybeInfo.vendor, maybeInfo.architecture, maybeInfo.device]
          .filter((x) => typeof x === "string" && x.length > 0)
          .join(" / ") || "adapter";
    } else {
      const req = (
        adapter as GPUAdapter & {
          requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
        }
      ).requestAdapterInfo;
      if (typeof req === "function") {
        try {
          const info = await req.call(adapter);
          description =
            [info.vendor, info.architecture, info.device]
              .filter((x) => typeof x === "string" && x.length > 0)
              .join(" / ") || "adapter";
        } catch {
          description = "adapter";
        }
      }
    }
    return { description, preferredFormat };
  } catch {
    return { description: null, preferredFormat: null };
  }
}

// ---------------------------------------------------------------------------
// Chart lifecycle
// ---------------------------------------------------------------------------

function buildOptions(
  def: ScenarioDef,
  series: ReturnType<typeof generateSeriesData>,
): ChartGPUOptions {
  const isStream =
    def.id === "stream-append-lttb" || def.id === "stream-append-none";
  return {
    renderMode: "external",
    animation: false,
    theme: "dark",
    palette: ["#4a9eff"],
    grid: { left: 56, right: 16, top: 16, bottom: 40 },
    xAxis: { type: "value", min: series.xMin, max: series.xMax },
    yAxis: { type: "value", min: series.yMin, max: series.yMax },
    tooltip: { show: true },
    // Stream scenarios: keep view pinned to latest data without setOption each frame.
    autoScroll: isStream,
    dataZoom: def.enableZoom
      ? [{ type: "inside" }, { type: "slider" }]
      : isStream
        ? [{ type: "inside" }, { type: "slider", start: 70, end: 100 }]
        : undefined,
    series: [
      {
        type: "line",
        name: "baseline",
        data: series.data,
        sampling: def.sampling,
        samplingThreshold: def.samplingThreshold,
        lineStyle: { width: 1.5, opacity: 1 },
        color: "#4a9eff",
      },
    ],
  };
}

async function createChart(
  container: HTMLElement,
  def: ScenarioDef,
  series: ReturnType<typeof generateSeriesData>,
): Promise<ChartGPUInstance> {
  container.replaceChildren();
  // Lock CSS size so DPR * size is stable across runs on the same machine.
  container.style.width = `${CANVAS_CSS_W}px`;
  container.style.height = `${CANVAS_CSS_H}px`;
  const chart = await ChartGPU.create(container, buildOptions(def, series));
  chart.resize();
  // Initial dirty render
  if (chart.needsRender()) chart.renderFrame();
  return chart;
}

// ---------------------------------------------------------------------------
// Scenario runners (stimulus + measure loop)
// ---------------------------------------------------------------------------

type Stimulus = (frameIndex: number) => void;

function makeStimulus(
  def: ScenarioDef,
  chart: ChartGPUInstance,
  series: ReturnType<typeof generateSeriesData>,
): { stimulus: Stimulus; notes: string[] } {
  const notes: string[] = [];
  let streamNextX = series.xMax + 1;
  let streamSeed = 0xabcdef01;

  if (def.id === "static-1m-lttb") {
    notes.push(
      "Forces dirty via alternating interaction-x (two domain samples) so renderFrame always runs.",
    );
    return {
      notes,
      stimulus: (i) => {
        const x = i % 2 === 0 ? series.xMin + (series.xMax - series.xMin) * 0.35 : series.xMin + (series.xMax - series.xMin) * 0.65;
        chart.setInteractionX(x, "baseline");
      },
    };
  }

  if (def.id === "hover-1m-lttb") {
    notes.push("Sweeps interaction-x across full domain each measure frame.");
    return {
      notes,
      stimulus: (i) => {
        const t = (i % 240) / 239;
        const x = series.xMin + t * (series.xMax - series.xMin);
        chart.setInteractionX(x, "baseline");
      },
    };
  }

  if (def.id === "zoom-pan-1m") {
    notes.push("Cycles zoom windows: full → 20% → 5% → pan → full.");
    const windows: ReadonlyArray<readonly [number, number]> = [
      [0, 100],
      [40, 60],
      [47.5, 52.5],
      [10, 30],
      [70, 90],
      [0, 100],
    ];
    return {
      notes,
      stimulus: (i) => {
        const w = windows[i % windows.length]!;
        chart.setZoomRange(w[0], w[1], "baseline");
      },
    };
  }

  if (def.id === "stream-append-lttb" || def.id === "stream-append-none") {
    notes.push(
      `Appends ${STREAM_BATCH} points/frame via appendData only (autoScroll=true); seed ${STREAM_SEED_POINTS} points.`,
    );
    return {
      notes,
      stimulus: () => {
        const batch = generateAppendBatch(streamNextX, STREAM_BATCH, streamSeed++);
        streamNextX += STREAM_BATCH;
        chart.appendData(0, batch);
      },
    };
  }

  return {
    notes: ["Unknown scenario; no stimulus."],
    stimulus: () => {
      chart.setInteractionX(series.xMin + (series.xMax - series.xMin) * 0.5, "baseline");
    },
  };
}

async function runScenario(
  container: HTMLElement,
  def: ScenarioDef,
  warmupFrames: number,
  measureFrames: number,
  onProgress: (msg: string) => void,
): Promise<ScenarioResult> {
  onProgress(`Generating ${def.pointCount.toLocaleString()} points…`);
  const series = generateSeriesData(def.pointCount);
  onProgress(`Creating chart (${def.id})…`);
  const chart = await createChart(container, def, series);

  const { stimulus, notes } = makeStimulus(def, chart, series);

  // Warmup: stabilize pipelines / caches / first-frame costs.
  onProgress(`Warmup ${warmupFrames} frames…`);
  for (let i = 0; i < warmupFrames; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        stimulus(i);
        const t0 = performance.now();
        if (chart.needsRender()) chart.renderFrame();
        else {
          // Ensure we still exercise a frame if something cleared dirty.
          chart.setInteractionX(
            series.xMin + ((i % 100) / 99) * (series.xMax - series.xMin),
            "baseline-warmup",
          );
          chart.renderFrame();
        }
        void t0;
        resolve();
      });
    });
  }

  // Measure window.
  onProgress(`Measuring ${measureFrames} frames…`);
  const cpuSamples: number[] = [];
  const frameDeltaSamples: number[] = [];
  let prevRaf = 0;
  const measureStart = performance.now();

  for (let i = 0; i < measureFrames; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame((ts) => {
        if (prevRaf > 0) frameDeltaSamples.push(ts - prevRaf);
        prevRaf = ts;

        stimulus(i);
        const t0 = performance.now();
        let rendered = false;
        if (chart.needsRender()) {
          rendered = chart.renderFrame();
        }
        if (!rendered) {
          // Fallback dirty so measurement never records a no-op frame.
          chart.setInteractionX(
            series.xMin + ((i % 200) / 199) * (series.xMax - series.xMin),
            "baseline-measure",
          );
          chart.renderFrame();
        }
        cpuSamples.push(performance.now() - t0);
        resolve();
      });
    });
  }

  const durationMs = performance.now() - measureStart;
  const fpsFromDelta = frameDeltaSamples.map((d) => (d > 0 ? 1000 / d : 0));

  let libraryFps: number | null = null;
  let libraryFrameTimeMs: number | null = null;
  let droppedFrames: number | null = null;
  try {
    const m: Readonly<PerformanceMetrics> | null = chart.getPerformanceMetrics();
    if (m) {
      libraryFps = m.fps;
      libraryFrameTimeMs = m.frameTimeStats.avg;
      droppedFrames = m.frameDrops.totalDrops;
    }
  } catch {
    // best-effort
  }

  chart.dispose();

  return {
    id: def.id,
    description: def.description,
    pointCount: def.pointCount,
    sampling: def.sampling,
    warmupFrames,
    measureFrames,
    measuredFrames: cpuSamples.length,
    durationMs,
    fps: statsFrom(fpsFromDelta),
    cpuMs: statsFrom(cpuSamples),
    libraryFps,
    libraryFrameTimeMs,
    droppedFrames,
    notes,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function setText(el: HTMLElement | null, text: string, isError = false): void {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function summarize(report: BaselineReport): string {
  const lines: string[] = [
    `schema v${report.schemaVersion} · ${report.scenarios.length} scenario(s)`,
    `adapter: ${report.environment.webgpuAdapter ?? "unknown"}`,
    `dpr=${report.environment.devicePixelRatio} canvas=${report.environment.canvasCssWidth}x${report.environment.canvasCssHeight}`,
    "",
  ];
  for (const s of report.scenarios) {
    lines.push(
      `${s.id}: fps p50=${fmt(s.fps.p50, 1)} mean=${fmt(s.fps.mean, 1)} | cpuMs p50=${fmt(s.cpuMs.p50)} p95=${fmt(s.cpuMs.p95)} | libFps=${s.libraryFps != null ? fmt(s.libraryFps, 1) : "n/a"}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const chartEl = document.getElementById("chart");
  const statusEl = document.getElementById("status");
  const reportEl = document.getElementById("report");
  const scenarioSelect = document.getElementById(
    "scenario-select",
  ) as HTMLSelectElement | null;
  const warmupInput = document.getElementById(
    "warmup-input",
  ) as HTMLInputElement | null;
  const measureInput = document.getElementById(
    "measure-input",
  ) as HTMLInputElement | null;
  const runOneBtn = document.getElementById("run-one") as HTMLButtonElement | null;
  const runAllBtn = document.getElementById("run-all") as HTMLButtonElement | null;
  const downloadBtn = document.getElementById(
    "download",
  ) as HTMLButtonElement | null;
  const copyBtn = document.getElementById("copy") as HTMLButtonElement | null;
  const envPill = document.getElementById("env-pill");
  const statePill = document.getElementById("state-pill");

  if (!(chartEl instanceof HTMLElement)) {
    throw new Error("Missing #chart");
  }

  const query = parseQuery();
  if (warmupInput) warmupInput.value = String(query.warmup);
  if (measureInput) measureInput.value = String(query.measure);

  if (scenarioSelect) {
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All scenarios";
    scenarioSelect.append(allOpt);
    for (const s of SCENARIOS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      scenarioSelect.append(opt);
    }
    scenarioSelect.value = query.scenario;
  }

  const adapterInfo = await probeWebGpuAdapter();
  if (envPill) {
    envPill.textContent = adapterInfo.description
      ? `GPU: ${adapterInfo.description}`
      : navigator.gpu
        ? "WebGPU: adapter unknown"
        : "WebGPU unavailable";
  }

  if (!navigator.gpu) {
    setText(
      statusEl,
      "WebGPU is not available in this browser. Use Chrome/Edge 113+ or Safari 18+.",
      true,
    );
    return;
  }

  let lastReport: BaselineReport | null = null;

  const setBusy = (busy: boolean, label: string): void => {
    if (runOneBtn) runOneBtn.disabled = busy;
    if (runAllBtn) runAllBtn.disabled = busy;
    if (statePill) {
      statePill.textContent = label;
      statePill.className = busy ? "pill run" : "pill ok";
    }
  };

  const enableExport = (enabled: boolean): void => {
    if (downloadBtn) downloadBtn.disabled = !enabled;
    if (copyBtn) copyBtn.disabled = !enabled;
  };

  const buildReport = async (
    results: ScenarioResult[],
    warmup: number,
    measure: number,
  ): Promise<BaselineReport> => {
    // Best-effort commit from injected meta or null (filled offline when saving baselines).
    const commitMeta = document.querySelector('meta[name="chartgpu-commit"]');
    const commit =
      commitMeta?.getAttribute("content")?.trim() ||
      (window as unknown as { __CHARTGPU_COMMIT__?: string }).__CHARTGPU_COMMIT__ ||
      null;

    return {
      schemaVersion: 1,
      kind: "chartgpu-performance-baseline",
      generatedAt: new Date().toISOString(),
      commit,
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        devicePixelRatio: window.devicePixelRatio || 1,
        canvasCssWidth: CANVAS_CSS_W,
        canvasCssHeight: CANVAS_CSS_H,
        webgpuAdapter: adapterInfo.description,
        preferredFormat: adapterInfo.preferredFormat,
      },
      config: { warmupFrames: warmup, measureFrames: measure },
      scenarios: results,
    };
  };

  const publishReport = (report: BaselineReport, alsoDownload: boolean): void => {
    lastReport = report;
    const json = JSON.stringify(report, null, 2);
    const jsonCompact = JSON.stringify(report);
    if (reportEl) reportEl.textContent = json;
    setText(statusEl, summarize(report));
    enableExport(true);
    // Expose for automation (Playwright / agent-browser / DevTools).
    const w = window as unknown as {
      __CHARTGPU_BASELINE_REPORT__?: BaselineReport;
      __CHARTGPU_BASELINE_JSON__?: string;
      __CHARTGPU_BASELINE_DONE__?: boolean;
    };
    w.__CHARTGPU_BASELINE_REPORT__ = report;
    w.__CHARTGPU_BASELINE_JSON__ = jsonCompact;
    w.__CHARTGPU_BASELINE_DONE__ = true;

    // Machine-readable markers for autonomous log scraping (one line each).
    // Agents should wait for BASELINE_DONE then parse BASELINE_JSON_BEGIN…END or window globals.
    console.log("CHARTGPU_BASELINE_DONE");
    console.log("CHARTGPU_BASELINE_JSON_BEGIN");
    console.log(jsonCompact);
    console.log("CHARTGPU_BASELINE_JSON_END");
    console.info("[ChartGPU baseline] report ready", {
      scenarios: report.scenarios.map((s) => s.id),
      adapter: report.environment.webgpuAdapter,
    });

    if (alsoDownload) {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chartgpu-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const run = async (ids: readonly ScenarioId[]): Promise<void> => {
    const warmup = Math.max(
      0,
      Number(warmupInput?.value ?? query.warmup) || query.warmup,
    );
    const measure = Math.max(
      30,
      Number(measureInput?.value ?? query.measure) || query.measure,
    );

    setBusy(true, "running");
    enableExport(false);
    (window as unknown as { __CHARTGPU_BASELINE_DONE__?: boolean }).__CHARTGPU_BASELINE_DONE__ =
      false;

    const results: ScenarioResult[] = [];
    try {
      for (let s = 0; s < ids.length; s++) {
        const id = ids[s]!;
        const def = SCENARIOS.find((x) => x.id === id);
        if (!def) continue;
        setText(
          statusEl,
          `Scenario ${s + 1}/${ids.length}: ${def.id}\n${def.description}`,
        );
        // Yield so UI updates.
        await waitFrames(2);
        const result = await runScenario(
          chartEl,
          def,
          warmup,
          measure,
          (msg) => setText(statusEl, `[${def.id}] ${msg}`),
        );
        results.push(result);
      }

      const report = await buildReport(results, warmup, measure);
      publishReport(report, query.download);
      setBusy(false, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setText(statusEl, `Benchmark failed: ${message}`, true);
      setBusy(false, "error");
      console.error(err);
    }
  };

  runOneBtn?.addEventListener("click", () => {
    const v = (scenarioSelect?.value ?? "all") as ScenarioId | "all";
    const ids =
      v === "all" ? SCENARIOS.map((s) => s.id) : ([v] as ScenarioId[]);
    void run(ids);
  });

  runAllBtn?.addEventListener("click", () => {
    void run(SCENARIOS.map((s) => s.id));
  });

  downloadBtn?.addEventListener("click", () => {
    if (!lastReport) return;
    const json = JSON.stringify(lastReport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chartgpu-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  copyBtn?.addEventListener("click", async () => {
    if (!lastReport) return;
    const json = JSON.stringify(lastReport, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setText(statusEl, `${summarize(lastReport)}\n\n(Copied JSON to clipboard)`);
    } catch {
      setText(statusEl, "Clipboard write failed — use Download JSON.", true);
    }
  });

  setText(
    statusEl,
    "Ready. Production preview recommended.\nClick Run scenario / Run all, or use ?autorun=1.",
  );

  if (query.autorun) {
    const ids =
      query.scenario === "all"
        ? SCENARIOS.map((s) => s.id)
        : ([query.scenario] as ScenarioId[]);
    // Defer so first paint + adapter label show.
    await waitFrames(3);
    void run(ids);
  }
}

main().catch((err) => {
  console.error(err);
  const statusEl = document.getElementById("status");
  setText(
    statusEl,
    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
    true,
  );
});
