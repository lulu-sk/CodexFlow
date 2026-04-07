import { describe, expect, it } from "vitest";
import { resolveWorktreeDeleteResetTargetBranch } from "./worktree-delete";

describe("worktree-delete（删除弹窗重置目标分支推断）", () => {
  it("优先选择创建记录中的基分支", () => {
    expect(
      resolveWorktreeDeleteResetTargetBranch({
        branches: ["main", "release", "feature/demo"],
        recordedBaseBranch: "release",
        repoCurrentBranch: "main",
      })
    ).toBe("release");
  });

  it("创建记录分支不可用时退回到目标 worktree 当前分支", () => {
    expect(
      resolveWorktreeDeleteResetTargetBranch({
        branches: ["main", "release", "feature/demo"],
        recordedBaseBranch: "missing",
        repoCurrentBranch: "main",
      })
    ).toBe("main");
  });

  it("会归一化分支列表，并在无显式偏好时退回首个分支", () => {
    expect(
      resolveWorktreeDeleteResetTargetBranch({
        branches: ["  release  ", "release", "", "main"],
      })
    ).toBe("release");
  });
});
