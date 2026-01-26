# Themes

## `ThemeConfig`

Theme configuration type for describing chart theme colors, palette, and typography. Used by `ChartGPUOptions.theme` (and produced by [`resolveOptions`](../../src/config/OptionResolver.ts)).

See [`types.ts`](../../src/themes/types.ts).

## Theme presets

ChartGPU provides built-in theme presets and a small helper for selecting them. These are exported from the public entrypoint; see [`src/index.ts`](../../src/index.ts).

- **`darkTheme: ThemeConfig`**: built-in dark preset. See [`darkTheme.ts`](../../src/themes/darkTheme.ts).
- **`lightTheme: ThemeConfig`**: built-in light preset. See [`lightTheme.ts`](../../src/themes/lightTheme.ts).
- **`ThemeName = 'dark' | 'light'`**: preset name union. See [`themes/index.ts`](../../src/themes/index.ts).
- **`getTheme(name: ThemeName): ThemeConfig`**: returns a preset by name. See [`themes/index.ts`](../../src/themes/index.ts).
