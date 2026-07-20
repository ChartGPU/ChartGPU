/**
 * Acceptance: pure resolve + pack coexistence for 3D modality (no WebGPU).
 * Run: tsx examples/acceptance/point-cloud-3d-resolve-pack.ts
 */
import { resolveOptions, isResolvedSeries2D } from '../../src/config/OptionResolver';
import { packPointCloud3D, appendPackedPointCloud3D } from '../../src/data/pointCloud3dData';
import { packSurface3D } from '../../src/data/surface3dData';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const y = new Float32Array(16);
for (let i = 0; i < 16; i++) y[i] = i;

const resolved = resolveOptions({
  coordinateSystem: 'cartesian3d',
  series: [
    { type: 'line', data: [[0, 0]] }, // skipped
    {
      type: 'pointCloud3d',
      data: { x: [0, 1], y: [0, 1], z: [0, 1] },
    },
    {
      type: 'surface3d',
      data: { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 4, rows: 4, y },
    },
  ],
});

assert(resolved.coordinateSystem === 'cartesian3d', 'modality');
assert(resolved.series.length === 2, `expected 2 resolved series, got ${resolved.series.length}`);
assert(resolved.series[0]!.type === 'pointCloud3d', 'cloud first after filter');
assert(resolved.series[1]!.type === 'surface3d', 'surface second');
assert(!isResolvedSeries2D(resolved.series[0]!), 'cloud not 2D');
assert(!isResolvedSeries2D(resolved.series[1]!), 'surface not 2D');

// appendData index must use resolved index 0 (not user index 1)
const cloud = resolved.series[0]!;
assert(cloud.type === 'pointCloud3d', 'narrow cloud');
let packed = packPointCloud3D(cloud.data);
packed = appendPackedPointCloud3D(packed.packed, packed.count, { x: [2], y: [2], z: [2] });
assert(packed.count === 3, `append total ${packed.count}`);

const surface = resolved.series[1]!;
assert(surface.type === 'surface3d', 'narrow surface');
const mesh = packSurface3D(surface.data);
assert(mesh != null && mesh.vertexCount === 16, 'surface pack');

// surface append not supported — document by checking type only
assert(surface.type !== 'pointCloud3d', 'surface is not appendable as cloud');

console.log('OK point-cloud-3d-resolve-pack');
