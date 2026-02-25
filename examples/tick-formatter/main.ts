import { ChartGPU } from '../../src';

async function init() {
  // 1. Percentage y-axis
  await ChartGPU.create(document.getElementById('chart-percent')!, {
    series: [{
      type: 'line',
      data: Array.from({ length: 20 }, (_, i) => [i, Math.random()]),
    }],
    xAxis: {
      name: 'Sample Index',
    },
    yAxis: {
      name: 'Completion',
      tickFormatter: (v) => `${(v * 100).toFixed(0)}%`,
    },
    grid: { left: 60, right: 20, top: 20, bottom: 50 },
    legend: { show: false },
  });

  // 2. Duration y-axis
  await ChartGPU.create(document.getElementById('chart-duration')!, {
    series: [{
      type: 'scatter',
      data: Array.from({ length: 30 }, (_, i) => [i, Math.random() * 172800]),
    }],
    xAxis: {
      name: 'Task ID',
    },
    yAxis: {
      name: 'Duration',
      tickFormatter: (seconds) => {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
      },
    },
    grid: { left: 60, right: 20, top: 20, bottom: 50 },
    legend: { show: false },
  });

  // 3. Custom time x-axis with temperature y-axis
  const now = Date.now();
  await ChartGPU.create(document.getElementById('chart-time')!, {
    series: [{
      type: 'line',
      data: Array.from({ length: 50 }, (_, i) => [now - (50 - i) * 86400000, 15 + Math.random() * 20]),
    }],
    xAxis: {
      type: 'time',
      name: 'Date',
      tickFormatter: (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    },
    yAxis: {
      name: 'Temperature',
      tickFormatter: (v) => `${v.toFixed(0)}°C`,
    },
    grid: { left: 55, right: 20, top: 20, bottom: 50 },
    legend: { show: false },
  });

  // 4. Integer-only x-axis (suppress fractional labels)
  // Use x-values 0..8 so that 5 evenly-spaced ticks (0, 2, 4, 6, 8) all land on integers.
  // Add padding via min/max so the edge bars don't clip.
  await ChartGPU.create(document.getElementById('chart-integer')!, {
    series: [{
      type: 'bar',
      data: Array.from({ length: 9 }, (_, i) => [i, Math.random() * 50 + 10]),
    }],
    xAxis: {
      min: -0.5,
      max: 8.5,
      name: 'Endpoint',
      tickFormatter: (v) => Number.isInteger(v) ? v.toLocaleString() : null,
    },
    yAxis: {
      name: 'Throughput',
      tickFormatter: (v) => `${v.toFixed(0)} req/s`,
    },
    grid: { left: 70, right: 20, top: 20, bottom: 50 },
    legend: { show: false },
  });
}

init().catch((err) => {
  console.error(err);
});
