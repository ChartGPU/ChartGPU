/**
 * 3D camera state: perspective / orthographic, orbit controls, fit-to-AABB.
 * Y-up, right-handed.
 */

import type { Chart3DCameraOptions } from '../../config/types';
import {
  addVec3,
  createMat4,
  lookAt,
  multiplyMat4,
  normalizeVec3,
  orthographic,
  perspective,
  scaleVec3,
  subVec3,
  type Mat4,
  type Vec3,
} from './mat4';
import { aabbCenter, aabbHalfDiagonal, sanitizeAABB, type AABB } from './aabb';

export type CameraProjectionType = 'perspective' | 'orthographic';

export type ResolvedCamera = Readonly<{
  readonly type: CameraProjectionType;
  readonly fovY: number;
  readonly near: number;
  readonly far: number;
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  readonly orthoSize: number;
}>;

export type OrbitCameraState = {
  type: CameraProjectionType;
  fovY: number;
  near: number;
  far: number;
  /** Orbit target (look-at). */
  target: [number, number, number];
  /** Spherical: yaw around Y, pitch from XZ plane, distance from target. */
  yaw: number;
  pitch: number;
  distance: number;
  orthoSize: number;
  up: [number, number, number];
  /** When true, next fit uses data AABB unless user set explicit eye/target. */
  needsFit: boolean;
  /** User locked explicit eye/target (skip auto-fit until reset). */
  userLocked: boolean;
};

const DEFAULT_FOV_Y = Math.PI / 4;
const DEFAULT_NEAR = 0.01;
const DEFAULT_FAR = 10000;
const DEFAULT_ORTHO = 1;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  typeof v[0] === 'number' &&
  Number.isFinite(v[0]) &&
  typeof v[1] === 'number' &&
  Number.isFinite(v[1]) &&
  typeof v[2] === 'number' &&
  Number.isFinite(v[2]);

export const createDefaultOrbitCameraState = (): OrbitCameraState => ({
  type: 'perspective',
  fovY: DEFAULT_FOV_Y,
  near: DEFAULT_NEAR,
  far: DEFAULT_FAR,
  target: [0, 0, 0],
  yaw: Math.PI / 4,
  pitch: Math.PI / 6,
  distance: 3,
  orthoSize: DEFAULT_ORTHO,
  up: [0, 1, 0],
  needsFit: true,
  userLocked: false,
});

export const eyeFromOrbit = (state: OrbitCameraState): Vec3 => {
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const cy = Math.cos(state.yaw);
  const sy = Math.sin(state.yaw);
  const x = state.target[0] + state.distance * cp * sy;
  const y = state.target[1] + state.distance * sp;
  const z = state.target[2] + state.distance * cp * cy;
  return [x, y, z];
};

export const toResolvedCamera = (state: OrbitCameraState): ResolvedCamera => ({
  type: state.type,
  fovY: state.fovY,
  near: state.near,
  far: state.far,
  eye: eyeFromOrbit(state),
  target: [state.target[0], state.target[1], state.target[2]],
  up: [state.up[0], state.up[1], state.up[2]],
  orthoSize: state.orthoSize,
});

/**
 * Apply partial camera options onto orbit state.
 * Explicit eye+target sets spherical from those vectors.
 */
export const applyCameraOptions = (state: OrbitCameraState, opts: Chart3DCameraOptions | undefined): void => {
  if (!opts) return;

  if (opts.type === 'orthographic' || opts.type === 'perspective') {
    state.type = opts.type;
  }
  if (typeof opts.fovY === 'number' && Number.isFinite(opts.fovY) && opts.fovY > 0) {
    state.fovY = opts.fovY;
  }
  if (typeof opts.near === 'number' && Number.isFinite(opts.near) && opts.near > 0) {
    state.near = opts.near;
  }
  if (typeof opts.far === 'number' && Number.isFinite(opts.far) && opts.far > state.near) {
    state.far = opts.far;
  }
  if (typeof opts.orthoSize === 'number' && Number.isFinite(opts.orthoSize) && opts.orthoSize > 0) {
    state.orthoSize = opts.orthoSize;
  }
  if (isVec3(opts.up)) {
    state.up = [opts.up[0], opts.up[1], opts.up[2]];
  }

  const hasEye = isVec3(opts.eye);
  const hasTarget = isVec3(opts.target);
  if (hasTarget) {
    state.target = [opts.target![0], opts.target![1], opts.target![2]];
  }
  if (hasEye && hasTarget) {
    const eye = opts.eye!;
    const target = opts.target!;
    const offset = subVec3(eye, target);
    const dist = Math.hypot(offset[0], offset[1], offset[2]);
    state.distance = dist > 1e-6 ? dist : 1;
    state.pitch = Math.asin(Math.max(-1, Math.min(1, offset[1] / state.distance)));
    state.yaw = Math.atan2(offset[0], offset[2]);
    state.userLocked = true;
    state.needsFit = false;
  } else if (hasEye && !hasTarget) {
    // Eye only: keep target, recompute orbit
    const eye = opts.eye!;
    const offset = subVec3(eye, state.target);
    const dist = Math.hypot(offset[0], offset[1], offset[2]);
    state.distance = dist > 1e-6 ? dist : 1;
    state.pitch = Math.asin(Math.max(-1, Math.min(1, offset[1] / state.distance)));
    state.yaw = Math.atan2(offset[0], offset[2]);
    state.userLocked = true;
    state.needsFit = false;
  } else if (!hasEye && !hasTarget) {
    // No pose: keep needsFit for auto-fit unless already locked
  }
};

/** Fit orbit camera to AABB (sphere-fit). */
export const fitCameraToAABB = (state: OrbitCameraState, aabbIn: AABB | null | undefined): void => {
  const aabb = sanitizeAABB(aabbIn);
  const center = aabbCenter(aabb);
  state.target = [center[0], center[1], center[2]];
  const halfDiag = aabbHalfDiagonal(aabb);
  const margin = 1.35;
  if (state.type === 'orthographic') {
    state.orthoSize = halfDiag * margin;
    state.distance = Math.max(halfDiag * 3, state.near * 10);
  } else {
    // distance so that sphere of radius halfDiag fits in FOV
    const halfFov = state.fovY * 0.5;
    const dist = (halfDiag * margin) / Math.sin(Math.max(halfFov, 0.05));
    state.distance = Math.max(dist, state.near * 10);
  }
  // Expand far plane if needed
  const needFar = state.distance + halfDiag * 4;
  if (state.far < needFar) state.far = needFar;
  state.needsFit = false;
  state.userLocked = false;
};

export const orbitByPixels = (state: OrbitCameraState, dx: number, dy: number, speed: number): void => {
  state.yaw -= dx * speed;
  state.pitch += dy * speed;
  if (state.pitch > PITCH_LIMIT) state.pitch = PITCH_LIMIT;
  if (state.pitch < -PITCH_LIMIT) state.pitch = -PITCH_LIMIT;
};

export const panByPixels = (
  state: OrbitCameraState,
  dx: number,
  dy: number,
  viewportHeightPx: number,
  speed: number
): void => {
  const eye = eyeFromOrbit(state);
  const forward = normalizeVec3(subVec3(state.target, eye));
  const worldUp = normalizeVec3(state.up);
  let right = normalizeVec3([
    forward[1] * worldUp[2] - forward[2] * worldUp[1],
    forward[2] * worldUp[0] - forward[0] * worldUp[2],
    forward[0] * worldUp[1] - forward[1] * worldUp[0],
  ]);
  if (!(Math.hypot(right[0], right[1], right[2]) > 1e-8)) {
    right = [1, 0, 0];
  }
  const up = normalizeVec3([
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]);

  // Scale pan to roughly match screen motion at current distance
  const scale =
    state.type === 'orthographic'
      ? (2 * state.orthoSize) / Math.max(1, viewportHeightPx)
      : (2 * state.distance * Math.tan(state.fovY * 0.5)) / Math.max(1, viewportHeightPx);

  const move = addVec3(scaleVec3(right, -dx * scale * speed), scaleVec3(up, dy * scale * speed));
  state.target[0] += move[0];
  state.target[1] += move[1];
  state.target[2] += move[2];
};

export const zoomByWheel = (state: OrbitCameraState, deltaY: number, speed: number): void => {
  const factor = Math.exp(deltaY * 0.001 * speed);
  if (state.type === 'orthographic') {
    state.orthoSize = Math.max(1e-6, state.orthoSize * factor);
  } else {
    state.distance = Math.max(state.near * 2, state.distance * factor);
  }
};

/** Build viewProj matrix (column-major Float32Array 16). */
export const buildViewProj = (state: OrbitCameraState, aspect: number, out: Mat4 = createMat4()): Mat4 => {
  const eye = eyeFromOrbit(state);
  const view = createMat4();
  lookAt(view, eye, state.target, state.up);
  const proj = createMat4();
  if (state.type === 'orthographic') {
    orthographic(proj, state.orthoSize, aspect, state.near, state.far);
  } else {
    perspective(proj, state.fovY, aspect, state.near, state.far);
  }
  return multiplyMat4(out, proj, view);
};
