// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { CommitOptionsPopover } from "./commit-options-popover";
import { createCommitAdvancedOptionsState } from "./commit-options-model";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供提交选项弹层在 jsdom 环境下渲染。
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
      try { host.remove(); } catch {}
      document.body.innerHTML = "";
    },
  };
}

/**
 * 创建一个可定位的触发按钮，供弹层计算 popup 坐标与点击外部判定复用。
 */
function createAnchorButton(): HTMLButtonElement {
  const button = document.createElement("button");
  Object.defineProperty(button, "getBoundingClientRect", {
    value: () => ({
      top: 300,
      left: 240,
      bottom: 328,
      right: 320,
      width: 80,
      height: 28,
      x: 240,
      y: 300,
      toJSON: () => undefined,
    }),
  });
  document.body.appendChild(button);
  return button;
}

/**
 * 按文本定位按钮，便于驱动折叠区切换。
 */
function getButtonByText(text: string): HTMLButtonElement {
  const matched = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
  if (!matched) throw new Error(`missing button: ${text}`);
  return matched as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CommitOptionsPopover", () => {
  it("作者时间应默认折叠，点击后再展开输入框", async () => {
    const mounted = createMountedRoot();
    const anchorButton = createAnchorButton();
    const anchorRef = { current: anchorButton };
    const onChange = vi.fn();

    await act(async () => {
      mounted.root.render(
        <CommitOptionsPopover
          open
          anchorRef={anchorRef}
          value={createCommitAdvancedOptionsState()}
          onOpenChange={() => {}}
          onChange={onChange}
        />,
      );
    });

    expect(document.body.textContent).toContain("低频选项，日常提交通常留空");
    expect(document.querySelector('input[placeholder="例如：2026-03-12 21:11:00"]')).toBeNull();

    await act(async () => {
      getButtonByText("作者时间（可选，Git `--date`）").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.querySelector('input[placeholder="例如：2026-03-12 21:11:00"]')).not.toBeNull();

    mounted.unmount();
  });

  it("已有作者时间时应默认展开，避免隐藏已填写内容", async () => {
    const mounted = createMountedRoot();
    const anchorButton = createAnchorButton();
    const anchorRef = { current: anchorButton };

    await act(async () => {
      mounted.root.render(
        <CommitOptionsPopover
          open
          anchorRef={anchorRef}
          value={{
            ...createCommitAdvancedOptionsState(),
            authorDate: "2026-03-12 21:11:00",
          }}
          onOpenChange={() => {}}
          onChange={() => {}}
        />,
      );
    });

    expect(document.querySelector('input[placeholder="例如：2026-03-12 21:11:00"]')).not.toBeNull();

    mounted.unmount();
  });

  it("amend 模式下应禁用 rename 单独提交选项并显示提示", async () => {
    const mounted = createMountedRoot();
    const anchorButton = createAnchorButton();
    const anchorRef = { current: anchorButton };

    await act(async () => {
      mounted.root.render(
        <CommitOptionsPopover
          open
          anchorRef={anchorRef}
          value={createCommitAdvancedOptionsState()}
          commitRenamesSeparatelyDisabled={true}
          commitRenamesSeparatelyHint="修改上一提交时不支持该选项。"
          onOpenChange={() => {}}
          onChange={() => {}}
        />,
      );
    });

    const checkbox = document.querySelector('input[type="checkbox"][disabled]') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(document.body.textContent).toContain("修改上一提交时不支持该选项。");

    mounted.unmount();
  });

  it("存在 hooks 且被全局禁用时，应展示禁用的运行 Hooks 选项与说明", async () => {
    const mounted = createMountedRoot();
    const anchorButton = createAnchorButton();
    const anchorRef = { current: anchorButton };

    await act(async () => {
      mounted.root.render(
        <CommitOptionsPopover
          open
          anchorRef={anchorRef}
          value={createCommitAdvancedOptionsState({ runHooks: false })}
          commitHooks={{ available: true, disabledByPolicy: true, runByDefault: false }}
          onOpenChange={() => {}}
          onChange={() => {}}
        />,
      );
    });

    expect(document.body.textContent).toContain("运行 Git Hooks");
    expect(document.body.textContent).toContain("当前已启用全局禁用策略");
    const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .find((item) => (item as HTMLInputElement).disabled) as HTMLInputElement | undefined;
    expect(checkbox).toBeTruthy();

    mounted.unmount();
  });
});
