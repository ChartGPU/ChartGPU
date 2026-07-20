import { describe, it, expect } from 'vitest';
import { createMat4, identityMat4, invertMat4, lookAt, multiplyMat4, perspective } from '../mat4';
import { projectWorldToCss, unprojectCssRay } from '../projectWorldToCss';

describe('projectWorldToCss', () => {
  it('projects origin near viewport center for identity-ish camera', () => {
    const view = createMat4();
    lookAt(view, [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = createMat4();
    perspective(proj, Math.PI / 4, 1, 0.1, 100);
    const vp = multiplyMat4(createMat4(), proj, view);
    const p = projectWorldToCss(vp, 0, 0, 0, 200, 200);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(100, 0);
    expect(p.y).toBeCloseTo(100, 0);
  });

  it('invertMat4 round-trips identity', () => {
    const m = identityMat4();
    const inv = invertMat4(m);
    expect(inv).not.toBeNull();
    expect(inv![0]).toBeCloseTo(1);
    expect(inv![15]).toBeCloseTo(1);
  });

  it('unprojectCssRay returns unit dir', () => {
    const view = createMat4();
    lookAt(view, [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const proj = createMat4();
    perspective(proj, Math.PI / 4, 1, 0.1, 100);
    const vp = multiplyMat4(createMat4(), proj, view);
    const inv = invertMat4(vp)!;
    const ray = unprojectCssRay(inv, 100, 100, 200, 200);
    expect(ray).not.toBeNull();
    const len = Math.hypot(ray!.dir[0], ray!.dir[1], ray!.dir[2]);
    expect(len).toBeCloseTo(1, 5);
  });
});
