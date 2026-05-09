import { describe, expect, it } from "vitest";
import { buildGitLogRowStyle, shouldHighlightCurrentBranch } from "./log-row-style";

describe("git log row style", () => {
  it("当前已过滤到 HEAD 或当前分支时不应继续启用 current branch 高亮", () => {
    expect(shouldHighlightCurrentBranch({ currentBranch: "master", branchFilter: "HEAD" })).toBe(false);
    expect(shouldHighlightCurrentBranch({ currentBranch: "master", branchFilter: "master" })).toBe(false);
    expect(shouldHighlightCurrentBranch({ currentBranch: "master", branchFilter: "origin/master" })).toBe(true);
    expect(shouldHighlightCurrentBranch({ currentBranch: "master", branchFilter: "all" })).toBe(true);
  });

  it("selected 应覆盖 current branch 高亮，普通场景下才回落到高亮背景", () => {
    const highlighted = buildGitLogRowStyle({
      selected: false,
      currentBranch: "master",
      branchFilter: "all",
      containedInCurrentBranch: true,
    });
    const selected = buildGitLogRowStyle({
      selected: true,
      currentBranch: "master",
      branchFilter: "all",
      containedInCurrentBranch: true,
    });

    expect(highlighted.highlightCurrentBranch).toBe(true);
    expect(highlighted.classNames).toContain("cf-git-row-current-branch");
    expect(selected.highlightCurrentBranch).toBe(false);
    expect(selected.classNames).toContain("cf-git-row-selected");
    expect(selected.classNames).not.toContain("cf-git-row-current-branch");
  });
});
