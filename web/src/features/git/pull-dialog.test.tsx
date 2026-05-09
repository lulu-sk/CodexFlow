// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { PullDialog } from "./pull-dialog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供 Pull 对话框在 jsdom 中渲染。
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
 * 按按钮文字查找目标按钮，缺失时直接抛错方便定位。
 */
function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing button: ${text}`);
  return matched as HTMLButtonElement;
}

/**
 * 按测试标识获取 Pull 对话框底部动作按钮，避免和附加选项按钮重名。
 */
function getActionButton(testId: string): HTMLButtonElement {
  const button = document.querySelector(`[data-testid="${testId}"]`);
  if (!button)
    throw new Error(`missing action button: ${testId}`);
  return button as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PullDialog", () => {
  /**
   * 验证 Pull 对话框从关闭切到打开时保持 Hook 调用顺序稳定。
   */
  it("从关闭态打开时不应触发 Hook 数量变化错误", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <PullDialog
            open={false}
            repositories={[{
              repoRoot: "/repo/project",
              label: "/repo/project",
              currentBranchName: "master",
              remotes: [{ name: "origin", branches: ["main"] }],
            }]}
            value={{ repoRoot: "/repo/project", remote: "origin", branch: "main", mode: "merge", options: [] }}
            capabilities={{ noVerify: true }}
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onChange={() => {}}
            onRefresh={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      expect(document.body.textContent).not.toContain("拉取到 master");

      await act(async () => {
        mounted.root.render(
          <PullDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/project",
              label: "/repo/project",
              currentBranchName: "master",
              remotes: [{ name: "origin", branches: ["main"] }],
            }]}
            value={{ repoRoot: "/repo/project", remote: "origin", branch: "main", mode: "merge", options: [] }}
            capabilities={{ noVerify: true }}
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onChange={() => {}}
            onRefresh={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("拉取到 master");
    } finally {
      mounted.unmount();
    }
  });

  it("默认应保持简洁界面，并在修改选项中展开高级配置", async () => {
    const mounted = createMountedRoot();
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    const onSubmit = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <PullDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/project",
              label: "/repo/project",
              currentBranchName: "master",
              remotes: [{ name: "origin", branches: ["main", "dev"] }],
            }]}
            value={{ repoRoot: "/repo/project", remote: "origin", branch: "main", mode: "merge", options: ["ffOnly", "noVerify"] }}
            capabilities={{ noVerify: true }}
            submitting={false}
            refreshing={false}
            onClose={onClose}
            onChange={() => {}}
            onRefresh={onRefresh}
            onSubmit={onSubmit}
          />,
        );
      });

      expect(document.body.textContent).toContain("拉取到 master");
      expect(document.body.textContent).toContain("远端");
      expect(document.body.textContent).toContain("分支");
      expect(document.querySelector('[data-testid="git-pull-command-strip"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain("git pull --ff-only --no-verify origin main");
      expect(document.body.textContent).not.toContain("仓库 Root");
      expect(document.body.textContent).not.toContain("拉取策略");
      expect(document.body.textContent).not.toContain("附加选项");
      expect(getActionButton("git-pull-submit").disabled).toBe(false);

      await act(async () => {
        const refreshButton = document.querySelector('button[aria-label="获取远端分支列表"]') as HTMLButtonElement | null;
        if (!refreshButton)
          throw new Error("missing refresh button");
        refreshButton.click();
        getActionButton("git-pull-submit").click();
      });

      await act(async () => {
        const optionsTrigger = document.querySelector('[data-testid="git-pull-options-trigger"]') as HTMLButtonElement | null;
        if (!optionsTrigger)
          throw new Error("missing options trigger");
        optionsTrigger.click();
      });

      expect(document.body.textContent).toContain("拉取策略");
      expect(document.body.textContent).toContain("附加选项");

      await act(async () => {
        getActionButton("git-pull-cancel").click();
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("rebase 模式应在修改选项中显式展示 Rebase 策略", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <PullDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/project",
              label: "/repo/project",
              currentBranchName: "master",
              remotes: [{ name: "origin", branches: ["main"] }],
            }]}
            value={{ repoRoot: "/repo/project", remote: "origin", branch: "main", mode: "rebase", options: ["noVerify", "ffOnly"] }}
            capabilities={{ noVerify: true }}
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onChange={() => {}}
            onRefresh={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      expect(document.body.textContent).not.toContain("git pull --rebase --no-verify origin main");
      await act(async () => {
        const optionsTrigger = document.querySelector('[data-testid="git-pull-options-trigger"]') as HTMLButtonElement | null;
        if (!optionsTrigger)
          throw new Error("missing options trigger");
        optionsTrigger.click();
      });

      expect(document.body.textContent).toContain("Rebase");
    } finally {
      mounted.unmount();
    }
  });

  it("当前 Git 不支持 no-verify 时应禁用对应选项", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <PullDialog
            open={true}
            repositories={[{
              repoRoot: "/repo/project",
              label: "/repo/project",
              currentBranchName: "master",
              remotes: [{ name: "origin", branches: ["main"] }],
            }]}
            value={{ repoRoot: "/repo/project", remote: "origin", branch: "main", mode: "merge", options: [] }}
            capabilities={{ noVerify: false }}
            submitting={false}
            refreshing={false}
            onClose={() => {}}
            onChange={() => {}}
            onRefresh={() => {}}
            onSubmit={() => {}}
          />,
        );
      });

      await act(async () => {
        const optionsTrigger = document.querySelector('[data-testid="git-pull-options-trigger"]') as HTMLButtonElement | null;
        if (!optionsTrigger)
          throw new Error("missing options trigger");
        optionsTrigger.click();
      });

      expect(document.body.textContent).toContain("当前 Git 不支持 `git pull --no-verify`");
    } finally {
      mounted.unmount();
    }
  });
});
