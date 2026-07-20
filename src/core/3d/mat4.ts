/**
 * Minimal column-major mat4 / vec3 helpers for 3D camera + projection.
 * Y-up, right-handed (WebGPU / glTF convention).
 *
 * Matrices are Float32Array length 16, column-major.
 */

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

export const createMat4 = (): Mat4 => new Float32Array(16);

export const identityMat4 = (out: Mat4 = createMat4()): Mat4 => {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
};

export const copyMat4 = (out: Mat4, a: Mat4): Mat4 => {
  out.set(a);
  return out;
};

/** out = a * b (column-major multiply). */
export const multiplyMat4 = (out: Mat4, a: Mat4, b: Mat4): Mat4 => {
  const a00 = a[0]!,
    a01 = a[1]!,
    a02 = a[2]!,
    a03 = a[3]!;
  const a10 = a[4]!,
    a11 = a[5]!,
    a12 = a[6]!,
    a13 = a[7]!;
  const a20 = a[8]!,
    a21 = a[9]!,
    a22 = a[10]!,
    a23 = a[11]!;
  const a30 = a[12]!,
    a31 = a[13]!,
    a32 = a[14]!,
    a33 = a[15]!;

  const b00 = b[0]!,
    b01 = b[1]!,
    b02 = b[2]!,
    b03 = b[3]!;
  const b10 = b[4]!,
    b11 = b[5]!,
    b12 = b[6]!,
    b13 = b[7]!;
  const b20 = b[8]!,
    b21 = b[9]!,
    b22 = b[10]!,
    b23 = b[11]!;
  const b30 = b[12]!,
    b31 = b[13]!,
    b32 = b[14]!,
    b33 = b[15]!;

  out[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  out[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  out[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  out[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;

  out[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  out[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  out[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  out[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;

  out[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  out[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  out[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  out[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;

  out[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  out[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  out[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  out[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
  return out;
};

export const normalizeVec3 = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
};

export const crossVec3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const subVec3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const addVec3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const scaleVec3 = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

export const dotVec3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * lookAt view matrix: eye → target, world up.
 * Produces a right-handed view matrix (camera looks down -Z in view space).
 */
export const lookAt = (out: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 => {
  const z = normalizeVec3(subVec3(eye, target)); // camera forward is -Z, so z axis points eye→target reversed
  let x = normalizeVec3(crossVec3(up, z));
  // Degenerate: up parallel to view direction
  if (!(Math.hypot(x[0], x[1], x[2]) > 1e-12)) {
    const altUp: Vec3 = Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = normalizeVec3(crossVec3(altUp, z));
  }
  const y = crossVec3(z, x);

  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[3] = 0;
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[7] = 0;
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[11] = 0;
  out[12] = -dotVec3(x, eye);
  out[13] = -dotVec3(y, eye);
  out[14] = -dotVec3(z, eye);
  out[15] = 1;
  return out;
};

/**
 * Perspective projection (WebGPU clip: z in [0,1], Y-up → NDC Y up is fine with positive f).
 * fovY in radians.
 */
export const perspective = (out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;

  out[0] = f / a;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = f;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = far * nf;
  out[11] = -1;
  out[12] = 0;
  out[13] = 0;
  out[14] = far * near * nf;
  out[15] = 0;
  return out;
};

/**
 * Orthographic projection. halfHeight is half the vertical extent in world units.
 * halfWidth = halfHeight * aspect.
 */
export const orthographic = (out: Mat4, halfHeight: number, aspect: number, near: number, far: number): Mat4 => {
  const hh = halfHeight > 0 && Number.isFinite(halfHeight) ? halfHeight : 1;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const hw = hh * a;
  const rl = 1 / (hw - -hw);
  const tb = 1 / (hh - -hh);
  const fn = 1 / (far - near);

  out[0] = 2 * rl;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = 2 * tb;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = -1 * fn;
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = -near * fn;
  out[15] = 1;
  return out;
};

/** Transform point (x,y,z,1) by mat4 → [x,y,z,w] clip. */
export const transformPoint = (m: Mat4, x: number, y: number, z: number): readonly [number, number, number, number] => {
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [cx, cy, cz, cw];
};

/**
 * Invert a column-major mat4. Returns null if determinant is near-zero.
 * Used for CSS → world ray unprojection.
 */
export const invertMat4 = (m: Mat4, out: Mat4 = createMat4()): Mat4 | null => {
  const a00 = m[0]!,
    a01 = m[1]!,
    a02 = m[2]!,
    a03 = m[3]!;
  const a10 = m[4]!,
    a11 = m[5]!,
    a12 = m[6]!,
    a13 = m[7]!;
  const a20 = m[8]!,
    a21 = m[9]!,
    a22 = m[10]!,
    a23 = m[11]!;
  const a30 = m[12]!,
    a31 = m[13]!,
    a32 = m[14]!,
    a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!(Math.abs(det) > 1e-12)) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
};
