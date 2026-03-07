import { describe, expect, it } from "vitest";

import type { DirTreeStore, GitDirInfo, Project } from "@/types/host";

import { listManagedWorktreeChildIds, resolveWorktreeManagementParentProjectId } from "./worktree-management";

/**
 * 中文说明：构造目录树测试数据，减少各用例重复样板。
 */
function createDirTreeStore(partial?: Partial<DirTreeStore>): DirTreeStore {
  return {
    version: 1,
    rootOrder: [],
    parentById: {},
    childOrderByParent: {},
    expandedById: {},
    labelById: {},
    ...(partial || {}),
  };
}

/**
 * 中文说明：构造项目测试数据，统一补齐最小必填字段。
 */
function createProject(id: string, winPath: string): Project {
  return {
    id,
    name: id,
    winPath,
    wslPath: winPath,
    hasDotCodex: false,
    createdAt: 0,
  };
}

/**
 * 中文说明：构造 Git 状态测试数据，并允许按需覆盖字段。
 */
function createGitInfo(dir: string, partial?: Partial<GitDirInfo>): GitDirInfo {
  return {
    dir,
    exists: true,
    isDirectory: true,
    isInsideWorkTree: true,
    repoRoot: dir,
    isRepoRoot: true,
    detached: false,
    isWorktree: true,
    ...(partial || {}),
  };
}

describe("worktree-management（worktree 管理父节点解析）", () => {
  it("子 worktree 优先沿用目录树中的父节点", () => {
    const projects = [
      createProject("main", "C:/repo"),
      createProject("wt-a", "C:/repo_wt/repo_wt1"),
      createProject("wt-b", "C:/repo_wt/repo_wt2"),
    ];
    const store = createDirTreeStore({
      parentById: { "wt-a": "main", "wt-b": "main" },
      childOrderByParent: { main: ["wt-a", "wt-b"] },
    });
    const gitInfoByProjectId = {
      main: createGitInfo("C:/repo", { isWorktree: true, mainWorktree: "C:/repo" }),
      "wt-a": createGitInfo("C:/repo_wt/repo_wt1", { mainWorktree: "C:/repo", branch: "feature/a" }),
      "wt-b": createGitInfo("C:/repo_wt/repo_wt2", { mainWorktree: "C:/repo", branch: "feature/b" }),
    };

    expect(resolveWorktreeManagementParentProjectId({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toBe("main");
    expect(listManagedWorktreeChildIds({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toEqual(["wt-a", "wt-b"]);
  });

  it("被提升为根级的副 worktree 仍可回溯到主工作区节点", () => {
    const projects = [
      createProject("main", "C:/repo"),
      createProject("wt-a", "C:/repo_wt/repo_wt1"),
    ];
    const store = createDirTreeStore({
      rootOrder: ["main", "wt-a"],
    });
    const gitInfoByProjectId = {
      main: createGitInfo("C:/repo", { isWorktree: true, mainWorktree: "C:/repo" }),
      "wt-a": createGitInfo("C:/repo_wt/repo_wt1", { mainWorktree: "C:/repo", branch: "feature/a" }),
    };

    expect(resolveWorktreeManagementParentProjectId({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toBe("main");
    expect(listManagedWorktreeChildIds({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toEqual(["wt-a"]);
  });

  it("同组的根级副 worktree 会补入复用列表且不混入其他仓库", () => {
    const projects = [
      createProject("main", "C:/repo"),
      createProject("wt-a", "C:/repo_wt/repo_wt1"),
      createProject("wt-b", "C:/repo_wt/repo_wt2"),
      createProject("other-main", "D:/other"),
      createProject("other-wt", "D:/other_wt/other_wt1"),
    ];
    const store = createDirTreeStore({
      rootOrder: ["main", "wt-b", "other-main"],
      parentById: { "wt-a": "main", "other-wt": "other-main" },
      childOrderByParent: { main: ["wt-a"], "other-main": ["other-wt"] },
    });
    const gitInfoByProjectId = {
      main: createGitInfo("C:/repo", { isWorktree: true, mainWorktree: "C:/repo" }),
      "wt-a": createGitInfo("C:/repo_wt/repo_wt1", { mainWorktree: "C:/repo", branch: "feature/a" }),
      "wt-b": createGitInfo("C:/repo_wt/repo_wt2", { mainWorktree: "C:/repo", branch: "feature/b" }),
      "other-main": createGitInfo("D:/other", { isWorktree: true, mainWorktree: "D:/other" }),
      "other-wt": createGitInfo("D:/other_wt/other_wt1", { mainWorktree: "D:/other", branch: "feature/c" }),
    };

    expect(listManagedWorktreeChildIds({ projectId: "main", store, projects, gitInfoByProjectId })).toEqual(["wt-a", "wt-b"]);
    expect(listManagedWorktreeChildIds({ projectId: "wt-b", store, projects, gitInfoByProjectId })).toEqual(["wt-a", "wt-b"]);
  });

  it("缺少主工作区节点时回退到当前项目自身", () => {
    const projects = [createProject("wt-a", "C:/repo_wt/repo_wt1")];
    const store = createDirTreeStore({
      rootOrder: ["wt-a"],
    });
    const gitInfoByProjectId = {
      "wt-a": createGitInfo("C:/repo_wt/repo_wt1", { mainWorktree: "C:/repo", branch: "feature/a" }),
    };

    expect(resolveWorktreeManagementParentProjectId({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toBe("wt-a");
    expect(listManagedWorktreeChildIds({ projectId: "wt-a", store, projects, gitInfoByProjectId })).toEqual([]);
  });
});
