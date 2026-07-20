import { describe, it, expect, vi } from 'vitest';
import { resolveOptions, isResolvedSeries2D } from '../OptionResolver';

describe('OptionResolver 3D modality', () => {
  it('defaults coordinateSystem to cartesian2d', () => {
    const r = resolveOptions({
      series: [
        {
          type: 'line',
          data: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    });
    expect(r.coordinateSystem).toBe('cartesian2d');
  });

  it('accepts cartesian3d + pointCloud3d', () => {
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        {
          type: 'pointCloud3d',
          data: { x: [0, 1], y: [0, 1], z: [0, 1] },
          pointStyle: { size: 4, color: '#fff', opacity: 0.5 },
        },
      ],
    });
    expect(r.coordinateSystem).toBe('cartesian3d');
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('pointCloud3d');
    expect(r.series[0]!.type === 'pointCloud3d' && r.series[0].pointStyle.size).toBe(4);
    expect(r.series[0]!.type === 'pointCloud3d' && r.series[0].drawable).toBe(true);
  });

  it('skips 2D series in 3D chart with warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        { type: 'line', data: [[0, 0]] },
        { type: 'pointCloud3d', data: { x: [0], y: [0], z: [0] } },
      ],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('pointCloud3d');
    // Resolved index of cloud is 0 after filter (user index 1 was skipped)
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips 3D series in 2D chart with warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolveOptions({
      series: [
        { type: 'pointCloud3d', data: { x: [0], y: [0], z: [0] } },
        {
          type: 'line',
          data: [
            [0, 1],
            [1, 2],
          ],
        },
      ],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('line');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips surface3d in 2D chart', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const y = new Float32Array(4).fill(1);
    const r = resolveOptions({
      series: [
        {
          type: 'surface3d',
          data: { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 2, rows: 2, y },
        },
      ],
    });
    expect(r.series).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps mixed pointCloud3d + surface3d in 3D chart', () => {
    const y = new Float32Array(4).fill(1);
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        { type: 'pointCloud3d', data: { x: [0], y: [0], z: [0] } },
        {
          type: 'surface3d',
          data: { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 2, rows: 2, y },
        },
      ],
    });
    expect(r.series).toHaveLength(2);
    expect(r.series[0]!.type).toBe('pointCloud3d');
    expect(r.series[1]!.type).toBe('surface3d');
  });

  it('resolves surface3d with colormap defaults and clamps lighting', () => {
    const cols = 4;
    const rows = 4;
    const y = new Float32Array(cols * rows).fill(1);
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        {
          type: 'surface3d',
          data: { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: cols, rows, y },
          lighting: 2,
          opacity: -1,
        },
      ],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('surface3d');
    const s = r.series[0]!;
    expect(s.type).toBe('surface3d');
    if (s.type !== 'surface3d') throw new Error('expected surface3d');
    expect(s.colormap).toBe('viridis');
    expect(s.drawable).toBe(true);
    expect(s.lighting).toBe(1);
    expect(s.opacity).toBe(0);
  });

  it('surface columns:1 is not drawable', () => {
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        {
          type: 'surface3d',
          data: {
            xStart: 0,
            xStep: 1,
            zStart: 0,
            zStep: 1,
            columns: 1,
            rows: 5,
            y: new Float32Array(5),
          },
        },
      ],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('surface3d');
    if (r.series[0]!.type !== 'surface3d') throw new Error('expected surface3d');
    expect(r.series[0].drawable).toBe(false);
  });

  it('empty point cloud is not drawable', () => {
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [{ type: 'pointCloud3d', data: { x: [], y: [], z: [] } }],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('pointCloud3d');
    if (r.series[0]!.type !== 'pointCloud3d') throw new Error('expected pointCloud3d');
    expect(r.series[0].drawable).toBe(false);
  });

  it('all-null object array is not drawable', () => {
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [{ type: 'pointCloud3d', data: [null, null, { x: Number.NaN, y: 0, z: 0 }] }],
    });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.type).toBe('pointCloud3d');
    if (r.series[0]!.type !== 'pointCloud3d') throw new Error('expected pointCloud3d');
    expect(r.series[0].drawable).toBe(false);
  });

  it('camera and interaction3d defaults + orthographic', () => {
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      camera: { type: 'orthographic', orthoSize: 3.5 },
    });
    expect(r.camera.type).toBe('orthographic');
    expect(r.camera.orthoSize).toBe(3.5);
    expect(r.camera.fovY).toBeGreaterThan(0);
    expect(r.interaction3d.orbit).toBe(true);
    expect(r.axes3d.showBox).toBe(true);
    expect(r.axes3d.showGrid).toBe(true);
    expect(r.axes3d.labelMode).toBe('auto');
    expect(r.axes3d.x.name).toBe('X');
    expect(r.axes3d.x.tickCount).toBe(5);
  });

  it('resolves axes3d names, showGrid false, tickCount, contours', () => {
    const y = new Float32Array(4).fill(1);
    const r = resolveOptions({
      coordinateSystem: 'cartesian3d',
      axes3d: {
        showGrid: false,
        x: { name: 'X (m)', tickCount: 8 },
        y: { name: 'Height' },
        z: { name: 'Depth', min: -1, max: 1 },
      },
      series: [
        {
          type: 'surface3d',
          data: { xStart: 0, xStep: 1, zStart: 0, zStep: 1, columns: 2, rows: 2, y },
          contours: { show: true, levels: 6, color: '#fff', opacity: 0.5 },
        },
      ],
    });
    expect(r.axes3d.showGrid).toBe(false);
    expect(r.axes3d.xName).toBe('X (m)');
    expect(r.axes3d.x.tickCount).toBe(8);
    expect(r.axes3d.z.min).toBe(-1);
    expect(r.axes3d.z.max).toBe(1);
    const s = r.series[0]!;
    expect(s.type).toBe('surface3d');
    if (s.type !== 'surface3d') throw new Error('expected surface3d');
    expect(s.contours.show).toBe(true);
    expect(s.contours.levels).toBe(6);
    expect(s.contours.color).toBe('#fff');
    expect(s.contours.opacity).toBe(0.5);
  });

  it('isResolvedSeries2D table', () => {
    const cloud = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [{ type: 'pointCloud3d', data: { x: [0], y: [0], z: [0] } }],
    }).series[0]!;
    const surf = resolveOptions({
      coordinateSystem: 'cartesian3d',
      series: [
        {
          type: 'surface3d',
          data: {
            xStart: 0,
            xStep: 1,
            zStart: 0,
            zStep: 1,
            columns: 2,
            rows: 2,
            y: new Float32Array(4),
          },
        },
      ],
    }).series[0]!;
    const line = resolveOptions({ series: [{ type: 'line', data: [[0, 0]] }] }).series[0]!;
    const band = resolveOptions({
      series: [{ type: 'band', data: { x: [0, 1], y: [0, 1], y1: [1, 2] } }],
    }).series[0]!;
    const heat = resolveOptions({
      series: [
        {
          type: 'heatmap',
          data: {
            xStart: 0,
            xStep: 1,
            yStart: 0,
            yStep: 1,
            columns: 2,
            rows: 2,
            z: new Float32Array(4),
          },
        },
      ],
    }).series[0]!;
    const scatter = resolveOptions({
      series: [{ type: 'scatter', data: [[0, 0]] }],
    }).series[0]!;

    expect(isResolvedSeries2D(cloud)).toBe(false);
    expect(isResolvedSeries2D(surf)).toBe(false);
    expect(isResolvedSeries2D(line)).toBe(true);
    expect(isResolvedSeries2D(band)).toBe(true);
    expect(isResolvedSeries2D(heat)).toBe(true);
    expect(isResolvedSeries2D(scatter)).toBe(true);
  });
});
