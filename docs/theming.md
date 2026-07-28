# Theming

ChartGPU themes control background, text, grid/axis colors, and series palette.

## Quick recipes

**Built-in presets:**
```ts
theme: 'dark'   // default
theme: 'light'
```

**Custom theme (partial override):**
```ts
theme: {
  backgroundColor: '#1e1e2e',
  colorPalette: ['#ff6b9d', '#c44569', '#ffa801'],
  // Other properties inherit from dark theme
}
```

**Palette-only override:**
```ts
theme: 'dark',
palette: ['#FF6384', '#36A2EB', '#FFCE56'],
```

**Switch at runtime:**
```ts
chart.setOption({ ...chart.options, theme: 'light' });
```

## Full reference

See [Themes API](https://chartgpu.io/docs/api/themes/) for `ThemeConfig` properties, color precedence, and type definitions.
