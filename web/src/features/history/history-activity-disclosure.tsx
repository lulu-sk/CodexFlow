import { ChevronRight, Clock3 } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatHistoryActivityDuration, type HistoryActivityDisclosureState, type HistoryActivityGroup } from "./activity-groups";
import type { VirtualizedListHandle } from "./virtualized-list";

type ActivityScrollAnchor = {
  group: HistoryActivityGroup;
  viewportKey: string;
  offset: number;
  focused: boolean;
};

/** 切换过程消息时固定耗时按钮的位置，让内容向下展开且收起后仍能找到入口。 */
export function useHistoryActivityScrollAnchor({ messages, scrollContainerRef, virtualListRef, virtualized, viewportKey }: {
  messages: readonly { originalIndex: number }[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  virtualListRef: RefObject<VirtualizedListHandle | null>;
  virtualized: boolean;
  viewportKey: string;
}): (group: HistoryActivityGroup, trigger: HTMLButtonElement) => void {
  const pendingAnchor = useRef<ActivityScrollAnchor | null>(null);

  /** 保存切换前按钮在视口内的位置，键盘操作时一并保留焦点。 */
  const captureAnchor = useCallback((group: HistoryActivityGroup, trigger: HTMLButtonElement): void => {
    const viewport = scrollContainerRef.current;
    if (!viewport) return;
    const triggerRect = trigger.getBoundingClientRect();
    pendingAnchor.current = {
      group,
      viewportKey,
      offset: Math.max(8, Math.min(triggerRect.top - viewport.getBoundingClientRect().top, Math.max(8, viewport.clientHeight - triggerRect.height - 8))),
      focused: document.activeElement === trigger,
    };
  }, [scrollContainerRef, viewportKey]);

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    const viewport = scrollContainerRef.current;
    if (!anchor || !viewport || anchor.viewportKey !== viewportKey) return;
    // 展开时入口在首条可见过程前，收起时入口回到最终答复前。
    const groupIndices = new Set([...anchor.group.messageIndices, anchor.group.anchorIndex]);
    const anchorIndex = messages.findIndex((view) => groupIndices.has(view.originalIndex));
    if (anchorIndex < 0) return;
    const viewportElement: HTMLDivElement = viewport;
    const targetAnchor: ActivityScrollAnchor = anchor;
    let frameId = 0;
    let attempts = 0;
    let stableFrames = 0;
    let stopped = false;

    /** 用户主动滚动或布局校准完成后停止定位，避免抢回阅读位置。 */
    function stopCalibration(): void {
      stopped = true;
      if (frameId) cancelAnimationFrame(frameId);
      viewportElement.removeEventListener("wheel", stopCalibration, true);
      viewportElement.removeEventListener("touchstart", stopCalibration, true);
      viewportElement.removeEventListener("keydown", stopCalibration, true);
    }

    /** 等待虚拟行挂载与测量后校正按钮位置，并恢复同一入口的键盘焦点。 */
    function alignAnchor(): void {
      frameId = 0;
      if (stopped) return;
      attempts += 1;
      const trigger = Array.from(viewportElement.querySelectorAll<HTMLButtonElement>("[data-history-activity-toggle]"))
        .find((button) => button.dataset.historyActivityToggle === targetAnchor.group.id);
      if (trigger) {
        const delta = trigger.getBoundingClientRect().top - viewportElement.getBoundingClientRect().top - targetAnchor.offset;
        const previousTop = viewportElement.scrollTop;
        if (Math.abs(delta) > 1) viewportElement.scrollTop = Math.max(0, previousTop + delta);
        virtualListRef.current?.syncViewport();
        stableFrames = Math.abs(delta) <= 1 || Math.abs(viewportElement.scrollTop - previousTop) <= 1 ? stableFrames + 1 : 0;
        if (targetAnchor.focused) trigger.focus({ preventScroll: true });
      } else {
        stableFrames = 0;
        if (virtualized) virtualListRef.current?.scrollToIndex(anchorIndex, { align: "start", behavior: "auto" });
      }
      if (attempts >= 16 || stableFrames >= 3) stopCalibration();
      else frameId = requestAnimationFrame(alignAnchor);
    }

    viewport.addEventListener("wheel", stopCalibration, { passive: true, capture: true });
    viewport.addEventListener("touchstart", stopCalibration, { passive: true, capture: true });
    viewport.addEventListener("keydown", stopCalibration, true);
    alignAnchor();
    return stopCalibration;
  }, [messages, scrollContainerRef, virtualListRef, virtualized, viewportKey]);

  return captureAnchor;
}

/** 提供与轮次耗时关联的执行过程展开按钮，鼠标和键盘使用同一受控状态。 */
export function HistoryActivityDisclosure({ group, onToggle, searchActive }: {
  group: HistoryActivityDisclosureState;
  onToggle?: (id: string, trigger: HTMLButtonElement) => void;
  searchActive?: boolean;
}) {
  const { t } = useTranslation("history");
  const label = group.durationMs === undefined
    ? t("activityMessages", { count: group.visibleCount })
    : t("activityWorkedFor", { time: formatHistoryActivityDuration(group.durationMs) });
  return (
    <button
      type="button"
      data-history-activity-toggle={group.id}
      aria-expanded={group.expanded}
      title={t(searchActive ? "activitySearchExpanded" : group.expanded ? "activityCollapse" : "activityExpand")}
      disabled={searchActive}
      onClick={(event) => onToggle?.(group.id, event.currentTarget)}
      className="mb-2 flex max-w-full items-center gap-1.5 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2 py-1.5 text-xs text-[var(--cf-text-secondary)] transition-colors hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-accent-light)] hover:text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] disabled:cursor-default"
    >
      <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", group.expanded && "rotate-90")} aria-hidden="true" />
    </button>
  );
}
