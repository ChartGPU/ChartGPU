import { describe, it, expect } from 'vitest';
import {
  createMat4,
  identityMat4,
  lookAt,
  multiplyMat4,
  perspective,
  orthographic,
  transformPoint,
  normalizeVec3,
  crossVec3,
  dotVec3,
} from '../mat4';
import {
  applyCameraOptions,
  buildViewProj,
  createDefaultOrbitCameraState,
  eyeFromOrbit,
  fitCameraToAABB,
  orbitByPixels,
  panByPixels,
  toResolvedCamera,
  zoomByWheel,
} from '../camera';
import {
  aabbHalfDiagonal,
  expandAABBPoint,
  expandAABB,
  emptyAABB,
  isValidAABB,
  sanitizeAABB,
  aabbCenter,
} from '../aabb';
import { pickNearestPointCloud, pointCloudPickStep } from '../pickPointCloud';

describe('mat4', () => {
  it('identity leaves point unchanged', () => {
    const m = identityMat4();
    const p = transformPoint(m, 1, 2, 3);
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(2);
    expect(p[2]).toBeCloseTo(3);
    expect(p[3]).toBeCloseTo(1);
  });

  it('lookAt produces orthonormal basis (right-handed Y-up)', () => {
    const m = createMat4();
    lookAt(m, [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const r: [number, number, number] = [m[0]!, m[4]!, m[8]!];
    const u: [number, number, number] = [m[1]!, m[5]!, m[9]!];
    const f: [number, number, number] = [m[2]!, m[6]!, m[10]!];
    expect(Math.hypot(...r)).toBeCloseTo(1, 5);
    expect(Math.hypot(...u)).toBeCloseTo(1, 5);
    expect(Math.hypot(...f)).toBeCloseTo(1, 5);
    expect(dotVec3(r, u)).toBeCloseTo(0, 5);
    expect(dotVec3(u, f)).toBeCloseTo(0, 5);
  });

  it('lookAt handles up parallel to view (degenerate cross)', () => {
    const m = createMat4();
    lookAt(m, [0, 5, 0], [0, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 16; i++) expect(Number.isFinite(m[i]!)).toBe(true);
  });

  it('perspective multiplies with view without NaN', () => {
    const view = createMat4();
    lookAt(view, [2, 2, 2], [0, 0, 0], [0, 1, 0]);
    const proj = createMat4();
    perspective(proj, Math.PI / 4, 16 / 9, 0.1, 100);
    const vp = createMat4();
    multiplyMat4(vp, proj, view);
    const clip = transformPoint(vp, 0, 0, 0);
    expect(Number.isFinite(clip[0])).toBe(true);
    expect(Number.isFinite(clip[3])).toBe(true);
    expect(Math.abs(clip[3])).toBeGreaterThan(0);
  });

  it('orthographic projects origin near NDC center', () => {
    const m = createMat4();
    orthographic(m, 2, 1, 0.1, 100);
    const p = transformPoint(m, 0, 0, -1);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
  });

  it('normalizeVec3 / crossVec3 basics', () => {
    const n = normalizeVec3([0, 0, 0]);
    expect(n[1]).toBe(1);
    const c = crossVec3([1, 0, 0], [0, 1, 0]);
    expect(c[2]).toBeCloseTo(1);
  });
});

describe('camera orbit', () => {
  it('creates default state and resolved camera', () => {
    const s = createDefaultOrbitCameraState();
    const r = toResolvedCamera(s);
    expect(r.type).toBe('perspective');
    expect(r.eye.length).toBe(3);
    expect(Number.isFinite(r.eye[0])).toBe(true);
  });

  it('fitCameraToAABB centers target and sets distance', () => {
    const s = createDefaultOrbitCameraState();
    fitCameraToAABB(s, { min: [0, 0, 0], max: [10, 2, 4] });
    expect(s.target[0]).toBeCloseTo(5);
    expect(s.target[1]).toBeCloseTo(1);
    expect(s.target[2]).toBeCloseTo(2);
    expect(s.distance).toBeGreaterThan(1);
    expect(s.needsFit).toBe(false);
  });

  it('fitCameraToAABB sets orthoSize for orthographic', () => {
    const s = createDefaultOrbitCameraState();
    s.type = 'orthographic';
    fitCameraToAABB(s, { min: [-2, -2, -2], max: [2, 2, 2] });
    expect(s.orthoSize).toBeGreaterThan(0);
  });

  it('orbitByPixels clamps pitch', () => {
    const s = createDefaultOrbitCameraState();
    s.pitch = 0;
    orbitByPixels(s, 0, 1e6, 1);
    expect(s.pitch).toBeLessThan(Math.PI / 2);
    orbitByPixels(s, 0, -1e6, 1);
    expect(s.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('panByPixels moves target', () => {
    const s = createDefaultOrbitCameraState();
    fitCameraToAABB(s, { min: [-1, -1, -1], max: [1, 1, 1] });
    const t0 = [...s.target];
    panByPixels(s, 40, 0, 400, 1);
    expect(Math.hypot(s.target[0] - t0[0]!, s.target[1] - t0[1]!, s.target[2] - t0[2]!)).toBeGreaterThan(0);
  });

  it('zoomByWheel changes distance / orthoSize', () => {
    const s = createDefaultOrbitCameraState();
    const d0 = s.distance;
    zoomByWheel(s, 100, 1);
    expect(s.distance).toBeGreaterThan(d0);
    s.type = 'orthographic';
    s.orthoSize = 2;
    zoomByWheel(s, -100, 1);
    expect(s.orthoSize).toBeLessThan(2);
  });

  it('applyCameraOptions locks eye/target', () => {
    const s = createDefaultOrbitCameraState();
    applyCameraOptions(s, {
      eye: [0, 0, 10],
      target: [0, 0, 0],
      type: 'orthographic',
      orthoSize: 5,
    });
    expect(s.userLocked).toBe(true);
    expect(s.type).toBe('orthographic');
    expect(s.orthoSize).toBe(5);
    const eye = eyeFromOrbit(s);
    expect(eye[2]).toBeCloseTo(10, 4);
  });

  it('applyCameraOptions eye-only updates orbit around existing target', () => {
    const s = createDefaultOrbitCameraState();
    s.target = [1, 2, 3];
    applyCameraOptions(s, { eye: [1, 2, 13] });
    expect(s.userLocked).toBe(true);
    expect(s.distance).toBeCloseTo(10, 4);
  });

  it('buildViewProj projects AABB center near NDC origin', () => {
    const s = createDefaultOrbitCameraState();
    const aabb = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };
    fitCameraToAABB(s, aabb);
    const vp = buildViewProj(s, 1);
    const c = aabbCenter(aabb);
    const clip = transformPoint(vp, c[0], c[1], c[2]);
    expect(Math.abs(clip[3])).toBeGreaterThan(1e-6);
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    expect(Math.abs(ndcX)).toBeLessThan(0.15);
    expect(Math.abs(ndcY)).toBeLessThan(0.15);
  });
});

describe('aabb', () => {
  it('expand and sanitize', () => {
    const b = emptyAABB();
    expandAABBPoint(b, 1, 2, 3);
    expandAABBPoint(b, -1, 0, 5);
    expect(isValidAABB({ min: b.min, max: b.max })).toBe(true);
    const half = aabbHalfDiagonal({ min: b.min, max: b.max });
    expect(half).toBeGreaterThan(0);
    const san = sanitizeAABB(null);
    expect(isValidAABB(san)).toBe(true);
  });

  it('expandAABB merges boxes', () => {
    const b = emptyAABB();
    expandAABB(b, { min: [0, 0, 0], max: [1, 1, 1] });
    expandAABB(b, { min: [-2, 0, 0], max: [0, 3, 0] });
    expect(b.min[0]).toBe(-2);
    expect(b.max[1]).toBe(3);
  });

  it('sanitizeAABB expands zero-thickness axes', () => {
    const s = sanitizeAABB({ min: [5, 5, 5], max: [5, 5, 5] });
    expect(s.max[0] - s.min[0]).toBeGreaterThan(0);
  });
});

describe('pickNearestPointCloud', () => {
  it('pointCloudPickStep is 1 below threshold and fixed stride above', () => {
    expect(pointCloudPickStep(1000)).toBe(1);
    expect(pointCloudPickStep(100_000)).toBe(2);
    expect(pointCloudPickStep(150_000)).toBe(3);
  });

  it('hits projected center and misses far threshold', () => {
    // Identity-ish: place point at origin; camera looking down -Z from +Z
    const s = createDefaultOrbitCameraState();
    s.target = [0, 0, 0];
    s.yaw = 0;
    s.pitch = 0;
    s.distance = 5;
    s.fovY = Math.PI / 4;
    const vp = buildViewProj(s, 1);
    const packed = new Float32Array([0, 0, 0, 1]);
    const hit = pickNearestPointCloud(packed, 1, vp, 200, 200, 400, 400, 20);
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
    expect(hit!.x).toBe(0);
    expect(hit!.z).toBe(0);

    const miss = pickNearestPointCloud(packed, 1, vp, 0, 0, 400, 400, 5);
    expect(miss).toBeNull();
  });

  it('uses fixed stride for large N without soft-guard', () => {
    const n = 60_000;
    const packed = new Float32Array(n * 4);
    // Only index 0 is at origin; others far away
    packed[0] = 0;
    packed[1] = 0;
    packed[2] = 0;
    for (let i = 1; i < n; i++) {
      packed[i * 4] = 1000;
      packed[i * 4 + 1] = 1000;
      packed[i * 4 + 2] = 1000;
    }
    expect(pointCloudPickStep(n)).toBeGreaterThan(1);
    const s = createDefaultOrbitCameraState();
    fitCameraToAABB(s, { min: [-1, -1, -1], max: [1, 1, 1] });
    const vp = buildViewProj(s, 1);
    // With step > 1, index 0 is always visited (i starts at 0)
    const hit = pickNearestPointCloud(packed, n, vp, 200, 200, 400, 400, 50);
    expect(hit).not.toBeNull();
    expect(hit!.dataIndex).toBe(0);
  });

  it('stride can miss points that are not multiples of step', () => {
    // maxFullScan=2, count=3 → step = ceil(3/2) = 2 → visits i=0,2 only (skips 1)
    const packed = new Float32Array(3 * 4);
    // Index 1 is the only on-screen origin point; 0 and 2 are far off-axis so
    // they either clip or land well outside a tight threshold when visited.
    packed[0] = 1e6;
    packed[1] = 1e6;
    packed[2] = 1e6;
    packed[4] = 0;
    packed[5] = 0;
    packed[6] = 0;
    packed[8] = 1e6;
    packed[9] = 1e6;
    packed[10] = 1e6;
    expect(pointCloudPickStep(3, 2)).toBe(2);
    const s = createDefaultOrbitCameraState();
    fitCameraToAABB(s, { min: [-1, -1, -1], max: [1, 1, 1] });
    const vp = buildViewProj(s, 1);
    // Without stride the origin at index 1 would hit; with step 2 it is skipped.
    const hitFull = pickNearestPointCloud(packed, 3, vp, 200, 200, 400, 400, 20, 3);
    expect(hitFull).not.toBeNull();
    expect(hitFull!.dataIndex).toBe(1);
    const miss = pickNearestPointCloud(packed, 3, vp, 200, 200, 400, 400, 20, 2);
    expect(miss).toBeNull();
  });
});
