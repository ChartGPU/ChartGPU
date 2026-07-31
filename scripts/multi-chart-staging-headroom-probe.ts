/**
 * Phase 0 isolation protocol + H1 causal proof (multi-chart staging headroom).
 *
 * Goal: docs/plans/2026-07-31-multi-chart-memory-staging-headroom-goal.md
 *
 * This script is an **offline unit/math probe** — no browser WebGPU required.
 * It mirrors DataStore setSeries capacity math (A = legacy 1M floor, B = ship
 * policy: nextPow2(seedBytes × 2)) and reports sum staging bytes for N charts.
 *
 * **Source of truth:** unit tests in
 * `src/data/__tests__/createDataStore.test.ts` →
 * `streaming headroom policy (setSeries modest vs append cap)`
 * (especially `live setSeries capacity matches ship formula for key sizes`).
 * If mult/threshold changes in createDataStore, update those tests first, then
 * this probe’s `capacityBytesShip` / `capacityBytesLegacy` to match.
 *
 * Primary causal instrument (GC-independent):
 *   sumStagingBytes = N × capacityBytes(policy, pointsPerChart)
 *
 * Run:
 *   bunx tsx scripts/multi-chart-staging-headroom-probe.ts
 *   bunx tsx scripts/multi-chart-staging-headroom-probe.ts --n=64 --points=100000
 *
 * Multi‑M note: production also runs `clampSeriesCapacityBytes` against
 * `maxStorageBufferBindingSize` (often 128 MiB). This probe does **not** apply
 * that clamp — use mid-size seeds (e.g. 100k) for H1; for multi‑M compare
 * against unit tests that use a mock device with realistic limits.
 *
 * Browser A/B (optional, production dist; E1 deferred if not run):
 *   1. bun run build
 *   2. Suite: http://localhost:5173/chartgpu/chartgpu.html?test_group_id=10
 *      (single-row only — do not run N=1…128 ladder for causal measurement)
 *   3. Chrome with --js-flags=--expose-gc; call gc() before create when available
 *   4. Compare usedJSHeapSize after_seed A vs B; expect Δ ≈ N×8 MiB order of magnitude
 *   5. Archive under baselines/multi-chart-mem-ab-YYYYMMDD/
 */

function nextPow2(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 1;
  const n = Math.ceil(bytes);
  return 2 ** Math.ceil(Math.log2(n));
}

/** Legacy (pre-fix) setSeries mid-size policy: mult 4 + absolute 1M-point floor. */
function capacityBytesLegacy(pointCount: number): number {
  const targetBytes = pointCount * 8;
  if (pointCount < 10_000) return nextPow2(targetBytes);
  const mult = pointCount >= 1_000_000 ? 2 : 4;
  const minReservePts = pointCount >= 1_000_000 ? pointCount : 1_000_000;
  return nextPow2(Math.max(targetBytes * mult, minReservePts * 2 * 4));
}

/**
 * Ship policy: mult 2, no absolute 1M floor (mid-size and multi-M).
 * Omits device clampSeriesCapacityBytes — see header multi‑M note.
 */
function capacityBytesShip(pointCount: number): number {
  const targetBytes = pointCount * 8;
  if (pointCount < 10_000) return nextPow2(targetBytes);
  return nextPow2(targetBytes * 2);
}

function parseArgs(argv: string[]): { n: number; points: number } {
  let n = 64;
  let points = 100_000;
  for (const a of argv) {
    const mN = /^--n=(\d+)$/.exec(a);
    if (mN) n = Number(mN[1]);
    const mP = /^--points=(\d+)$/.exec(a);
    if (mP) points = Number(mP[1]);
  }
  return { n, points };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(3);
}

function main(): void {
  const { n, points } = parseArgs(process.argv.slice(2));
  const targetBytes = points * 8;
  const capA = capacityBytesLegacy(points);
  const capB = capacityBytesShip(points);
  const sumA = n * capA;
  const sumB = n * capB;
  const delta = sumA - sumB;
  const expectedFloorDelta = n * 1_000_000 * 8; // H1 rough order: N × 8 MiB before pow2

  // Plan ±40% on N×8 MiB → ratio in [0.6, 1.4]
  const h1_confirmed =
    delta >= expectedFloorDelta * 0.6 &&
    delta <= expectedFloorDelta * 1.4 &&
    sumB < sumA &&
    capB < 1_000_000 * 8 &&
    capB <= targetBytes * 4;

  const log = {
    protocol: 'unit_math_staging_sum',
    variant_A: 'A_legacy_1M_floor',
    variant_B: 'B_no_1M_floor_mult2',
    chartsN: n,
    pointsPerChart: points,
    phase: 'after_seed',
    targetBytesPerSeries: targetBytes,
    capacityBytes_A: capA,
    capacityBytes_B: capB,
    sumStagingBytes_A: sumA,
    sumStagingBytes_B: sumB,
    deltaBytes: delta,
    sumStagingMB_A: Number(mb(sumA)),
    sumStagingMB_B: Number(mb(sumB)),
    deltaMB: Number(mb(delta)),
    expectedFloorBytes_Nx8MiB: expectedFloorDelta,
    deltaVsNx8MiB_ratio: delta / expectedFloorDelta,
    h1_confirmed,
    note:
      'Staging sum is GC-independent causal instrument for H1. Full browser usedJSHeapSize A/B is optional corroboration (production dist + expose-gc). Multi-M omit clamp — see header.',
  };

  console.log(JSON.stringify(log, null, 2));

  console.log('\n--- Protocol checklist (browser optional) ---');
  console.log('1. Single-row only (N=32 or 64 primary)');
  console.log('2. Force GC before create when window.gc available');
  console.log('3. Shared GPUDevice + pipelineCache (G10 harness already does)');
  console.log('4. Seed pointsPerChart per chart; sample after_seed');
  console.log('5. Primary causal signal: sumStaging or Δ heap ≈ N×8 MiB order');
  console.log(`6. This run: N=${n} points=${points} Δ_staging=${mb(delta)} MiB (A−B)`);
  if (points >= 1_000_000) {
    console.log(
      '7. WARNING: multi-M ship capacity here is unclamped; production clamps to maxStorageBufferBindingSize'
    );
  }
}

main();
