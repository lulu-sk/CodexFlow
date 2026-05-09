// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { CommitTreePane } from "./commit-tree-pane";
import type { CommitInclusionState, CommitTreeGroup, CommitTreeNodeAction } from "./types";
import type { GitStatusEntry } from "../types";
import { buildCommitInclusionItemId, createCommitInclusionState } from "./inclusion-model";

/**
 * 启用 React 18 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建一个挂载根节点，供 jsdom 下渲染提交面板组件。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      try {
        act(() => {
          root.unmount();
        });
      } catch {
        try { root.unmount(); } catch {}
      }
      try { host.remove(); } catch {}
    },
  };
}

/**
 * 构建最小提交树分组输入，便于组件行为测试。
 */
function createGroup(input: Partial<CommitTreeGroup> & Pick<CommitTreeGroup, "key" | "label" | "entries" | "kind">): CommitTreeGroup {
  return {
    showHeader: true,
    helper: false,
    changeListId: undefined,
    treeNodes: [],
    treeRows: [],
    ...input,
  };
}

/**
 * 构建文件状态条目，避免每个用例手写重复字段。
 */
function createEntry(input: Partial<GitStatusEntry> & Pick<GitStatusEntry, "path">): GitStatusEntry {
  return {
    oldPath: undefined,
    x: "M",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "已暂存",
    changeListId: "default",
    ...input,
  };
}

/**
 * 等待一个 animation frame，确保 speed search 输入框的自动聚焦副作用已完成。
 */
async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

/**
 * 基于状态条目构造最小 inclusion state，确保测试里的 item id 与组件真实解析规则一致。
 */
function createTestInclusionState(entries: GitStatusEntry[], includedEntryPaths: string[] = []): CommitInclusionState {
  const itemsById: CommitInclusionState["itemsById"] = {};
  const includedIds: string[] = [];
  for (const entry of entries) {
    if (entry.ignored) continue;
    const itemId = buildCommitInclusionItemId(entry);
    itemsById[itemId] = {
      id: itemId,
      path: entry.path,
      oldPath: entry.oldPath,
      kind: entry.untracked ? "unversioned" : "change",
      changeListId: entry.changeListId || "default",
      repoRoot: entry.repositoryRoot,
      staged: entry.staged,
      tracked: !entry.untracked,
      conflictState: entry.conflictState,
    };
    if (includedEntryPaths.includes(entry.path))
      includedIds.push(itemId);
  }
  return {
    ...createCommitInclusionState(),
    includedIds,
    userTouched: includedIds.length > 0,
    itemsById,
  };
}

/**
 * 按测试输入渲染 CommitTreePane，并补齐最小空实现回调。
 */
function renderCommitTreePane(input: {
  groups: CommitTreeGroup[];
  inclusionState?: CommitInclusionState;
  statusEntryByPath?: Map<string, GitStatusEntry>;
  statusEntriesByPath?: Map<string, GitStatusEntry[]>;
  selectedRowKeys?: string[];
  selectedNodeKeys?: string[];
  selectedPaths?: string[];
  selectedDiffableEntry?: GitStatusEntry | null;
  groupExpanded?: Record<string, boolean>;
  treeExpanded?: Record<string, boolean>;
  activeChangeListId?: string;
  localChangesConfig?: { stagingAreaEnabled: boolean; changeListsEnabled: boolean };
  onInvokeEntryAction?: (entry: GitStatusEntry, intent: "doubleClick" | "f4" | "enter" | "singleClick") => void;
  onInvokeHoverAction?: (node: any, action: CommitTreeNodeAction) => void;
  onMoveFilesToChangeList?: (paths: string[], targetListId: string) => Promise<void>;
  onPerformStageOperation?: (entries: GitStatusEntry[], action: "stage" | "unstage") => Promise<void>;
  onBrowseGroup?: (group: CommitTreeGroup) => void;
  onIgnorePaths?: (paths: string[], anchor?: { x: number; y: number }) => void;
  onApplyNodeSelection?: (rowKeys: string[]) => void;
  onResolveConflictGroup?: (group: CommitTreeGroup) => void;
}): { cleanup: () => void; host: HTMLDivElement } {
  const mounted = createMountedRoot();
  const containerRef = React.createRef<HTMLDivElement>();
  const statusEntryByPath = input.statusEntryByPath || new Map<string, GitStatusEntry>();
  const statusEntriesByPath = input.statusEntriesByPath || new Map(Array.from(statusEntryByPath.entries()).map(([key, entry]) => [key, [entry]]));
  const inclusionState = input.inclusionState || createCommitInclusionState();
  act(() => {
    mounted.root.render(
      <CommitTreePane
        groups={input.groups}
        inclusionState={inclusionState}
        statusEntryByPath={statusEntryByPath}
        statusEntriesByPath={statusEntriesByPath}
        selectedRowKeys={input.selectedRowKeys || (input.selectedNodeKeys || []).map((nodeKey) => `node:${nodeKey}`)}
        selectedPaths={input.selectedPaths || []}
        groupExpanded={input.groupExpanded || {}}
        treeExpanded={input.treeExpanded || {}}
        localChangesConfig={input.localChangesConfig || { stagingAreaEnabled: false, changeListsEnabled: true }}
        activeChangeListId={input.activeChangeListId || "default"}
        selectedDiffableEntry={input.selectedDiffableEntry}
        ignoredLoading={false}
        containerRef={containerRef}
        onActivate={() => {}}
        onSelectRow={() => {}}
        onApplyTreeSelection={input.onApplyNodeSelection || (() => {})}
        onInvokeEntryAction={input.onInvokeEntryAction || (() => {})}
        onInvokeHoverAction={input.onInvokeHoverAction || (() => {})}
        onResolveConflictGroup={input.onResolveConflictGroup || (() => {})}
        onBrowseGroup={input.onBrowseGroup || (() => {})}
        onIgnorePaths={input.onIgnorePaths || (() => {})}
        onPerformStageOperation={input.onPerformStageOperation || (async () => {})}
        onToggleGroupExpanded={() => {}}
        onToggleTreeExpanded={() => {}}
        onToggleInclusion={() => {}}
        onOpenContextMenu={() => {}}
        onMoveFilesToChangeList={input.onMoveFilesToChangeList || (async () => {})}
        resolveStatusToneClassName={() => ""}
      />,
    );
  });
  return {
    cleanup: mounted.unmount,
    host: mounted.host,
  };
}

describe("CommitTreePane", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("应展示空 changelist，并标记当前活动列表", () => {
    const groups = [
      createGroup({
        key: "cl:feature",
        label: "功能A",
        entries: [],
        kind: "changelist",
        changeListId: "feature",
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      activeChangeListId: "feature",
    });
    cleanup = rendered.cleanup;
    expect(rendered.host.textContent).toContain("功能A");
    expect(rendered.host.textContent).toContain("活动");
  });

  it("ignored helper node 不应渲染 inclusion checkbox", () => {
    const groups = [
      createGroup({
        key: "special:ignored",
        label: "已忽略文件",
        entries: [createEntry({ path: "dist/app.js", ignored: true, staged: false, unstaged: false, statusText: "已忽略", changeListId: "" })],
        kind: "ignored",
      }),
    ];
    const rendered = renderCommitTreePane({ groups });
    cleanup = rendered.cleanup;
    expect(rendered.host.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("默认选中 group 头时，空格应按 group subtree 切换 inclusion", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const onToggleInclusion = vi.fn();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const containerRef = React.createRef<HTMLDivElement>();
    act(() => {
      mounted.root.render(
        <CommitTreePane
          groups={[
            createGroup({
              key: "cl:default",
              label: "默认",
              entries: [entry],
              kind: "changelist",
              changeListId: "default",
            }),
          ]}
          inclusionState={createTestInclusionState([entry])}
          statusEntryByPath={new Map([["src/app.ts", entry]])}
          statusEntriesByPath={new Map([["src/app.ts", [entry]]])}
          selectedRowKeys={["group:cl:default"]}
          selectedPaths={["src/app.ts"]}
          groupExpanded={{}}
          treeExpanded={{}}
          localChangesConfig={{ stagingAreaEnabled: false, changeListsEnabled: true }}
          activeChangeListId="default"
          ignoredLoading={false}
          containerRef={containerRef}
          onActivate={() => {}}
          onSelectRow={() => {}}
          onApplyTreeSelection={() => {}}
          onInvokeEntryAction={() => {}}
          onInvokeHoverAction={() => {}}
          onResolveConflictGroup={() => {}}
          onBrowseGroup={() => {}}
          onIgnorePaths={() => {}}
          onPerformStageOperation={async () => {}}
          onToggleGroupExpanded={() => {}}
          onToggleTreeExpanded={() => {}}
          onToggleInclusion={onToggleInclusion}
          onOpenContextMenu={() => {}}
          onMoveFilesToChangeList={async () => {}}
          resolveStatusToneClassName={() => ""}
        />,
      );
    });
    const treeRoot = mounted.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onToggleInclusion).toHaveBeenCalledWith([buildCommitInclusionItemId(entry)], true, []);
  });

  it("空选区按 Space 时应作用于整棵树，而不是伪造 focused row", async () => {
    const entryA = createEntry({ path: "src/a.ts" });
    const entryB = createEntry({ path: "src/b.ts" });
    const onToggleInclusion = vi.fn();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const containerRef = React.createRef<HTMLDivElement>();
    act(() => {
      mounted.root.render(
        <CommitTreePane
          groups={[
            createGroup({
              key: "cl:default",
              label: "默认",
              entries: [entryA, entryB],
              kind: "changelist",
              changeListId: "default",
              treeNodes: [
                { key: "node:a", name: "a.ts", fullPath: "src/a.ts", isFile: true, count: 1, filePaths: ["src/a.ts"], entry: entryA, kind: "file", children: [] },
                { key: "node:b", name: "b.ts", fullPath: "src/b.ts", isFile: true, count: 1, filePaths: ["src/b.ts"], entry: entryB, kind: "file", children: [] },
              ],
              treeRows: [
                { node: { key: "node:a", name: "a.ts", fullPath: "src/a.ts", isFile: true, count: 1, filePaths: ["src/a.ts"], entry: entryA, kind: "file", children: [] }, depth: 0 },
                { node: { key: "node:b", name: "b.ts", fullPath: "src/b.ts", isFile: true, count: 1, filePaths: ["src/b.ts"], entry: entryB, kind: "file", children: [] }, depth: 0 },
              ],
            }),
          ]}
          inclusionState={createTestInclusionState([entryA, entryB])}
          statusEntryByPath={new Map([["src/a.ts", entryA], ["src/b.ts", entryB]])}
          statusEntriesByPath={new Map([["src/a.ts", [entryA]], ["src/b.ts", [entryB]]])}
          selectedRowKeys={[]}
          selectedPaths={[]}
          groupExpanded={{}}
          treeExpanded={{}}
          localChangesConfig={{ stagingAreaEnabled: false, changeListsEnabled: true }}
          activeChangeListId="default"
          ignoredLoading={false}
          containerRef={containerRef}
          onActivate={() => {}}
          onSelectRow={() => {}}
          onApplyTreeSelection={() => {}}
          onInvokeEntryAction={() => {}}
          onInvokeHoverAction={() => {}}
          onResolveConflictGroup={() => {}}
          onBrowseGroup={() => {}}
          onIgnorePaths={() => {}}
          onPerformStageOperation={async () => {}}
          onToggleGroupExpanded={() => {}}
          onToggleTreeExpanded={() => {}}
          onToggleInclusion={onToggleInclusion}
          onOpenContextMenu={() => {}}
          onMoveFilesToChangeList={async () => {}}
          resolveStatusToneClassName={() => ""}
        />,
      );
    });
    const treeRoot = mounted.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onToggleInclusion).toHaveBeenCalledWith([buildCommitInclusionItemId(entryA), buildCommitInclusionItemId(entryB)], true, []);
  });

  it("speed search 浮层应固定在滚动容器外，避免随列表滚动消失", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "默认",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["src/app.ts", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]');
    expect(treeRoot).not.toBeNull();
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      await flushAnimationFrame();
    });
    const searchOverlay = rendered.host.querySelector('[data-testid="commit-tree-speed-search"]');
    const searchInput = rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]') as HTMLInputElement | null;
    expect(searchOverlay).not.toBeNull();
    expect(searchInput).not.toBeNull();
    expect(searchOverlay?.className).toContain("left-3");
    expect(searchOverlay?.className).not.toContain("right-3");
    expect(searchInput?.value).toBe("a");
    expect(treeRoot?.contains(searchOverlay as Node)).toBe(false);
  });

  it("鼠标按下提交树后应把焦点收回滚动容器，保证后续字符键和 Ctrl+F 可用", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "默认",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["src/app.ts", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]') as HTMLDivElement | null;
    expect(treeRoot).not.toBeNull();
    await act(async () => {
      treeRoot?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.activeElement).toBe(treeRoot);
  });

  it("Ctrl+F 打开 speed search 后应聚焦真实输入框并支持直接改值", async () => {
    const entry = createEntry({ path: "Font_cjkFonts_Medium_FontAssets.asset" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "FontChanges",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["Font_cjkFonts_Medium_FontAssets.asset", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      await flushAnimationFrame();
    });
    const searchInput = rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);
    await act(async () => {
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(searchInput, "Font");
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(searchInput?.value).toBe("Font");
    expect(rendered.host.querySelectorAll(".cf-git-speed-search-hit").length).toBeGreaterThan(0);
  });

  it("提交树焦点切换到 speed search 输入框时不应立即关闭搜索浮层", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "默认",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["src/app.ts", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]') as HTMLDivElement | null;
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      await flushAnimationFrame();
    });
    const searchInput = rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    await act(async () => {
      treeRoot?.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: searchInput }));
    });
    expect(rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]')).not.toBeNull();
  });

  it("speed search 命中片段应在树节点内高亮显示", async () => {
    const entry = createEntry({ path: "Font_cjkFonts_Medium_FontAssets.asset" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "FontChanges",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["Font_cjkFonts_Medium_FontAssets.asset", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    });
    expect(rendered.host.querySelectorAll(".cf-git-speed-search-hit").length).toBeGreaterThan(0);
  });

  it("按下 Escape 后应关闭并清空 speed search", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "alpha",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["src/app.ts", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(rendered.host.querySelector('[data-testid="commit-tree-speed-search"]')).toBeNull();
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      await flushAnimationFrame();
    });
    const reopenedInput = rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]') as HTMLInputElement | null;
    expect(reopenedInput).not.toBeNull();
    expect(reopenedInput?.value).toBe("");
  });

  it("点击提交面板外部后应关闭并清空 speed search", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "alpha",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      statusEntryByPath: new Map([["src/app.ts", entry]]),
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[data-testid="commit-tree-scroll"]');
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      await act(async () => {
        treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      });
      await act(async () => {
        outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(rendered.host.querySelector('[data-testid="commit-tree-speed-search"]')).toBeNull();
      await act(async () => {
        treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
        await flushAnimationFrame();
      });
      const reopenedInput = rendered.host.querySelector('[data-testid="commit-tree-speed-search-input"]') as HTMLInputElement | null;
      expect(reopenedInput).not.toBeNull();
      expect(reopenedInput?.value).toBe("");
    } finally {
      outside.remove();
    }
  });

  it("Enter 在 group 头选中时应走 selectedDiffable 语义", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const onInvokeEntryAction = vi.fn();
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "默认",
          entries: [entry],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      selectedRowKeys: ["group:cl:default"],
      selectedPaths: ["src/app.ts"],
      selectedDiffableEntry: entry,
      onInvokeEntryAction,
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvokeEntryAction).toHaveBeenCalledWith(entry, "enter");
  });

  it("Ctrl+C 在空选区时不应伪造 focused row 结果", async () => {
    const copyText = vi.fn(async () => ({ ok: true }));
    const previousHost = (window as any).host;
    (window as any).host = {
      utils: {
        copyText,
      },
    };
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "cl:default",
          label: "默认",
          entries: [createEntry({ path: "src/app.ts" })],
          kind: "changelist",
          changeListId: "default",
        }),
      ],
      selectedRowKeys: [],
      selectedPaths: [],
    });
    cleanup = () => {
      rendered.cleanup();
      (window as any).host = previousHost;
    };
    const treeRoot = rendered.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    });
    expect(copyText).not.toHaveBeenCalled();
  });

  it("conflict group 头应提供 Resolve 入口", async () => {
    const entry = createEntry({ path: "src/conflict.ts", conflictState: "conflict", x: "U", y: "U", staged: true, unstaged: true, statusText: "冲突" });
    const onResolveConflictGroup = vi.fn();
    const rendered = renderCommitTreePane({
      groups: [
        createGroup({
          key: "special:conflicts",
          label: "冲突",
          entries: [entry],
          kind: "conflict",
        }),
      ],
      onResolveConflictGroup,
    });
    cleanup = rendered.cleanup;
    const button = Array.from(rendered.host.querySelectorAll("button")).find((node) => node.textContent?.includes("解决"));
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onResolveConflictGroup).toHaveBeenCalledWith(expect.objectContaining({ key: "special:conflicts" }));
  });

  it("group row 双击应切换展开收起", async () => {
    const onApplyNodeSelection = vi.fn();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const containerRef = React.createRef<HTMLDivElement>();
    act(() => {
      mounted.root.render(
        <CommitTreePane
          groups={[
            createGroup({
              key: "cl:default",
              label: "默认",
              entries: [createEntry({ path: "src/app.ts" })],
              kind: "changelist",
              changeListId: "default",
            }),
          ]}
          inclusionState={createCommitInclusionState()}
          statusEntryByPath={new Map()}
          statusEntriesByPath={new Map()}
          selectedRowKeys={[]}
          selectedPaths={[]}
          groupExpanded={{}}
          treeExpanded={{}}
          localChangesConfig={{ stagingAreaEnabled: false, changeListsEnabled: true }}
          activeChangeListId="default"
          ignoredLoading={false}
          containerRef={containerRef}
          onActivate={() => {}}
          onSelectRow={() => {}}
          onApplyTreeSelection={onApplyNodeSelection}
          onInvokeEntryAction={() => {}}
          onInvokeHoverAction={() => {}}
          onResolveConflictGroup={() => {}}
          onBrowseGroup={() => {}}
          onIgnorePaths={() => {}}
          onPerformStageOperation={async () => {}}
          onToggleGroupExpanded={onApplyNodeSelection}
          onToggleTreeExpanded={() => {}}
          onToggleInclusion={() => {}}
          onOpenContextMenu={() => {}}
          onMoveFilesToChangeList={async () => {}}
          resolveStatusToneClassName={() => ""}
        />,
      );
    });
    const groupRow = mounted.host.querySelector('[data-testid="commit-group-cl:default"]');
    await act(async () => {
      groupRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onApplyNodeSelection).toHaveBeenCalledWith("cl:default");
  });

  it("双击文件节点应走统一动作派发，而不是直接写死打开源文件", async () => {
    const entry = createEntry({ path: "src/app.ts" });
    const onInvokeEntryAction = vi.fn();
    const groups = [
      createGroup({
        key: "cl:default",
        label: "默认",
        entries: [entry],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "node:app",
          name: "app.ts",
          fullPath: "src/app.ts",
          isFile: true,
          count: 1,
          filePaths: ["src/app.ts"],
          entry,
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:app",
            name: "app.ts",
            fullPath: "src/app.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/app.ts"],
            entry,
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/app.ts", entry]]),
      onInvokeEntryAction,
    });
    cleanup = rendered.cleanup;
    const rerenderedNode = rendered.host.querySelector('[data-testid="commit-node-node:app"]');
    await act(async () => {
      rerenderedNode?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onInvokeEntryAction).toHaveBeenCalledWith(entry, "doubleClick");
  });

  it("拖拽已选节点到 changelist 头部时，应把选中路径投放到目标列表", async () => {
    const entry = createEntry({ path: "src/a.ts" });
    const onMoveFilesToChangeList = vi.fn(async () => {});
    const groups = [
      createGroup({
        key: "cl:target",
        label: "目标",
        entries: [],
        kind: "changelist",
        changeListId: "target",
      }),
      createGroup({
        key: "cl:default",
        label: "默认",
        entries: [entry],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "node:a",
          name: "a.ts",
          fullPath: "src/a.ts",
          isFile: true,
          count: 1,
          filePaths: ["src/a.ts"],
          entry,
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:a",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry,
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/a.ts", entry]]),
      selectedNodeKeys: ["node:a"],
      selectedPaths: ["src/a.ts"],
      onMoveFilesToChangeList,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:a"]');
    const targetGroup = rendered.host.querySelector('[data-testid="commit-group-cl:target"]');
    expect(node).not.toBeNull();
    expect(targetGroup).not.toBeNull();
    await act(async () => {
      node?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      targetGroup?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      targetGroup?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(onMoveFilesToChangeList).toHaveBeenCalledWith(["src/a.ts"], "target");
  });

  it("staging 模式下拖拽未暂存节点到 staged 头部时，应走统一 stage 操作链路并保留 repoRoot", async () => {
    const stagedEntry = createEntry({
      path: "src/already-staged.ts",
      repositoryRoot: "repo-a",
    });
    const entry = createEntry({
      path: "src/a.ts",
      x: ".",
      y: "M",
      staged: false,
      unstaged: true,
      statusText: "未暂存",
      repositoryRoot: "repo-a",
    });
    const onPerformStageOperation = vi.fn(async () => {});
    const groups = [
      createGroup({
        key: "staging:staged",
        label: "已暂存",
        entries: [stagedEntry],
        kind: "staged",
      }),
      createGroup({
        key: "staging:unstaged",
        label: "未暂存",
        entries: [entry],
        kind: "unstaged",
        treeNodes: [{
          key: "node:unstaged",
          name: "a.ts",
          fullPath: "src/a.ts",
          isFile: true,
          count: 1,
          filePaths: ["src/a.ts"],
          entry,
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:unstaged",
            name: "a.ts",
            fullPath: "src/a.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/a.ts"],
            entry,
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/a.ts", entry], ["src/already-staged.ts", stagedEntry]]),
      statusEntriesByPath: new Map([["src/a.ts", [entry]], ["src/already-staged.ts", [stagedEntry]]]),
      selectedNodeKeys: ["node:unstaged"],
      selectedPaths: ["src/a.ts"],
      localChangesConfig: { stagingAreaEnabled: true, changeListsEnabled: false },
      onPerformStageOperation,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:unstaged"]');
    const stagedGroup = rendered.host.querySelector('[data-testid="commit-group-staging:staged"]');
    await act(async () => {
      node?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      stagedGroup?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      stagedGroup?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(onPerformStageOperation).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "src/a.ts", repositoryRoot: "repo-a" })],
      "stage",
    );
  });

  it("拖拽未跟踪文件到 ignored special node 时，应走 ignore 目标选择链路", async () => {
    const entry = createEntry({ path: "new.txt", untracked: true, staged: false, unstaged: true, statusText: "未跟踪", changeListId: "" });
    const onIgnorePaths = vi.fn();
    const groups = [
      createGroup({
        key: "special:ignored",
        label: "已忽略文件",
        entries: [createEntry({ path: "dist/existing.log", ignored: true, staged: false, unstaged: false, statusText: "已忽略", changeListId: "" })],
        kind: "ignored",
      }),
      createGroup({
        key: "special:unversioned",
        label: "未跟踪文件",
        entries: [entry],
        kind: "unversioned",
        treeNodes: [{
          key: "node:new",
          name: "new.txt",
          fullPath: "new.txt",
          isFile: true,
          count: 1,
          filePaths: ["new.txt"],
          entry,
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:new",
            name: "new.txt",
            fullPath: "new.txt",
            isFile: true,
            count: 1,
            filePaths: ["new.txt"],
            entry,
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["new.txt", entry]]),
      selectedNodeKeys: ["node:new"],
      selectedPaths: ["new.txt"],
      onIgnorePaths,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:new"]');
    const ignoredGroup = rendered.host.querySelector('[data-testid="commit-group-special:ignored"]');
    await act(async () => {
      node?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      ignoredGroup?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      ignoredGroup?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(onIgnorePaths).toHaveBeenCalledWith(["new.txt"], undefined);
  });

  it("拖拽已跟踪文件到 ignored special node 时，不应误触发 ignore 目标链路", async () => {
    const entry = createEntry({ path: "src/tracked.ts" });
    const onIgnorePaths = vi.fn();
    const groups = [
      createGroup({
        key: "special:ignored",
        label: "已忽略文件",
        entries: [createEntry({ path: "dist/existing.log", ignored: true, staged: false, unstaged: false, statusText: "已忽略", changeListId: "" })],
        kind: "ignored",
      }),
      createGroup({
        key: "cl:default",
        label: "默认",
        entries: [entry],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [{
          key: "node:tracked",
          name: "tracked.ts",
          fullPath: "src/tracked.ts",
          isFile: true,
          count: 1,
          filePaths: ["src/tracked.ts"],
          entry,
          kind: "file",
          children: [],
        }],
        treeRows: [{
          node: {
            key: "node:tracked",
            name: "tracked.ts",
            fullPath: "src/tracked.ts",
            isFile: true,
            count: 1,
            filePaths: ["src/tracked.ts"],
            entry,
            kind: "file",
            children: [],
          },
          depth: 0,
        }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/tracked.ts", entry]]),
      selectedNodeKeys: ["node:tracked"],
      selectedPaths: ["src/tracked.ts"],
      onIgnorePaths,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:tracked"]');
    const ignoredGroup = rendered.host.querySelector('[data-testid="commit-group-special:ignored"]');
    await act(async () => {
      node?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      ignoredGroup?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      ignoredGroup?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(onIgnorePaths).not.toHaveBeenCalled();
  });

  it("文件节点不应再渲染状态标签，目录节点仍应显示文件计数", () => {
    const fileEntry = createEntry({ path: "Client/Assets/Default Local Group.asset", statusText: "已修改" });
    const fileNode = {
      key: "node:file",
      name: "Default Local Group.asset",
      fullPath: "Client/Assets/Default Local Group.asset",
      isFile: true,
      count: 1,
      fileCount: 1,
      filePaths: ["Client/Assets/Default Local Group.asset"],
      entry: fileEntry,
      kind: "file" as const,
      children: [],
    };
    const repositoryNode = {
      key: "node:repo",
      name: "ExampleRepo",
      fullPath: "",
      isFile: false,
      count: 45,
      fileCount: 45,
      filePaths: ["Client/Assets/Default Local Group.asset"],
      kind: "repository" as const,
      textPresentation: "ExampleRepo",
      children: [fileNode],
    };
    const groups = [
      createGroup({
        key: "cl:default",
        label: "默认",
        entries: [fileEntry],
        kind: "changelist",
        treeNodes: [repositoryNode],
        treeRows: [
          { node: repositoryNode, depth: 0 },
          { node: fileNode, depth: 1 },
        ],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["Client/Assets/Default Local Group.asset", fileEntry]]),
      selectedNodeKeys: ["node:file"],
      selectedPaths: ["Client/Assets/Default Local Group.asset"],
    });
    cleanup = rendered.cleanup;
    expect(rendered.host.textContent || "").toContain("ExampleRepo");
    expect(rendered.host.textContent || "").toContain("45 个文件");
    expect(rendered.host.textContent || "").toContain("Default Local Group.asset");
    expect(rendered.host.textContent || "").not.toContain("已修改");
  });

  it("special node 超过 many files 阈值时，应展示浏览入口而不是展开子节点", async () => {
    const onBrowseGroup = vi.fn();
    const groups = [
      createGroup({
        key: "special:ignored",
        label: "已忽略文件",
        entries: [createEntry({ path: "dist/a.txt", ignored: true, statusText: "已忽略", changeListId: "" })],
        kind: "ignored",
        manyFiles: true,
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      onBrowseGroup,
    });
    cleanup = rendered.cleanup;
    expect(rendered.host.textContent).toContain("浏览");
    expect(rendered.host.querySelector('[data-testid^="commit-node-"]')).toBeNull();
    const browse = Array.from(rendered.host.querySelectorAll("button")).find((node) => node.textContent?.includes("浏览"));
    await act(async () => {
      browse?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBrowseGroup).toHaveBeenCalledTimes(1);
  });

  it("hover action 应优先于默认双击打开链路", async () => {
    const entry = createEntry({ path: "src/conflict.ts", conflictState: "conflict", x: "U", y: "U", unstaged: true, statusText: "冲突" });
    const onInvokeEntryAction = vi.fn();
    const onInvokeHoverAction = vi.fn();
    const conflictNode = {
      key: "node:conflict",
      name: "conflict.ts",
      fullPath: "src/conflict.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/conflict.ts"],
      entry,
      kind: "file" as const,
      children: [],
      hoverAction: {
        id: "node:conflict:hover",
        iconLabel: "差异",
        tooltip: "显示冲突差异",
        action: "show-diff" as const,
      },
      openHandler: { action: "show-diff" as const },
    };
    const groups = [
      createGroup({
        key: "special:conflicts",
        label: "冲突",
        entries: [entry],
        kind: "conflict",
        treeNodes: [conflictNode],
        treeRows: [{ node: conflictNode, depth: 0 }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/conflict.ts", entry]]),
      selectedNodeKeys: ["node:conflict"],
      selectedPaths: ["src/conflict.ts"],
      onInvokeEntryAction,
      onInvokeHoverAction,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:conflict"]');
    await act(async () => {
      node?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onInvokeHoverAction).toHaveBeenCalledWith(expect.objectContaining({ key: "node:conflict" }), "show-diff");
    expect(onInvokeEntryAction).not.toHaveBeenCalled();
  });

  it("Enter 应优先复用节点 openHandler，而不是直接回落到默认 entry 动作", async () => {
    const entry = createEntry({ path: "src/conflict.ts", conflictState: "conflict", x: "U", y: "U", unstaged: true, statusText: "冲突" });
    const onInvokeEntryAction = vi.fn();
    const onInvokeHoverAction = vi.fn();
    const conflictNode = {
      key: "node:conflict-enter",
      name: "conflict.ts",
      fullPath: "src/conflict.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/conflict.ts"],
      entry,
      kind: "file" as const,
      children: [],
      openHandler: { action: "open-merge" as const },
      hoverAction: {
        id: "node:conflict-enter:hover",
        iconLabel: "合并",
        tooltip: "打开 Merge 工具",
        action: "open-merge" as const,
      },
    };
    const groups = [
      createGroup({
        key: "special:conflicts",
        label: "冲突",
        entries: [entry],
        kind: "conflict",
        treeNodes: [conflictNode],
        treeRows: [{ node: conflictNode, depth: 0 }],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/conflict.ts", entry]]),
      selectedNodeKeys: ["node:conflict-enter"],
      selectedPaths: ["src/conflict.ts"],
      onInvokeEntryAction,
      onInvokeHoverAction,
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvokeHoverAction).toHaveBeenCalledWith(expect.objectContaining({ key: "node:conflict-enter" }), "open-merge");
    expect(onInvokeEntryAction).not.toHaveBeenCalled();
  });

  it("多选时双击不应走节点 openHandler，而应回落到默认文件动作", async () => {
    const entry = createEntry({ path: "src/conflict.ts", conflictState: "conflict", x: "U", y: "U", unstaged: true, statusText: "冲突" });
    const extraEntry = createEntry({ path: "src/other.ts" });
    const onInvokeEntryAction = vi.fn();
    const onInvokeHoverAction = vi.fn();
    const conflictNode = {
      key: "node:conflict-multi",
      name: "conflict.ts",
      fullPath: "src/conflict.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/conflict.ts"],
      entry,
      kind: "file" as const,
      children: [],
      openHandler: { action: "open-merge" as const },
    };
    const extraNode = {
      key: "node:other",
      name: "other.ts",
      fullPath: "src/other.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/other.ts"],
      entry: extraEntry,
      kind: "file" as const,
      children: [],
    };
    const groups = [
      createGroup({
        key: "special:conflicts",
        label: "冲突",
        entries: [entry, extraEntry],
        kind: "conflict",
        treeNodes: [conflictNode, extraNode],
        treeRows: [
          { node: conflictNode, depth: 0 },
          { node: extraNode, depth: 0 },
        ],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([
        ["src/conflict.ts", entry],
        ["src/other.ts", extraEntry],
      ]),
      selectedNodeKeys: ["node:conflict-multi", "node:other"],
      selectedPaths: ["src/conflict.ts", "src/other.ts"],
      onInvokeEntryAction,
      onInvokeHoverAction,
    });
    cleanup = rendered.cleanup;
    const node = rendered.host.querySelector('[data-testid="commit-node-node:conflict-multi"]');
    await act(async () => {
      node?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onInvokeHoverAction).not.toHaveBeenCalled();
    expect(onInvokeEntryAction).toHaveBeenCalledWith(entry, "doubleClick");
  });

  it("多选时 Enter 不应走节点 openHandler，而应回落到默认文件动作", async () => {
    const entry = createEntry({ path: "src/conflict.ts", conflictState: "conflict", x: "U", y: "U", unstaged: true, statusText: "冲突" });
    const extraEntry = createEntry({ path: "src/other.ts" });
    const onInvokeEntryAction = vi.fn();
    const onInvokeHoverAction = vi.fn();
    const conflictNode = {
      key: "node:conflict-enter-multi",
      name: "conflict.ts",
      fullPath: "src/conflict.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/conflict.ts"],
      entry,
      kind: "file" as const,
      children: [],
      openHandler: { action: "open-merge" as const },
    };
    const extraNode = {
      key: "node:other-enter",
      name: "other.ts",
      fullPath: "src/other.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/other.ts"],
      entry: extraEntry,
      kind: "file" as const,
      children: [],
    };
    const groups = [
      createGroup({
        key: "special:conflicts",
        label: "冲突",
        entries: [entry, extraEntry],
        kind: "conflict",
        treeNodes: [conflictNode, extraNode],
        treeRows: [
          { node: conflictNode, depth: 0 },
          { node: extraNode, depth: 0 },
        ],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([
        ["src/conflict.ts", entry],
        ["src/other.ts", extraEntry],
      ]),
      selectedNodeKeys: ["node:other-enter", "node:conflict-enter-multi"],
      selectedPaths: ["src/other.ts", "src/conflict.ts"],
      onInvokeEntryAction,
      onInvokeHoverAction,
    });
    cleanup = rendered.cleanup;
    const treeRoot = rendered.host.querySelector('[tabindex="0"]');
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onInvokeHoverAction).not.toHaveBeenCalled();
    expect(onInvokeEntryAction).toHaveBeenCalledWith(entry, "enter");
  });

  it("hover icon 应只以浮层形式出现在 hovered / lead 行，且点击命中区优先触发 hover action", async () => {
    const entryA = createEntry({ path: "src/a.ts" });
    const entryB = createEntry({ path: "src/b.ts" });
    const onInvokeEntryAction = vi.fn();
    const onInvokeHoverAction = vi.fn();
    const nodeA = {
      key: "node:hover-a",
      name: "a.ts",
      fullPath: "src/a.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/a.ts"],
      entry: entryA,
      kind: "file" as const,
      children: [],
      hoverAction: {
        id: "node:hover-a:hover",
        iconLabel: "差异",
        tooltip: "显示差异",
        action: "show-diff" as const,
      },
    };
    const nodeB = {
      key: "node:hover-b",
      name: "b.ts",
      fullPath: "src/b.ts",
      isFile: true,
      count: 1,
      filePaths: ["src/b.ts"],
      entry: entryB,
      kind: "file" as const,
      children: [],
      hoverAction: {
        id: "node:hover-b:hover",
        iconLabel: "差异",
        tooltip: "显示差异",
        action: "show-diff" as const,
      },
    };
    const groups = [
      createGroup({
        key: "cl:default",
        label: "默认",
        entries: [entryA, entryB],
        kind: "changelist",
        changeListId: "default",
        treeNodes: [nodeA, nodeB],
        treeRows: [
          { node: nodeA, depth: 0 },
          { node: nodeB, depth: 0 },
        ],
      }),
    ];
    const rendered = renderCommitTreePane({
      groups,
      statusEntryByPath: new Map([["src/a.ts", entryA], ["src/b.ts", entryB]]),
      selectedNodeKeys: ["node:hover-a"],
      selectedPaths: ["src/a.ts"],
      onInvokeEntryAction,
      onInvokeHoverAction,
    });
    cleanup = rendered.cleanup;

    expect(rendered.host.querySelector('[data-testid="commit-hover-action-node:hover-a"]')).not.toBeNull();
    expect(rendered.host.querySelector('[data-testid="commit-hover-action-node:hover-b"]')).toBeNull();

    const rowB = rendered.host.querySelector('[data-testid="commit-node-node:hover-b"]');
    await act(async () => {
      rowB?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const hoverButton = rendered.host.querySelector('[data-testid="commit-hover-action-node:hover-b"]');
    expect(hoverButton).not.toBeNull();
    expect(rendered.host.querySelector('[data-testid="commit-hover-action-node:hover-a"]')).toBeNull();

    await act(async () => {
      hoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvokeHoverAction).toHaveBeenCalledWith(expect.objectContaining({ key: "node:hover-b" }), "show-diff");
    expect(onInvokeEntryAction).not.toHaveBeenCalled();
  });
});
