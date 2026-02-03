# Annotations API

ChartGPU's annotations feature provides a powerful system for adding visual markers, reference lines, text notes, and point annotations to charts. The annotations API includes both declarative configuration and interactive authoring tools.

## Table of Contents

- [Overview](#overview)
- [Annotation Types](#annotation-types)
- [Configuration](#configuration)
- [Interactive Authoring](#interactive-authoring)
- [Hit Testing](#hit-testing)
- [Drag and Reposition](#drag-and-reposition)
- [Configuration Dialog](#configuration-dialog)
- [Usage Examples](#usage-examples)
- [Advanced Use Cases](#advanced-use-cases)
- [Troubleshooting](#troubleshooting)

## Overview

Annotations are visual overlays that can be:
- **Declaratively configured** via `ChartGPUOptions.annotations`
- **Interactively created and edited** using `createAnnotationAuthoring(...)`
- **Programmatically managed** with full undo/redo support
- **Exported and imported** as JSON for persistence

**Key capabilities:**
- Vertical lines (lineX), horizontal lines (lineY), text notes, point markers
- Two coordinate systems: data-space (tracks with zoom/pan) and plot-space (pinned HUD-style)
- Drag-to-reposition with type-specific constraints
- Right-click context menu for creation, editing, and deletion
- Undo/redo history (50 entries)
- JSON export/import
- Layer control (above or below series)
- Rich styling with colors, line styles, opacity, and labels

## Annotation Types

### LineX (Vertical Line)

A vertical line at a specific x-coordinate in data-space.

```typescript
interface AnnotationLineX {
  readonly type: 'lineX';
  readonly x: number;              // Data-space x coordinate
  readonly yRange?: readonly [minY: number, maxY: number]; // Optional y range
}
```

**Use cases:** Milestones, event markers, phase boundaries, time markers

**Drag behavior:** Constrained to horizontal movement only

### LineY (Horizontal Line)

A horizontal line at a specific y-coordinate in data-space.

```typescript
interface AnnotationLineY {
  readonly type: 'lineY';
  readonly y: number;              // Data-space y coordinate
  readonly xRange?: readonly [minX: number, maxX: number]; // Optional x range
}
```

**Use cases:** Thresholds, baselines, reference levels, target values

**Drag behavior:** Constrained to vertical movement only

### Point Marker

A marker at a specific (x, y) coordinate in data-space.

```typescript
interface AnnotationPoint {
  readonly type: 'point';
  readonly x: number;              // Data-space x coordinate
  readonly y: number;              // Data-space y coordinate
  readonly marker?: AnnotationPointMarker;
}

interface AnnotationPointMarker {
  readonly symbol?: 'circle' | 'rect' | 'triangle';
  readonly size?: number;          // Marker size in CSS pixels
  readonly style?: AnnotationStyle;
}
```

**Use cases:** Peak/trough markers, special events, outliers, highlights

**Drag behavior:** Free 2D movement in data-space

### Text Note

A text annotation at a specific position in either data-space or plot-space.

```typescript
interface AnnotationText {
  readonly type: 'text';
  readonly position: AnnotationPosition;
  readonly text: string;
}

type AnnotationPosition =
  | Readonly<{ space: 'data'; x: number; y: number }>   // Tracks with zoom/pan
  | Readonly<{ space: 'plot'; x: number; y: number }>;  // Pinned to plot area (0-1 fractions)
```

**Use cases:**
- **Data-space:** Annotations that track with data (e.g., "peak value", "minimum")
- **Plot-space:** HUD-style notes that stay pinned (e.g., "Q1 2024", watermarks)

**Drag behavior:** Free 2D movement preserving original coordinate space

## Configuration

All annotations share a common base configuration:

```typescript
interface AnnotationConfigBase {
  readonly id?: string;                    // Optional stable identifier
  readonly layer?: 'belowSeries' | 'aboveSeries';
  readonly style?: AnnotationStyle;
  readonly label?: AnnotationLabel;
}

type AnnotationConfig = (AnnotationLineX | AnnotationLineY | AnnotationPoint | AnnotationText) &
  AnnotationConfigBase;
```

### Style Configuration

```typescript
interface AnnotationStyle {
  readonly color?: string;                 // CSS color string
  readonly lineWidth?: number;             // Line width in CSS pixels (1-8 typical)
  readonly lineDash?: ReadonlyArray<number>; // Dash pattern (e.g., [4, 4] for dashed)
  readonly opacity?: number;               // 0-1 (default: varies by type)
}
```

**Common patterns:**
- Solid: `lineDash: undefined`
- Dashed: `lineDash: [4, 4]`
- Dotted: `lineDash: [2, 2]`

### Label Configuration

Labels provide automatic text rendering with templating support:

```typescript
interface AnnotationLabel {
  readonly text?: string;                  // Explicit label text
  readonly template?: string;              // Template string (e.g., 'x={x}, y={y}')
  readonly decimals?: number;              // Decimal places for numeric formatting
  readonly offset?: readonly [dx: number, dy: number]; // Pixel offset from anchor
  readonly anchor?: 'start' | 'center' | 'end';
  readonly background?: AnnotationLabelBackground;
}

interface AnnotationLabelBackground {
  readonly color?: string;                 // Background color
  readonly opacity?: number;               // Background opacity (0-1)
  readonly padding?: AnnotationLabelPadding;
  readonly borderRadius?: number;          // Border radius in CSS pixels
}

type AnnotationLabelPadding =
  | number                                 // Uniform padding
  | readonly [top: number, right: number, bottom: number, left: number];
```

**Template variables:**
- `{x}` - x-coordinate value
- `{y}` - y-coordinate value
- `{value}` - y-coordinate value (alias)

**Examples:**
```typescript
// Simple label
label: { text: 'Milestone' }

// Template with decimals
label: { template: 'ref y={y}', decimals: 3 }

// Label with background
label: {
  text: 'Peak',
  offset: [10, -10],
  anchor: 'start',
  background: {
    color: '#000000',
    opacity: 0.7,
    padding: [2, 6, 2, 6],
    borderRadius: 6
  }
}
```

### Layer Control

Annotations can be rendered above or below series data:

```typescript
layer: 'belowSeries' | 'aboveSeries'  // Default: 'aboveSeries'
```

**Use cases:**
- `'belowSeries'` - Reference lines, grids, background markers
- `'aboveSeries'` - Highlights, labels, annotations that must be visible

## Interactive Authoring

The `createAnnotationAuthoring(...)` function provides a complete annotation editing UI:

```typescript
function createAnnotationAuthoring(
  container: HTMLElement,
  chart: ChartGPUInstance,
  options?: AnnotationAuthoringOptions
): AnnotationAuthoringInstance;

interface AnnotationAuthoringOptions {
  readonly menuZIndex?: number;        // Context menu z-index (default: 1000)
  readonly toolbarZIndex?: number;     // Toolbar z-index (default: 10)
  readonly showToolbar?: boolean;      // Enable toolbar (default: true)
  readonly enableContextMenu?: boolean; // Enable right-click menu (default: true)
}
```

### AnnotationAuthoringInstance

The returned instance provides programmatic control:

```typescript
interface AnnotationAuthoringInstance {
  addVerticalLine(x: number): void;
  addTextNote(x: number, y: number, text: string, space?: 'data' | 'plot'): void;
  undo(): boolean;
  redo(): boolean;
  exportJSON(): string;
  getAnnotations(): readonly AnnotationConfig[];
  dispose(): void;
}
```

### Interactive Features

**Right-click context menu:**
- Right-click on **empty space** → Add vertical line / horizontal line / text note
- Right-click on **annotation** → Edit / Delete
- Automatic coordinate conversion (data-space and plot-space)
- Escape key closes menu

**Drag-to-reposition:**
- Click and drag any annotation to move it
- Visual feedback: cursor changes, 70% opacity during drag
- Type-specific constraints (lineX: horizontal only, lineY: vertical only)
- Escape cancels drag and reverts position
- 60 FPS performance

**Undo/redo system:**
- Toolbar buttons in top-right corner
- Single history entry per operation (create, drag, edit, delete)
- 50 entry limit
- Full state restoration

**JSON export:**
- Export button copies to clipboard
- Fallback modal if clipboard unavailable
- Compatible with `ChartGPUOptions.annotations`

### Lifecycle Management

```typescript
// Create authoring helper
const authoring = createAnnotationAuthoring(container, chart, {
  showToolbar: true,
  enableContextMenu: true,
});

// Use programmatic API
authoring.addVerticalLine(Date.now());
authoring.addTextNote(50, 75, 'Important', 'data');

// Cleanup (IMPORTANT: dispose before chart)
authoring.dispose();
chart.dispose();
```

**Important:** Always call `authoring.dispose()` before `chart.dispose()` to clean up event listeners and DOM elements.

## Hit Testing

Hit testing detects which annotation (if any) the user clicked or hovered over. This is handled internally by `createAnnotationAuthoring(...)`, but the underlying API is available for custom implementations.

### Hit Test API

```typescript
interface AnnotationHitTestResult {
  readonly annotationIndex: number;        // Index in annotations array
  readonly annotation: AnnotationConfig;   // The annotation that was hit
  readonly hitType: 'line' | 'text' | 'point' | 'label';
  readonly distanceCssPx: number;         // Distance from pointer in CSS pixels
}

interface AnnotationHitTesterOptions {
  readonly lineTolerance?: number;        // Default: 20px
  readonly textTolerance?: number;        // Default: 8px
  readonly pointTolerance?: number;       // Default: 16px
  readonly labelTolerance?: number;       // Default: 2px
  readonly spatialGridThreshold?: number; // Default: 20 annotations
}
```

**Hit priority order:** Labels > Points > Text > Lines

**Coordinate systems:**
- Input: canvas-space CSS pixels (relative to canvas element)
- Internal: converts to data-space or plot-space as needed
- Handles grid margins, device pixel ratio, zoom/pan transformations

## Drag and Reposition

Dragging is constraint-based and optimized for 60 FPS performance:

### Constraints

| Type   | Movement Constraint | Coordinate Space |
|--------|-------------------|------------------|
| lineX  | Horizontal only   | Data-space       |
| lineY  | Vertical only     | Data-space       |
| point  | Free 2D           | Data-space       |
| text   | Free 2D           | Original space   |

### Performance Optimizations

- **Optimistic updates** during drag (no history entries)
- **Single history entry** on drag end
- **Window-level pointer events** for smooth dragging outside canvas
- **Visual feedback** with cursor changes and opacity reduction

### Cancellation

- **Escape key** cancels drag and reverts to original position
- **Pointer cancel** events handled gracefully

## Configuration Dialog

The configuration dialog provides a modal UI for creating and editing annotations. It's created internally by `createAnnotationAuthoring(...)` but can be customized:

### Dialog Features

**Color picker:**
- 12-color high-contrast palette
- Grid layout with visual swatches
- Hover effects and selection state

**Form controls:**
- Text input (label, text content)
- Textarea (multi-line text)
- Dropdown (line style: solid/dashed/dotted)
- Slider (line width: 1-8px, marker size: 4-16px)

**Keyboard shortcuts:**
- **Escape** closes dialog (cancel)
- **Enter** in text fields submits form (save)
- **Auto-focus** on first input

### Palette Customization

```typescript
interface AnnotationConfigDialogOptions {
  readonly palette?: readonly string[];  // Default: high-contrast 12-color palette
  readonly zIndex?: number;              // Dialog z-index (default: 1000)
}

const HIGH_CONTRAST_PALETTE = [
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
  '#64748b', // Dark gray (subtle)
  '#1e293b', // Near-black (background)
];
```

## Usage Examples

### Basic Declarative Annotations

```typescript
const options: ChartGPUOptions = {
  series: [
    { type: 'line', name: 'Temperature', data: [...] }
  ],
  annotations: [
    // Vertical line at specific timestamp
    {
      type: 'lineX',
      x: 1704067200000,
      layer: 'belowSeries',
      style: { color: '#40d17c', lineWidth: 2 },
      label: { text: 'Q1 Start' }
    },
    // Horizontal threshold line
    {
      type: 'lineY',
      y: 75,
      layer: 'belowSeries',
      style: {
        color: '#ffd166',
        lineWidth: 2,
        lineDash: [8, 6]
      },
      label: { template: 'threshold={y}', decimals: 1 }
    },
    // Peak marker
    {
      type: 'point',
      x: 1704153600000,
      y: 98.6,
      layer: 'aboveSeries',
      marker: {
        symbol: 'circle',
        size: 10,
        style: { color: '#ff4ab0' }
      },
      label: {
        template: 'peak={y}°F',
        decimals: 1,
        offset: [10, -10]
      }
    },
    // Plot-space HUD text
    {
      type: 'text',
      position: { space: 'plot', x: 0.05, y: 0.05 },
      text: 'Preliminary Data',
      layer: 'aboveSeries',
      style: { color: '#ffffff', opacity: 0.7 }
    }
  ]
};

const chart = await ChartGPU.create(container, options);
```

### Interactive Annotation Authoring

```typescript
import { ChartGPU, createAnnotationAuthoring } from 'chartgpu';

// Create chart
const chart = await ChartGPU.create(container, {
  series: [{ type: 'line', data: [...] }],
  annotations: [] // Start with no annotations
});

// Enable annotation authoring
const authoring = createAnnotationAuthoring(container, chart, {
  showToolbar: true,
  enableContextMenu: true,
  menuZIndex: 1000,
  toolbarZIndex: 10
});

// Users can now:
// - Right-click to add annotations
// - Drag annotations to reposition
// - Right-click annotations to edit/delete
// - Use undo/redo buttons
// - Export JSON

// Programmatic operations
authoring.addVerticalLine(Date.now());
authoring.addTextNote(50, 75, 'Critical Point', 'data');

const annotations = authoring.getAnnotations();
const json = authoring.exportJSON();

// Cleanup
authoring.dispose();
chart.dispose();
```

### Programmatic Annotation Management

```typescript
// Add annotations dynamically
chart.setOption({
  ...chart.options,
  annotations: [
    ...chart.options.annotations ?? [],
    {
      type: 'lineX',
      x: newEventTimestamp,
      style: { color: '#00ff00', lineWidth: 2 },
      label: { text: 'New Event' }
    }
  ]
});

// Update existing annotation
const annotations = chart.options.annotations ?? [];
const updated = annotations.map((a, i) =>
  i === targetIndex
    ? { ...a, style: { ...a.style, color: '#ff0000' } }
    : a
);
chart.setOption({ ...chart.options, annotations: updated });

// Remove annotation
const filtered = annotations.filter((_, i) => i !== removeIndex);
chart.setOption({ ...chart.options, annotations: filtered });
```

### JSON Export and Import

```typescript
// Export annotations
const authoring = createAnnotationAuthoring(container, chart);
const json = authoring.exportJSON();
localStorage.setItem('chart-annotations', json);

// Import annotations
const storedJson = localStorage.getItem('chart-annotations');
if (storedJson) {
  const annotations = JSON.parse(storedJson) as AnnotationConfig[];
  chart.setOption({ ...chart.options, annotations });
}
```

## Advanced Use Cases

### Dynamic Thresholds with Labels

```typescript
function addThreshold(y: number, label: string, color: string) {
  const annotations = chart.options.annotations ?? [];
  chart.setOption({
    ...chart.options,
    annotations: [
      ...annotations,
      {
        type: 'lineY',
        y,
        layer: 'belowSeries',
        style: { color, lineWidth: 2, lineDash: [4, 4], opacity: 0.9 },
        label: {
          template: `${label}={y}`,
          decimals: 2,
          offset: [8, -8],
          anchor: 'start',
          background: {
            color: '#000000',
            opacity: 0.6,
            padding: [2, 6, 2, 6],
            borderRadius: 4
          }
        }
      }
    ]
  });
}

addThreshold(100, 'Max', '#ef4444');
addThreshold(50, 'Target', '#22c55e');
addThreshold(0, 'Min', '#3b82f6');
```

### Event Timeline with Vertical Lines

```typescript
const events = [
  { timestamp: 1704067200000, label: 'Release 1.0', color: '#22c55e' },
  { timestamp: 1704153600000, label: 'Bug Fix', color: '#f97316' },
  { timestamp: 1704240000000, label: 'Release 2.0', color: '#3b82f6' },
];

const annotations: AnnotationConfig[] = events.map(evt => ({
  type: 'lineX',
  x: evt.timestamp,
  layer: 'belowSeries',
  style: { color: evt.color, lineWidth: 2 },
  label: {
    text: evt.label,
    offset: [8, 10],
    anchor: 'start',
    background: { color: '#000000', opacity: 0.7, padding: [2, 6, 2, 6], borderRadius: 4 }
  }
}));

chart.setOption({ ...chart.options, annotations });
```

### Peak and Trough Markers

```typescript
function findExtrema(data: DataPoint[]): { max: DataPoint; min: DataPoint } {
  let max = data[0]!;
  let min = data[0]!;

  for (const point of data) {
    const y = Array.isArray(point) ? point[1] : point.y;
    const maxY = Array.isArray(max) ? max[1] : max.y;
    const minY = Array.isArray(min) ? min[1] : min.y;

    if (y > maxY) max = point;
    if (y < minY) min = point;
  }

  return { max, min };
}

const { max, min } = findExtrema(seriesData);
const maxX = Array.isArray(max) ? max[0] : max.x;
const maxY = Array.isArray(max) ? max[1] : max.y;
const minX = Array.isArray(min) ? min[0] : min.x;
const minY = Array.isArray(min) ? min[1] : min.y;

const annotations: AnnotationConfig[] = [
  {
    type: 'point',
    x: maxX,
    y: maxY,
    layer: 'aboveSeries',
    marker: { symbol: 'circle', size: 10, style: { color: '#22c55e' } },
    label: { template: 'Peak: {y}', decimals: 2, offset: [10, -10] }
  },
  {
    type: 'point',
    x: minX,
    y: minY,
    layer: 'aboveSeries',
    marker: { symbol: 'circle', size: 10, style: { color: '#ef4444' } },
    label: { template: 'Trough: {y}', decimals: 2, offset: [10, 10] }
  }
];

chart.setOption({ ...chart.options, annotations });
```

### Plot-Space HUD Overlays

```typescript
const hudAnnotations: AnnotationConfig[] = [
  // Top-left watermark
  {
    type: 'text',
    position: { space: 'plot', x: 0.05, y: 0.05 },
    text: '© 2024 Company',
    layer: 'aboveSeries',
    style: { color: '#ffffff', opacity: 0.3 }
  },
  // Bottom-right status
  {
    type: 'text',
    position: { space: 'plot', x: 0.95, y: 0.95 },
    text: 'Live',
    layer: 'aboveSeries',
    style: { color: '#22c55e', opacity: 1 }
  },
  // Center banner
  {
    type: 'text',
    position: { space: 'plot', x: 0.5, y: 0.5 },
    text: 'DRAFT',
    layer: 'belowSeries',
    style: { color: '#ef4444', opacity: 0.2 }
  }
];

chart.setOption({ ...chart.options, annotations: hudAnnotations });
```

### Custom Right-Click Handler

```typescript
const canvas = container.querySelector('canvas')!;

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  const hit = chart.hitTest(e);

  if (hit.isInGrid) {
    // Show custom menu at hit.gridX, hit.gridY (CSS pixels relative to canvas)
    // Use hit.match for snap-to-data behavior

    if (hit.match) {
      console.log('Right-clicked near data point:', hit.match.value);
      // Add annotation at exact data point
      const [x, y] = hit.match.value;
      // ... add annotation programmatically
    } else {
      console.log('Right-clicked in plot area at grid position:', hit.gridX, hit.gridY);
      // ... convert grid coordinates to data-space and add annotation
    }
  }
});
```

## Troubleshooting

### Common Issues

**Annotations not visible:**
- Check `layer` property - ensure it's set appropriately for your use case
- Verify coordinates are within the visible data range
- Check `style.opacity` - ensure it's not 0 or very low
- For plot-space text: verify x and y are in [0, 1] range

**Drag not working:**
- Ensure `createAnnotationAuthoring(...)` has been called
- Check that pointer events are not being blocked by other elements
- Verify canvas is not inside a container with `pointer-events: none`

**Context menu not appearing:**
- Ensure `enableContextMenu: true` in options
- Check that browser's default context menu isn't blocking it
- Verify z-index is high enough (`menuZIndex` option)

**Poor performance with many annotations:**
- Limit to ~20-30 visible annotations for optimal performance
- Use `layer: 'belowSeries'` for background annotations
- Avoid very wide `lineTolerance` in hit testing

**Undo/redo not working:**
- Ensure you're using the programmatic API through `AnnotationAuthoringInstance`
- Direct calls to `chart.setOption(...)` bypass the history system
- Check that `dispose()` hasn't been called

**Labels overlapping:**
- Adjust `label.offset` to shift label position
- Use `label.anchor` to control alignment
- Consider reducing the number of labels or using conditional rendering

### Best Practices

**Performance:**
- Keep annotation count reasonable (<50 for smooth 60 FPS)
- Use `layer: 'belowSeries'` for decorative elements
- Batch annotation updates in a single `setOption(...)` call

**Coordinate systems:**
- Use **data-space** for annotations that track with zoom/pan
- Use **plot-space** for HUD elements that stay pinned
- Test with different zoom levels to verify coordinate behavior

**Styling:**
- Use high-contrast colors for visibility
- Set appropriate `opacity` for layering (0.8-0.95 typical)
- Use `lineDash` patterns for distinction from series lines
- Add label backgrounds for readability over complex charts

**Lifecycle:**
- Always call `authoring.dispose()` before `chart.dispose()`
- Remove event listeners if implementing custom interactions
- Clear large annotation arrays when switching datasets

**Accessibility:**
- Provide meaningful label text for screen readers
- Use sufficient color contrast (consider colorblind users)
- Include keyboard navigation for custom implementations

## See Also

- [Interaction API](./interaction.md) - Event handling, zoom, and pan
- [Options API](./options.md) - Chart configuration reference
- [Chart API](./chart.md) - ChartGPU instance methods
- [Example: Annotation Authoring](../../examples/annotation-authoring/) - Interactive demo
- [TypeScript Types](../../src/config/types.ts) - Full type definitions
