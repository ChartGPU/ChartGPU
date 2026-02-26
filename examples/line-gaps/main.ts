import { ChartGPU } from '../../src';

const dataWithGaps = [
  [0, 2], [1, 5], [2, 3], [3, 7], [4, 4],
  null, // gap
  [6, 8], [7, 6], [8, 9], [9, 5], [10, 7],
  null, // gap
  [12, 3], [13, 6], [14, 4],
] as const;

// Chart 1: Line with gaps (default connectNulls: false)
ChartGPU.create(document.getElementById('chart1')!, {
  series: [{ type: 'line', data: dataWithGaps as any }],
  xAxis: { type: 'value' },
});

// Chart 2: Line with connectNulls: true (bridges gaps)
ChartGPU.create(document.getElementById('chart2')!, {
  series: [{ type: 'line', data: dataWithGaps as any, connectNulls: true }],
  xAxis: { type: 'value' },
});

// Chart 3: Area with gaps
ChartGPU.create(document.getElementById('chart3')!, {
  series: [{ type: 'area', data: dataWithGaps as any }],
  xAxis: { type: 'value' },
});

// Chart 4: Multi-segment via concatenation
const segment1 = [[0, 2], [1, 5], [2, 3], [3, 7]] as const;
const segment2 = [[5, 8], [6, 6], [7, 9], [8, 5]] as const;
const segment3 = [[10, 3], [11, 6], [12, 4]] as const;

ChartGPU.create(document.getElementById('chart4')!, {
  series: [{
    type: 'line',
    data: [...segment1, null, ...segment2, null, ...segment3] as any,
  }],
  xAxis: { type: 'value' },
});
