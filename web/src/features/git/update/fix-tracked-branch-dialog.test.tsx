// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { FixTrackedBranchDialog } from "./fix-tracked-branch-dialog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供 tracked branch 修复对话框在 jsdom 中渲染。
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
    },
  };
}

/**
 * 按文案获取按钮元素，供触发对话框动作时复用。
 */
function getButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(label));
  if (!matched) throw new Error(`missing button: ${label}`);
  return matched as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FixTrackedBranchDialog", () => {
  it("应提交 upstream 修复选择与继续更新方式", async () => {
    const mounted = createMountedRoot();
    const onConfirm = vi.fn();

    await act(async () => {
      mounted.root.render(
        <FixTrackedBranchDialog
          open={true}
          preview={{
            requestedRepoRoot: "/repo",
            multiRoot: false,
            defaultUpdateMethod: "rebase",
            hasFixableIssues: true,
            issues: [
              {
                repoRoot: "/repo",
                rootName: "repo",
                kind: "repository",
                issueCode: "no-tracked-branch",
                message: "当前分支 main 未配置远端上游分支",
                branch: "main",
                suggestedRemote: "origin",
                suggestedRemoteBranch: "main",
                remoteOptions: [
                  {
                    name: "origin",
                    branches: ["main"],
                  },
                ],
                canFix: true,
                canSetAsTracked: true,
              },
            ],
          }}
          submitting={false}
          onClose={() => {}}
          onConfirm={(payload) => {
            onConfirm(payload);
          }}
        />,
      );
    });

    await act(async () => {
      getButton("应用并继续更新").click();
    });

    expect(onConfirm).toHaveBeenCalledWith({
      selections: [
        expect.objectContaining({
          repoRoot: "/repo",
          remote: "origin",
          remoteBranch: "main",
          setAsTracked: true,
        }),
      ],
      updateMethod: "rebase",
    });

    mounted.unmount();
  });

  it("Reset 续作模式应隐藏 Merge / Rebase 选择，并使用 Reset 文案提交", async () => {
    const mounted = createMountedRoot();
    const onConfirm = vi.fn();

    await act(async () => {
      mounted.root.render(
        <FixTrackedBranchDialog
          open={true}
          continueMode="reset"
          preview={{
            requestedRepoRoot: "/repo",
            multiRoot: false,
            defaultUpdateMethod: "merge",
            hasFixableIssues: true,
            issues: [
              {
                repoRoot: "/repo",
                rootName: "repo",
                kind: "repository",
                issueCode: "no-tracked-branch",
                message: "当前分支 main 未配置远端上游分支",
                branch: "main",
                suggestedRemote: "origin",
                suggestedRemoteBranch: "main",
                remoteOptions: [
                  {
                    name: "origin",
                    branches: ["main"],
                  },
                ],
                canFix: true,
                canSetAsTracked: true,
              },
            ],
          }}
          submitting={false}
          onClose={() => {}}
          onConfirm={(payload) => {
            onConfirm(payload);
          }}
        />,
      );
    });

    expect(document.body.textContent).not.toContain("继续更新方式");
    expect(document.body.textContent).toContain("修复跟踪分支后会继续执行本次重置更新");

    await act(async () => {
      getButton("应用并继续重置").click();
    });

    expect(onConfirm).toHaveBeenCalledWith({
      selections: [
        expect.objectContaining({
          repoRoot: "/repo",
          remote: "origin",
          remoteBranch: "main",
          setAsTracked: true,
        }),
      ],
      updateMethod: "merge",
    });

    mounted.unmount();
  });
});
