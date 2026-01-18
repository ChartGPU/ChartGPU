import { createZoomState } from '../../src/interaction/createZoomState';

// TypeScript-only acceptance checks for Story 5.2.
// This file is excluded from the library build (tsconfig excludes `examples/`).

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const assertRange = (
  label: string,
  actual: { start: number; end: number },
  expectedStart: number,
  expectedEnd: number,
): void => {
  if (actual.start !== expectedStart || actual.end !== expectedEnd) {
    throw new Error(
      `${label}: expected { start: ${expectedStart}, end: ${expectedEnd} } but got { start: ${actual.start}, end: ${actual.end} }`,
    );
  }
};

// setRange clamp + ordering
{
  const z = createZoomState(0, 100);

  z.setRange(80, 20);
  assertRange('setRange orders (80, 20)', z.getRange(), 20, 80);

  z.setRange(120, -10);
  assertRange('setRange clamps + orders (120, -10)', z.getRange(), 0, 100);
}

// zoomIn/zoomOut no-op when factor <= 1 (and should not emit)
{
  const z = createZoomState(20, 40);
  const initial = z.getRange();

  let calls = 0;
  z.onChange(() => {
    calls += 1;
  });

  z.zoomIn(30, 1);
  z.zoomIn(30, 0.5);
  z.zoomOut(30, 1);
  z.zoomOut(30, 0.5);

  assertRange('zoom factor<=1 does not change range', z.getRange(), initial.start, initial.end);
  assert(calls === 0, `Expected no onChange emissions for factor<=1 zoom ops, got ${calls}.`);
}

// zoomIn/zoomOut apply when factor > 1 and emit exactly once per change
{
  const z = createZoomState(20, 40);

  let calls = 0;
  let last: { start: number; end: number } | null = null;
  z.onChange((r) => {
    calls += 1;
    last = r;
  });

  z.zoomIn(30, 2); // span 20 -> 10, anchored at midpoint
  assertRange('zoomIn(center=30,factor=2) updates range', z.getRange(), 25, 35);
  assert(calls === 1, `Expected 1 emission after zoomIn change, got ${calls}.`);
  assert(last !== null, 'Expected zoomIn to provide a range payload.');
  assertRange('zoomIn payload matches state', last!, 25, 35);

  z.zoomOut(30, 2); // span 10 -> 20, returns to original
  assertRange('zoomOut(center=30,factor=2) updates range', z.getRange(), 20, 40);
  assert(calls === 2, `Expected 2 total emissions after zoomOut change, got ${calls}.`);
  assertRange('zoomOut payload matches state', last!, 20, 40);
}

// zoomOut clamps to max span (defaults to 100) and emits
{
  const z = createZoomState(20, 40);
  let calls = 0;
  z.onChange(() => {
    calls += 1;
  });

  z.zoomOut(30, 10); // proposed span 200 -> should clamp to full extent 0..100
  assertRange('zoomOut clamps to max span', z.getRange(), 0, 100);
  assert(calls === 1, `Expected 1 emission after zoomOut clamp, got ${calls}.`);
}

// pan preserves span, clamps at 0-100
{
  const z = createZoomState(20, 40);

  z.pan(70); // proposed: 90..110 -> should clamp/shift to 80..100 (span preserved)
  assertRange('pan(+70) clamps within [0,100] preserving span', z.getRange(), 80, 100);

  z.pan(-200); // proposed: -120..-100 -> should clamp/shift to 0..20
  assertRange('pan(-200) clamps within [0,100] preserving span', z.getRange(), 0, 20);
}

// invalid / non-finite inputs should no-op and should not emit
{
  const z = createZoomState(10, 30);
  let calls = 0;
  z.onChange(() => {
    calls += 1;
  });

  z.setRange(Number.NaN, 50);
  z.setRange(10, Number.POSITIVE_INFINITY);
  z.zoomIn(Number.NaN, 2);
  z.zoomIn(20, Number.NaN);
  z.zoomOut(Number.NaN, 2);
  z.zoomOut(20, Number.NaN);
  z.pan(Number.NaN);

  assertRange('non-finite inputs do not change range', z.getRange(), 10, 30);
  assert(calls === 0, `Expected no emissions for non-finite inputs, got ${calls}.`);
}

// onChange fires only on actual changes and unsubscribe stops firing
{
  const z = createZoomState(10, 30);

  let calls = 0;
  const unsubscribe = z.onChange(() => {
    calls += 1;
  });

  // No-op: identical range
  z.setRange(10, 30);
  assert(calls === 0, `Expected no emissions for no-op setRange, got ${calls}.`);

  // No-op: identical range after ordering (should not emit)
  z.setRange(30, 10);
  assert(calls === 0, `Expected no emissions for no-op setRange after ordering, got ${calls}.`);

  // Actual change: should emit once
  z.setRange(12, 28);
  assert(calls === 1, `Expected 1 emission after changing range, got ${calls}.`);

  // No-op: zoom factor<=1
  z.zoomIn(20, 1);
  assert(calls === 1, `Expected no additional emissions for no-op zoomIn, got ${calls}.`);

  unsubscribe();

  // After unsubscribe: should not emit
  z.setRange(0, 100);
  assert(calls === 1, `Expected unsubscribe to stop emissions; got ${calls}.`);
}

