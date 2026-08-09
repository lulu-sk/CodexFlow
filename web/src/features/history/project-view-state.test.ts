import { describe, expect, it } from "vitest";

import {
  getProjectCenterViewState,
  getTabHistoryViewState,
  parseProjectCenterViewStateMap,
  parseTabHistoryViewStateMap,
  resolveHistoryDetailLayout,
  resolveProjectCenterViewStateKey,
  resolveTabHistoryViewStateKey,
  shouldApplyHistoryDetailBottomRequest,
  updateProjectCenterViewState,
  updateTabHistoryViewState,
} from "./project-view-state";

describe("project-view-state", () => {
  it("项目没有终端标签时历史详情只能全屏", () => {
    expect(resolveHistoryDetailLayout("split", [])).toEqual({
      mode: "full",
      canSplit: false,
    });
    expect(resolveHistoryDetailLayout("split", [{ kind: "git" }])).toEqual({
      mode: "full",
      canSplit: false,
    });
  });

  it("项目存在终端标签时保留用户选择的历史详情布局", () => {
    expect(resolveHistoryDetailLayout("split", [{ kind: "terminal" }])).toEqual({
      mode: "split",
      canSplit: true,
    });
    expect(resolveHistoryDetailLayout("full", [{ kind: "git" }, { kind: "terminal" }])).toEqual({
      mode: "full",
      canSplit: true,
    });
  });

  it("不同项目只分别保存中心视图模式", () => {
    const first = updateProjectCenterViewState({}, "project-a", {
      mode: "history",
    });
    const second = updateProjectCenterViewState(first, "project-b", { mode: "console" });

    expect(getProjectCenterViewState(second, "project-a")).toEqual({ mode: "history" });
    expect(getProjectCenterViewState(second, "project-b").mode).toBe("console");
  });

  it("未选择项目时使用独立的全局状态键", () => {
    expect(resolveProjectCenterViewStateKey("")).not.toBe(resolveProjectCenterViewStateKey("project-a"));
  });

  it("同一项目的不同标签页分别保存历史详情", () => {
    const first = updateTabHistoryViewState({}, "tab-a", "project-a", {
      selectedHistoryDir: "today",
      selectedHistoryId: "session-a",
      detailScrollProgress: 0.42,
    });
    const second = updateTabHistoryViewState(first, "tab-b", "project-a", {
      selectedHistoryDir: "yesterday",
      selectedHistoryId: "session-b",
    });

    expect(getTabHistoryViewState(second, "tab-a", "project-a").selectedHistoryId).toBe("session-a");
    expect(getTabHistoryViewState(second, "tab-a", "project-a").detailScrollProgress).toBe(0.42);
    expect(getTabHistoryViewState(second, "tab-b", "project-a").selectedHistoryId).toBe("session-b");
  });

  it("仅在没有标签页时使用项目兜底详情", () => {
    const states = updateTabHistoryViewState({}, null, "project-a", { selectedHistoryId: "project-session" });

    expect(resolveTabHistoryViewStateKey(null, "project-a")).not.toBe(resolveTabHistoryViewStateKey("tab-a", "project-a"));
    expect(getTabHistoryViewState(states, null, "project-a").selectedHistoryId).toBe("project-session");
    expect(getTabHistoryViewState(states, "tab-a", "project-a").selectedHistoryId).toBeNull();
  });

  it("损坏数据回退为空状态并规整无效字段", () => {
    expect(parseProjectCenterViewStateMap("not-json")).toEqual({});
    expect(parseProjectCenterViewStateMap(JSON.stringify({
      valid: { mode: "history", selectedHistoryDir: 1, selectedHistoryId: "session" },
      invalid: null,
    }))).toEqual({
      valid: { mode: "history" },
    });
    expect(parseTabHistoryViewStateMap(JSON.stringify({
      "tab:valid": { selectedHistoryDir: 1, selectedHistoryId: "session" },
      invalid: null,
    }))).toEqual({
      "tab:valid": { selectedHistoryDir: null, selectedHistoryId: "session", detailScrollProgress: null },
    });
  });

  it("滚动百分比会被规整到合法范围", () => {
    const states = parseTabHistoryViewStateMap(JSON.stringify({
      low: { detailScrollProgress: -1 },
      high: { detailScrollProgress: 2 },
      invalid: { detailScrollProgress: "not-a-number" },
    }));

    expect(states).toEqual({
      low: { selectedHistoryDir: null, selectedHistoryId: null, detailScrollProgress: 0 },
      high: { selectedHistoryDir: null, selectedHistoryId: null, detailScrollProgress: 1 },
      invalid: { selectedHistoryDir: null, selectedHistoryId: null, detailScrollProgress: null },
    });
  });

  it("仅对终端按钮指定的当前历史详情执行到底部请求", () => {
    const request = { id: 1, scrollStateKey: "tab:tab-a", sessionId: "session-a" };

    expect(shouldApplyHistoryDetailBottomRequest(request, "tab:tab-a", "session-a")).toBe(true);
    expect(shouldApplyHistoryDetailBottomRequest(null, "tab:tab-a", "session-a")).toBe(false);
    expect(shouldApplyHistoryDetailBottomRequest(request, "tab:tab-b", "session-a")).toBe(false);
    expect(shouldApplyHistoryDetailBottomRequest(request, "tab:tab-a", "session-b")).toBe(false);
  });
});
