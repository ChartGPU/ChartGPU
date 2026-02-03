# Annotations Quick Reference

Quick lookup guide for ChartGPU annotations API.

## Import

```typescript
import { ChartGPU, createAnnotationAuthoring } from 'chartgpu';
import type { AnnotationConfig, AnnotationAuthoringInstance } from 'chartgpu';
```

## Annotation Types

### LineX (Vertical Line)

```typescript
{
  type: 'lineX',
  x: number,                    // Data-space x coordinate
  yRange?: [minY, maxY],        // Optional y range
  layer?: 'belowSeries' | 'aboveSeries',
  style?: { color?, lineWidth?, lineDash?, opacity? },
  label?: { text?, template?, decimals?, offset?, anchor?, background? }
}
```

**Drag:** Horizontal only

### LineY (Horizontal Line)

```typescript
{
  type: 'lineY',
  y: number,                    // Data-space y coordinate
  xRange?: [minX, maxX],        // Optional x range
  layer?: 'belowSeries' | 'aboveSeries',
  style?: { color?, lineWidth?, lineDash?, opacity? },
  label?: { text?, template?, decimals?, offset?, anchor?, background? }
}
```

**Drag:** Vertical only

### Point Marker

```typescript
{
  type: 'point',
  x: number,                    // Data-space x coordinate
  y: number,                    // Data-space y coordinate
  marker?: {
    symbol?: 'circle' | 'rect' | 'triangle',
    size?: number,              // CSS pixels
    style?: { color?, opacity? }
  },
  layer?: 'belowSeries' | 'aboveSeries',
  label?: { text?, template?, decimals?, offset?, anchor?, background? }
}
```

**Drag:** Free 2D

### Text Note

```typescript
{
  type: 'text',
  position: {
    space: 'data' | 'plot',     // 'data' tracks zoom/pan, 'plot' pinned
    x: number,                  // Data units or 0-1 fraction (plot)
    y: number                   // Data units or 0-1 fraction (plot)
  },
  text: string,
  layer?: 'belowSeries' | 'aboveSeries',
  style?: { color?, opacity? }
}
```

**Drag:** Free 2D (preserves space)

## Style Configuration

```typescript
style: {
  color: string,               // CSS color (e.g., '#ff0000', 'rgba(255,0,0,0.5)')
  lineWidth: number,           // 1-8 typical (CSS pixels)
  lineDash: number[],          // [4, 4] dashed, [2, 2] dotted
  opacity: number              // 0-1 (default varies by type)
}
```

**Common patterns:**
- Solid: `lineDash: undefined`
- Dashed: `lineDash: [4, 4]`
- Dotted: `lineDash: [2, 2]`

## Label Configuration

```typescript
label: {
  text: string,                // Explicit text (overrides template)
  template: string,            // e.g., 'x={x}, y={y}'
  decimals: number,            // Decimal places for formatting
  offset: [dx, dy],            // Pixel offset from anchor
  anchor: 'start' | 'center' | 'end',
  background: {
    color: string,
    opacity: number,           // 0-1
    padding: number | [top, right, bottom, left],
    borderRadius: number       // CSS pixels
  }
}
```

**Template variables:**
- `{x}` - x-coordinate
- `{y}` - y-coordinate
- `{value}` - y-coordinate (alias)

## Interactive Authoring

### Setup

```typescript
const authoring = createAnnotationAuthoring(container, chart, {
  showToolbar: true,           // Default: true
  enableContextMenu: true,     // Default: true
  menuZIndex: 1000,            // Default: 1000
  toolbarZIndex: 10            // Default: 10
});
```

### Methods

```typescript
// Add annotations programmatically
authoring.addVerticalLine(x: number): void
authoring.addTextNote(x: number, y: number, text: string, space?: 'data' | 'plot'): void

// History
authoring.undo(): boolean
authoring.redo(): boolean

// Query/Export
authoring.getAnnotations(): readonly AnnotationConfig[]
authoring.exportJSON(): string

// Cleanup
authoring.dispose(): void
```

### User Interactions

**Right-click empty space:**
- Add vertical line here
- Add horizontal line here
- Add text note here

**Right-click annotation:**
- Edit annotation...
- Delete annotation

**Drag annotation:**
- Click and drag to reposition
- ESC cancels drag

**Toolbar buttons:**
- Undo
- Redo
- Export JSON

## Declarative Usage

```typescript
const chart = await ChartGPU.create(container, {
  series: [...],
  annotations: [
    {
      type: 'lineX',
      x: 1704067200000,
      style: { color: '#22c55e', lineWidth: 2 },
      label: { text: 'Milestone' }
    },
    {
      type: 'lineY',
      y: 100,
      style: { color: '#ef4444', lineDash: [4, 4] },
      label: { template: 'Max: {y}', decimals: 1 }
    },
    {
      type: 'point',
      x: 1704153600000,
      y: 98.6,
      marker: { symbol: 'circle', size: 10, style: { color: '#ff4ab0' } },
      label: { template: 'Peak: {y}', decimals: 2 }
    },
    {
      type: 'text',
      position: { space: 'plot', x: 0.5, y: 0.05 },
      text: 'Preliminary Data',
      style: { color: '#ffffff', opacity: 0.7 }
    }
  ]
});
```

## Programmatic Management

```typescript
// Add annotation
const current = chart.options.annotations ?? [];
chart.setOption({
  ...chart.options,
  annotations: [
    ...current,
    { type: 'lineX', x: newX, style: { color: '#00ff00' } }
  ]
});

// Update annotation
const updated = current.map((a, i) =>
  i === targetIndex
    ? { ...a, style: { ...a.style, color: '#ff0000' } }
    : a
);
chart.setOption({ ...chart.options, annotations: updated });

// Remove annotation
const filtered = current.filter((_, i) => i !== removeIndex);
chart.setOption({ ...chart.options, annotations: filtered });

// Clear all
chart.setOption({ ...chart.options, annotations: [] });
```

## Common Patterns

### Horizontal Threshold

```typescript
{
  type: 'lineY',
  y: 100,
  layer: 'belowSeries',
  style: { color: '#ef4444', lineWidth: 2, lineDash: [8, 6], opacity: 0.9 },
  label: {
    text: 'Max Threshold',
    offset: [8, -8],
    anchor: 'start',
    background: { color: '#000000', opacity: 0.7, padding: [2, 6, 2, 6], borderRadius: 4 }
  }
}
```

### Vertical Event Marker

```typescript
{
  type: 'lineX',
  x: eventTimestamp,
  layer: 'belowSeries',
  style: { color: '#22c55e', lineWidth: 2 },
  label: { text: 'Product Launch', offset: [8, 10], anchor: 'start' }
}
```

### Peak Marker

```typescript
{
  type: 'point',
  x: maxX,
  y: maxY,
  layer: 'aboveSeries',
  marker: { symbol: 'circle', size: 10, style: { color: '#22c55e' } },
  label: {
    template: 'Peak: {y}',
    decimals: 2,
    offset: [10, -10],
    anchor: 'start',
    background: { color: '#000000', opacity: 0.8, padding: [2, 6, 2, 6], borderRadius: 4 }
  }
}
```

### Plot-Space HUD Text

```typescript
{
  type: 'text',
  position: { space: 'plot', x: 0.05, y: 0.05 },
  text: 'DRAFT',
  layer: 'belowSeries',
  style: { color: '#ef4444', opacity: 0.2 }
}
```

## Color Palette (High Contrast)

```typescript
const palette = [
  '#ef4444', // Red (critical)
  '#f97316', // Orange (warning)
  '#eab308', // Yellow (caution)
  '#22c55e', // Green (success)
  '#06b6d4', // Cyan (info)
  '#3b82f6', // Blue (primary)
  '#8b5cf6', // Purple (accent)
  '#ec4899', // Pink (highlight)
  '#ffffff', // White (high contrast)
  '#94a3b8', // Gray (neutral)
];
```

## Performance Tips

✅ **Do:**
- Keep visible annotations under 30
- Use `layer: 'belowSeries'` for backgrounds
- Batch updates in single `setOption(...)`
- Use appropriate tolerances for hit testing

❌ **Don't:**
- Add 100+ annotations without filtering
- Call `setOption(...)` in loop
- Use high opacity for many overlapping annotations
- Set very wide hit test tolerances

## Troubleshooting

### Annotations not visible
- Check coordinates are within data range
- Verify `layer` setting
- Check `style.opacity` is not 0
- For plot-space: ensure x/y in [0, 1]

### Drag not working
- Ensure `createAnnotationAuthoring(...)` called
- Check canvas pointer events not blocked
- Verify not inside `pointer-events: none` container

### Poor performance
- Limit to ~20-30 visible annotations
- Use `belowSeries` layer
- Reduce hit test tolerances

## Lifecycle

```typescript
// Create
const chart = await ChartGPU.create(container, options);
const authoring = createAnnotationAuthoring(container, chart);

// Use
authoring.addVerticalLine(Date.now());

// Cleanup (IMPORTANT: authoring first!)
authoring.dispose();
chart.dispose();
```

## See Also

- [Complete API Reference](../api/annotations.md)
- [Annotations Cookbook](./annotations-cookbook.md)
- [Example: Annotation Authoring](../../examples/annotation-authoring/)
- [TypeScript Types](../../src/config/types.ts)
