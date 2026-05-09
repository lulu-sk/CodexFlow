import { describe, expect, it } from "vitest";
import type { GitWorktreeItem } from "./types";
import {
  createDefaultWorktreeTabPreferences,
  markWorktreeFeatureUsed,
  markWorktreeTabClosedByUser,
  markWorktreeTabOpenedByUser,
  shouldShowWorktreeNewBadge,
  shouldShowWorktreeTab,
} from "./worktree-tab-state";

const singleWorktree: GitWorktreeItem[] = [
  { path: "/repo", bare: false, detached: false, branch: "main" },
];

const multiWorktree: GitWorktreeItem[] = [
  { path: "/repo", bare: false, detached: false, branch: "main" },
  { path: "/repo-wt", bare: false, detached: false, branch: "feature/test" },
];

describe("worktree tab state helpers", () => {
  it("当前产品设计下，页签应始终显示且不展示 NEW badge", () => {
    const preferences = createDefaultWorktreeTabPreferences();
    expect(shouldShowWorktreeTab({ preferences, items: multiWorktree })).toBe(true);
    expect(shouldShowWorktreeTab({ preferences, items: singleWorktree })).toBe(true);
    expect(shouldShowWorktreeNewBadge({ preferences, items: multiWorktree })).toBe(false);
  });

  it("用户手动打开后，仍应维持常驻页签且不展示 NEW badge", () => {
    const preferences = markWorktreeTabOpenedByUser(createDefaultWorktreeTabPreferences());
    expect(shouldShowWorktreeTab({ preferences, items: singleWorktree })).toBe(true);
    expect(shouldShowWorktreeNewBadge({ preferences, items: multiWorktree })).toBe(false);
  });

  it("即使保留已关闭偏好，当前产品设计仍应保持页签常驻", () => {
    const opened = markWorktreeTabOpenedByUser(createDefaultWorktreeTabPreferences());
    const closed = markWorktreeTabClosedByUser(opened);
    expect(shouldShowWorktreeTab({ preferences: closed, items: multiWorktree })).toBe(true);
  });

  it("功能已使用后，仍不展示 NEW badge", () => {
    const preferences = markWorktreeFeatureUsed(createDefaultWorktreeTabPreferences());
    expect(shouldShowWorktreeNewBadge({ preferences, items: multiWorktree })).toBe(false);
  });
});
