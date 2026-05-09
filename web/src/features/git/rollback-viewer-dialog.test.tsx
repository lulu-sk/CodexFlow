// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { RollbackViewerDialog } from "./rollback-viewer-dialog";
import { buildRollbackBrowserEntriesFromStatusEntries, type GitRollbackBrowserEntry, type GitRollbackBrowserGroupingKey } from "./rollback-browser-model";
import type { GitStatusEntry } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_ENTRIES: GitStatusEntry[] = [
  {
    path: "src/app.ts",
    x: "M",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "已暂存修改",
    changeListId: "default",
  },
  {
    path: "src/renamed.ts",
    oldPath: "src/old.ts",
    x: "R",
    y: ".",
    staged: true,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: true,
    deleted: false,
    statusText: "已暂存重命名",
    changeListId: "default",
  },
];

const ENTRIES: GitRollbackBrowserEntry[] = buildRollbackBrowserEntriesFromStatusEntries(SOURCE_ENTRIES);

/**
 * 创建并挂载一个 React Root，供 rollback viewer 在 jsdom 中渲染。
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
 * 按按钮文字查找按钮，方便直接驱动 viewer 交互。
 */
function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing button: ${text}`);
  return matched as HTMLButtonElement;
}

/**
 * 按按钮标题查找图标按钮，便于驱动 rollback viewer 的工具栏动作。
 */
function getButtonByTitle(title: string): HTMLButtonElement {
  const matched = document.querySelector(`button[title="${title}"]`);
  if (!matched)
    throw new Error(`missing button title: ${title}`);
  return matched as HTMLButtonElement;
}

/**
 * 按菜单项文字查找当前下拉菜单项，供视图选项切换断言复用。
 */
function getMenuItemByText(text: string): HTMLDivElement {
  const items = Array.from(document.querySelectorAll('[data-dropdown-menu-content="true"] div'));
  const matched = items.find((item) => item.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing menu item: ${text}`);
  return matched as HTMLDivElement;
}

/**
 * 返回当前 rollback viewer 对应的顶层 DialogContent，便于断言视口约束样式。
 */
function getDialogContentElement(): HTMLDivElement {
  const element = document.querySelector('[data-cf-dialog-content="true"]');
  if (!element)
    throw new Error("missing dialog content");
  return element as HTMLDivElement;
}

/**
 * 用最小受控状态包装 rollback viewer，便于测试分组切换后的真实重渲染结果。
 */
function ControlledGroupingRollbackViewer(): JSX.Element {
  const [groupingKeys, setGroupingKeys] = React.useState<GitRollbackBrowserGroupingKey[]>([]);
  return (
    <RollbackViewerDialog
      open={true}
      title="回滚更改"
      description="测试 viewer"
      entries={ENTRIES}
      selectedPaths={["src/app.ts"]}
      activePath="src/app.ts"
      groupingKeys={groupingKeys}
      submitting={false}
      refreshing={false}
      onClose={() => {}}
      onSelectionChange={() => {}}
      onGroupingKeysChange={setGroupingKeys}
      onActivePathChange={() => {}}
      onRollback={() => {}}
    />
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RollbackViewerDialog", () => {
  it("应支持全选切换、回滚、刷新与打开 diff", async () => {
    const mounted = createMountedRoot();
    const onSelectionChange = vi.fn();
    const onRollback = vi.fn();
    const onRollbackAndContinue = vi.fn();
    const onRefresh = vi.fn();
    const onOpenDiff = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <RollbackViewerDialog
            open={true}
            title="回滚更改"
            description="测试 viewer"
            entries={ENTRIES}
            selectedPaths={["src/app.ts"]}
            activePath="src/app.ts"
            submitting={false}
            refreshing={false}
            continueLabel="回滚并继续拉取"
            onClose={() => {}}
            onSelectionChange={onSelectionChange}
            onActivePathChange={() => {}}
            onOpenDiff={onOpenDiff}
            onRefresh={onRefresh}
            onRollback={onRollback}
            onRollbackAndContinue={onRollbackAndContinue}
          />,
        );
      });

      expect(document.body.textContent).toContain("已选 1 / 2");
      expect(document.body.textContent).toContain("待回滚文件");
      expect(document.body.textContent).toContain("app.ts");

      await act(async () => {
        getButtonByText("全选").click();
        getButtonByTitle("刷新").click();
        getButtonByTitle("显示差异").click();
        getButtonByText("回滚所选更改").click();
        getButtonByText("回滚并继续拉取").click();
      });

      expect(onSelectionChange).toHaveBeenCalledWith(["src/app.ts", "src/renamed.ts"]);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(onOpenDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "src/app.ts" }));
      expect(onRollback).toHaveBeenCalledTimes(1);
      expect(onRollbackAndContinue).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("文件较多时应保持受限高度，并将滚动约束留在内部内容区", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <RollbackViewerDialog
            open={true}
            title="回滚更改"
            description="测试 viewer"
            entries={ENTRIES}
            selectedPaths={["src/app.ts"]}
            activePath="src/app.ts"
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onSelectionChange={() => {}}
            onActivePathChange={() => {}}
            onRollback={() => {}}
          />,
        );
      });

      const dialog = getDialogContentElement();
      expect(dialog.className).toContain("flex");
      expect(dialog.className).toContain("flex-col");
      expect(dialog.className).toContain("max-h-[calc(100vh-3rem)]");
      expect(dialog.className).toContain("overflow-hidden");
      expect(document.body.textContent).toContain("回滚只会处理当前勾选的文件");
      expect(document.body.textContent).not.toContain("回滚并继续");
    } finally {
      mounted.unmount();
    }
  });

  it("应支持通过视图选项切换目录分组", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(<ControlledGroupingRollbackViewer />);
      });

      await act(async () => {
        getButtonByTitle("视图选项").click();
      });
      await act(async () => {
        getMenuItemByText("目录").click();
      });

      expect(document.body.textContent).toContain("2 个文件");
    } finally {
      mounted.unmount();
    }
  });

  it("已保存的目录分组应在初次渲染时直接生效", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <RollbackViewerDialog
            open={true}
            title="回滚更改"
            description="测试 viewer"
            entries={ENTRIES}
            selectedPaths={["src/app.ts"]}
            activePath="src/app.ts"
            groupingKeys={["directory"]}
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onSelectionChange={() => {}}
            onGroupingKeysChange={() => {}}
            onActivePathChange={() => {}}
            onRollback={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("2 个文件");
    } finally {
      mounted.unmount();
    }
  });
});
