import { describe, expect, it } from "vitest";
import {
  buildWorktreeRecycleBranchListCandidates,
  resolveWorktreeRecycleRepoMainPath,
} from "./worktree-recycle";

describe("worktree-recycle（回收对话框路径解析）", () => {
  it("优先使用记录路径与 fallback 路径，再回退到当前子 worktree", () => {
    expect(buildWorktreeRecycleBranchListCandidates({
      repoMainPath: "C:/repo/base-wt",
      fallbackRepoPath: "C:/repo/main",
      projectPath: "C:/repo/wt/child",
    })).toEqual([
      "C:/repo/base-wt",
      "C:/repo/main",
      "C:/repo/wt/child",
    ]);
  });

  it("会去重重复候选路径", () => {
    expect(buildWorktreeRecycleBranchListCandidates({
      repoMainPath: "C:/repo/main",
      fallbackRepoPath: "C:/repo/main",
      projectPath: "C:/repo/wt/child",
    })).toEqual([
      "C:/repo/main",
      "C:/repo/wt/child",
    ]);
  });

  it("若只能从当前子 worktree 读到分支，仍优先保留 fallback 作为目标路径", () => {
    expect(resolveWorktreeRecycleRepoMainPath({
      branchListPath: "C:/repo/wt/child",
      fallbackRepoPath: "C:/repo/main",
      projectPath: "C:/repo/wt/child",
    })).toBe("C:/repo/main");
  });

  it("若目标路径本身可用，则直接使用该路径", () => {
    expect(resolveWorktreeRecycleRepoMainPath({
      branchListPath: "C:/repo/base-wt",
      fallbackRepoPath: "C:/repo/main",
      projectPath: "C:/repo/wt/child",
    })).toBe("C:/repo/base-wt");
  });

  it("若没有 fallback，则回退到实际读取成功的当前子 worktree", () => {
    expect(resolveWorktreeRecycleRepoMainPath({
      branchListPath: "C:/repo/wt/child",
      fallbackRepoPath: "",
      projectPath: "C:/repo/wt/child",
    })).toBe("C:/repo/wt/child");
  });
});
