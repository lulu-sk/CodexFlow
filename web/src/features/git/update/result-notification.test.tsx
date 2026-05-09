// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { ResultNotification } from "./result-notification";
import type { GitUpdatePostAction, GitUpdateSessionNotificationData } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供结果通知组件在 jsdom 中渲染。
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
 * 按按钮文案查找结果通知中的按钮元素；缺失时直接抛错，便于定位断言失败。
 */
function getButtonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(label));
  if (!matched) throw new Error(`missing button: ${label}`);
  return matched as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ResultNotification", () => {
  it("应保留未知 post action，并把点击事件透传给上层处理器", async () => {
    const mounted = createMountedRoot();
    const onPostAction = vi.fn();
    const notification: GitUpdateSessionNotificationData = {
      title: "3 个文件已更新",
      description: "测试通知",
      updatedFilesCount: 3,
      receivedCommitsCount: 2,
      filteredCommitsCount: 2,
      ranges: [
        {
          repoRoot: "/repo",
          rootName: "root",
          range: {
            start: "11111111aaaaaaaa",
            end: "22222222bbbbbbbb",
          },
          commitCount: 1,
          fileCount: 2,
        },
        {
          repoRoot: "/repo/lib",
          rootName: "lib",
          range: {
            start: "33333333aaaaaaaa",
            end: "44444444bbbbbbbb",
          },
          commitCount: 1,
          fileCount: 1,
        },
      ],
      primaryRange: undefined,
      skippedRoots: [],
      postActions: [
        { kind: "view-commits", label: "查看提交" },
        { kind: "open-saved-changes", label: "查看搁置记录", repoRoot: "/repo/lib", payload: { repoRoot: "/repo/lib", saveChangesPolicy: "shelve" } },
      ],
    };

    await act(async () => {
      mounted.root.render(
        <ResultNotification
          notification={notification}
          resultView={{
            title: notification.title,
            description: notification.description,
            updatedFilesCount: notification.updatedFilesCount,
            receivedCommitsCount: notification.receivedCommitsCount,
            filteredCommitsCount: notification.filteredCommitsCount,
            postActions: [],
            roots: [
              {
                repoRoot: "/repo/lib",
                rootName: "lib",
                kind: "submodule",
                resultCode: "SKIPPED",
                resultLabel: "已跳过",
                detail: "由父仓递归更新",
                detailLines: ["Detached 子模块 · 由父仓递归更新", "保留搁置记录 #1"],
                badges: ["Detached 子模块", "保留已保存"],
                actions: [{ kind: "open-parent-repo", label: "打开父仓", repoRoot: "/repo" }],
                isUpdated: false,
                isProblematic: false,
              },
            ],
          }}
          expanded={true}
          onToggleExpanded={() => {}}
          onFocusConsole={() => {}}
          onPostAction={(action: GitUpdatePostAction) => {
            onPostAction(action);
          }}
        />,
      );
    });

    expect(document.body.textContent).toContain("查看提交");
    expect(document.body.textContent).toContain("查看搁置记录");
    expect(document.body.textContent).toContain("Detached 子模块");
    expect(document.body.textContent).toContain("保留搁置记录 #1");

    await act(async () => {
      getButtonByText("查看搁置记录").click();
    });

    expect(onPostAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "open-saved-changes",
        label: "查看搁置记录",
      }),
    );

    mounted.unmount();
  });

  it("仅有 resultView 时也应渲染标题与 root action，并透传点击事件", async () => {
    const mounted = createMountedRoot();
    const onPostAction = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <ResultNotification
            notification={null}
            resultView={{
              title: "更新项目已完成",
              description: "存在仓级后续动作",
              postActions: [{ kind: "resolve-conflicts", label: "处理冲突", repoRoot: "/repo/lib" }],
              roots: [
                {
                  repoRoot: "/repo/lib",
                  rootName: "lib",
                  kind: "repository",
                  resultCode: "INCOMPLETE",
                  resultLabel: "未完成",
                  detail: "仍有未解决冲突",
                  detailLines: ["仍有未解决冲突"],
                  badges: ["未完成状态"],
                  actions: [{ kind: "resolve-conflicts", label: "处理该仓冲突", repoRoot: "/repo/lib" }],
                  isUpdated: false,
                  isProblematic: true,
                },
              ],
            }}
            expanded={true}
            onToggleExpanded={() => {}}
            onFocusConsole={() => {}}
            onPostAction={(action) => {
              onPostAction(action);
            }}
          />,
        );
      });

      expect(document.body.textContent).toContain("更新项目已完成");
      expect(document.body.textContent).toContain("处理该仓冲突");

      await act(async () => {
        getButtonByText("处理该仓冲突").click();
      });

      expect(onPostAction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "resolve-conflicts",
          repoRoot: "/repo/lib",
        }),
      );
    } finally {
      mounted.unmount();
    }
  });
});
