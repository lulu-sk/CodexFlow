// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { FetchDialog } from "./fetch-dialog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供 Fetch 对话框在 jsdom 中渲染。
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
 * 按按钮文字查找对话框动作按钮，缺失时直接抛错便于定位。
 */
function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing button: ${text}`);
  return matched as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FetchDialog", () => {
  it("应渲染多 root fetch 参数，并显示具体命令预览", async () => {
    const mounted = createMountedRoot();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <FetchDialog
            open={true}
            repositories={[
              {
                repoRoot: "/repo/app",
                label: "/repo/app",
                defaultRemote: "origin",
                remotes: [{ name: "origin" }, { name: "upstream" }],
              },
              {
                repoRoot: "/repo/lib",
                label: "/repo/lib",
                defaultRemote: "upstream",
                remotes: [{ name: "upstream" }],
              },
            ]}
            value={{
              repoRoot: "/repo/app",
              mode: "specific-remote",
              remote: "origin",
              refspec: "refs/heads/main:refs/remotes/origin/main",
              unshallow: true,
              tagMode: "all",
            }}
            submitting={false}
            onClose={onClose}
            onChange={() => {}}
            onSubmit={onSubmit}
          />,
        );
      });

      expect(document.body.textContent).toContain("获取远端变更");
      expect(document.body.textContent).toContain("目标仓库");
      expect(document.body.textContent).toContain("git fetch origin --unshallow --tags refs/heads/main:refs/remotes/origin/main");
      expect(getButtonByText("开始获取").disabled).toBe(false);

      await act(async () => {
        getButtonByText("开始获取").click();
        getButtonByText("取消").click();
      });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("all-remotes 模式应在命令预览里显式带出 --all 与 --no-tags", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <FetchDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/app",
              label: "/repo/app",
              defaultRemote: "origin",
              remotes: [{ name: "origin" }, { name: "upstream" }],
            }]}
            value={{
              repoRoot: "/repo/app",
              mode: "all-remotes",
              remote: "origin",
              refspec: "",
              unshallow: false,
              tagMode: "none",
            }}
            submitting={false}
            onClose={() => {}}
            onChange={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("git fetch --all --no-tags");
    } finally {
      mounted.unmount();
    }
  });

  it("指定远端模式缺少 remote 时应禁用提交", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <FetchDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/app",
              label: "/repo/app",
              defaultRemote: "origin",
              remotes: [{ name: "origin" }],
            }]}
            value={{
              repoRoot: "/repo/app",
              mode: "specific-remote",
              remote: "",
              refspec: "",
              unshallow: false,
              tagMode: "auto",
            }}
            submitting={false}
            onClose={() => {}}
            onChange={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      expect(getButtonByText("开始获取").disabled).toBe(true);
    } finally {
      mounted.unmount();
    }
  });
});
