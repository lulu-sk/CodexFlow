import { describe, expect, it } from "vitest";
import type { GitUpdateSessionNotificationData } from "../types";
import {
  buildUpdateInfoLogRevision,
  buildUpdateInfoLogState,
  resolveUpdateInfoLogRange,
  selectUpdateInfoLogRange,
} from "./update-info-log";

const notification: GitUpdateSessionNotificationData = {
  title: "2 个文件在 3 个提交中已更新",
  updatedFilesCount: 2,
  receivedCommitsCount: 3,
  filteredCommitsCount: 2,
  ranges: [
    {
      repoRoot: "/repo-a",
      rootName: "repo-a",
      range: { start: "a1", end: "a2" },
      commitCount: 2,
      fileCount: 1,
    },
    {
      repoRoot: "/repo-b",
      rootName: "repo-b",
      range: { start: "b1", end: "b2" },
      commitCount: 1,
      fileCount: 1,
    },
  ],
  primaryRange: {
    repoRoot: "/repo-a",
    rootName: "repo-a",
    range: { start: "a1", end: "a2" },
    commitCount: 2,
    fileCount: 1,
  },
  skippedRoots: [],
  postActions: [],
};

describe("update info log helpers", () => {
  it("buildUpdateInfoLogRevision 应输出稳定 revision 文本", () => {
    expect(buildUpdateInfoLogRevision(notification.ranges[0])).toBe("a1..a2");
    expect(buildUpdateInfoLogRevision(null)).toBe("");
  });

  it("buildUpdateInfoLogState 应生成独立于普通日志的默认过滤状态", () => {
    const state = buildUpdateInfoLogState({
      notification,
      preferredRepoRoot: "/repo-b",
      autoOpened: true,
      currentPathFilter: "src/app.ts",
    });
    expect(state).not.toBeNull();
    expect(state?.selectedRepoRoot).toBe("/repo-b");
    expect(state?.filters.revision).toBe("b1..b2");
    expect(state?.filters.path).toBe("src/app.ts");
    expect(state?.filters.branch).toBe("all");
    expect(state?.filters.branchValues).toEqual([]);
    expect(state?.filters.authorValues).toEqual([]);
    expect(state?.autoOpened).toBe(true);
  });

  it("selectUpdateInfoLogRange 应切换范围并保留路径过滤", () => {
    const initial = buildUpdateInfoLogState({
      notification,
      preferredRepoRoot: "/repo-a",
      currentPathFilter: "src/app.ts",
    });
    expect(initial).not.toBeNull();
    const next = selectUpdateInfoLogRange(initial!, "/repo-b");
    expect(resolveUpdateInfoLogRange(next)?.repoRoot).toBe("/repo-b");
    expect(next.filters.revision).toBe("b1..b2");
    expect(next.filters.path).toBe("src/app.ts");
    expect(next.filters.branchValues).toEqual([]);
  });
});
