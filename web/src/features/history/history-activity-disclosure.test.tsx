// @vitest-environment jsdom

import React, { act, createRef, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "@/types/host";
import { buildHistoryActivityGroups, resolveHistoryActivityVisibility } from "./activity-groups";
import { HistoryActivityDisclosure, useHistoryActivityScrollAnchor } from "./history-activity-disclosure";
import { VirtualizedList, type VirtualizedListHandle } from "./virtualized-list";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; time?: string }) => {
      if (key === "activityWorkedFor") return `用时 ${options?.time}`;
      if (key === "activityMessages") return `${options?.count} 条执行消息`;
      return key;
    },
  }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let mountedRoot: Root | undefined;

const MESSAGES: HistoryMessage[] = [
  { role: "user", turnId: "turn-a", content: [{ type: "input_text", text: "第一轮请求" }] },
  { role: "assistant", turnId: "turn-a", phase: "commentary", content: [{ type: "output_text", text: "第一轮执行说明" }] },
  { role: "tool", turnId: "turn-a", content: [{ type: "function_output", text: "第一轮工具结果" }] },
  { role: "assistant", turnId: "turn-a", phase: "final", durationMs: 51000, content: [{ type: "output_text", text: "第一轮最终答复" }] },
  { role: "assistant", turnId: "turn-a", content: [{ type: "turn_diff", text: "第一轮文件变更" }] },
  { role: "user", turnId: "turn-b", content: [{ type: "input_text", text: "第二轮请求" }] },
  { role: "assistant", turnId: "turn-b", phase: "commentary", content: [{ type: "output_text", text: "第二轮仍在执行" }] },
];

type ActivityFixtureProps = {
  expandedIds?: ReadonlySet<string>;
  searchActive?: boolean;
  visibleIndices?: readonly number[];
  onToggle?: (id: string, trigger: HTMLButtonElement) => void;
};

/** 用生产分组逻辑组装可见消息和真实折叠按钮，不重复分组与搜索展开实现。 */
function ActivityFixture({ expandedIds = new Set(), searchActive = false, visibleIndices, onToggle }: ActivityFixtureProps) {
  const views = MESSAGES.map((message, originalIndex) => ({ message, originalIndex }))
    .filter((view) => !visibleIndices || visibleIndices.includes(view.originalIndex));
  const visibility = resolveHistoryActivityVisibility(views, buildHistoryActivityGroups(MESSAGES), expandedIds, searchActive);
  return (
    <div>
      {visibility.messages.map((view) => {
        const group = visibility.disclosures.get(view.originalIndex);
        return (
          <div key={view.originalIndex} data-message-index={view.originalIndex}>
            {group ? <HistoryActivityDisclosure group={group} searchActive={searchActive} onToggle={onToggle} /> : null}
            <p>{view.message.content.map((item) => item.text).join("\n")}</p>
          </div>
        );
      })}
    </div>
  );
}

/** 挂载受控的执行过程视图，测试通过重新传入状态模拟详情层保存展开选择。 */
function mountActivityFixture(props: ActivityFixtureProps = {}): { host: HTMLDivElement; render: (next: ActivityFixtureProps) => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  const render = (next: ActivityFixtureProps): void => {
    act(() => mountedRoot?.render(<ActivityFixture {...next} />));
  };
  render(props);
  return { host, render };
}

/** 获取可见耗时按钮，缺少按钮时提供明确的失败原因。 */
function disclosureButton(host: HTMLDivElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>("[data-history-activity-toggle]");
  if (!button) throw new Error("没有找到执行过程折叠按钮");
  return button;
}

const SCROLL_MESSAGES: HistoryMessage[] = [
  ...Array.from({ length: 30 }, (_, index) => ({ role: "user", content: [{ type: "input_text", text: `此前请求 ${index}` }] })),
  { role: "user", turnId: "long-turn", content: [{ type: "input_text", text: "执行长任务" }] },
  ...Array.from({ length: 130 }, (_, index) => ({ role: "tool", turnId: "long-turn", content: [{ type: "function_output", text: `执行结果 ${index}` }] })),
  { role: "assistant", turnId: "long-turn", phase: "final", durationMs: 51000, content: [{ type: "output_text", text: "长任务最终答复" }] },
  ...Array.from({ length: 30 }, (_, index) => ({ role: "user", content: [{ type: "input_text", text: `后续请求 ${index}` }] })),
];
const SCROLL_VIEWS = SCROLL_MESSAGES.map((message, originalIndex) => ({ message, originalIndex }));
const SCROLL_GROUPS = buildHistoryActivityGroups(SCROLL_MESSAGES);

/** 复用生产折叠和滚动锚定钩子，在真实虚拟列表中验证非零滚动位置的切换。 */
function ScrollActivityFixture({ virtualized, listRef }: {
  virtualized: boolean;
  listRef: React.RefObject<VirtualizedListHandle>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const visibility = useMemo(() => resolveHistoryActivityVisibility(SCROLL_VIEWS, SCROLL_GROUPS, expandedIds, false), [expandedIds]);
  const captureAnchor = useHistoryActivityScrollAnchor({
    messages: visibility.messages, scrollContainerRef, virtualListRef: listRef, virtualized, viewportKey: "history-example",
  });
  /** 保存被点击的入口，再更新整轮过程的可见状态。 */
  const toggle = (id: string, trigger: HTMLButtonElement): void => {
    captureAnchor(SCROLL_GROUPS[0], trigger);
    setExpandedIds((current) => current.has(id) ? new Set() : new Set([id]));
  };
  /** 渲染固定高度的消息，按钮与消息使用真实的生产分组关系。 */
  const renderMessage = (view: typeof SCROLL_VIEWS[number]): React.ReactNode => {
    const group = visibility.disclosures.get(view.originalIndex);
    return (
      <div data-activity-row={view.originalIndex} key={view.originalIndex}>
        {group ? <HistoryActivityDisclosure group={group} onToggle={toggle} /> : null}
        <p>{view.message.content[0].text}</p>
      </div>
    );
  };
  return (
    <div ref={scrollContainerRef} data-activity-viewport>
      {virtualized ? (
        <VirtualizedList ref={listRef} items={visibility.messages} scrollContainerRef={scrollContainerRef}
          estimateItemHeight={100} overscan={100} getItemKey={(view) => String(view.originalIndex)} renderItem={renderMessage} />
      ) : visibility.messages.map(renderMessage)}
    </div>
  );
}

/** 为 jsdom 补充浏览器的行高、视口和滚动边界，保留真实虚拟窗口计算。 */
function installActivityScrollLayout(host: HTMLDivElement): HTMLDivElement {
  const viewport = host.querySelector<HTMLDivElement>("[data-activity-viewport]");
  if (!viewport) throw new Error("未找到执行过程滚动区");
  let scrollTop = 0;
  /** 根据虚拟列表高度或普通消息行数读取当前内容高度。 */
  const contentHeight = (): number => Number.parseFloat((viewport.firstElementChild as HTMLElement)?.style.height || "")
    || viewport.querySelectorAll("[data-activity-row]").length * 100;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: contentHeight },
    scrollTop: {
      configurable: true,
      get: () => Math.min(scrollTop, Math.max(0, contentHeight() - 200)),
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, contentHeight() - 200)); },
    },
    scrollTo: { configurable: true, value: ({ top }: ScrollToOptions) => { viewport.scrollTop = Number(top) || 0; } },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
    const row = this.closest<HTMLElement>("[data-activity-row]");
    const rowTop = row?.parentElement?.style.position === "absolute"
      ? Number.parseFloat(row.parentElement.style.top)
      : Array.from(viewport.querySelectorAll("[data-activity-row]")).indexOf(row!) * 100;
    return { top: row ? rowTop - viewport.scrollTop : 0, height: this === viewport ? 200 : 28 } as DOMRect;
  });
  return viewport;
}

afterEach(() => {
  act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HistoryActivityDisclosure", () => {
  it("点击耗时可展开和收起，最终答复、文件变更和下一轮正文始终保留", () => {
    const onToggle = vi.fn();
    const mounted = mountActivityFixture({ onToggle });
    const groupId = buildHistoryActivityGroups(MESSAGES)[0].id;
    expect(disclosureButton(mounted.host).textContent).toBe("用时 0:51");
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.textContent).not.toContain("第一轮执行说明");
    expect(mounted.host.textContent).not.toContain("第一轮工具结果");
    expect(disclosureButton(mounted.host).closest("[data-message-index]")?.getAttribute("data-message-index")).toBe("3");
    expect(mounted.host.textContent).toContain("第一轮最终答复");
    expect(mounted.host.textContent).toContain("第一轮文件变更");
    expect(mounted.host.textContent).toContain("第二轮仍在执行");

    act(() => disclosureButton(mounted.host).click());
    expect(onToggle).toHaveBeenLastCalledWith(groupId, expect.any(HTMLButtonElement));
    mounted.render({ onToggle, expandedIds: new Set([groupId]) });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("第一轮执行说明");
    expect(mounted.host.textContent).toContain("第一轮工具结果");
    expect(disclosureButton(mounted.host).closest("[data-message-index]")?.getAttribute("data-message-index")).toBe("1");
    expect(disclosureButton(mounted.host).compareDocumentPosition(mounted.host.querySelector('[data-message-index="2"]')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    act(() => disclosureButton(mounted.host).click());
    expect(onToggle).toHaveBeenCalledTimes(2);
    mounted.render({ onToggle, expandedIds: new Set() });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.textContent).not.toContain("第一轮执行说明");
    expect(mounted.host.textContent).toContain("第一轮最终答复");
    expect(mounted.host.textContent).toContain("第一轮文件变更");
    expect(mounted.host.textContent).toContain("第二轮请求");
    expect(mounted.host.textContent).toContain("第二轮仍在执行");
  });

  it("搜索临时展开且禁用折叠，退出搜索恢复用户原来的折叠或展开选择", () => {
    const onToggle = vi.fn();
    const collapsedIds = new Set<string>();
    const mounted = mountActivityFixture({ onToggle, expandedIds: collapsedIds });
    mounted.render({ onToggle, expandedIds: collapsedIds, searchActive: true });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("true");
    expect(disclosureButton(mounted.host).disabled).toBe(true);
    expect(disclosureButton(mounted.host).title).toBe("activitySearchExpanded");
    expect(mounted.host.textContent).toContain("第一轮工具结果");
    act(() => disclosureButton(mounted.host).click());
    expect(onToggle).not.toHaveBeenCalled();
    expect(collapsedIds.size).toBe(0);

    mounted.render({ onToggle, expandedIds: collapsedIds });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.textContent).not.toContain("第一轮工具结果");

    const expandedIds = new Set([buildHistoryActivityGroups(MESSAGES)[0].id]);
    mounted.render({ onToggle, expandedIds, searchActive: true });
    mounted.render({ onToggle, expandedIds });
    expect(disclosureButton(mounted.host).disabled).toBe(false);
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("第一轮工具结果");
    expect(mounted.host.textContent).toContain("第一轮最终答复");
  });

  it("搜索只命中执行过程时仍保留结果，最终答复不命中时不生成空按钮", () => {
    const mounted = mountActivityFixture({ searchActive: true, visibleIndices: [2] });
    expect(mounted.host.textContent).toBe("第一轮工具结果");
    expect(mounted.host.querySelector("button")).toBeNull();
    mounted.render({ visibleIndices: [3, 4] });
    expect(mounted.host.textContent).toContain("第一轮最终答复");
    expect(mounted.host.textContent).toContain("第一轮文件变更");
    expect(mounted.host.querySelector("button")).toBeNull();
  });

  it("消息行卸载后重新出现仍遵循详情层保存的展开选择", () => {
    const expandedIds = new Set([buildHistoryActivityGroups(MESSAGES)[0].id]);
    const mounted = mountActivityFixture({ expandedIds });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("true");
    mounted.render({ expandedIds, visibleIndices: [5, 6] });
    expect(mounted.host.querySelector("button")).toBeNull();
    mounted.render({ expandedIds });
    expect(disclosureButton(mounted.host).getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("第一轮工具结果");
    expect(mounted.host.textContent).toContain("第一轮最终答复");
  });

  it.each([false, true])("滚动到中部后从入口向下展开，折叠及再次展开仍保留位置（虚拟列表：%s）", async (virtualized) => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => window.clearTimeout(frameId));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountedRoot = createRoot(host);
    const listRef = createRef<VirtualizedListHandle>();
    act(() => mountedRoot?.render(<ScrollActivityFixture virtualized={virtualized} listRef={listRef} />));
    const viewport = installActivityScrollLayout(host);
    act(() => {
      viewport.scrollTop = 3040;
      listRef.current?.syncViewport();
    });
    expect(disclosureButton(host).getBoundingClientRect().top).toBe(60);
    act(() => disclosureButton(host).focus());

    await act(async () => {
      disclosureButton(host).click();
    });
    expect(viewport.scrollTop).toBe(3040);
    expect(disclosureButton(host).getBoundingClientRect().top).toBe(60);
    await act(async () => vi.advanceTimersByTimeAsync(320));
    expect(disclosureButton(host).getAttribute("aria-expanded")).toBe("true");
    expect(disclosureButton(host).getBoundingClientRect().top).toBe(60);
    expect(viewport.scrollTop).toBe(3040);
    expect(disclosureButton(host).closest("[data-activity-row]")?.getAttribute("data-activity-row")).toBe("31");
    expect(host.querySelector('[data-activity-row="32"]')?.getBoundingClientRect().top).toBeGreaterThan(60);
    expect(host.textContent).toContain("执行结果 0");

    await act(async () => {
      disclosureButton(host).click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(320));
    expect(disclosureButton(host).getAttribute("aria-expanded")).toBe("false");
    expect(disclosureButton(host).getBoundingClientRect().top).toBe(60);
    expect(viewport.scrollTop).toBe(3040);
    expect(disclosureButton(host).closest("[data-activity-row]")?.getAttribute("data-activity-row")).toBe("161");
    expect(document.activeElement).toBe(disclosureButton(host));

    await act(async () => {
      disclosureButton(host).click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(320));
    expect(disclosureButton(host).getAttribute("aria-expanded")).toBe("true");
    expect(disclosureButton(host).getBoundingClientRect().top).toBe(60);
    expect(viewport.scrollTop).toBe(3040);
    expect(host.textContent).toContain("执行结果 0");
    if (virtualized) expect(host.querySelector('[data-activity-row="0"]')).toBeNull();
  });
});
