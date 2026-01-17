export type TextOverlayAnchor = 'start' | 'middle' | 'end';

export interface TextOverlayLabelOptions {
  readonly fontSize?: number;
  readonly color?: string;
  readonly anchor?: TextOverlayAnchor;
  /**
   * Rotation in degrees (CSS `rotate(<deg>deg)`).
   */
  readonly rotation?: number;
}

export interface TextOverlay {
  clear(): void;
  addLabel(
    text: string,
    x: number,
    y: number,
    options?: TextOverlayLabelOptions
  ): HTMLSpanElement;
  dispose(): void;
}

const getAnchorTransform = (
  anchor: TextOverlayAnchor
): Readonly<{ translateX: string; originX: string }> => {
  switch (anchor) {
    case 'start':
      return { translateX: '0%', originX: '0%' };
    case 'middle':
      return { translateX: '-50%', originX: '50%' };
    case 'end':
      return { translateX: '-100%', originX: '100%' };
  }
};

export function createTextOverlay(container: HTMLElement): TextOverlay {
  const computedPosition = getComputedStyle(container).position;
  const didSetRelative = computedPosition === 'static';
  const previousInlinePosition = didSetRelative ? container.style.position : null;

  if (didSetRelative) {
    container.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.overflow = 'hidden';
  container.appendChild(overlay);

  let disposed = false;

  const clear = (): void => {
    if (disposed) return;
    overlay.replaceChildren();
  };

  const addLabel: TextOverlay['addLabel'] = (text, x, y, options) => {
    if (disposed) {
      // Keep it non-throwing so callsites don't need try/catch in teardown paths.
      return document.createElement('span');
    }

    const span = document.createElement('span');
    span.textContent = text;
    span.style.position = 'absolute';
    span.style.left = `${x}px`;
    span.style.top = `${y}px`;
    span.style.pointerEvents = 'none';
    span.style.userSelect = 'none';
    span.style.whiteSpace = 'nowrap';
    span.style.lineHeight = '1';

    if (options?.fontSize != null) span.style.fontSize = `${options.fontSize}px`;
    if (options?.color != null) span.style.color = options.color;

    const rotation = options?.rotation ?? 0;
    const anchor = options?.anchor ?? 'start';
    const { translateX, originX } = getAnchorTransform(anchor);

    span.style.transformOrigin = `${originX} 50%`;
    span.style.transform = `translateX(${translateX}) translateY(-50%) rotate(${rotation}deg)`;

    overlay.appendChild(span);
    return span;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    try {
      overlay.remove();
    } finally {
      if (previousInlinePosition !== null) {
        container.style.position = previousInlinePosition;
      }
    }
  };

  return { clear, addLabel, dispose };
}

