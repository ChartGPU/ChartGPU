import type { SeriesConfig } from '../config/types';
import type { ResolvedSeriesConfig } from '../config/OptionResolver';
import type { ThemeConfig } from '../themes/types';

export type LegendPosition = 'top' | 'bottom' | 'left' | 'right';

/** User or resolved series — legend only reads type/name/color/visible (+ pie slices). */
export type LegendSeriesInput = SeriesConfig | ResolvedSeriesConfig;

export interface Legend {
  update(series: ReadonlyArray<LegendSeriesInput>, theme: ThemeConfig): void;
  dispose(): void;
}

const getSeriesName = (series: LegendSeriesInput, index: number): string => {
  const candidate = series.name?.trim();
  return candidate ? candidate : `Series ${index + 1}`;
};

const getSeriesColor = (series: LegendSeriesInput, index: number, theme: ThemeConfig): string => {
  const explicit = series.color?.trim();
  if (explicit) return explicit;

  // Finance series: prefer upColor for the legend swatch when series.color is unset
  // (plan D11: solid swatch = up color or series color).
  if (series.type === 'candlestick' || series.type === 'ohlc') {
    const up = (series as { itemStyle?: { upColor?: string } }).itemStyle?.upColor?.trim();
    if (up) return up;
  }

  // Error bars: itemStyle.color when series.color omitted.
  if (series.type === 'errorBar') {
    const c = (series as { itemStyle?: { color?: string } }).itemStyle?.color?.trim();
    if (c) return c;
  }

  const palette = theme.colorPalette;
  if (palette.length > 0) return palette[index % palette.length] ?? '#000000';
  return '#000000';
};

const getPieSliceLabel = (sliceName: string | undefined, sliceIndex: number): string => {
  const candidate = sliceName?.trim();
  return candidate ? candidate : `Slice ${sliceIndex + 1}`;
};

const getPieSliceColor = (
  sliceColor: string | undefined,
  seriesIndex: number,
  sliceIndex: number,
  theme: ThemeConfig
): string => {
  const explicit = sliceColor?.trim();
  if (explicit) return explicit;

  const palette = theme.colorPalette;
  const len = palette.length;
  if (len > 0) return palette[(seriesIndex + sliceIndex) % len] ?? '#000000';
  return '#000000';
};

export function createLegend(
  container: HTMLElement,
  position: LegendPosition = 'right',
  onSeriesToggle?: (seriesIndex: number, sliceIndex?: number) => void
): Legend {
  const computedPosition = getComputedStyle(container).position;
  const didSetRelative = computedPosition === 'static';
  const previousInlinePosition = didSetRelative ? container.style.position : null;

  if (didSetRelative) {
    container.style.position = 'relative';
  }

  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.pointerEvents = 'auto';
  root.style.userSelect = 'none';
  root.style.boxSizing = 'border-box';
  // Above axis label canvas (createTextOverlay z-index 10) so legend masks labels.
  root.style.zIndex = '15';

  // Theme-driven styling (set/update in update()).
  root.style.padding = '8px';
  root.style.borderRadius = '8px';
  root.style.borderStyle = 'solid';
  root.style.borderWidth = '1px';
  root.style.maxHeight = 'calc(100% - 16px)';
  root.style.overflow = 'auto';

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.gap = '8px';
  root.appendChild(list);

  // Event delegation for series toggle (fixes memory leak and improves performance)
  if (onSeriesToggle) {
    list.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('[data-series-index]') as HTMLElement;
      if (item) {
        const seriesIndex = parseInt(item.dataset.seriesIndex!, 10);
        if (!isNaN(seriesIndex)) {
          // Check if this is a pie slice item
          const sliceIndexStr = item.dataset.sliceIndex;
          if (sliceIndexStr !== undefined) {
            const sliceIndex = parseInt(sliceIndexStr, 10);
            if (!isNaN(sliceIndex)) {
              onSeriesToggle(seriesIndex, sliceIndex);
              return;
            }
          }
          // Regular series toggle
          onSeriesToggle(seriesIndex);
        }
      }
    });

    // Keyboard navigation support for accessibility
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target as HTMLElement;
        const item = target.closest('[data-series-index]') as HTMLElement;
        if (item) {
          e.preventDefault();
          const seriesIndex = parseInt(item.dataset.seriesIndex!, 10);
          if (!isNaN(seriesIndex)) {
            // Check if this is a pie slice item
            const sliceIndexStr = item.dataset.sliceIndex;
            if (sliceIndexStr !== undefined) {
              const sliceIndex = parseInt(sliceIndexStr, 10);
              if (!isNaN(sliceIndex)) {
                onSeriesToggle(seriesIndex, sliceIndex);
                return;
              }
            }
            // Regular series toggle
            onSeriesToggle(seriesIndex);
          }
        }
      }
    });
  }

  const applyPositionStyles = (p: LegendPosition): void => {
    // Clear positional styles first so changing position is safe/idempotent.
    root.style.top = '';
    root.style.right = '';
    root.style.bottom = '';
    root.style.left = '';
    root.style.maxWidth = '';

    list.style.flexDirection = '';
    list.style.flexWrap = '';
    list.style.alignItems = '';

    switch (p) {
      case 'right': {
        root.style.top = '8px';
        root.style.right = '8px';
        root.style.maxWidth = '40%';

        list.style.flexDirection = 'column';
        list.style.flexWrap = 'nowrap';
        list.style.alignItems = 'flex-start';
        return;
      }
      case 'left': {
        root.style.top = '8px';
        root.style.left = '8px';
        root.style.maxWidth = '40%';

        list.style.flexDirection = 'column';
        list.style.flexWrap = 'nowrap';
        list.style.alignItems = 'flex-start';
        return;
      }
      case 'top': {
        root.style.top = '8px';
        root.style.left = '8px';
        root.style.right = '8px';

        list.style.flexDirection = 'row';
        list.style.flexWrap = 'wrap';
        list.style.alignItems = 'center';
        return;
      }
      case 'bottom': {
        root.style.bottom = '8px';
        root.style.left = '8px';
        root.style.right = '8px';

        list.style.flexDirection = 'row';
        list.style.flexWrap = 'wrap';
        list.style.alignItems = 'center';
        return;
      }
    }
  };

  applyPositionStyles(position);
  container.appendChild(root);

  let disposed = false;
  /**
   * Identity skip for axes-only multi-series setOption (group 1): when the
   * resolved series array reference is unchanged **and theme is unchanged**,
   * do not rebuild N legend DOM nodes every frame. Root theme chrome always
   * updates; per-item swatch borders use theme so theme identity changes force
   * a list rebuild.
   */
  let lastSeriesRef: ReadonlyArray<LegendSeriesInput> | null = null;
  let lastThemeRef: ThemeConfig | null = null;
  let lastListLen = -1;

  const update: Legend['update'] = (series, theme) => {
    if (disposed) return;

    root.style.color = theme.textColor;
    root.style.background = theme.backgroundColor;
    root.style.borderColor = theme.axisLineColor;
    root.style.fontFamily = theme.fontFamily;
    root.style.fontSize = `${theme.fontSize}px`;

    // Same series array identity + same theme ref → list content and per-item
    // theme-derived styles are unchanged. Skip O(n) createElement + replaceChildren.
    if (lastSeriesRef === series && lastThemeRef === theme && lastListLen === series.length) {
      return;
    }
    lastSeriesRef = series;
    lastThemeRef = theme;
    lastListLen = series.length;

    const items: HTMLElement[] = [];
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
      const s = series[seriesIndex];

      if (s.type === 'pie') {
        for (let sliceIndex = 0; sliceIndex < s.data.length; sliceIndex++) {
          const slice = s.data[sliceIndex];
          const isVisible = slice?.visible !== false;

          const item = document.createElement('div');
          item.style.display = 'flex';
          item.style.alignItems = 'center';
          item.style.gap = '6px';
          item.style.lineHeight = '1.1';
          item.style.whiteSpace = 'nowrap';
          item.style.cursor = onSeriesToggle ? 'pointer' : 'default';
          item.style.opacity = isVisible ? '1' : '0.5';
          item.style.transition = 'opacity 0.2s';

          // Add accessibility attributes and data attributes for event delegation
          if (onSeriesToggle) {
            item.setAttribute('role', 'button');
            item.setAttribute('aria-pressed', String(isVisible));
            item.setAttribute('aria-label', `Toggle ${getPieSliceLabel(slice?.name, sliceIndex)} visibility`);
            item.tabIndex = 0;
            item.dataset.seriesIndex = String(seriesIndex);
            item.dataset.sliceIndex = String(sliceIndex);
          }

          const swatch = document.createElement('div');
          swatch.style.width = '10px';
          swatch.style.height = '10px';
          swatch.style.borderRadius = '2px';
          swatch.style.flex = '0 0 auto';
          swatch.style.background = getPieSliceColor(slice?.color, seriesIndex, sliceIndex, theme);
          swatch.style.border = `1px solid ${theme.axisLineColor}`;

          const label = document.createElement('span');
          label.textContent = getPieSliceLabel(slice?.name, sliceIndex);
          label.style.textDecoration = isVisible ? 'none' : 'line-through';

          item.appendChild(swatch);
          item.appendChild(label);
          items.push(item);
        }
      } else {
        const isVisible = s.visible !== false;

        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '6px';
        item.style.lineHeight = '1.1';
        item.style.whiteSpace = 'nowrap';
        item.style.cursor = onSeriesToggle ? 'pointer' : 'default';
        item.style.opacity = isVisible ? '1' : '0.5';
        item.style.transition = 'opacity 0.2s';

        // Add accessibility attributes and data attribute for event delegation
        if (onSeriesToggle) {
          item.setAttribute('role', 'button');
          item.setAttribute('aria-pressed', String(isVisible));
          item.setAttribute('aria-label', `Toggle ${getSeriesName(s, seriesIndex)} visibility`);
          item.tabIndex = 0;
          item.dataset.seriesIndex = String(seriesIndex);
        }

        const swatch = document.createElement('div');
        swatch.style.width = '10px';
        swatch.style.height = '10px';
        swatch.style.borderRadius = '2px';
        swatch.style.flex = '0 0 auto';
        swatch.style.background = getSeriesColor(s, seriesIndex, theme);
        swatch.style.border = `1px solid ${theme.axisLineColor}`;

        const label = document.createElement('span');
        label.textContent = getSeriesName(s, seriesIndex);
        label.style.textDecoration = isVisible ? 'none' : 'line-through';

        item.appendChild(swatch);
        item.appendChild(label);
        items.push(item);
      }
    }

    list.replaceChildren(...items);
  };

  const dispose: Legend['dispose'] = () => {
    if (disposed) return;
    disposed = true;

    try {
      root.remove();
    } finally {
      if (previousInlinePosition !== null) {
        container.style.position = previousInlinePosition;
      }
    }
  };

  return { update, dispose };
}
