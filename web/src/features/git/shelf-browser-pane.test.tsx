// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { resolveShelfDeleteActionLabel, ShelfBrowserPane } from "./shelf-browser-pane";
import { buildShelfBrowserRows } from "./shelf-browser-model";
import type { GitShelfItem, GitShelfViewState } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建最小可用的 shelf 条目夹具，便于在组件测试中聚焦交互行为。
 */
function createShelfItem(input: Partial<GitShelfItem> & Pick<GitShelfItem, "ref" | "createdAt" | "paths">): GitShelfItem {
  return {
    ref: input.ref,
    repoRoot: input.repoRoot || "/repo",
    repoRoots: input.repoRoots || ["/repo"],
    message: input.message || "示例搁置",
    createdAt: input.createdAt,
    source: input.source || "manual",
    saveChangesPolicy: "shelve",
    state: input.state || "saved",
    displayName: input.displayName || input.message || "示例搁置",
    hasIndexPatch: input.hasIndexPatch !== false,
    hasWorktreePatch: input.hasWorktreePatch !== false,
    hasUntrackedFiles: input.hasUntrackedFiles === true,
    paths: input.paths,
    originalChangeListName: input.originalChangeListName,
    lastError: input.lastError,
  };
}

/**
 * 创建并挂载测试用 React Root，供 shelf browser 在 jsdom 中真实渲染。
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
 * 按按钮标题查找图标按钮，便于驱动 shelf browser 工具栏和右键菜单测试。
 */
function getButtonByTitle(title: string): HTMLButtonElement {
  const matched = document.querySelector(`button[title="${title}"]`);
  if (!matched)
    throw new Error(`missing button title: ${title}`);
  return matched as HTMLButtonElement;
}

/**
 * 按菜单项文字查找当前下拉菜单项，避免误命中普通内容区文本。
 */
function getDropdownMenuItemByText(text: string): HTMLDivElement {
  const nodes = Array.from(document.querySelectorAll('[data-dropdown-menu-content="true"] div'));
  const matched = nodes.find((node) => node.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing dropdown item: ${text}`);
  return matched as HTMLDivElement;
}

/**
 * 用受控状态包装 shelf browser，验证目录分组回调可以驱动真实重渲染。
 */
function ControlledShelfBrowser(props: {
  onViewStateChange?: ReturnType<typeof vi.fn>;
  onRecycleShelf?: ReturnType<typeof vi.fn>;
  onRunDiffAction?: ReturnType<typeof vi.fn>;
  onCreatePatch?: ReturnType<typeof vi.fn>;
}): JSX.Element {
  const [viewState, setViewState] = React.useState<GitShelfViewState>({
    showRecycled: false,
    groupByDirectory: false,
  });
  return (
    <ShelfBrowserPane
      items={[createShelfItem({
        ref: "shelf@{1}",
        createdAt: "2026-03-26T10:00:00.000Z",
        paths: ["src/app.ts", "docs/readme.md"],
      })]}
      stashItems={[]}
      viewState={viewState}
      onRefresh={() => {}}
      onImportPatch={() => {}}
      onViewStateChange={(patch) => {
        props.onViewStateChange?.(patch);
        setViewState((prev) => ({
          showRecycled: patch.showRecycled ?? prev.showRecycled,
          groupByDirectory: patch.groupByDirectory ?? prev.groupByDirectory,
        }));
      }}
      onOpenShelfRestore={() => {}}
      onRenameShelf={() => {}}
      onRecycleShelf={(shelf) => {
        props.onRecycleShelf?.(shelf);
      }}
      onRestoreArchivedShelf={() => {}}
      onDeleteShelfPermanently={() => {}}
      onRunDiffAction={(shelf, selectedPaths, action) => {
        props.onRunDiffAction?.(shelf, selectedPaths, action);
      }}
      onCreatePatch={(shelf, selectedPaths, mode) => {
        props.onCreatePatch?.(shelf, selectedPaths, mode);
      }}
    />
  );
}

/**
 * 打开包含指定文本行的 shelf 右键菜单，供菜单项对齐测试复用。
 */
function openContextMenuByRowText(text: string): void {
  const target = Array.from(document.querySelectorAll(".cf-git-list-row"))
    .find((node) => node.textContent?.includes(text));
  if (!target)
    throw new Error(`missing shelf row text: ${text}`);
  target.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 32,
    clientY: 32,
  }));
}

/**
 * 按菜单项文字查找 shelf 右键菜单按钮，避免把正文区同名文本误判成菜单项。
 */
function getContextMenuButtonByText(text: string): HTMLButtonElement {
  const root = document.querySelector('[data-action-group="shelf-browser"]');
  if (!root)
    throw new Error("missing shelf context menu");
  const target = Array.from(root.querySelectorAll("button"))
    .find((node) => node.textContent?.includes(text));
  if (!target)
    throw new Error(`missing context menu item: ${text}`);
  return target as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ShelfBrowserPane", () => {
  it("应支持通过视图选项切换目录分组", async () => {
    const mounted = createMountedRoot();
    const onViewStateChange = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(<ControlledShelfBrowser onViewStateChange={onViewStateChange} onRecycleShelf={vi.fn()} />);
      });

      expect(document.body.textContent).toContain("app.ts");

      await act(async () => {
        getButtonByTitle("视图选项").click();
      });
      await act(async () => {
        getDropdownMenuItemByText("目录").click();
      });

      expect(onViewStateChange).toHaveBeenCalledWith({ groupByDirectory: true });
      expect(document.body.textContent).toContain("src");
    } finally {
      mounted.unmount();
    }
  });

  it("活动 shelf 删除语义应统一显示为 IDEA 对齐的删除文案", async () => {
    const mounted = createMountedRoot();
    const onRecycleShelf = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(<ControlledShelfBrowser onViewStateChange={vi.fn()} onRecycleShelf={onRecycleShelf} />);
      });

      const row = buildShelfBrowserRows({
        items: [createShelfItem({
          ref: "shelf@{1}",
          createdAt: "2026-03-26T10:00:00.000Z",
          paths: ["src/app.ts"],
        })],
        showRecycled: false,
      }).find((item) => item.kind === "shelf");
      expect(resolveShelfDeleteActionLabel(row || null)).toBe("删除...");
      expect(document.querySelector('button[title="删除..."]')).toBeTruthy();
      expect(document.querySelector('button[title="移到回收区"]')).toBeNull();

      await act(async () => {
        getButtonByTitle("删除...").click();
      });

      expect(onRecycleShelf).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("shelf 右键菜单应补齐 IDEA 对齐的差异与补丁动作", async () => {
    const mounted = createMountedRoot();
    const onRunDiffAction = vi.fn();
    const onCreatePatch = vi.fn();
    try {
      await act(async () => {
        mounted.root.render((
          <ControlledShelfBrowser
            onViewStateChange={vi.fn()}
            onRecycleShelf={vi.fn()}
            onRunDiffAction={onRunDiffAction}
            onCreatePatch={onCreatePatch}
          />
        ));
      });

      await act(async () => {
        openContextMenuByRowText("app.ts");
      });

      expect(document.body.textContent).toContain("显示差异");
      expect(document.body.textContent).toContain("在新标签页中显示差异");
      expect(document.body.textContent).toContain("与本地比较");
      expect(document.body.textContent).toContain("创建补丁...");
      expect(document.body.textContent).toContain("作为补丁复制到剪贴板");
      expect(document.body.textContent).toContain("导入补丁...");
      expect(document.body.textContent).toContain("重命名...");
      expect(document.body.textContent).toContain("删除...");
      expect(document.body.textContent).not.toContain("移到回收区");

      await act(async () => {
        getContextMenuButtonByText("显示差异").click();
      });
      expect(onRunDiffAction).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "shelf@{1}" }),
        ["src/app.ts"],
        "showDiff",
      );

      await act(async () => {
        openContextMenuByRowText("app.ts");
      });
      await act(async () => {
        getContextMenuButtonByText("作为补丁复制到剪贴板").click();
      });
      expect(onCreatePatch).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "shelf@{1}" }),
        ["src/app.ts"],
        "clipboard",
      );
    } finally {
      mounted.unmount();
    }
  });
});
