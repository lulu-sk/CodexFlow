// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ConflictResolverDialog } from "./conflict-resolver-dialog";
import type { GitConflictMergeSessionSnapshot } from "../types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供冲突管理对话框在 jsdom 中渲染。
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
      } catch {}
      try {
        host.remove();
      } catch {}
    },
  };
}

/**
 * 按 data-testid 查找目标元素，缺失时直接抛错。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element data-testid=${id}`);
  return element as T;
}

/**
 * 按 data-testid 查找目标元素；缺失时返回 null，供存在性断言使用。
 */
function queryByTestId<T extends HTMLElement>(id: string): T | null {
  return document.querySelector(`[data-testid="${id}"]`) as T | null;
}

/**
 * 创建最小可用的 merge session 快照，供 manager UI 与选择逻辑测试复用。
 */
function createSnapshot(): GitConflictMergeSessionSnapshot {
  const unresolvedEntries: GitConflictMergeSessionSnapshot["unresolvedEntries"] = [
    {
      path: "src/a.ts",
      fileName: "a.ts",
      directoryPath: "src",
      conflictState: "unresolved",
      reverseSides: true,
      canOpenMerge: true,
      canOpenFile: true,
      oursState: "modified",
      theirsState: "modified",
      base: { label: "Base", available: true },
      ours: { label: "Theirs", available: true },
      theirs: { label: "Ours", available: true },
      working: { label: "结果", available: true },
    },
    {
      path: "src/b.ts",
      fileName: "b.ts",
      directoryPath: "src",
      conflictState: "unresolved",
      reverseSides: true,
      canOpenMerge: true,
      canOpenFile: true,
      oursState: "modified",
      theirsState: "modified",
      base: { label: "Base", available: true },
      ours: { label: "Theirs", available: true },
      theirs: { label: "Ours", available: true },
      working: { label: "结果", available: true },
    },
  ];
  const resolvedEntries: GitConflictMergeSessionSnapshot["resolvedEntries"] = [
    {
      path: "src/c.ts",
      fileName: "c.ts",
      directoryPath: "src",
      conflictState: "resolved",
      reverseSides: true,
      canOpenMerge: false,
      canOpenFile: true,
      oursState: "resolved",
      theirsState: "resolved",
      base: { label: "Base", available: false },
      ours: { label: "Theirs", available: false },
      theirs: { label: "Ours", available: false },
      working: { label: "结果", available: true },
    },
  ];
  return {
    reverseSides: true,
    labels: {
      base: "Base",
      ours: "Theirs",
      theirs: "Ours",
      working: "结果",
    },
    unresolvedCount: 2,
    resolvedCount: 1,
    unresolvedEntries,
    resolvedEntries,
    entries: [...unresolvedEntries, ...resolvedEntries],
    resolvedHolder: {
      source: "resolve-undo",
      operationState: "rebasing",
      inUpdate: false,
      paths: ["src/c.ts"],
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConflictResolverDialog", () => {
  it("应允许切换冲突文件并打开当前选中文件", async () => {
    const mounted = createMountedRoot();
    const onSelectPath = vi.fn();
    const onOpenSelected = vi.fn();
    const onTogglePath = vi.fn();
    const onToggleAll = vi.fn();
    const onSelectNext = vi.fn();
    const onApplySide = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <ConflictResolverDialog
            open={true}
            title="解决冲突"
            description="desc"
            snapshot={createSnapshot()}
            selectedPath="src/a.ts"
            checkedPaths={["src/a.ts"]}
            groupByDirectory={false}
            showResolved={true}
            operationState="rebasing"
            loading={false}
            submitting={null}
            applyingSide={null}
            onOpenChange={() => {}}
            onSelectPath={onSelectPath}
            onTogglePath={onTogglePath}
            onToggleAll={onToggleAll}
            onToggleGroupByDirectory={() => {}}
            onToggleShowResolved={() => {}}
            onOpenSelected={onOpenSelected}
            onRefresh={() => {}}
            onSelectNext={onSelectNext}
            onApplySide={onApplySide}
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-row-src/b.ts").click();
      });
      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-open-selected").click();
      });
      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-accept-ours").click();
        getByTestId<HTMLButtonElement>("conflict-resolver-next").click();
      });

      expect(onSelectPath).toHaveBeenCalledWith("src/b.ts");
      expect(onOpenSelected).toHaveBeenCalledTimes(1);
      expect(onApplySide).toHaveBeenCalledWith("ours");
      expect(onSelectNext).toHaveBeenCalledTimes(1);
      expect(getByTestId<HTMLButtonElement>("conflict-resolver-continue").disabled).toBe(true);
      expect(document.body.textContent).toContain("当前文件支持继续进入应用内合并");
    } finally {
      mounted.unmount();
    }
  });

  it("resolved 或 binary 条目主操作应退化为 Open，并保留外部 fallback 动作", async () => {
    const mounted = createMountedRoot();
    const onOpenSelected = vi.fn();
    const onOpenSelectedInIde = vi.fn();
    const onOpenSelectedInSystem = vi.fn();
    const snapshot = createSnapshot();
    snapshot.unresolvedCount = 1;
    snapshot.unresolvedEntries = [
      {
        path: "assets/logo.png",
        fileName: "logo.png",
        directoryPath: "assets",
        conflictState: "unresolved",
        reverseSides: false,
        canOpenMerge: false,
        canOpenFile: true,
        oursState: "modified",
        theirsState: "modified",
        base: { label: "Base", available: true, isBinary: true },
        ours: { label: "Ours", available: true, isBinary: true },
        theirs: { label: "Theirs", available: true, isBinary: true },
        working: { label: "结果", available: true, isBinary: true },
      },
    ];
    snapshot.resolvedCount = 1;
    snapshot.resolvedEntries = [createSnapshot().resolvedEntries[0]];
    snapshot.entries = [...snapshot.unresolvedEntries, ...snapshot.resolvedEntries];
    try {
      await act(async () => {
        mounted.root.render(
          <ConflictResolverDialog
            open={true}
            title="解决冲突"
            description="desc"
            snapshot={snapshot}
            selectedPath="assets/logo.png"
            checkedPaths={[]}
            groupByDirectory={true}
            showResolved={false}
            operationState="merging"
            loading={false}
            submitting={null}
            applyingSide={null}
            onOpenChange={() => {}}
            onSelectPath={() => {}}
            onTogglePath={() => {}}
            onToggleAll={() => {}}
            onToggleGroupByDirectory={() => {}}
            onToggleShowResolved={() => {}}
            onOpenSelected={onOpenSelected}
            onOpenSelectedInIde={onOpenSelectedInIde}
            onOpenSelectedInSystem={onOpenSelectedInSystem}
            onRefresh={() => {}}
            onSelectNext={() => {}}
            onApplySide={() => {}}
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLButtonElement>("conflict-resolver-open-selected").textContent).toContain("打开");

      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-open-selected").click();
        getByTestId<HTMLButtonElement>("conflict-resolver-open-in-ide").click();
        getByTestId<HTMLButtonElement>("conflict-resolver-open-in-system").click();
      });

      expect(onOpenSelected).toHaveBeenCalledTimes(1);
      expect(onOpenSelectedInIde).toHaveBeenCalledTimes(1);
      expect(onOpenSelectedInSystem).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("当前文件不支持应用内合并");
    } finally {
      mounted.unmount();
    }
  });

  it("按目录分组时应支持展开与收起目录节点", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <ConflictResolverDialog
            open={true}
            title="解决冲突"
            description="desc"
            snapshot={createSnapshot()}
            selectedPath="src/a.ts"
            checkedPaths={[]}
            groupByDirectory={true}
            showResolved={false}
            operationState="merging"
            loading={false}
            submitting={null}
            applyingSide={null}
            onOpenChange={() => {}}
            onSelectPath={() => {}}
            onTogglePath={() => {}}
            onToggleAll={() => {}}
            onToggleGroupByDirectory={() => {}}
            onToggleShowResolved={() => {}}
            onOpenSelected={() => {}}
            onRefresh={() => {}}
            onSelectNext={() => {}}
            onApplySide={() => {}}
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      expect(queryByTestId("conflict-resolver-row-src/a.ts")).toBeTruthy();

      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-directory-ct:merge-conflict:unresolved:resolver:unresolved:src").click();
      });

      expect(queryByTestId("conflict-resolver-row-src/a.ts")).toBeNull();

      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-resolver-directory-ct:merge-conflict:unresolved:resolver:unresolved:src").click();
      });

      expect(queryByTestId("conflict-resolver-row-src/a.ts")).toBeTruthy();
    } finally {
      mounted.unmount();
    }
  });

  it("最后一个冲突解决后应继续显示 resolved 条目，而不是把列表清空", async () => {
    const mounted = createMountedRoot();
    const snapshot = createSnapshot();
    snapshot.unresolvedEntries = [];
    snapshot.unresolvedCount = 0;
    snapshot.entries = [...snapshot.resolvedEntries];
    try {
      await act(async () => {
        mounted.root.render(
          <ConflictResolverDialog
            open={true}
            title="解决冲突"
            description="desc"
            snapshot={snapshot}
            selectedPath=""
            checkedPaths={[]}
            groupByDirectory={false}
            showResolved={false}
            operationState="grafting"
            loading={false}
            submitting={null}
            applyingSide={null}
            onOpenChange={() => {}}
            onSelectPath={() => {}}
            onTogglePath={() => {}}
            onToggleAll={() => {}}
            onToggleGroupByDirectory={() => {}}
            onToggleShowResolved={() => {}}
            onOpenSelected={() => {}}
            onRefresh={() => {}}
            onSelectNext={() => {}}
            onApplySide={() => {}}
            continueLabel="提交更改"
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLButtonElement>("conflict-resolver-row-src/c.ts")).toBeTruthy();
      expect(getByTestId<HTMLButtonElement>("conflict-resolver-continue").textContent).toContain("提交更改");
      expect(document.body.textContent).toContain("1 个已解决");
      expect(document.body.textContent).toContain("Cherry-pick");
    } finally {
      mounted.unmount();
    }
  });
});
