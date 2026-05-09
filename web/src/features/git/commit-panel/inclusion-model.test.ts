import { describe, expect, it } from "vitest";
import {
  buildCommitInclusionItems,
  resolveCommitActivationInclusionState,
  createCommitInclusionState,
  getCommitInclusionCheckState,
  isSameCommitInclusionState,
  isCommitGroupInclusionVisible,
  isCommitNodeInclusionVisible,
  setCommitInclusionForItemIds,
  syncCommitInclusionState,
  toggleCommitInclusionForItemIds,
} from "./inclusion-model";

describe("commit inclusion model", () => {
  it("首次同步应只自动纳入 resolved conflict，不再默认勾选普通 changes", () => {
    const items = buildCommitInclusionItems([
      { path: "resolved.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "feature", conflictState: "resolved" },
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
    ]);
    const state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    expect(state.includedIds).toEqual([items[0]!.id]);
  });

  it("首次同步没有 resolved conflict 时，不应默认纳入活动 changelist changes 或未跟踪文件", () => {
    const items = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "" },
    ]);
    const state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    expect(state.includedIds).toEqual([]);
  });

  it("多仓 staged root 与 changed root 应被正确汇总，并在无 staged 时切换到 commit-all 语义", () => {
    const state = syncCommitInclusionState(createCommitInclusionState(), buildCommitInclusionItems([
      { path: "pkg-a/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "pkg-b/b.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-b" },
      { path: "pkg-b/conflict.ts", x: "U", y: "U", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "冲突", changeListId: "default", repositoryRoot: "/repo-b", conflictState: "conflict" },
    ]), "default");

    expect(state.stagedRepoRoots).toEqual(["/repo-a"]);
    expect(state.changedRepoRoots).toEqual(["/repo-a", "/repo-b"]);
    expect(state.conflictedRepoRoots).toEqual(["/repo-b"]);
    expect(state.isCommitAll).toBe(false);
    expect(state.rootsToCommit).toEqual(["/repo-a"]);

    const commitAllState = syncCommitInclusionState(createCommitInclusionState(), buildCommitInclusionItems([
      { path: "pkg-a/a.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "pkg-b/b.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-b" },
    ]), "default");

    expect(commitAllState.isCommitAll).toBe(true);
    expect(commitAllState.includedRepoRoots).toEqual(["/repo-a", "/repo-b"]);
    expect(commitAllState.rootsToCommit).toEqual(["/repo-a", "/repo-b"]);
  });

  it("关闭 commit-all 开关后，只有 changed root 时也不应进入全部提交语义", () => {
    const state = syncCommitInclusionState(createCommitInclusionState(false), buildCommitInclusionItems([
      { path: "pkg-a/a.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-a" },
      { path: "pkg-b/b.ts", x: "M", y: ".", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已修改", changeListId: "default", repositoryRoot: "/repo-b" },
    ]), "default");

    expect(state.commitAllEnabled).toBe(false);
    expect(state.stagedRepoRoots).toEqual([]);
    expect(state.changedRepoRoots).toEqual(["/repo-a", "/repo-b"]);
    expect(state.isCommitAll).toBe(false);
    expect(state.includedRepoRoots).toEqual([]);
    expect(state.rootsToCommit).toEqual([]);
  });

  it("刷新后 inclusion 语义未变化时应复用旧对象，避免提交面板进入重复渲染", () => {
    const items = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    const state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    const refreshed = syncCommitInclusionState(state, items, "default");
    expect(isSameCommitInclusionState(state, refreshed)).toBe(true);
    expect(refreshed).toBe(state);
  });

  it("用户显式全选活动 changelist 后，刷新应自动纳入该列表新增 change", () => {
    const firstItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), firstItems, "default");
    state = setCommitInclusionForItemIds(state, firstItems.map((item) => item.id), true);

    const nextItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    state = syncCommitInclusionState(state, nextItems, "default");
    expect(state.includedIds).toEqual(nextItems.map((item) => item.id));
  });

  it("刷新后应保留显式排除状态，并且不自动纳入后续新增 change", () => {
    const firstItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), firstItems, "default");
    state = setCommitInclusionForItemIds(state, firstItems.map((item) => item.id), true);
    state = setCommitInclusionForItemIds(state, [firstItems[1]!.id], false);

    const nextItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "c.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    state = syncCommitInclusionState(state, nextItems, "default");

    const check = getCommitInclusionCheckState(state, nextItems.map((item) => item.id));
    expect(state.includedIds).toContain(nextItems[0]!.id);
    expect(state.includedIds).not.toContain(nextItems[1]!.id);
    expect(state.includedIds).not.toContain(nextItems[2]!.id);
    expect(check.partial).toBe(true);
  });

  it("目录节点三态复选框应根据 inclusion 项实时收敛", () => {
    const items = buildCommitInclusionItems([
      { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    state = setCommitInclusionForItemIds(state, items.map((item) => item.id), true);
    state = setCommitInclusionForItemIds(state, [items[1]!.id], false);
    const partial = getCommitInclusionCheckState(state, items.map((item) => item.id));
    expect(partial.allChecked).toBe(false);
    expect(partial.partial).toBe(true);

    state = setCommitInclusionForItemIds(state, items.map((item) => item.id), true);
    const allChecked = getCommitInclusionCheckState(state, items.map((item) => item.id));
    expect(allChecked.allChecked).toBe(true);
    expect(allChecked.partial).toBe(false);
  });

  it("用户已手动清空 inclusion 后，刷新不应重新自动纳入新文件", () => {
    const firstItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), firstItems, "default");
    state = setCommitInclusionForItemIds(state, [firstItems[0]!.id], true);
    state = setCommitInclusionForItemIds(state, [firstItems[0]!.id], false);

    const nextItems = buildCommitInclusionItems([
      { path: "a.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "b.txt", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
    ]);
    state = syncCommitInclusionState(state, nextItems, "default");
    expect(state.includedIds).toEqual([]);
  });

  it("激活提交流程且没有显式 selection 时，应按活动 changelist 重建 included changes，并保留 resolved conflict", () => {
    const items = buildCommitInclusionItems([
      { path: "resolved.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "feature", conflictState: "resolved" },
      { path: "default-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "default-b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "feature-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
      { path: "new-file.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
    ]);

    const state = resolveCommitActivationInclusionState({
      items,
      activeChangeListId: "default",
    });

    expect(state.includedIds).toEqual([
      items[0]!.id,
      items[1]!.id,
      items[2]!.id,
    ]);
    expect(state.userTouched).toBe(true);
  });

  it("激活提交流程且存在显式 selected changes/unversioned 时，应只纳入显式选中项并保留 resolved conflict", () => {
    const selectedEntries = [
      { path: "feature-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
      { path: "new-file.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
    ];
    const items = buildCommitInclusionItems([
      { path: "resolved.txt", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "default", conflictState: "resolved" },
      { path: "default-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      ...selectedEntries,
    ]);

    const state = resolveCommitActivationInclusionState({
      items,
      activeChangeListId: "default",
      selectedEntries,
      selectedChangeListIds: ["feature", "default"],
    });

    expect(state.includedIds).toEqual([
      items[0]!.id,
      items[2]!.id,
      items[3]!.id,
    ]);
  });

  it("激活提交流程且选中 changelist 组头时，应纳入该 changelist 全部 tracked changes", () => {
    const items = buildCommitInclusionItems([
      { path: "default-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "default-b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "feature-a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "feature" },
      { path: "feature-b.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "feature" },
    ]);

    const state = resolveCommitActivationInclusionState({
      items,
      activeChangeListId: "default",
      selectedChangeListIds: ["feature"],
    });

    expect(state.includedIds).toEqual([items[2]!.id]);
  });

  it("empty changelist、ignored、conflict、resolved-conflict 均不应显示显式 inclusion checkbox", () => {
    expect(isCommitGroupInclusionVisible({
      kind: "changelist",
      entries: [],
    } as any)).toBe(false);
    expect(isCommitGroupInclusionVisible({
      kind: "ignored",
      entries: [{ path: "dist/app.js" }],
    } as any)).toBe(false);
    expect(isCommitGroupInclusionVisible({
      kind: "unversioned",
      entries: [{ path: "src/new.ts" }],
    } as any)).toBe(true);
    expect(isCommitGroupInclusionVisible({
      kind: "conflict",
      entries: [{ path: "src/conflict.ts" }],
    } as any)).toBe(false);
    expect(isCommitGroupInclusionVisible({
      kind: "resolved-conflict",
      entries: [{ path: "src/resolved.ts" }],
    } as any)).toBe(false);
  });

  it("节点标记为 hide checkbox 时不应渲染 inclusion", () => {
    expect(isCommitNodeInclusionVisible({
      isFile: true,
      filePaths: ["src/a.ts"],
      selectionFlags: {
        selectable: true,
        inclusionVisible: true,
        inclusionEnabled: true,
        hideInclusionCheckbox: true,
        helper: false,
      },
    } as any)).toBe(false);
  });

  it("Space toggle 应在存在任一未选项时整体纳入，否则整体排除", () => {
    const items = buildCommitInclusionItems([
      { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "src/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    let state = syncCommitInclusionState(createCommitInclusionState(), items, "default");
    state = setCommitInclusionForItemIds(state, [items[1]!.id], false);
    state = toggleCommitInclusionForItemIds(state, items.map((item) => item.id));
    expect(state.includedIds).toEqual(items.map((item) => item.id));
    state = toggleCommitInclusionForItemIds(state, items.map((item) => item.id));
    expect(state.includedIds).toEqual([]);
  });
});
