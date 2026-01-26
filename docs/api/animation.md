# Animation

## Animation controller (internal)

ChartGPU includes a small internal controller for driving time-based value tweens (scalar or numeric arrays).

See [`createAnimationController.ts`](../../src/core/createAnimationController.ts) for the implementation and full TypeScript types.

- **Factory**: `createAnimationController(): AnimationController`
- **`AnimationController.animate(from, to, duration, easing, onUpdate, onComplete?) => symbol`**
  - **Value types**: `from`/`to` are either `number` or `ReadonlyArray<number>` (array lengths must match).
  - **Timebase**: `duration` is in ms; easing is an [`EasingFunction`](../../src/utils/easing.ts) (`(t: number) => number`) where `t` is treated as \([0, 1]\).
  - **Updates**: calls `onUpdate(interpolated)` each `update(timestamp)` tick while active.
- **`AnimationController.cancel(animationId): void`**: stops a specific animation (does not call `onComplete`).
- **`AnimationController.cancelAll(): void`**: stops all animations (does not call `onComplete`).
- **`AnimationController.update(timestamp): void`**: progresses all active animations to `timestamp` (ms), intended to be called from a frame loop (e.g. `requestAnimationFrame` timestamp).

For a minimal acceptance check (0→100 over 300ms with easing), see [`examples/acceptance/animation-controller.ts`](../../examples/acceptance/animation-controller.ts).

For animation configuration options, see [Animation Configuration](options.md#animation-configuration).
