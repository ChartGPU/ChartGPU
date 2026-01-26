# Theming Guide

ChartGPU provides a flexible theming system that controls chart appearance through background colors, text styling, grid/axis colors, and data visualization palettes. This guide shows how to use built-in themes, create custom themes, and switch themes dynamically.

## Quick Start

### Using Built-in Themes

ChartGPU includes two built-in themes: `'dark'` (default) and `'light'`.

**Dark theme (default):**

```typescript
const chart = ChartGPU.create(container, {
  theme: 'dark', // or omit this line
  series: [/* ... */]
});
```

**Light theme:**

```typescript
const chart = ChartGPU.create(container, {
  theme: 'light',
  series: [/* ... */]
});
```

The built-in themes are defined in:
- [darkTheme.ts](../src/themes/darkTheme.ts)
- [lightTheme.ts](../src/themes/lightTheme.ts)

## Theme Properties

A theme is defined by the [`ThemeConfig`](../src/themes/types.ts) interface with 8 properties:

| Property | Type | Description |
|----------|------|-------------|
| `backgroundColor` | `string` | Chart canvas background color (CSS color string) |
| `textColor` | `string` | Axis labels and text color |
| `axisLineColor` | `string` | Color of axis lines (x-axis and y-axis) |
| `axisTickColor` | `string` | Color of axis tick marks |
| `gridLineColor` | `string` | Color of grid lines |
| `colorPalette` | `string[]` | Array of colors used for series when no explicit color is set |
| `fontFamily` | `string` | Font stack for all text rendering |
| `fontSize` | `number` | Font size in pixels for axis labels |

### Property Details

**`backgroundColor`**  
Background color for the entire chart canvas. Rendered before any chart elements.

**`textColor`**  
Used for axis labels, legend text, and all UI text components.

**`axisLineColor` / `axisTickColor`**  
Control the visual styling of coordinate axes. Typically uses semi-transparent colors for subtle appearance.

**`gridLineColor`**  
Color for horizontal and vertical grid lines. Usually a low-opacity color to avoid visual clutter.

**`colorPalette`**  
Default colors assigned to series in sequence. When a series doesn't specify an explicit `color`, it uses `colorPalette[seriesIndex % colorPalette.length]`. For pie charts, individual slices without explicit colors also draw from this palette.

**`fontFamily`**  
CSS font-family string. The default uses system fonts for optimal rendering across platforms:
```typescript
'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"'
```

**`fontSize`**  
Size in pixels for axis labels and other chart text. Default: `12`.

## Creating Custom Themes

### Full Theme Object

Define a complete custom theme by providing all 8 properties:

```typescript
import type { ThemeConfig } from 'chart-gpu';

const corporateTheme: ThemeConfig = {
  backgroundColor: '#f5f5f5',
  textColor: '#2c3e50',
  axisLineColor: 'rgba(44, 62, 80, 0.3)',
  axisTickColor: 'rgba(44, 62, 80, 0.5)',
  gridLineColor: 'rgba(0, 0, 0, 0.08)',
  colorPalette: [
    '#3498db', // Primary blue
    '#e74c3c', // Alert red
    '#2ecc71', // Success green
    '#f39c12', // Warning orange
    '#9b59b6', // Purple
    '#1abc9c', // Teal
  ],
  fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
  fontSize: 13,
};

const chart = ChartGPU.create(container, {
  theme: corporateTheme,
  series: [/* ... */]
});
```

### Partial Theme Override

Override specific properties while keeping the rest from the dark theme base:

```typescript
const chart = ChartGPU.create(container, {
  theme: {
    backgroundColor: '#1e1e2e',
    colorPalette: ['#ff6b9d', '#c44569', '#ffa801', '#4b6584'],
    // Other properties inherit from dark theme
  },
  series: [/* ... */]
});
```

**Resolution behavior:** When you provide a theme object, ChartGPU merges it onto the dark theme. Only the properties you specify are overridden; missing properties fallback to the dark theme defaults. See [OptionResolver.ts](../src/config/OptionResolver.ts) `resolveTheme()` for implementation details.

### Example: Corporate Brand Theme

A complete example creating a professional brand-aligned theme:

```typescript
const brandTheme: ThemeConfig = {
  backgroundColor: '#ffffff',
  textColor: '#333333',
  axisLineColor: 'rgba(51, 51, 51, 0.2)',
  axisTickColor: 'rgba(51, 51, 51, 0.4)',
  gridLineColor: 'rgba(0, 0, 0, 0.05)',
  colorPalette: [
    '#0066cc', // Brand primary
    '#ff6600', // Brand secondary
    '#00cc66', // Success
    '#cc0000', // Error
    '#6600cc', // Accent
    '#00cccc', // Info
  ],
  fontFamily: '"Roboto", "Helvetica Neue", sans-serif',
  fontSize: 12,
};

const chart = ChartGPU.create(container, {
  theme: brandTheme,
  xAxis: { type: 'value' },
  yAxis: { type: 'value' },
  series: [
    { type: 'line', name: 'Revenue', data: [/* ... */] },
    { type: 'line', name: 'Expenses', data: [/* ... */] },
  ],
});
```

## Color Palette Behavior

The `colorPalette` array determines default series colors:

1. **Line series stroke color precedence:**  
   - Explicit `lineStyle.color` (highest priority)
   - Explicit `series[i].color`
   - `theme.colorPalette[i % colorPalette.length]` (fallback)

2. **Line series fill color precedence (when `areaStyle` is present):**  
   - Explicit `areaStyle.color` (highest priority)
   - Resolved stroke color (from above precedence)

3. **Area series fill color precedence:**  
   - Explicit `areaStyle.color` (highest priority)
   - Explicit `series[i].color`
   - `theme.colorPalette[i % colorPalette.length]` (fallback)

4. **Other series color precedence (bar, scatter):**  
   - Explicit `series[i].color` (highest priority)
   - `theme.colorPalette[i % colorPalette.length]` (fallback)

5. **Pie chart slices:**  
   - Explicit `PieDataItem.color` (highest priority)
   - `theme.colorPalette[(seriesIndex + itemIndex) % colorPalette.length]` (fallback)

6. **Palette override option:**  
   You can override just the palette without creating a full theme:

```typescript
const chart = ChartGPU.create(container, {
  theme: 'dark', // Use dark theme styling
  palette: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0'], // Override palette only
  series: [/* ... */]
});
```

When `palette` is provided in options, it replaces `theme.colorPalette` in the resolved configuration. See [OptionResolver.ts](../src/config/OptionResolver.ts) lines 286-289 for implementation.

## Switching Themes Dynamically

Use [`chart.setOption()`](../src/ChartGPU.ts) to change themes at runtime:

```typescript
// Create chart with dark theme
const chart = ChartGPU.create(container, {
  theme: 'dark',
  series: [/* ... */]
});

// Switch to light theme
chart.setOption({
  theme: 'light',
  series: chart.options.series, // Reuse existing series
});

// Switch to custom theme
chart.setOption({
  theme: {
    backgroundColor: '#2d2d2d',
    textColor: '#ffffff',
    gridLineColor: 'rgba(255, 255, 255, 0.15)',
    colorPalette: ['#00d4ff', '#ff0080', '#00ff88'],
  },
  series: chart.options.series,
});
```

**Important:** `setOption()` replaces the entire options object. When switching themes, you typically want to preserve your existing series, axis configuration, and other settings. Access the current options via `chart.options` and merge your theme changes.

### Example: Theme Toggle Button

```typescript
let isDark = true;

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  isDark = !isDark;
  
  chart.setOption({
    ...chart.options, // Preserve all current settings
    theme: isDark ? 'dark' : 'light',
  });
});
```

## Theme Application in Rendering

Themes are applied throughout the rendering pipeline:

- **Background:** Canvas cleared with `theme.backgroundColor` before each frame
- **Grid lines:** Rendered with `theme.gridLineColor`
- **Axes:** Lines use `theme.axisLineColor`, ticks use `theme.axisTickColor`
- **Text:** Axis labels rendered with `theme.textColor`, `theme.fontFamily`, `theme.fontSize`
- **Components:** Legend ([createLegend.ts](../src/components/createLegend.ts)) and data-zoom slider ([createDataZoomSlider.ts](../src/components/createDataZoomSlider.ts)) use theme styling

The main render coordinator ([createRenderCoordinator.ts](../src/core/createRenderCoordinator.ts)) orchestrates theme application across all chart elements.

## Theme Name Resolution

When using string theme names:

- `'light'` → Light theme (exact match, case-insensitive after trim)
- Any other string → Dark theme (fallback)
- `undefined` → Dark theme (default)

This means typos or unsupported theme names safely fallback to dark theme. See [OptionResolver.ts](../src/config/OptionResolver.ts) `resolveTheme()` lines 172-175.

## Best Practices

**1. Consistency:**  
Ensure sufficient contrast between `backgroundColor` and `textColor` for readability. Use semi-transparent colors for `gridLineColor` and `axisLineColor` to avoid overwhelming the data visualization.

**2. Palette size:**  
Provide enough colors in `colorPalette` to avoid repetition in multi-series charts. Typically 6-8 distinct colors work well.

**3. Accessible colors:**  
Choose color palettes that are distinguishable for users with color vision deficiencies. Tools like [ColorBrewer](https://colorbrewer2.org/) or [Adobe Color](https://color.adobe.com/) can help.

**4. Performance:**  
Theme changes trigger a full re-render. For frequent theme switching, consider debouncing user input or toggling themes only on explicit user action.

**5. Brand alignment:**  
Extract theme colors from your design system or brand guidelines to maintain visual consistency across your application.

## Type Safety

Import types for compile-time theme validation:

```typescript
import type { ThemeConfig } from 'chart-gpu';

const validateTheme = (theme: ThemeConfig): void => {
  // TypeScript ensures all 8 properties are present
  console.log('Valid theme:', theme);
};
```

Full type definitions: [types.ts](../src/themes/types.ts)

## Related Documentation

- [API Reference](./api/README.md) - Complete API documentation including theme-related types
- [Getting Started](./GETTING_STARTED.md) - Basic chart creation and configuration
- [Built-in Themes](../src/themes/) - Source code for dark and light themes
