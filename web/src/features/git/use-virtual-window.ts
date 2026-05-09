// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

export type VirtualWindowState = {
  start: number;
  end: number;
  top: number;
  bottom: number;
};

/**
 * 根据滚动容器尺寸计算虚拟列表窗口，避免一次渲染全部行。
 */
export function useVirtualWindow(
  itemCount: number,
  rowHeight: number,
  overscan: number,
  resetToken?: string | number,
  externalContainerRef?: React.RefObject<HTMLDivElement>,
): {
  containerRef: React.RefObject<HTMLDivElement>;
  windowState: VirtualWindowState;
  totalHeight: number;
} {
  const internalContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = externalContainerRef || internalContainerRef;
  const containerNode = containerRef.current;
  const [windowState, setWindowState] = useState<VirtualWindowState>({
    start: 0,
    end: Math.max(0, itemCount),
    top: 0,
    bottom: 0,
  });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    /**
     * 读取当前滚动位置与视口尺寸，刷新可视窗口区间。
     */
    const recalcWindow = (): void => {
      const viewport = Math.max(1, el.clientHeight);
      const scrollTop = Math.max(0, el.scrollTop);
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const visibleCount = Math.ceil(viewport / rowHeight) + overscan * 2;
      const end = Math.min(itemCount, start + visibleCount);
      const top = start * rowHeight;
      const bottom = Math.max(0, (itemCount - end) * rowHeight);
      setWindowState((prev) => {
        if (prev.start === start && prev.end === end && prev.top === top && prev.bottom === bottom) return prev;
        return { start, end, top, bottom };
      });
    };

    recalcWindow();
    const onScroll = (): void => {
      recalcWindow();
    };
    const onResize = (): void => {
      recalcWindow();
    };
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        recalcWindow();
      });
      resizeObserver.observe(el);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch {}
      }
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [containerNode, containerRef, itemCount, overscan, resetToken, rowHeight]);

  useEffect(() => {
    setWindowState((prev) => {
      if (prev.start < itemCount) return prev;
      const end = Math.min(itemCount, Math.max(1, overscan * 2));
      return {
        start: 0,
        end,
        top: 0,
        bottom: Math.max(0, (itemCount - end) * rowHeight),
      };
    });
  }, [itemCount, overscan, rowHeight]);

  return {
    containerRef,
    windowState,
    totalHeight: Math.max(0, itemCount * rowHeight),
  };
}
