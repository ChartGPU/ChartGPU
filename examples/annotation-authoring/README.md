# Annotations - Comprehensive Demo

Interactive annotation system showcasing ChartGPU's full annotation editing capabilities.

## Features

### Create Annotations with Configuration Dialog
- **Right-click on empty space** to add annotations
- Choose from:
  - **Vertical Line** (lineX) - constrained to horizontal movement
  - **Horizontal Line** (lineY) - constrained to vertical movement
  - **Text Note** - free 2D positioning in data-space or plot-space
- Configure before creation:
  - **Label** - custom text label (optional)
  - **Color** - choose from 12-color high-contrast palette
  - **Line Style** - solid, dashed, or dotted
  - **Line Width** - 1-8 pixels

### Drag to Reposition
- **Click and drag any annotation** to move it
- Visual feedback:
  - Cursor changes based on annotation type (ew-resize, ns-resize, or grabbing)
  - Annotation becomes semi-transparent (70% opacity) while dragging
- Constraints:
  - Vertical lines (lineX): horizontal movement only
  - Horizontal lines (lineY): vertical movement only
  - Text annotations: free 2D movement
  - Point annotations: free 2D movement
- **Escape key** cancels drag and reverts to original position
- **Smooth 60 FPS** performance during drag

### Edit Existing Annotations
- **Right-click on any annotation** → "Edit annotation..."
- Opens configuration dialog with current values
- Modify any property (label, color, style, width)
- Changes integrate with undo/redo system

### Delete Annotations
- **Right-click on any annotation** → "Delete annotation"
- Immediate deletion with single history entry
- Can be undone with the Undo button

### Undo/Redo System
- **Toolbar buttons** in top-right corner
- Each operation creates a single history entry:
  - Create annotation
  - Drag annotation (entire drag = 1 entry)
  - Edit annotation
  - Delete annotation
- **50 entry history limit**
- Full state restoration on undo/redo

### JSON Export
- **Live JSON panel** on the right shows current annotations
- **Export JSON button** copies to clipboard
- Updates automatically as you modify annotations

## Pre-populated Examples

The demo includes example annotations demonstrating all features:

1. **Horizontal Reference Line** (yellow dashed)
   - Type: `lineY`
   - Template label: `ref y={y}`
   - Decimals: 3
   - Layer: below series

2. **Vertical Milestone Line** (green solid)
   - Type: `lineX`
   - Custom label: "milestone"
   - Layer: below series

3. **Peak Point Marker** (pink circle)
   - Type: `point`
   - Template label: `peak={y}`
   - Marker: circle, 8px

4. **Plot-space Text** (top-left, pinned)
   - Type: `text`
   - Position: plot-space (0.04, 0.08)
   - Stays pinned during pan/zoom

5. **Data-space Text** (tracks with data)
   - Type: `text`
   - Position: data-space at minimum point
   - Tracks with pan/zoom

## Usage

### Programmatic API

```typescript
import { createAnnotationAuthoring } from 'chartgpu';

// Create annotation authoring helper
const authoring = createAnnotationAuthoring(container, chart, {
  showToolbar: true,
  enableContextMenu: true,
});

// Programmatic API (optional - UI handles most use cases)
authoring.addVerticalLine(100);
authoring.addTextNote(50, 75, 'Note', 'data');
authoring.undo();
authoring.redo();
const json = authoring.exportJSON();

// Cleanup
authoring.dispose();
```

### Configuration Dialog API (Internal)

The configuration dialog is created internally by `createAnnotationAuthoring`. Configuration options:

```typescript
interface AnnotationConfigDialogOptions {
  palette?: readonly string[];  // 12-color palette (default: high-contrast)
  zIndex?: number;              // Dialog z-index (default: 1000)
}
```

### Hit Detection (Internal)

Hit detection determines which annotation was clicked:

```typescript
interface AnnotationHitTesterOptions {
  lineTolerance?: number;    // Default: 8px
  textTolerance?: number;    // Default: 4px
  pointTolerance?: number;   // Default: 12px
}
```

## Technical Details

### Coordinate Systems

1. **Data-space**: Chart domain coordinates (e.g., timestamp, value)
2. **Plot-space**: 0-1 fractions relative to plot area
3. **Canvas-space**: CSS pixels relative to canvas element

All conversions handle:
- Grid margins (left, right, top, bottom)
- Device pixel ratio for high-DPI displays
- Zoom/pan transformations
- Category vs. linear scales

### Performance

- **Optimistic updates** during drag (no history entries)
- **Single history entry** on drag end
- **60 FPS** maintained with 20+ annotations
- **Hit testing** completes in <1ms
- **Dialog rendering** completes in <16ms (1 frame)

### Browser Support

Requires WebGPU support:
- Chrome/Edge 113+
- Safari 18+
- Firefox: not supported yet

## See Also

- [ChartGPU Documentation](../../docs/)
- [API Reference](../../docs/API.md)
- [Interaction Guide](../../docs/api/interaction.md)
