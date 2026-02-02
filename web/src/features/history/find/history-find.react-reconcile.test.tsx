// @vitest-environment jsdom

import React, { useState, act } from "react";
import { describe, it, expect } from "vitest";
import { createRoot } from "react-dom/client";

import { applyHistoryFindHighlights } from "@/features/history/find/history-find";

// 说明：让 React 在 Vitest/jsdom 下正确识别 act 环境，避免 “not configured to support act(...)” 警告。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type DemoItem = {
  id: string;
  text: string;
  variant: "text" | "span";
};

const DEMO_ITEMS: DemoItem[] = [
  { id: "a", text: "ga", variant: "span" },
  { id: "b", text: "gallery", variant: "text" },
];

type KeyMode = "index" | "stable";

/**
 * 中文说明：构造一个最小可复现组件：
 * - 初始 query="gallery" 只渲染第 2 条（文本为 gallery，且 code 子节点为纯文本）
 * - 手动插入 DOM 高亮后，更新为 query="ga" 会让列表前置新增一条（code 子节点为 span）
 * - 若使用“索引 key”，React 会复用节点并在移除 TextNode 时触发 removeChild 异常
 * - 若使用“稳定 key”，React 不会复用错误节点，更新过程应稳定不报错
 */
function DemoHistoryList(props: { keyMode: KeyMode }) {
  const { keyMode } = props;
  const [query, setQuery] = useState("gallery");
  const normalized = String(query || "").toLowerCase();
  const visible = DEMO_ITEMS.filter((x) => x.text.toLowerCase().includes(normalized));

  const buildKey = (item: DemoItem, index: number) => (keyMode === "stable" ? item.id : String(index));

  return (
    <div>
      <button type="button" onClick={() => setQuery("ga")}>to-ga</button>
      <div data-testid="history-root">
        {visible.map((item, index) => {
          const key = buildKey(item, index);
          return (
            <div key={key} data-history-message-key={key}>
              <code data-history-search-scope>{item.variant === "span" ? <span>{item.text}</span> : item.text}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

describe("history-find（React 协同稳定性）", () => {
  it("索引 key 会导致高亮节点被复用，命中可能漂移到其它行", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<DemoHistoryList keyMode="index" />);
    });

    const historyRoot = container.querySelector("[data-testid='history-root']") as HTMLElement | null;
    expect(historyRoot).toBeTruthy();
    applyHistoryFindHighlights({ root: historyRoot!, query: "gallery" });
    expect(container.querySelector("mark")?.textContent).toBe("gallery");

    const btn = container.querySelector("button") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();

    act(() => {
      btn!.click();
    });

    // 说明：由于节点复用，之前包裹 "gallery" 的 mark 可能被更新为其它文本或被移除。
    expect(container.querySelector("mark")?.textContent || "").not.toBe("gallery");

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("稳定 key + DOM 高亮后更新列表应保持稳定", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<DemoHistoryList keyMode="stable" />);
    });

    const historyRoot = container.querySelector("[data-testid='history-root']") as HTMLElement | null;
    expect(historyRoot).toBeTruthy();
    applyHistoryFindHighlights({ root: historyRoot!, query: "gallery" });
    expect(container.querySelector("mark")?.textContent).toBe("gallery");

    const btn = container.querySelector("button") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();

    act(() => {
      btn!.click();
    });

    // 说明：稳定 key 下，"gallery" 对应的节点不会被错误复用，mark 应保持在原文本上。
    expect(container.querySelector("mark")?.textContent).toBe("gallery");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
