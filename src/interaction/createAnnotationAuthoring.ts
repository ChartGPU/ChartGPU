/**
 * Annotation authoring helper for ChartGPU instances.
 * 
 * Provides right-click context menu for adding vertical lines and text annotations,
 * with undo/redo and JSON export capabilities.
 */

import type { ChartGPUInstance, ChartGPUHitTestResult } from '../ChartGPU';
import type { AnnotationConfig, DataPoint, DataPointTuple, OHLCDataPoint, OHLCDataPointTuple } from '../config/types';
import { defaultGrid } from '../config/defaults';

// Type guards and helpers
const isTupleDataPoint = (p: DataPoint): p is DataPointTuple => Array.isArray(p);
const isTupleOHLCDataPoint = (p: OHLCDataPoint): p is OHLCDataPointTuple => Array.isArray(p);

const getPointX = (p: DataPoint): number => (isTupleDataPoint(p) ? p[0] : p.x);
const getOHLCTimestamp = (p: OHLCDataPoint): number => (isTupleOHLCDataPoint(p) ? p[0] : p.timestamp);

/**
 * Configuration options for annotation authoring.
 */
export interface AnnotationAuthoringOptions {
  /**
   * Z-index for the context menu (default: 1000).
   */
  readonly menuZIndex?: number;
  /**
   * Z-index for the toolbar (default: 10).
   */
  readonly toolbarZIndex?: number;
  /**
   * Enable toolbar with undo/redo/export buttons (default: true).
   */
  readonly showToolbar?: boolean;
  /**
   * Enable right-click context menu (default: true).
   */
  readonly enableContextMenu?: boolean;
}

/**
 * Annotation authoring instance returned by `createAnnotationAuthoring`.
 * 
 * Provides programmatic control over annotations and manages UI lifecycle.
 */
export interface AnnotationAuthoringInstance {
  /**
   * Programmatically add a vertical line annotation.
   * 
   * @param x - X-coordinate in data domain units
   */
  addVerticalLine(x: number): void;
  /**
   * Programmatically add a text annotation.
   * 
   * @param x - X-coordinate (domain units for 'data' space, fraction [0-1] for 'plot' space)
   * @param y - Y-coordinate (domain units for 'data' space, fraction [0-1] for 'plot' space)
   * @param text - Annotation text content
   * @param space - Coordinate space: 'data' (default) or 'plot'
   */
  addTextNote(x: number, y: number, text: string, space?: 'data' | 'plot'): void;
  /**
   * Undo the last annotation change.
   * 
   * @returns `true` if undo was successful, `false` if nothing to undo
   */
  undo(): boolean;
  /**
   * Redo a previously undone change.
   * 
   * @returns `true` if redo was successful, `false` if nothing to redo
   */
  redo(): boolean;
  /**
   * Export current annotations as JSON string.
   * 
   * @returns JSON string representation of annotations array
   */
  exportJSON(): string;
  /**
   * Get the current annotations array.
   * 
   * @returns Readonly copy of current annotations
   */
  getAnnotations(): readonly AnnotationConfig[];
  /**
   * Clean up event listeners and DOM elements.
   * 
   * Safe to call multiple times. After disposal, the instance should not be used.
   */
  dispose(): void;
}

interface HistoryEntry {
  readonly annotations: readonly AnnotationConfig[];
}

/**
 * Creates an annotation authoring helper for a chart instance.
 * 
 * Features:
 * - Right-click context menu for adding vertical lines and text annotations
 * - Optional toolbar with undo/redo/export buttons
 * - Undo/redo history (50 entries max)
 * - JSON export with clipboard integration
 * - Automatic coordinate conversion (data-space and plot-space)
 * - Event listener cleanup on dispose
 * 
 * Annotations are persisted by calling `chart.setOption({ ...options, annotations })`,
 * so they integrate seamlessly with the chart's option system.
 * 
 * @param container - The chart container element (must contain the chart canvas)
 * @param chart - The ChartGPU instance
 * @param options - Optional configuration for menu/toolbar z-index and visibility
 * @returns Annotation authoring instance with programmatic API and dispose method
 * @throws Error if canvas is not found
 * 
 * @example
 * ```ts
 * const chart = await ChartGPU.create(container, options);
 * const authoring = createAnnotationAuthoring(container, chart, {
 *   showToolbar: true,
 *   enableContextMenu: true,
 * });
 * 
 * // Programmatic API
 * authoring.addVerticalLine(Date.now());
 * authoring.addTextNote(x, y, 'Peak', 'data');
 * authoring.undo();
 * authoring.redo();
 * const json = authoring.exportJSON();
 * 
 * // Cleanup
 * authoring.dispose();
 * chart.dispose();
 * ```
 */
export function createAnnotationAuthoring(
  container: HTMLElement,
  chart: ChartGPUInstance,
  options: AnnotationAuthoringOptions = {}
): AnnotationAuthoringInstance {
  const {
    menuZIndex = 1000,
    toolbarZIndex = 10,
    showToolbar = true,
    enableContextMenu = true,
  } = options;

  // Find the canvas element
  const canvas = container.querySelector('canvas');
  if (!canvas) {
    throw new Error('createAnnotationAuthoring: canvas element not found in container');
  }

  // History management
  let history: HistoryEntry[] = [{ annotations: chart.options.annotations ?? [] }];
  let historyIndex = 0;
  let disposed = false;

  // Get current annotations
  const getCurrentAnnotations = (): readonly AnnotationConfig[] => {
    return chart.options.annotations ?? [];
  };

  // Push a new history entry
  const pushHistory = (annotations: readonly AnnotationConfig[]): void => {
    // Truncate any redo history
    history = history.slice(0, historyIndex + 1);
    history.push({ annotations: [...annotations] });
    historyIndex = history.length - 1;

    // Limit history size to 50 entries
    if (history.length > 50) {
      history.shift();
      historyIndex--;
    }
  };

  // Apply annotations to chart
  const applyAnnotations = (annotations: readonly AnnotationConfig[]): void => {
    chart.setOption({
      ...chart.options,
      annotations: [...annotations],
    });
  };

  // Context menu DOM
  let contextMenu: HTMLDivElement | null = null;

  const createContextMenu = (): HTMLDivElement => {
    const menu = document.createElement('div');
    menu.style.position = 'fixed';
    menu.style.display = 'none';
    menu.style.backgroundColor = '#1a1a2e';
    menu.style.border = '1px solid #333';
    menu.style.borderRadius = '8px';
    menu.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
    menu.style.zIndex = String(menuZIndex);
    menu.style.minWidth = '180px';
    menu.style.padding = '6px 0';
    menu.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    menu.style.fontSize = '14px';
    menu.style.color = '#e0e0e0';

    const createMenuItem = (text: string, onClick: () => void): HTMLDivElement => {
      const item = document.createElement('div');
      item.textContent = text;
      item.style.padding = '8px 16px';
      item.style.cursor = 'pointer';
      item.style.transition = 'background-color 0.15s';
      item.style.userSelect = 'none';

      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = '#2a2a3e';
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = 'transparent';
      });
      item.addEventListener('click', () => {
        onClick();
        hideContextMenu();
      });

      return item;
    };

    menu.appendChild(createMenuItem('Add vertical line here', () => handleAddVerticalLine()));
    menu.appendChild(createMenuItem('Add text note here', () => handleAddTextNote()));

    document.body.appendChild(menu);
    return menu;
  };

  // Toolbar DOM
  let toolbar: HTMLDivElement | null = null;

  const createToolbar = (): HTMLDivElement => {
    const bar = document.createElement('div');
    bar.style.position = 'absolute';
    bar.style.top = '10px';
    bar.style.right = '10px';
    bar.style.display = 'flex';
    bar.style.gap = '8px';
    bar.style.backgroundColor = 'rgba(26, 26, 46, 0.9)';
    bar.style.border = '1px solid #333';
    bar.style.borderRadius = '6px';
    bar.style.padding = '6px 8px';
    bar.style.zIndex = String(toolbarZIndex);
    bar.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    bar.style.fontSize = '12px';

    const createButton = (text: string, onClick: () => void, title?: string): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = text;
      if (title) btn.title = title;
      btn.style.padding = '4px 10px';
      btn.style.backgroundColor = '#2a2a3e';
      btn.style.color = '#e0e0e0';
      btn.style.border = '1px solid #444';
      btn.style.borderRadius = '4px';
      btn.style.cursor = 'pointer';
      btn.style.fontSize = '12px';
      btn.style.transition = 'all 0.15s';
      btn.style.userSelect = 'none';

      btn.addEventListener('mouseenter', () => {
        btn.style.backgroundColor = '#3a3a4e';
        btn.style.borderColor = '#555';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.backgroundColor = '#2a2a3e';
        btn.style.borderColor = '#444';
      });
      btn.addEventListener('click', onClick);

      return btn;
    };

    const undoBtn = createButton('Undo', () => undo(), 'Undo last annotation change');
    const redoBtn = createButton('Redo', () => redo(), 'Redo annotation change');
    const exportBtn = createButton('Export JSON', () => handleExportJSON(), 'Copy annotations JSON to clipboard');

    bar.appendChild(undoBtn);
    bar.appendChild(redoBtn);
    bar.appendChild(exportBtn);

    container.appendChild(bar);
    return bar;
  };

  // Show context menu
  let lastHitTestResult: ChartGPUHitTestResult | null = null;

  const showContextMenu = (e: MouseEvent): void => {
    if (!contextMenu) return;
    
    lastHitTestResult = chart.hitTest(e);

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Adjust position if menu goes off-screen (check both viewport bounds)
    requestAnimationFrame(() => {
      if (!contextMenu || contextMenu.style.display !== 'block') return;
      
      const menuRect = contextMenu.getBoundingClientRect();
      let adjustedX = e.clientX;
      let adjustedY = e.clientY;

      // Adjust horizontal position if menu extends beyond right edge
      if (menuRect.right > window.innerWidth) {
        adjustedX = Math.max(0, e.clientX - menuRect.width);
      }

      // Adjust vertical position if menu extends beyond bottom edge
      if (menuRect.bottom > window.innerHeight) {
        adjustedY = Math.max(0, e.clientY - menuRect.height);
      }

      // Apply adjustments if needed
      if (adjustedX !== e.clientX || adjustedY !== e.clientY) {
        contextMenu.style.left = `${adjustedX}px`;
        contextMenu.style.top = `${adjustedY}px`;
      }
    });
  };

  const hideContextMenu = (): void => {
    if (!contextMenu) return;
    contextMenu.style.display = 'none';
    lastHitTestResult = null;
  };

  // Compute visible x-domain for freeform vertical lines
  const computeVisibleXDomain = (): { min: number; max: number } => {
    const opts = chart.options;
    
    // Get base domain
    let xMin = opts.xAxis?.min;
    let xMax = opts.xAxis?.max;

    // If not explicitly set, derive from series data
    if (xMin === undefined || xMax === undefined) {
      const series = opts.series ?? [];
      let dataXMin = Number.POSITIVE_INFINITY;
      let dataXMax = Number.NEGATIVE_INFINITY;

      for (const s of series) {
        if (s.type === 'pie') continue;

        if (s.type === 'candlestick') {
          // Candlestick uses timestamp (first element)
          const data = s.data;
          for (const p of data) {
            const timestamp = getOHLCTimestamp(p);
            if (timestamp < dataXMin) dataXMin = timestamp;
            if (timestamp > dataXMax) dataXMax = timestamp;
          }
        } else {
          // Cartesian series
          const data = s.data;
          for (const p of data) {
            const x = getPointX(p);
            if (x < dataXMin) dataXMin = x;
            if (x > dataXMax) dataXMax = x;
          }
        }
      }

      if (xMin === undefined) xMin = Number.isFinite(dataXMin) ? dataXMin : 0;
      if (xMax === undefined) xMax = Number.isFinite(dataXMax) ? dataXMax : 100;
    }

    // Apply zoom if present
    const zoomRange = chart.getZoomRange();
    if (zoomRange) {
      const span = xMax - xMin;
      const zoomMin = xMin + (zoomRange.start / 100) * span;
      const zoomMax = xMin + (zoomRange.end / 100) * span;
      return { min: zoomMin, max: zoomMax };
    }

    return { min: xMin, max: xMax };
  };

  // Convert grid-space coordinates to data-space x
  const gridXToDataX = (gridX: number): number => {
    const rect = canvas.getBoundingClientRect();
    const grid = chart.options.grid ?? defaultGrid;
    const plotWidthCss = rect.width - (grid.left ?? defaultGrid.left) - (grid.right ?? defaultGrid.right);
    
    const xDomain = computeVisibleXDomain();
    const t = plotWidthCss > 0 ? gridX / plotWidthCss : 0;
    return xDomain.min + t * (xDomain.max - xDomain.min);
  };

  // Convert grid-space coordinates to plot-space [0-1]
  const gridToPlotSpace = (gridX: number, gridY: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const grid = chart.options.grid ?? defaultGrid;
    const plotWidthCss = rect.width - (grid.left ?? defaultGrid.left) - (grid.right ?? defaultGrid.right);
    const plotHeightCss = rect.height - (grid.top ?? defaultGrid.top) - (grid.bottom ?? defaultGrid.bottom);
    
    const px = plotWidthCss > 0 ? gridX / plotWidthCss : 0;
    const py = plotHeightCss > 0 ? gridY / plotHeightCss : 0;
    return { x: px, y: py };
  };

  // Handle "Add vertical line here"
  const handleAddVerticalLine = (): void => {
    if (!lastHitTestResult) return;

    const { match, isInGrid, gridX } = lastHitTestResult;

    let x: number;
    if (match) {
      // Use matched data point x
      x = match.value[0];
    } else if (isInGrid) {
      // Compute x from grid position
      x = gridXToDataX(gridX);
    } else {
      return; // Outside grid, do nothing
    }

    const current = getCurrentAnnotations();
    const newAnnotation: AnnotationConfig = {
      type: 'lineX',
      x,
      layer: 'aboveSeries',
      style: {
        color: '#ffa500',
        lineWidth: 2,
        lineDash: [4, 4],
        opacity: 0.9,
      },
      label: {
        text: 'Line',
        offset: [8, 8],
        anchor: 'start',
        background: {
          color: '#000000',
          opacity: 0.7,
          padding: [2, 6, 2, 6],
          borderRadius: 4,
        },
      },
    };

    const next = [...current, newAnnotation];
    applyAnnotations(next);
    pushHistory(next);
  };

  // Handle "Add text note here"
  const handleAddTextNote = (): void => {
    if (!lastHitTestResult) return;

    const { match, isInGrid, gridX, gridY } = lastHitTestResult;

    const text = prompt('Enter annotation text:', 'Note');
    // Cancel or empty string should not create annotation
    if (!text || text.trim().length === 0) return;

    let newAnnotation: AnnotationConfig;

    if (match) {
      // Use data-space position
      newAnnotation = {
        type: 'text',
        position: { space: 'data', x: match.value[0], y: match.value[1] },
        text,
        layer: 'aboveSeries',
        style: {
          color: '#00d4ff',
          opacity: 1,
        },
      };
    } else if (isInGrid) {
      // Use plot-space position
      const plotPos = gridToPlotSpace(gridX, gridY);
      newAnnotation = {
        type: 'text',
        position: { space: 'plot', x: plotPos.x, y: plotPos.y },
        text,
        layer: 'aboveSeries',
        style: {
          color: '#00d4ff',
          opacity: 1,
        },
      };
    } else {
      return; // Outside grid, do nothing
    }

    const current = getCurrentAnnotations();
    const next = [...current, newAnnotation];
    applyAnnotations(next);
    pushHistory(next);
  };

  // Handle export JSON
  const handleExportJSON = (): void => {
    const json = exportJSON();
    
    // Try to copy to clipboard (async clipboard API may fail due to permissions or security context)
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(json)
        .then(() => {
          // eslint-disable-next-line no-alert
          alert('Annotations JSON copied to clipboard!');
        })
        .catch((err) => {
          console.warn('Failed to copy to clipboard:', err);
          // Fallback: show in a textarea
          showJSONModal(json);
        });
    } else {
      // Fallback: show in a textarea (clipboard API not available)
      showJSONModal(json);
    }
  };

  const showJSONModal = (json: string): void => {
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.backgroundColor = '#1a1a2e';
    modal.style.border = '1px solid #333';
    modal.style.borderRadius = '8px';
    modal.style.padding = '20px';
    modal.style.zIndex = String(menuZIndex + 1);
    modal.style.maxWidth = '600px';
    modal.style.width = '90%';
    modal.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.7)';

    const title = document.createElement('h3');
    title.textContent = 'Annotations JSON';
    title.style.marginTop = '0';
    title.style.color = '#e0e0e0';
    title.style.fontSize = '16px';
    title.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const textarea = document.createElement('textarea');
    textarea.value = json;
    textarea.readOnly = true;
    textarea.style.width = '100%';
    textarea.style.height = '300px';
    textarea.style.backgroundColor = '#0f0f14';
    textarea.style.color = '#e0e0e0';
    textarea.style.border = '1px solid #333';
    textarea.style.borderRadius = '4px';
    textarea.style.padding = '10px';
    textarea.style.fontSize = '13px';
    textarea.style.fontFamily = 'monospace';
    textarea.style.resize = 'vertical';
    textarea.style.boxSizing = 'border-box';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '12px';
    closeBtn.style.padding = '8px 16px';
    closeBtn.style.backgroundColor = '#2a2a3e';
    closeBtn.style.color = '#e0e0e0';
    closeBtn.style.border = '1px solid #444';
    closeBtn.style.borderRadius = '4px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '14px';
    closeBtn.style.transition = 'background-color 0.15s';
    closeBtn.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const closeModal = (): void => {
      modal.remove();
    };

    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.backgroundColor = '#3a3a4e';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.backgroundColor = '#2a2a3e';
    });
    closeBtn.addEventListener('click', closeModal);

    // Close on Escape key
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup listener on modal removal
    const originalRemove = modal.remove.bind(modal);
    modal.remove = () => {
      document.removeEventListener('keydown', handleKeyDown);
      originalRemove();
    };

    modal.appendChild(title);
    modal.appendChild(textarea);
    modal.appendChild(closeBtn);
    document.body.appendChild(modal);

    // Auto-select text for easy copying
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  };

  // Context menu event handler
  const onContextMenu = (e: MouseEvent): void => {
    if (disposed || !enableContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e);
  };

  // Click outside to close context menu
  const onDocumentClick = (e: MouseEvent): void => {
    if (disposed) return;
    if (contextMenu && !contextMenu.contains(e.target as Node)) {
      hideContextMenu();
    }
  };

  // Escape to close context menu
  const onDocumentKeyDown = (e: KeyboardEvent): void => {
    if (disposed) return;
    if (e.key === 'Escape' && contextMenu && contextMenu.style.display === 'block') {
      hideContextMenu();
    }
  };

  // Scroll/resize to close context menu (prevents menu from floating at wrong position)
  const onWindowScrollOrResize = (): void => {
    if (disposed) return;
    if (contextMenu && contextMenu.style.display === 'block') {
      hideContextMenu();
    }
  };

  // Public API
  const addVerticalLine = (x: number): void => {
    const current = getCurrentAnnotations();
    const newAnnotation: AnnotationConfig = {
      type: 'lineX',
      x,
      layer: 'aboveSeries',
      style: {
        color: '#ffa500',
        lineWidth: 2,
        opacity: 0.9,
      },
    };
    const next = [...current, newAnnotation];
    applyAnnotations(next);
    pushHistory(next);
  };

  const addTextNote = (x: number, y: number, text: string, space: 'data' | 'plot' = 'data'): void => {
    const current = getCurrentAnnotations();
    const newAnnotation: AnnotationConfig = {
      type: 'text',
      position: { space, x, y },
      text,
      layer: 'aboveSeries',
      style: {
        color: '#00d4ff',
        opacity: 1,
      },
    };
    const next = [...current, newAnnotation];
    applyAnnotations(next);
    pushHistory(next);
  };

  const undo = (): boolean => {
    if (historyIndex <= 0) return false;
    historyIndex--;
    const entry = history[historyIndex];
    if (!entry) return false;
    applyAnnotations(entry.annotations);
    return true;
  };

  const redo = (): boolean => {
    if (historyIndex >= history.length - 1) return false;
    historyIndex++;
    const entry = history[historyIndex];
    if (!entry) return false;
    applyAnnotations(entry.annotations);
    return true;
  };

  const exportJSON = (): string => {
    const annotations = getCurrentAnnotations();
    return JSON.stringify(annotations, null, 2);
  };

  const getAnnotations = (): readonly AnnotationConfig[] => {
    return getCurrentAnnotations();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    canvas.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeyDown);
    window.removeEventListener('scroll', onWindowScrollOrResize, true);
    window.removeEventListener('resize', onWindowScrollOrResize);

    contextMenu?.remove();
    contextMenu = null;

    toolbar?.remove();
    toolbar = null;

    history = [];
  };

  // Initialize
  if (enableContextMenu) {
    contextMenu = createContextMenu();
    canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeyDown);
    // Capture phase for scroll to handle all scrollable ancestors
    window.addEventListener('scroll', onWindowScrollOrResize, true);
    window.addEventListener('resize', onWindowScrollOrResize);
  }

  if (showToolbar) {
    toolbar = createToolbar();
  }

  return {
    addVerticalLine,
    addTextNote,
    undo,
    redo,
    exportJSON,
    getAnnotations,
    dispose,
  };
}
