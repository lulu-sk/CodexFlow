import { describe, expect, it } from "vitest";
import {
  formatGitLogFilterTriggerLabel,
  getGitLogAuthorFilterValues,
  getGitLogBranchFilterValues,
  normalizeGitLogFilters,
} from "./log-filters";

describe("git log filter helpers", () => {
  it("normalizeGitLogFilters 应同步旧版单值与新版多值字段", () => {
    const filters = normalizeGitLogFilters({
      branch: "feature/demo",
      author: "Alice",
      text: "fix",
    });
    expect(filters.branch).toBe("feature/demo");
    expect(filters.branchValues).toEqual(["feature/demo"]);
    expect(filters.author).toBe("Alice");
    expect(filters.authorValues).toEqual(["Alice"]);
  });

  it("normalizeGitLogFilters 遇到多选时应把旧版单值字段回退到默认态", () => {
    const filters = normalizeGitLogFilters({
      branchValues: ["feature/a", "feature/b"],
      authorValues: ["Alice", "Bob"],
    });
    expect(filters.branch).toBe("all");
    expect(filters.branchValues).toEqual(["feature/a", "feature/b"]);
    expect(filters.author).toBe("");
    expect(filters.authorValues).toEqual(["Alice", "Bob"]);
  });

  it("分支与作者取值提取应兼容空值与 all 哨兵", () => {
    expect(getGitLogBranchFilterValues({ branch: "all" })).toEqual([]);
    expect(getGitLogBranchFilterValues({ branchValues: ["all", "HEAD", "origin/main"] })).toEqual(["HEAD", "origin/main"]);
    expect(getGitLogAuthorFilterValues({ author: "" })).toEqual([]);
  });

  it("formatGitLogFilterTriggerLabel 应输出紧凑文案", () => {
    expect(formatGitLogFilterTriggerLabel("分支", [])).toBe("分支");
    expect(formatGitLogFilterTriggerLabel("分支", ["feature/demo"])).toBe("分支: feature/demo");
    expect(formatGitLogFilterTriggerLabel("用户", ["Alice", "Bob"])).toBe("用户: Alice +1");
  });
});
