/**
 * Acceptance: logarithmic axis scale + ticks + option resolution (no WebGPU).
 * Run: tsx examples/acceptance/log-axis-scale.ts
 *
 * Imports pure TS modules only (avoid package entry / WGSL raw imports).
 */
import {
  createLogScale,
  createAxisScale,
  createLinearScale,
  normalizeLogBase,
} from '../../src/utils/scales';
import { resolveOptions } from '../../src/config/OptionResolver';
import { sanitizeLogDomain } from '../../src/core/renderCoordinator/utils/boundsComputation';
import {
  generateLogTicks,
  generateLogTicksForVisibleDomain,
  formatLogTickValue,
} from '../../src/core/renderCoordinator/axis/computeAxisTicks';
import {
  computeClipAffineFromContinuousScale,
  computeClipAffineFromScale,
} from '../../src/renderers/packedXAffine';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// --- createLogScale round-trip ---
{
  const s = createLogScale(10).domain(0.01, 1000).range(0, 500);
  for (const v of [0.01, 1, 10, 1000]) {
    const p = s.scale(v);
    const back = s.invert(p);
    assert(Math.abs(back / v - 1) < 1e-10, `round-trip failed for ${v}: got ${back}`);
  }
  assert(s.kind === 'log', 'kind should be log');
  assert(s.base === 10, 'base should be 10');
}

// --- generateLogTicks boundaries ---
{
  const ticks = generateLogTicks(0.01, 1000, 10);
  const expected = [0.01, 0.1, 1, 10, 100, 1000];
  assert(ticks.length === expected.length, `tick count ${ticks.length} != ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert(Math.abs(ticks[i]! - expected[i]!) < 1e-12, `tick[${i}] ${ticks[i]} != ${expected[i]}`);
  }
}

// --- generateLogTicksForVisibleDomain densifies zoomed sub-range ---
{
  const ticks = generateLogTicksForVisibleDomain(2e3, 8e3, 10);
  assert(ticks.length >= 3, `zoomed log ticks should densify, got ${ticks.length}`);
  assert(!ticks.includes(1e3) && !ticks.includes(1e4), 'must not emit out-of-window decade powers');
  assert(
    ticks.every((t) => t >= 2e3 * (1 - 1e-12) && t <= 8e3 * (1 + 1e-12)),
    'all ticks must lie in visible domain'
  );
  assert(ticks.includes(2e3) && ticks.includes(5e3), 'expected 2e3 and 5e3 mantissas');
}

{
  const ticks = generateLogTicksForVisibleDomain(500, 2e4, 10);
  assert(ticks.includes(1e3) && ticks.includes(1e4), 'majors inside window must remain');
}

// --- OptionResolver type: log + default base ---
{
  const r = resolveOptions({
    yAxis: { type: 'log', name: 'Pressure' },
    series: [{ type: 'line', data: [[1, 1], [2, 10]] }],
  });
  assert(r.yAxes[0]!.type === 'log', 'resolved yAxis type should be log');
  assert(r.yAxes[0]!.logBase === 10, `default logBase should be 10, got ${r.yAxes[0]!.logBase}`);
}

{
  const r = resolveOptions({
    xAxis: { type: 'log', logBase: 2, min: 1, max: 1024 },
    series: [{ type: 'line', data: [[1, 0], [2, 1]] }],
  });
  assert(r.xAxis.type === 'log', 'xAxis type log');
  assert(r.xAxis.logBase === 2, 'xAxis logBase 2');
}

// --- Non-positive domain sanitizer ---
{
  const s = sanitizeLogDomain(-1, 0, { base: 10, warn: false });
  assert(s.min > 0 && s.max > s.min, 'sanitized domain must be positive');
  assert(s.warned, 'should warn on non-positive');
}

// --- Affine helper linear parity ---
{
  const lin = createLinearScale().domain(-5, 15).range(-1, 1);
  const a = computeClipAffineFromContinuousScale(lin);
  const b = computeClipAffineFromScale(lin, 0, 1);
  assert(Math.abs(a.a - b.a) < 1e-12 && Math.abs(a.b - b.b) < 1e-12, 'linear affine parity');
}

// --- createAxisScale ---
{
  assert(createAxisScale({ type: 'log' }).kind === 'log', 'axis factory log');
  assert(createAxisScale({ type: 'value' }).kind === 'linear', 'axis factory linear');
  assert(normalizeLogBase(1) === 10, 'invalid base falls back');
}

// --- formatLogTickValue ---
{
  assert(formatLogTickValue(1000, 10) === '1e3', 'format 1e3');
  assert(formatLogTickValue(1, 10) === '1', 'format 1');
}

console.log('log-axis-scale acceptance: OK');
