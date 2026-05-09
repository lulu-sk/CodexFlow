// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { IgnoreTargetDialog } from "./ignore-target-dialog";

/**
 * 启用 React 18 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建一个挂载根节点，供 jsdom 下渲染 ignore target popup。
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

describe("IgnoreTargetDialog", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("应以 popup 语义展示目标并支持点击选择", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const onSelectTarget = vi.fn();
    act(() => {
      mounted.root.render(
        <IgnoreTargetDialog
          open
          paths={["build/cache.log"]}
          anchor={{ x: 80, y: 120 }}
          targets={[{
            id: "git-exclude:test",
            kind: "git-exclude",
            label: "添加到 .git/info/exclude",
            description: "仅当前仓库本地生效",
            targetPath: ".git/info/exclude",
            displayPath: ".git/info/exclude",
          }]}
          onOpenChange={() => {}}
          onSelectTarget={onSelectTarget}
        />,
      );
    });
    const targetButton = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.includes(".git/info/exclude"));
    await act(async () => {
      targetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectTarget).toHaveBeenCalled();
    expect(document.body.textContent).toContain("忽略文件");
  });
});
