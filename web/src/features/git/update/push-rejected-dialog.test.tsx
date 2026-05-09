// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { PushRejectedDialog } from "./push-rejected-dialog";
import type { GitPushRejectedDecision } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供 Push Rejected 对话框在 jsdom 中渲染。
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
 * 构造最小 Push Rejected 决策模型，按不同 reject 类型复用测试输入。
 */
function createDecision(type: GitPushRejectedDecision["type"]): GitPushRejectedDecision {
  if (type === "stale-info") {
    return {
      type,
      title: "带租约保护的强制推送被拒绝",
      description: "远端引用已变化，当前租约保护已过期。",
      branch: "feature/demo",
      upstream: "origin/feature/demo",
      remote: "origin",
      remoteBranch: "feature/demo",
      actions: [
        {
          kind: "force-push",
          label: "继续强制推送（无租约保护）",
          payloadPatch: { forcePush: true, forceWithLease: false },
          variant: "danger",
        },
        {
          kind: "cancel",
          label: "取消",
          payloadPatch: {},
          variant: "secondary",
        },
      ],
    };
  }
  if (type === "rejected-other") {
    return {
      type,
      title: "远端拒绝了推送",
      description: "远端拒绝接收当前推送，请先处理远端策略或服务端钩子限制后再重试。",
      branch: "feature/demo",
      upstream: "origin/feature/demo",
      remote: "origin",
      remoteBranch: "feature/demo",
      actions: [
        {
          kind: "cancel",
          label: "关闭",
          payloadPatch: {},
          variant: "secondary",
        },
      ],
    };
  }
  return {
    type,
    title: "推送被拒绝，需要先同步远端",
    description: "远端分支 origin/feature/demo 已领先于当前分支，请先更新后再重试推送。",
    branch: "feature/demo",
    upstream: "origin/feature/demo",
    remote: "origin",
    remoteBranch: "feature/demo",
    actions: [
      {
        kind: "update-with-merge",
        label: "先更新（合并）再推送",
        payloadPatch: { updateMethod: "merge" },
        variant: "primary",
      },
      {
        kind: "force-with-lease",
        label: "强制推送（保留租约保护）",
        payloadPatch: { forceWithLease: true },
        variant: "danger",
      },
      {
        kind: "cancel",
        label: "取消",
        payloadPatch: {},
        variant: "secondary",
      },
    ],
  };
}

/**
 * 按动作类型读取对话框按钮，缺失时返回 null，供不同分支断言按钮集合。
 */
function queryActionButton(kind: string): HTMLButtonElement | null {
  return document.querySelector(`[data-testid="push-rejected-action-${kind}"]`) as HTMLButtonElement | null;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PushRejectedDialog", () => {
  it("stale-info 应展示普通强推决策，并把动作透传给上层", async () => {
    const mounted = createMountedRoot();
    const onAction = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <PushRejectedDialog
            open={true}
            decision={createDecision("stale-info")}
            submitting={false}
            onClose={() => {}}
            onAction={onAction}
          />,
        );
      });

      expect(document.body.textContent).toContain("租约保护已过期");
      expect(document.body.textContent).toContain("继续强制推送");
      expect(document.body.textContent).not.toContain("先更新（合并）再推送");
      expect(queryActionButton("force-push")).toBeTruthy();
      expect(queryActionButton("force-with-lease")).toBeNull();

      await act(async () => {
        queryActionButton("force-push")?.click();
      });

      expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
        kind: "force-push",
      }));
    } finally {
      mounted.unmount();
    }
  });

  it("rejected-other 应只展示关闭动作和远端限制说明", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <PushRejectedDialog
            open={true}
            decision={createDecision("rejected-other")}
            submitting={false}
            onClose={() => {}}
            onAction={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("远端拒绝");
      expect(document.body.textContent).toContain("服务端钩子");
      expect(queryActionButton("cancel")?.textContent).toContain("关闭");
      expect(queryActionButton("force-push")).toBeNull();
      expect(queryActionButton("update-with-merge")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
