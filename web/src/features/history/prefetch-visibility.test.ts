import { describe, expect, it } from "vitest";

import { shouldMergeHistoryPrefetchIntoVisibleList } from "./prefetch-visibility";

describe("history prefetch visibility", () => {
  it("当前项目范围拒绝其他项目的后台预取结果", () => {
    expect(shouldMergeHistoryPrefetchIntoVisibleList("project-b", {
      effectiveScope: "current_project",
      projectIds: ["project-a"],
    })).toBe(false);
  });

  it("当前项目范围允许当前项目的后台预取结果", () => {
    expect(shouldMergeHistoryPrefetchIntoVisibleList("project-a", {
      effectiveScope: "current_project",
      projectIds: ["project-a"],
    })).toBe(true);
  });

  it("项目组范围只允许组内项目的后台预取结果", () => {
    const visibleScope = {
      effectiveScope: "project_group" as const,
      projectIds: ["project-root", "project-child"],
    };

    expect(shouldMergeHistoryPrefetchIntoVisibleList("project-child", visibleScope)).toBe(true);
    expect(shouldMergeHistoryPrefetchIntoVisibleList("project-outside", visibleScope)).toBe(false);
  });

  it("全部会话范围允许任意有效项目的后台预取结果", () => {
    expect(shouldMergeHistoryPrefetchIntoVisibleList("project-b", {
      effectiveScope: "all_sessions",
      projectIds: [],
    })).toBe(true);
    expect(shouldMergeHistoryPrefetchIntoVisibleList("", {
      effectiveScope: "all_sessions",
      projectIds: [],
    })).toBe(false);
  });
});
