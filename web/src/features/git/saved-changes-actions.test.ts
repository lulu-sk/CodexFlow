import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManualShelveSelection,
  consumePendingSavedChangesOpenRequest,
  openSavedChangesViewAsync,
  runShelfEntryActionAsync,
  runStashEntryActionAsync,
} from "./saved-changes-actions";
import type { GitShelfItem, GitStashItem, GitStatusEntry } from "./types";

type LocalStorageMock = {
  length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

/**
 * 构造最小 Git 状态条目，便于测试手动搁置选择载荷。
 */
function createStatusEntry(input: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return {
    path: input.path,
    x: "M",
    y: "M",
    staged: input.staged ?? true,
    unstaged: input.unstaged ?? true,
    untracked: input.untracked ?? false,
    ignored: input.ignored ?? false,
    renamed: input.renamed ?? false,
    deleted: input.deleted ?? false,
    statusText: input.statusText || "已修改",
    changeListId: input.changeListId || "default",
    oldPath: input.oldPath,
    repositoryId: input.repositoryId,
    repositoryRoot: input.repositoryRoot,
    repositoryName: input.repositoryName,
    repositoryExternal: input.repositoryExternal,
    repositoryParentId: input.repositoryParentId,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    moduleInternal: input.moduleInternal,
    conflictState: input.conflictState,
  };
}

/**
 * 构造最小 shelf 条目，便于验证统一恢复/删除动作。
 */
function createShelfItem(source: GitShelfItem["source"] = "manual"): GitShelfItem {
  return {
    ref: "shelf@{1}",
    repoRoot: "/repo",
    repoRoots: ["/repo"],
    message: "manual shelf",
    createdAt: "2025-01-01T00:00:00.000Z",
    source,
    saveChangesPolicy: "shelve",
    state: "saved",
    displayName: "manual shelf",
    hasIndexPatch: true,
    hasWorktreePatch: true,
    hasUntrackedFiles: false,
    paths: ["src/app.ts", "src/lib.ts"],
  };
}

/**
 * 构造最小 stash 条目，便于验证统一暂存动作链路。
 */
function createStashItem(): GitStashItem {
  return {
    ref: "stash@{0}",
    hash: "abc123",
    date: "2025-01-01T00:00:00.000Z",
    message: "manual stash",
  };
}

/**
 * 为 Node 测试环境注入最小 localStorage，实现跨仓保存动作的持久化断言。
 */
function ensureLocalStorageMock(): LocalStorageMock {
  const globalObject = globalThis as typeof globalThis & { localStorage?: LocalStorageMock };
  if (globalObject.localStorage) return globalObject.localStorage;
  const store = new Map<string, string>();
  const mock: LocalStorageMock = {
    get length() {
      return store.size;
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] || null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  globalObject.localStorage = mock as unknown as Storage & LocalStorageMock;
  return mock;
}

afterEach(() => {
  ensureLocalStorageMock().clear();
});

describe("saved changes actions", () => {
  it("跨仓打开已保存暂存后，应在目标仓继续消费并定位原始请求", async () => {
    ensureLocalStorageMock().clear();
    const openRepoRootInAppAsync = vi.fn(async () => true);
    const getStashListAsync = vi.fn(async () => ({ ok: true, data: { items: [createStashItem()] } }));
    await openSavedChangesViewAsync({
      currentRepoRoot: "/repo",
      targetRepoRoot: "/repo/lib",
      saveChangesPolicy: "stash",
      payload: { ref: "stash@{0}", viewKind: "stash" },
      getShelvesAsync: vi.fn(async () => ({ ok: true, data: { items: [] } })),
      getStashListAsync,
      openRepoRootInAppAsync,
      setLeftTab: vi.fn(),
      setShelfItems: vi.fn(),
      setStashItems: vi.fn(),
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(openRepoRootInAppAsync).toHaveBeenCalledWith("/repo/lib", {
      successMessage: "已打开目标仓库，可继续查看其暂存列表",
    });
    expect(getStashListAsync).not.toHaveBeenCalled();
    expect(consumePendingSavedChangesOpenRequest("/repo")).toBeNull();
    expect(consumePendingSavedChangesOpenRequest("/repo/lib")).toEqual({
      targetRepoRoot: "/repo/lib",
      saveChangesPolicy: "stash",
      payload: { ref: "stash@{0}", viewKind: "stash" },
    });
    expect(consumePendingSavedChangesOpenRequest("/repo/lib")).toBeNull();
  });

  it("应构造包含当前选择、当前更改列表与当前可见改动的手动搁置载荷", () => {
    const selection = buildManualShelveSelection({
      selectedEntries: [
        createStatusEntry({ path: "src/app.ts", changeListId: "feature" }),
        createStatusEntry({ path: "dist/app.js", ignored: true }),
      ],
      statusEntries: [
        createStatusEntry({ path: "src/app.ts", changeListId: "feature" }),
        createStatusEntry({ path: "src/lib.ts", changeListId: "feature" }),
        createStatusEntry({ path: "dist/app.js", ignored: true }),
      ],
      changeListsEnabled: true,
      targetChangeListId: "feature",
      targetChangeListName: "功能改动",
    });

    expect(selection).toEqual({
      selectedPaths: ["src/app.ts"],
      availablePaths: ["src/app.ts", "src/lib.ts"],
      targetChangeListId: "feature",
      targetChangeListName: "功能改动",
      changeListsEnabled: true,
    });
  });

  it("open-saved-changes 应直接定位并置顶目标搁置记录", async () => {
    const setLeftTab = vi.fn();
    const setShelfItems = vi.fn();
    const setStashItems = vi.fn();
    await openSavedChangesViewAsync({
      currentRepoRoot: "/repo",
      targetRepoRoot: "/repo",
      saveChangesPolicy: "shelve",
      payload: { ref: "shelf@{target}", viewKind: "shelf" },
      getShelvesAsync: vi.fn(async () => ({
        ok: true,
        data: {
          items: [
            { ...createShelfItem("system"), ref: "shelf@{other}" },
            { ...createShelfItem("system"), ref: "shelf@{target}", message: "target shelf" },
          ],
        },
      })),
      getStashListAsync: vi.fn(async () => ({ ok: true, data: { items: [] } })),
      openRepoRootInAppAsync: vi.fn(async () => true),
      setLeftTab,
      setShelfItems,
      setStashItems,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(setLeftTab).toHaveBeenCalledWith("shelve");
    expect(setStashItems).not.toHaveBeenCalled();
    expect(setShelfItems).toHaveBeenCalledWith([
      expect.objectContaining({ ref: "shelf@{target}", message: "target shelf" }),
      expect.objectContaining({ ref: "shelf@{other}" }),
    ]);
  });

  it("open-saved-changes 应直接定位并置顶目标暂存记录", async () => {
    const setStashItems = vi.fn();
    await openSavedChangesViewAsync({
      currentRepoRoot: "/repo",
      targetRepoRoot: "/repo",
      saveChangesPolicy: "stash",
      payload: { ref: "stash@{1}", viewKind: "stash" },
      getShelvesAsync: vi.fn(async () => ({ ok: true, data: { items: [] } })),
      getStashListAsync: vi.fn(async () => ({
        ok: true,
        data: {
          items: [
            createStashItem(),
            { ...createStashItem(), ref: "stash@{1}", message: "target stash" },
          ],
        },
      })),
      openRepoRootInAppAsync: vi.fn(async () => true),
      setLeftTab: vi.fn(),
      setShelfItems: vi.fn(),
      setStashItems,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(setStashItems).toHaveBeenCalledWith([
      expect.objectContaining({ ref: "stash@{1}", message: "target stash" }),
      expect.objectContaining({ ref: "stash@{0}" }),
    ]);
  });

  it("恢复暂存发生冲突时应统一刷新并进入 resolver", async () => {
    const refreshAllAsync = vi.fn(async () => undefined);
    const openConflictResolverDialog = vi.fn();
    await runStashEntryActionAsync({
      repoRoot: "/repo",
      stash: createStashItem(),
      action: "pop",
      applyStashAsync: vi.fn(async () => ({
        ok: false,
        error: "冲突",
        data: { conflictRepoRoots: ["/repo"] },
      })),
      dropStashAsync: vi.fn(async () => ({ ok: true })),
      refreshAllAsync,
      openConflictResolverDialog,
      isLikelyConflictErrorText: () => true,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(refreshAllAsync).toHaveBeenCalledWith({ keepLog: true });
    expect(openConflictResolverDialog).toHaveBeenCalledWith({
      title: "解决恢复暂存冲突",
      description: "恢复暂存 stash@{0} 后检测到冲突；可在这里逐个打开冲突文件继续处理。",
      reverseMerge: true,
    });
  });

  it("系统搁置与手动搁置应共用同一删除路径", async () => {
    const refreshAllAsync = vi.fn(async () => undefined);
    const deleteShelveAsync = vi.fn(async () => ({ ok: true }));
    const onDeleteSuccess = vi.fn(async () => undefined);
    await runShelfEntryActionAsync({
      repoRoot: "/repo",
      shelf: createShelfItem("system"),
      action: "delete",
      restoreShelveAsync: vi.fn(async () => ({ ok: true })),
      deleteShelveAsync,
      refreshAllAsync,
      openConflictResolverDialog: vi.fn(),
      isLikelyConflictErrorText: () => false,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
      onDeleteSuccess,
    });

    expect(deleteShelveAsync).toHaveBeenCalledWith("/repo", "shelf@{1}");
    expect(refreshAllAsync).toHaveBeenCalledWith({ keepLog: true });
    expect(onDeleteSuccess).toHaveBeenCalledWith(expect.objectContaining({ ref: "shelf@{1}" }));
  });

  it("恢复搁置时应透传 partial unshelve 与 remove policy 选项", async () => {
    const restoreShelveAsync = vi.fn(async () => ({ ok: true }));
    await runShelfEntryActionAsync({
      repoRoot: "/repo",
      shelf: createShelfItem("manual"),
      action: "restore",
      options: {
        selectedPaths: ["src/lib.ts"],
        targetChangeListId: "feature",
        removeAppliedFromShelf: false,
      },
      restoreShelveAsync,
      deleteShelveAsync: vi.fn(async () => ({ ok: true })),
      refreshAllAsync: vi.fn(async () => undefined),
      openConflictResolverDialog: vi.fn(),
      isLikelyConflictErrorText: () => false,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(restoreShelveAsync).toHaveBeenCalledWith("/repo", "shelf@{1}", {
      selectedPaths: ["src/lib.ts"],
      targetChangeListId: "feature",
      removeAppliedFromShelf: false,
    });
  });

  it("应用暂存时应支持 reinstate-index 选项", async () => {
    const applyStashAsync = vi.fn(async () => ({ ok: true }));
    await runStashEntryActionAsync({
      repoRoot: "/repo",
      stash: createStashItem(),
      action: "apply",
      options: {
        reinstateIndex: true,
      },
      applyStashAsync,
      dropStashAsync: vi.fn(async () => ({ ok: true })),
      refreshAllAsync: vi.fn(async () => undefined),
      openConflictResolverDialog: vi.fn(),
      isLikelyConflictErrorText: () => false,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(applyStashAsync).toHaveBeenCalledWith("/repo", "stash@{0}", false, {
      reinstateIndex: true,
      branchName: undefined,
    });
  });

  it("恢复为分支时应透传 branchName，且不再附带 reinstate-index", async () => {
    const applyStashAsync = vi.fn(async () => ({ ok: true }));
    await runStashEntryActionAsync({
      repoRoot: "/repo",
      stash: createStashItem(),
      action: "branch",
      options: {
        branchName: "feature/from-stash",
        reinstateIndex: true,
      },
      applyStashAsync,
      dropStashAsync: vi.fn(async () => ({ ok: true })),
      refreshAllAsync: vi.fn(async () => undefined),
      openConflictResolverDialog: vi.fn(),
      isLikelyConflictErrorText: () => false,
      setError: vi.fn(),
      formatError: (error, fallback) => error || fallback,
    });

    expect(applyStashAsync).toHaveBeenCalledWith("/repo", "stash@{0}", false, {
      reinstateIndex: false,
      branchName: "feature/from-stash",
    });
  });
});
