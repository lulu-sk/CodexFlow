// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { OperationStateCard } from "./operation-state-card";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供进行中操作条组件在 jsdom 中渲染。
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
 * 按 data-testid 获取元素，缺失时直接抛错，便于定位失败原因。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element data-testid=${id}`);
  return element as T;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("OperationStateCard", () => {
  it("存在未解决冲突时应禁用 continue，并展示对应提示", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <OperationStateCard
            state="rebasing"
            unresolvedConflictCount={2}
            resolvedConflictCount={0}
            submitting={null}
            onResolveConflicts={() => {}}
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLDivElement>("operation-state-card").textContent).toContain("当前仓库处于变基过程中");
      expect(getByTestId<HTMLDivElement>("operation-state-hint").textContent).toContain("还有 2 个文件存在未解决冲突");
      expect(getByTestId<HTMLButtonElement>("operation-state-resolve").disabled).toBe(false);
      expect(getByTestId<HTMLButtonElement>("operation-state-continue").disabled).toBe(true);
      expect(getByTestId<HTMLButtonElement>("operation-state-abort").disabled).toBe(false);
    } finally {
      mounted.unmount();
    }
  });

  it("无未解决冲突时应允许继续和中止，并回调对应处理器", async () => {
    const mounted = createMountedRoot();
    const onContinue = vi.fn();
    const onAbort = vi.fn();
    const onResolveConflicts = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <OperationStateCard
            state="grafting"
            unresolvedConflictCount={0}
            resolvedConflictCount={1}
            submitting={null}
            onResolveConflicts={onResolveConflicts}
            onContinue={onContinue}
            onAbort={onAbort}
          />,
        );
      });

      await act(async () => {
        getByTestId<HTMLButtonElement>("operation-state-continue").click();
      });
      await act(async () => {
        getByTestId<HTMLButtonElement>("operation-state-abort").click();
      });

      expect(getByTestId<HTMLDivElement>("operation-state-hint").textContent).toContain("已有 1 个冲突文件完成解析");
      expect(document.querySelector('[data-testid="operation-state-resolve"]')).toBeNull();
      expect(onResolveConflicts).toHaveBeenCalledTimes(0);
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(onAbort).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("Cherry-pick 冲突已全部解决时应支持改写为提交收尾文案", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <OperationStateCard
            state="grafting"
            unresolvedConflictCount={0}
            resolvedConflictCount={1}
            submitting={null}
            continueLabelOverride="提交更改"
            hintOverride="所有冲突已解决，现在请提交更改以完成当前优选。"
            onResolveConflicts={() => {}}
            onContinue={() => {}}
            onAbort={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLDivElement>("operation-state-hint").textContent).toContain("提交更改以完成当前优选");
      expect(getByTestId<HTMLButtonElement>("operation-state-continue").textContent).toContain("提交更改");
    } finally {
      mounted.unmount();
    }
  });
});
