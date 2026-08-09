// @vitest-environment jsdom

import React, { act, createRef, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VirtualizedList, type VirtualizedListHandle } from "@/features/history/virtualized-list";

// 让 React 在 Vitest/jsdom 下正确识别 act 环境。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type VirtualizedListHarnessProps = {
  listRef: React.RefObject<VirtualizedListHandle>;
  viewportKey?: string;
};

/**
 * 构造带外部滚动容器的最小虚拟列表，验证程序化跳转后的视口同步。
 */
function VirtualizedListHarness({ listRef, viewportKey }: VirtualizedListHarnessProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}` }));

  return (
    <div ref={scrollContainerRef} data-testid="viewport">
      <VirtualizedList
        ref={listRef}
        items={items}
        scrollContainerRef={scrollContainerRef}
        viewportKey={viewportKey}
        estimateItemHeight={100}
        overscan={100}
        getItemKey={(item) => item.id}
        renderItem={(item) => <div data-testid={item.id}>{item.id}</div>}
      />
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("history virtualized list viewport synchronization", () => {
  it("跳转到最后一项后立即切换到末尾渲染窗口", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const listRef = createRef<VirtualizedListHandle>();

    act(() => {
      root.render(<VirtualizedListHarness listRef={listRef} />);
    });

    const viewport = container.querySelector("[data-testid='viewport']") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Number(value) || 0; },
      },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => { scrollTop = Number(top) || 0; },
      },
    });

    await act(async () => {
      listRef.current?.syncViewport();
      listRef.current?.scrollToIndex(9, { align: "end", behavior: "auto" });
      await Promise.resolve();
    });

    expect(scrollTop).toBe(900);
    const renderedItemIds = Array.from(container.querySelectorAll("[data-testid^='item-']"))
      .map((element) => element.getAttribute("data-testid"));
    expect(renderedItemIds).toContain("item-9");
    expect(renderedItemIds).not.toContain("item-0");

    act(() => {
      root.unmount();
    });
  });

  it("标签页状态键切换后无需滚动事件也会同步真实视口", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const listRef = createRef<VirtualizedListHandle>();

    act(() => {
      root.render(<VirtualizedListHarness listRef={listRef} viewportKey="tab-a" />);
    });

    const viewport = container.querySelector("[data-testid='viewport']") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Number(value) || 0; },
      },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => { scrollTop = Number(top) || 0; },
      },
    });

    await act(async () => {
      listRef.current?.syncViewport();
      listRef.current?.scrollToIndex(9, { align: "end", behavior: "auto" });
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='item-9']")).not.toBeNull();

    scrollTop = 0;
    await act(async () => {
      root.render(<VirtualizedListHarness listRef={listRef} viewportKey="tab-b" />);
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='item-0']")).not.toBeNull();
    expect(container.querySelector("[data-testid='item-9']")).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
