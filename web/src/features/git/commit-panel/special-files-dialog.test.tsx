// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { GitStatusEntry } from "../types";
import { SpecialFilesDialog } from "./special-files-dialog";

/**
 * 启用 React 18 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建一个挂载根节点，供 jsdom 下渲染 special files 对话框。
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
      document.body.innerHTML = "";
    },
  };
}

/**
 * 等待一个 animation frame，确保 speed search 输入框的自动聚焦副作用已完成。
 */
async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * 构建 Browse 测试所需的最小状态条目。
 */
function createEntry(path: string): GitStatusEntry {
  return {
    path,
    oldPath: undefined,
    x: "?",
    y: "?",
    staged: false,
    unstaged: true,
    untracked: true,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "未跟踪",
    changeListId: "default",
  };
}

describe("SpecialFilesDialog", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("关闭重开后应保留目录展开状态", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const props = {
      cacheKey: "unversioned",
      kind: "unversioned" as const,
      title: "未跟踪文件",
      description: "测试",
      entries: [createEntry("src/app.ts"), createEntry("src/utils.ts")],
      viewOptions: {
        groupByDirectory: true,
        groupingKeys: ["directory"] as const,
        availableGroupingKeys: ["directory"] as const,
        showIgnored: false,
        detailsPreviewShown: true,
        diffPreviewOnDoubleClickOrEnter: true,
        manyFilesThreshold: 1000,
      },
      initialGroupingKeys: ["directory"] as const,
      availableGroupingKeys: ["directory"] as const,
      onOpenChange: vi.fn(),
      onInvokeEntryAction: vi.fn(),
      onStagePaths: vi.fn(async () => {}),
      onDeletePaths: vi.fn(async () => {}),
      onIgnoreEntries: vi.fn(),
    };
    act(() => {
      mounted.root.render(<SpecialFilesDialog {...props} open />);
    });
    const toggleButton = document.querySelector('[data-testid="special-files-toggle-ct:browse:unversioned:default:src"]');
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      mounted.root.render(<SpecialFilesDialog {...props} open={false} />);
    });
    act(() => {
      mounted.root.render(<SpecialFilesDialog {...props} open />);
    });
    expect(document.body.textContent).not.toContain("app.ts");
    expect(document.body.textContent).not.toContain("utils.ts");
  });

  it("首次打开时不应伪造第一个文件为默认选区", () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onStagePaths = vi.fn(async () => {});
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/app.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={onStagePaths}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    const selectedRows = document.querySelectorAll(".cf-git-row-selected");
    const stageButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("添加到 VCS"));
    expect(selectedRows).toHaveLength(0);
    expect(stageButton?.hasAttribute("disabled")).toBe(true);
  });

  it("首开时只应自动展开单根节点，而不是递归展开整棵目录树", () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/nested/app.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    expect(document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src"]')).toBeNull();
    expect(document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/nested"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/nested/app.ts"]')).not.toBeNull();
  });

  it("双击应走与主树一致的动作派发，Enter 语义由 interaction-model 统一覆盖", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onInvokeEntryAction = vi.fn();
    const onOpenChange = vi.fn();
    const entry = createEntry("src/app.ts");
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[entry]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={onOpenChange}
          onInvokeEntryAction={onInvokeEntryAction}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    const fileRow = document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/app.ts"]');
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onInvokeEntryAction).toHaveBeenCalledWith(entry, "doubleClick");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("unversioned Browse popup 应可触发 add-to-vcs 与 ignore 动作", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onStagePaths = vi.fn(async () => {});
    const onIgnoreEntries = vi.fn();
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/app.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={onStagePaths}
          onDeletePaths={async () => {}}
          onIgnoreEntries={onIgnoreEntries}
        />,
      );
    });
    const fileRow = document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/app.ts"]');
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 90, clientY: 120 }));
    });
    const stageButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("添加到 VCS"));
    await act(async () => {
      stageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 90, clientY: 120 }));
    });
    const ignoreButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("忽略"));
    await act(async () => {
      ignoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStagePaths).toHaveBeenCalledWith(["src/app.ts"]);
    expect(onIgnoreEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: "src/app.ts" }),
    ], expect.any(Object));
    expect(document.querySelector('[data-action-group="Unversioned.Files.Dialog.Popup"]')).not.toBeNull();
  });

  it("ignore 动作应保留选中条目的仓库归属，供外层按仓分组处理", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onIgnoreEntries = vi.fn();
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned-cross-repo"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[
            { ...createEntry("repo-a/a.txt"), repositoryRoot: "/repo-a" },
            { ...createEntry("repo-b/b.txt"), repositoryRoot: "/repo-b" },
          ]}
          viewOptions={{
            groupByDirectory: false,
            groupingKeys: [] as const,
            availableGroupingKeys: [] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={[]}
          availableGroupingKeys={[]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={onIgnoreEntries}
        />,
      );
    });
    const rows = Array.from(document.querySelectorAll('[data-testid^="special-files-row-"]'));
    const firstRow = rows[0] || null;
    const secondRow = rows[1] || null;
    await act(async () => {
      firstRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      secondRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    const ignoreButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("忽略"));
    await act(async () => {
      ignoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onIgnoreEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: "repo-a/a.txt", repositoryRoot: "/repo-a" }),
      expect.objectContaining({ path: "repo-b/b.txt", repositoryRoot: "/repo-b" }),
    ], undefined);
  });

  it("many-files Browse 应支持多选，并按选区集合执行动作", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onStagePaths = vi.fn(async () => {});
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="unversioned"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/app.ts"), createEntry("src/utils.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={onStagePaths}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    const appRow = document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/app.ts"]');
    const utilsRow = document.querySelector('[data-testid="special-files-row-ct:browse:unversioned:default:src/utils.ts"]');
    await act(async () => {
      appRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      utilsRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    const stageButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("添加到 VCS"));
    await act(async () => {
      stageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStagePaths).toHaveBeenCalledWith(["src/app.ts", "src/utils.ts"]);
  });

  it("ignored Browse 删除动作应可用", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onDeletePaths = vi.fn(async () => {});
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="ignored"
          kind="ignored"
          title="已忽略文件"
          description="测试"
          entries={[{ ...createEntry("dist/app.js"), ignored: true, untracked: false, x: "!", y: "!", statusText: "已忽略", changeListId: "" }]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: true,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={onDeletePaths}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    const fileRow = document.querySelector('[data-testid="special-files-row-ct:browse:ignored:none:dist/app.js"]');
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const deleteButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("删除"));
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDeletePaths).toHaveBeenCalledWith(["dist/app.js"]);
    expect(document.querySelector('[data-action-group="Delete"]')).not.toBeNull();
  });

  it("conflict Browse 右键菜单不应被短路", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onInvokeEntryAction = vi.fn();
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="conflict"
          kind="conflict"
          title="解决冲突"
          description="测试"
          entries={[{ ...createEntry("src/conflict.ts"), untracked: false, staged: true, unstaged: true, x: "U", y: "U", statusText: "冲突" }]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={onInvokeEntryAction}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    const fileRow = document.querySelector('[data-testid="special-files-row-ct:browse:conflict:default:src/conflict.ts"]');
    await act(async () => {
      fileRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 60, clientY: 80 }));
    });
    const resolveButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes("解决选中冲突"));
    expect(resolveButton).not.toBeNull();
    await act(async () => {
      resolveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onInvokeEntryAction).toHaveBeenCalled();
    expect(document.querySelector('[data-action-group="ChangesView.Conflicts.Dialog.Popup"]')).not.toBeNull();
  });

  it("无 grouping 时不应渲染 Expand All/Collapse All", () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="flat"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("app.ts")]}
          viewOptions={{
            groupByDirectory: false,
            groupingKeys: [] as const,
            availableGroupingKeys: [] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={[]}
          availableGroupingKeys={[]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });
    expect(Array.from(document.querySelectorAll("button")).some((node) => node.textContent?.includes("展开全部"))).toBe(false);
    expect(Array.from(document.querySelectorAll("button")).some((node) => node.textContent?.includes("收起全部"))).toBe(false);
  });

  it("Ctrl+F 打开 speed search 后应聚焦真实输入框并支持直接改值", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="speed-search"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/app.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });

    const treeRoot = document.querySelector('[data-testid="special-files-tree"]') as HTMLDivElement | null;
    expect(treeRoot).not.toBeNull();

    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    });
    await flushAnimationFrame();

    const searchInput = document.querySelector('[data-testid="special-files-speed-search-input"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);

    await act(async () => {
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(searchInput, "src");
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(searchInput?.value).toBe("src");
  });

  it("Browse 树焦点切换到 speed search 输入框时不应立即关闭搜索浮层", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    act(() => {
      mounted.root.render(
        <SpecialFilesDialog
          open
          cacheKey="speed-search-blur"
          kind="unversioned"
          title="未跟踪文件"
          description="测试"
          entries={[createEntry("src/app.ts")]}
          viewOptions={{
            groupByDirectory: true,
            groupingKeys: ["directory"] as const,
            availableGroupingKeys: ["directory"] as const,
            showIgnored: false,
            detailsPreviewShown: true,
            diffPreviewOnDoubleClickOrEnter: true,
            manyFilesThreshold: 1000,
          }}
          initialGroupingKeys={["directory"]}
          availableGroupingKeys={["directory"]}
          onOpenChange={() => {}}
          onInvokeEntryAction={() => {}}
          onStagePaths={async () => {}}
          onDeletePaths={async () => {}}
          onIgnoreEntries={() => {}}
        />,
      );
    });

    const treeRoot = document.querySelector('[data-testid="special-files-tree"]') as HTMLDivElement | null;
    await act(async () => {
      treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    });
    await flushAnimationFrame();

    const searchInput = document.querySelector('[data-testid="special-files-speed-search-input"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      treeRoot?.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: searchInput }));
    });

    expect(document.querySelector('[data-testid="special-files-speed-search-input"]')).not.toBeNull();
  });
});
