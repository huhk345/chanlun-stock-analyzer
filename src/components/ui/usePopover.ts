import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

type PopoverOptions = {
  /** 面板宽度；不传则跟随触发器宽度（但不小于 180px） */
  width?: number;
  /** 与触发器之间的间距 */
  offset?: number;
  /** 视口内至少保留的空间，用来决定向上还是向下展开 */
  minSpace?: number;
};

/**
 * 把弹层定位到触发器的正下方 / 正上方。
 *
 * 左栏本身是 `overflow-y-auto` 的滚动容器，直接在里面写 absolute 会被裁掉，
 * 所以弹层统一 portal 到 body + `position: fixed`，这里只负责算坐标。
 */
export function usePopoverPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  options: PopoverOptions = {},
): CSSProperties {
  const { width, offset = 6, minSpace = 220 } = options;
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const panelWidth = Math.min(width ?? Math.max(rect.width, 180), vw - 16);

    let left = rect.left;
    if (left + panelWidth > vw - 8) left = Math.max(8, vw - 8 - panelWidth);

    const spaceBelow = vh - rect.bottom - offset - 8;
    const spaceAbove = rect.top - offset - 8;
    const flip = spaceBelow < minSpace && spaceAbove > spaceBelow;

    setStyle({
      position: 'fixed',
      left,
      width: panelWidth,
      zIndex: 80,
      ...(flip
        ? { bottom: vh - rect.top + offset, maxHeight: Math.max(spaceAbove, 120) }
        : { top: rect.bottom + offset, maxHeight: Math.max(spaceBelow, 120) }),
    });
  }, [anchorRef, width, offset, minSpace]);

  useLayoutEffect(() => {
    if (!open) return;
    update();
    window.addEventListener('resize', update);
    // 捕获阶段监听：滚动容器自己滚动时也能跟上
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, update]);

  return style;
}

/** 点击弹层 / 触发器之外的地方时关闭 */
export function useDismiss(
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onDismiss: () => void,
) {
  useLayoutEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss]);
}
