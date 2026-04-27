import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

type VirtualizedListProps<TItem> = {
  items: TItem[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  estimateItemHeight?: number;
  overscan?: number;
  getItemKey: (item: TItem, index: number) => string;
  renderItem: (item: TItem, index: number) => React.ReactNode;
};

type VirtualizedScrollAlign = "auto" | "start" | "center" | "end";

export type VirtualizedListHandle = {
  scrollToIndex: (index: number, options?: { align?: VirtualizedScrollAlign; behavior?: ScrollBehavior }) => void;
};

type VirtualizedViewportState = {
  scrollTop: number;
  height: number;
};

type VirtualizedMeasuredRowProps = {
  itemKey: string;
  top: number;
  onHeightChange: (itemKey: string, height: number) => void;
  children: React.ReactNode;
};

/**
 * 中文说明：将测量高度归一为稳定值，避免浮点/抖动导致的重复重排。
 */
function normalizeMeasuredHeight(height: number): number {
  return Math.max(1, Math.ceil(Number(height) || 0));
}

/**
 * 中文说明：将滚动目标限制在合法范围内，避免出现越界滚动。
 */
function clampScrollTop(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 中文说明：二分查找第一个“底部进入可视区”的索引。
 */
export function findVisibleStartIndex(tops: number[], heights: number[], offset: number): number {
  if (tops.length === 0) return 0;
  let left = 0;
  let right = tops.length - 1;
  let answer = tops.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const bottom = tops[mid] + heights[mid];
    if (bottom >= offset) {
      answer = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  return answer;
}

/**
 * 中文说明：二分查找最后一个“顶部仍落在可视区末端之前”的索引。
 */
function findVisibleEndIndex(tops: number[], offset: number): number {
  if (tops.length === 0) return -1;
  let left = 0;
  let right = tops.length - 1;
  let answer = tops.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    if (tops[mid] <= offset) {
      answer = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return answer;
}

/**
 * 中文说明：订阅滚动容器位置与高度，驱动虚拟列表窗口计算。
 */
function useVirtualizedViewport(scrollContainerRef: React.RefObject<HTMLDivElement | null>, syncSignal: number): VirtualizedViewportState {
  const [viewport, setViewport] = useState<VirtualizedViewportState>({ scrollTop: 0, height: 0 });
  const syncViewportRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId = 0;

    /**
     * 中文说明：同步容器视口状态，并避免无变化时多余渲染。
     */
    const syncViewport = () => {
      const nextScrollTop = Math.max(0, container.scrollTop || 0);
      const nextHeight = Math.max(0, container.clientHeight || 0);
      setViewport((current) => {
        if (current.scrollTop === nextScrollTop && current.height === nextHeight) return current;
        return { scrollTop: nextScrollTop, height: nextHeight };
      });
    };
    syncViewportRef.current = syncViewport;

    /**
     * 中文说明：使用 rAF 合并高频滚动事件，降低状态更新压力。
     */
    const scheduleSync = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        syncViewport();
      });
    };

    syncViewport();

    let resizeObserver: ResizeObserver | null = null;
    container.addEventListener("scroll", scheduleSync, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleSync());
      resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", scheduleSync);
    }

    return () => {
      container.removeEventListener("scroll", scheduleSync);
      if (syncViewportRef.current === syncViewport) syncViewportRef.current = null;
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch {}
      } else {
        window.removeEventListener("resize", scheduleSync);
      }
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    syncViewportRef.current?.();
  }, [syncSignal]);

  return viewport;
}

/**
 * 中文说明：包装单个可见行，并在尺寸变化时回传真实高度。
 */
function VirtualizedMeasuredRow({ itemKey, top, onHeightChange, children }: VirtualizedMeasuredRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = rowRef.current;
    if (!node) return;

    /**
     * 中文说明：回传当前行高度，供父级重建位移表。
     */
    const reportHeight = () => {
      onHeightChange(itemKey, normalizeMeasuredHeight(node.offsetHeight));
    };

    reportHeight();

    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(() => reportHeight());
    resizeObserver.observe(node);
    return () => {
      try {
        resizeObserver.disconnect();
      } catch {}
    };
  }, [itemKey, onHeightChange]);

  return (
    <div
      ref={rowRef}
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        paddingBottom: "0.5rem",
      }}
    >
      {children}
    </div>
  );
}

/**
 * 中文说明：按滚动窗口仅渲染可见区附近条目，避免海量详情一次性挂载。
 * 另外通过 ref 暴露 `scrollToIndex`，供搜索跳转与激活定位复用。
 */
function VirtualizedListInner<TItem>({
  items,
  scrollContainerRef,
  estimateItemHeight = 240,
  overscan,
  getItemKey,
  renderItem,
}: VirtualizedListProps<TItem>, ref: React.ForwardedRef<VirtualizedListHandle>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Record<string, number>>({});
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const aliveKeys = new Set<string>();
    for (let index = 0; index < items.length; index += 1) aliveKeys.add(getItemKey(items[index], index));
    for (const key of Object.keys(heightsRef.current)) {
      if (!aliveKeys.has(key)) delete heightsRef.current[key];
    }
  }, [items, getItemKey]);

  /**
   * 中文说明：记录真实行高；仅在高度变化时触发布局重算。
   */
  const handleHeightChange = useCallback((itemKey: string, height: number) => {
    const nextHeight = normalizeMeasuredHeight(height);
    if (heightsRef.current[itemKey] === nextHeight) return;
    heightsRef.current[itemKey] = nextHeight;
    setLayoutVersion((value) => value + 1);
  }, []);

  const layout = useMemo(() => {
    const tops: number[] = new Array(items.length);
    const heights: number[] = new Array(items.length);
    let totalHeight = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemKey = getItemKey(item, index);
      const itemHeight = heightsRef.current[itemKey] ?? estimateItemHeight;
      tops[index] = totalHeight;
      heights[index] = itemHeight;
      totalHeight += itemHeight;
    }
    return { tops, heights, totalHeight };
  }, [items, estimateItemHeight, getItemKey, layoutVersion]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (container.scrollTop > maxScrollTop) container.scrollTop = maxScrollTop;
  }, [layout.totalHeight, scrollContainerRef]);

  const viewport = useVirtualizedViewport(scrollContainerRef, layout.totalHeight);
  const overscanPx = Math.max(estimateItemHeight, overscan ?? estimateItemHeight * 4);
  const hostOffsetTop = Math.max(0, hostRef.current?.offsetTop || 0);
  const viewportTopInList = Math.max(0, viewport.scrollTop - hostOffsetTop);
  const windowStart = Math.max(0, viewportTopInList - overscanPx);
  const windowEnd = Math.max(0, viewportTopInList + viewport.height + overscanPx);
  const startIndex = items.length > 0 ? findVisibleStartIndex(layout.tops, layout.heights, windowStart) : 0;
  const endIndex = items.length > 0 ? Math.min(items.length - 1, findVisibleEndIndex(layout.tops, windowEnd)) : -1;

  const visibleItems = useMemo(() => {
    if (items.length === 0 || endIndex < startIndex) return [] as Array<{ item: TItem; index: number; key: string; top: number }>;
    const out: Array<{ item: TItem; index: number; key: string; top: number }> = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const item = items[index];
      out.push({
        item,
        index,
        key: getItemKey(item, index),
        top: layout.tops[index] || 0,
      });
    }
    return out;
  }, [items, startIndex, endIndex, getItemKey, layout.tops]);

  /**
   * 中文说明：滚动到指定索引，优先复用已有滚动容器，避免额外的定位逻辑分叉。
   */
  const scrollToIndex = useCallback((index: number, options?: { align?: VirtualizedScrollAlign; behavior?: ScrollBehavior }) => {
    const container = scrollContainerRef.current;
    const host = hostRef.current;
    if (!container || !host) return;
    if (index < 0 || index >= items.length) return;

    const align = options?.align || "auto";
    const itemTop = host.offsetTop + (layout.tops[index] || 0);
    const itemHeight = layout.heights[index] || estimateItemHeight;
    const itemBottom = itemTop + itemHeight;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;

    let nextTop = viewportTop;
    if (align === "start")
      nextTop = itemTop;
    else if (align === "center")
      nextTop = itemTop - (container.clientHeight - itemHeight) / 2;
    else if (align === "end")
      nextTop = itemBottom - container.clientHeight;
    else if (itemTop < viewportTop)
      nextTop = itemTop;
    else if (itemBottom > viewportBottom)
      nextTop = itemBottom - container.clientHeight;
    else
      return;

    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({
      top: clampScrollTop(nextTop, 0, maxTop),
      behavior: options?.behavior || "smooth",
    });
  }, [estimateItemHeight, items.length, layout.heights, layout.tops, scrollContainerRef]);

  useImperativeHandle(ref, () => ({
    scrollToIndex,
  }), [scrollToIndex]);

  if (items.length === 0) return null;

  return (
    <div ref={hostRef} style={{ position: "relative", minHeight: 0, minWidth: 0, height: layout.totalHeight }}>
      {visibleItems.map(({ item, index, key, top }) => (
        <VirtualizedMeasuredRow key={key} itemKey={key} top={top} onHeightChange={handleHeightChange}>
          {renderItem(item, index)}
        </VirtualizedMeasuredRow>
      ))}
    </div>
  );
}

export const VirtualizedList = React.forwardRef(VirtualizedListInner) as <TItem>(
  props: VirtualizedListProps<TItem> & { ref?: React.Ref<VirtualizedListHandle> }
) => React.ReactElement | null;
