# Annotations Cookbook

Practical recipes for common annotation use cases in ChartGPU.

## Quick Start

```typescript
import { ChartGPU, createAnnotationAuthoring } from 'chartgpu';

// Create chart
const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: myData }]
});

// Enable interactive annotation editing
const authoring = createAnnotationAuthoring(container, chart);

// Users can now right-click to add/edit annotations
// Don't forget cleanup:
// authoring.dispose();
// chart.dispose();
```

## Common Patterns

### Adding Reference Lines

#### Horizontal Threshold Line

```typescript
chart.setOption({
  ...chart.options,
  annotations: [
    {
      type: 'lineY',
      y: 100,
      layer: 'belowSeries',
      style: {
        color: '#ef4444',
        lineWidth: 2,
        lineDash: [8, 6],
        opacity: 0.9
      },
      label: {
        text: 'Max Threshold',
        offset: [8, -8],
        anchor: 'start',
        background: {
          color: '#000000',
          opacity: 0.7,
          padding: [2, 6, 2, 6],
          borderRadius: 4
        }
      }
    }
  ]
});
```

#### Vertical Event Marker

```typescript
{
  type: 'lineX',
  x: eventTimestamp,
  layer: 'belowSeries',
  style: { color: '#22c55e', lineWidth: 2 },
  label: {
    text: 'Product Launch',
    offset: [8, 10],
    anchor: 'start'
  }
}
```

### Marking Peaks and Troughs

```typescript
// Find extrema
const max = data.reduce((a, b) =>
  (Array.isArray(b) ? b[1] : b.y) > (Array.isArray(a) ? a[1] : a.y) ? b : a
);
const maxX = Array.isArray(max) ? max[0] : max.x;
const maxY = Array.isArray(max) ? max[1] : max.y;

// Add peak marker
const annotations: AnnotationConfig[] = [
  {
    type: 'point',
    x: maxX,
    y: maxY,
    layer: 'aboveSeries',
    marker: {
      symbol: 'circle',
      size: 10,
      style: { color: '#22c55e', opacity: 1 }
    },
    label: {
      template: 'Peak: {y}',
      decimals: 2,
      offset: [10, -10],
      anchor: 'start',
      background: {
        color: '#000000',
        opacity: 0.8,
        padding: [2, 6, 2, 6],
        borderRadius: 4
      }
    }
  }
];

chart.setOption({ ...chart.options, annotations });
```

### Event Timeline

```typescript
const events = [
  { timestamp: Date.parse('2024-01-01'), label: 'Q1', color: '#3b82f6' },
  { timestamp: Date.parse('2024-04-01'), label: 'Q2', color: '#22c55e' },
  { timestamp: Date.parse('2024-07-01'), label: 'Q3', color: '#f97316' },
  { timestamp: Date.parse('2024-10-01'), label: 'Q4', color: '#ef4444' },
];

const annotations = events.map(evt => ({
  type: 'lineX' as const,
  x: evt.timestamp,
  layer: 'belowSeries' as const,
  style: { color: evt.color, lineWidth: 2, opacity: 0.8 },
  label: {
    text: evt.label,
    offset: [8, 10] as const,
    anchor: 'start' as const,
    background: {
      color: '#000000',
      opacity: 0.7,
      padding: [2, 6, 2, 6] as const,
      borderRadius: 4
    }
  }
}));

chart.setOption({ ...chart.options, annotations });
```

### Range Annotations

```typescript
// Highlight a specific time range with shaded region (using two vertical lines)
const rangeAnnotations: AnnotationConfig[] = [
  {
    type: 'lineX',
    x: rangeStartTimestamp,
    layer: 'belowSeries',
    style: { color: '#3b82f6', lineWidth: 2, opacity: 0.3 }
  },
  {
    type: 'lineX',
    x: rangeEndTimestamp,
    layer: 'belowSeries',
    style: { color: '#3b82f6', lineWidth: 2, opacity: 0.3 }
  },
  {
    type: 'text',
    position: {
      space: 'data',
      x: (rangeStartTimestamp + rangeEndTimestamp) / 2,
      y: maxY * 0.95
    },
    text: 'Maintenance Window',
    layer: 'aboveSeries',
    style: { color: '#3b82f6', opacity: 0.9 }
  }
];
```

### HUD Overlays (Plot-Space)

```typescript
// Watermark
{
  type: 'text',
  position: { space: 'plot', x: 0.5, y: 0.5 },
  text: 'DRAFT',
  layer: 'belowSeries',
  style: { color: '#ef4444', opacity: 0.15 }
}

// Status indicator (top-right)
{
  type: 'text',
  position: { space: 'plot', x: 0.95, y: 0.05 },
  text: 'LIVE',
  layer: 'aboveSeries',
  style: { color: '#22c55e', opacity: 1 }
}

// Dataset info (top-left)
{
  type: 'text',
  position: { space: 'plot', x: 0.05, y: 0.05 },
  text: 'Last updated: 2024-01-15',
  layer: 'aboveSeries',
  style: { color: '#ffffff', opacity: 0.8 }
}
```

### Dynamic Threshold Bands

```typescript
function addThresholdBands(
  critical: number,
  warning: number,
  normal: number
) {
  const bands = [
    { y: critical, label: 'Critical', color: '#ef4444' },
    { y: warning, label: 'Warning', color: '#f97316' },
    { y: normal, label: 'Normal', color: '#22c55e' },
  ];

  const annotations = bands.map(band => ({
    type: 'lineY' as const,
    y: band.y,
    layer: 'belowSeries' as const,
    style: {
      color: band.color,
      lineWidth: 2,
      lineDash: [4, 4] as const,
      opacity: 0.8
    },
    label: {
      template: `${band.label}: {y}`,
      decimals: 1,
      offset: [8, -8] as const,
      anchor: 'start' as const,
      background: {
        color: '#000000',
        opacity: 0.6,
        padding: [2, 6, 2, 6] as const,
        borderRadius: 4
      }
    }
  }));

  chart.setOption({ ...chart.options, annotations });
}

addThresholdBands(100, 75, 50);
```

## Interactive Workflows

### Enable Full Editing

```typescript
const authoring = createAnnotationAuthoring(container, chart, {
  showToolbar: true,         // Show undo/redo/export toolbar
  enableContextMenu: true,   // Enable right-click menu
  menuZIndex: 1000,
  toolbarZIndex: 10
});

// Users can:
// - Right-click empty space → add annotations
// - Right-click annotation → edit/delete
// - Drag annotations to reposition
// - Undo/redo changes
// - Export JSON
```

### Programmatic Annotation Management

```typescript
// Add annotation
authoring.addVerticalLine(Date.now());
authoring.addTextNote(50, 75, 'Important Note', 'data');

// Get current annotations
const annotations = authoring.getAnnotations();
console.log(`Total annotations: ${annotations.length}`);

// Export for persistence
const json = authoring.exportJSON();
localStorage.setItem('chart-annotations', json);

// Restore from storage
const storedJson = localStorage.getItem('chart-annotations');
if (storedJson) {
  const restoredAnnotations = JSON.parse(storedJson);
  chart.setOption({ ...chart.options, annotations: restoredAnnotations });
}
```

### Custom Right-Click Handler

```typescript
const canvas = container.querySelector('canvas')!;

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  const hit = chart.hitTest(e);

  if (hit.isInGrid && hit.match) {
    // User right-clicked near a data point
    const [x, y] = hit.match.value;

    // Show custom menu or add annotation immediately
    const annotations = chart.options.annotations ?? [];
    chart.setOption({
      ...chart.options,
      annotations: [
        ...annotations,
        {
          type: 'point',
          x,
          y,
          layer: 'aboveSeries',
          marker: { symbol: 'circle', size: 8, style: { color: '#ff4ab0' } }
        }
      ]
    });
  }
});
```

## Advanced Techniques

### Conditional Annotations (Show/Hide)

```typescript
function updateAnnotations(showThresholds: boolean, showEvents: boolean) {
  let annotations: AnnotationConfig[] = [];

  if (showThresholds) {
    annotations.push({
      type: 'lineY',
      y: 100,
      layer: 'belowSeries',
      style: { color: '#ef4444', lineWidth: 2 },
      label: { text: 'Max' }
    });
  }

  if (showEvents) {
    annotations.push({
      type: 'lineX',
      x: eventTimestamp,
      layer: 'belowSeries',
      style: { color: '#22c55e', lineWidth: 2 },
      label: { text: 'Launch' }
    });
  }

  chart.setOption({ ...chart.options, annotations });
}

// Toggle controls
document.getElementById('thresholds')!.addEventListener('change', (e) => {
  updateAnnotations((e.target as HTMLInputElement).checked, showEvents);
});
```

### Annotation Templates

```typescript
function createThreshold(y: number, severity: 'critical' | 'warning' | 'info'): AnnotationConfig {
  const colorMap = {
    critical: '#ef4444',
    warning: '#f97316',
    info: '#3b82f6'
  };

  return {
    type: 'lineY',
    y,
    layer: 'belowSeries',
    style: {
      color: colorMap[severity],
      lineWidth: 2,
      lineDash: severity === 'info' ? [4, 4] : undefined,
      opacity: 0.9
    },
    label: {
      template: `${severity.toUpperCase()}: {y}`,
      decimals: 1,
      offset: [8, -8],
      anchor: 'start',
      background: {
        color: '#000000',
        opacity: 0.7,
        padding: [2, 6, 2, 6],
        borderRadius: 4
      }
    }
  };
}

// Usage
chart.setOption({
  ...chart.options,
  annotations: [
    createThreshold(100, 'critical'),
    createThreshold(75, 'warning'),
    createThreshold(50, 'info')
  ]
});
```

### Annotation Filtering and Search

```typescript
function findAnnotationsInRange(
  annotations: readonly AnnotationConfig[],
  xMin: number,
  xMax: number
): AnnotationConfig[] {
  return annotations.filter(a => {
    if (a.type === 'lineX') {
      return a.x >= xMin && a.x <= xMax;
    }
    if (a.type === 'point') {
      return a.x >= xMin && a.x <= xMax;
    }
    if (a.type === 'text' && a.position.space === 'data') {
      return a.position.x >= xMin && a.position.x <= xMax;
    }
    return true; // lineY and plot-space text are always visible
  });
}

// Get visible annotations
const zoomRange = chart.getZoomRange();
if (zoomRange) {
  const xAxis = chart.options.xAxis;
  const xMin = xAxis?.min ?? 0;
  const xMax = xAxis?.max ?? 100;
  const span = xMax - xMin;
  const visibleMin = xMin + (zoomRange.start / 100) * span;
  const visibleMax = xMin + (zoomRange.end / 100) * span;

  const visible = findAnnotationsInRange(
    chart.options.annotations ?? [],
    visibleMin,
    visibleMax
  );
  console.log(`${visible.length} annotations visible`);
}
```

### Annotation Clustering

```typescript
function clusterAnnotations(
  annotations: readonly AnnotationConfig[],
  threshold: number
): AnnotationConfig[][] {
  // Group annotations that are within threshold distance
  const clusters: AnnotationConfig[][] = [];

  for (const annotation of annotations) {
    if (annotation.type !== 'lineX') continue;

    let addedToCluster = false;
    for (const cluster of clusters) {
      const first = cluster[0];
      if (first && first.type === 'lineX') {
        if (Math.abs(annotation.x - first.x) < threshold) {
          cluster.push(annotation);
          addedToCluster = true;
          break;
        }
      }
    }

    if (!addedToCluster) {
      clusters.push([annotation]);
    }
  }

  return clusters;
}

// Display cluster count instead of individual annotations when zoomed out
const clusters = clusterAnnotations(chart.options.annotations ?? [], 100);
console.log(`${clusters.length} annotation clusters`);
```

## Performance Tips

### Optimize Annotation Count

```typescript
// Limit visible annotations based on zoom level
function getVisibleAnnotations(
  all: readonly AnnotationConfig[],
  zoomLevel: number
): AnnotationConfig[] {
  const maxAnnotations = zoomLevel > 50 ? 10 : 50;
  return all.slice(0, maxAnnotations);
}

const zoomRange = chart.getZoomRange();
const zoomLevel = zoomRange ? zoomRange.end - zoomRange.start : 100;
const visible = getVisibleAnnotations(allAnnotations, zoomLevel);

chart.setOption({ ...chart.options, annotations: visible });
```

### Batch Updates

```typescript
// BAD: Multiple setOption calls
annotations.forEach(a => {
  chart.setOption({ ...chart.options, annotations: [...chart.options.annotations ?? [], a] });
});

// GOOD: Single batch update
const newAnnotations = [...chart.options.annotations ?? [], ...annotations];
chart.setOption({ ...chart.options, annotations: newAnnotations });
```

### Layer Strategically

```typescript
// Use belowSeries for background annotations
const backgroundAnnotations = [
  { type: 'lineY', y: 50, layer: 'belowSeries', style: { opacity: 0.3 } },
  { type: 'lineY', y: 100, layer: 'belowSeries', style: { opacity: 0.3 } }
];

// Use aboveSeries only for important markers
const foregroundAnnotations = [
  { type: 'point', x: maxX, y: maxY, layer: 'aboveSeries', marker: { size: 10 } }
];

chart.setOption({
  ...chart.options,
  annotations: [...backgroundAnnotations, ...foregroundAnnotations]
});
```

## Troubleshooting

### Annotations Not Visible

**Check coordinate range:**
```typescript
// Verify annotation is within visible data range
const annotation = { type: 'lineX', x: 1000 };
const xAxis = chart.options.xAxis;
console.log('X range:', xAxis?.min, 'to', xAxis?.max);
console.log('Annotation x:', annotation.x);
```

**Check layer and opacity:**
```typescript
// Ensure annotation is on correct layer and visible
{
  layer: 'aboveSeries',  // Try switching layers
  style: { opacity: 1 }  // Ensure not transparent
}
```

### Drag Performance Issues

**Reduce annotation count:**
```typescript
// Keep visible annotations under 20-30 for smooth dragging
if (chart.options.annotations && chart.options.annotations.length > 30) {
  console.warn('Too many annotations may impact drag performance');
}
```

### Label Overlap

**Adjust offsets:**
```typescript
// Stagger label offsets to prevent overlap
annotations.map((a, i) => ({
  ...a,
  label: {
    ...a.label,
    offset: [8, -8 - (i * 20)] // Vertical stagger
  }
}));
```

## See Also

- [Annotations API Reference](../api/annotations.md) - Complete API documentation
- [Interaction API](../api/interaction.md) - Event handling and hit testing
- [Example: Annotation Authoring](../../examples/annotation-authoring/) - Interactive demo
- [TypeScript Types](../../src/config/types.ts) - Full type definitions
