// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { InteractiveRebaseDialog } from "./interactive-rebase-dialog";
import type { GitInteractiveRebasePlan } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN_FIXTURE: GitInteractiveRebasePlan = {
  targetHash: "1111111",
  headHash: "2222222",
  baseHash: "0000000",
  rootMode: false,
  warnings: [
    {
      code: "autosquash",
      title: "检测到 autosquash 提交",
      message: "warning",
    },
  ],
  entries: [
    {
      hash: "1111111",
      shortHash: "1111111",
      subject: "first",
      authorName: "CodexFlow",
      authorDate: "2026-03-11T10:00:00.000Z",
      fullMessage: "first full message",
      action: "pick",
      originalIndex: 0,
    },
    {
      hash: "2222222",
      shortHash: "2222222",
      subject: "second",
      authorName: "CodexFlow",
      authorDate: "2026-03-11T10:01:00.000Z",
      fullMessage: "second full message",
      action: "reword",
      originalIndex: 1,
    },
  ],
};

/**
 * 创建并挂载一个 React Root，供 interactive rebase 对话框在 jsdom 中渲染。
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
 * 按 data-testid 读取元素，缺失时直接抛错，方便定位测试失败点。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element data-testid=${id}`);
  return element as T;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("InteractiveRebaseDialog", () => {
  it("应允许切换行、修改动作与消息，并触发移动/提交回调", async () => {
    const mounted = createMountedRoot();
    const onSelectHash = vi.fn();
    const onMoveEntry = vi.fn();
    const onMoveEntryToEdge = vi.fn();
    const onChangeAction = vi.fn();
    const onChangeMessage = vi.fn();
    const onSelectDiffPath = vi.fn();
    const onOpenDiff = vi.fn();
    const onFillSuggestedMessage = vi.fn();
    const onReset = vi.fn();
    const onSubmit = vi.fn();
    const onRequestCancel = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <InteractiveRebaseDialog
            open={true}
            plan={PLAN_FIXTURE}
            entries={PLAN_FIXTURE.entries}
            selectedHash="2222222"
            submitting={false}
            detailsLoading={false}
            selectedDiffPath="src/app.ts"
            selectedDetails={{
              mode: "single",
              detail: {
                hash: "2222222",
                shortHash: "2222222",
                parents: ["1111111"],
                authorName: "CodexFlow",
                authorEmail: "codexflow@example.com",
                authorDate: "2026-03-11T10:01:00.000Z",
                subject: "second",
                body: "second body detail",
                files: [{ status: "M", path: "src/app.ts" }],
                lineStats: { additions: 1, deletions: 0 },
                branches: ["main"],
                tags: [],
              },
            }}
            onOpenChange={() => {}}
            onSelectHash={onSelectHash}
            onMoveEntry={onMoveEntry}
            onMoveEntryToEdge={onMoveEntryToEdge}
            onChangeAction={onChangeAction}
            onChangeMessage={onChangeMessage}
            onSelectDiffPath={onSelectDiffPath}
            onOpenDiff={onOpenDiff}
            onFillSuggestedMessage={onFillSuggestedMessage}
            onReset={onReset}
            onSubmit={onSubmit}
            onRequestCancel={onRequestCancel}
          />,
        );
      });

      await act(async () => {
        getByTestId<HTMLButtonElement>("interactive-rebase-row-1111111").click();
      });
      await act(async () => {
        const select = getByTestId<HTMLSelectElement>("interactive-rebase-action-select");
        select.value = "squash";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        const textarea = getByTestId<HTMLTextAreaElement>("interactive-rebase-message-input");
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        valueSetter?.call(textarea, "rewritten message");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        getByTestId<HTMLButtonElement>("interactive-rebase-detail-file-0").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-open-diff").click();
      });
      await act(async () => {
        getByTestId<HTMLButtonElement>("interactive-rebase-fill-suggestion").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-quick-drop").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-move-top").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-move-up").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-reset").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-cancel").click();
        getByTestId<HTMLButtonElement>("interactive-rebase-submit").click();
      });

      expect(document.body.textContent).toContain("检测到 autosquash 提交");
      expect(document.body.textContent).toContain("second body detail");
      expect(onSelectHash).toHaveBeenCalledWith("1111111");
      expect(onChangeAction).toHaveBeenCalledWith("2222222", "squash");
      expect(onChangeAction).toHaveBeenCalledWith("2222222", "drop");
      expect(onChangeMessage).toHaveBeenCalledWith("2222222", "rewritten message");
      expect(onSelectDiffPath).toHaveBeenCalledWith("src/app.ts");
      expect(onOpenDiff).toHaveBeenCalledTimes(1);
      expect(onFillSuggestedMessage).toHaveBeenCalledWith("2222222");
      expect(onMoveEntryToEdge).toHaveBeenCalledWith("2222222", "top");
      expect(onMoveEntry).toHaveBeenCalledWith("2222222", -1);
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(onRequestCancel).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("首条提交没有前序目标时应禁用 fixup/squash，并支持快捷键触发 diff 与动作切换", async () => {
    const mounted = createMountedRoot();
    const onChangeAction = vi.fn();
    const onOpenDiff = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <InteractiveRebaseDialog
            open={true}
            plan={PLAN_FIXTURE}
            entries={PLAN_FIXTURE.entries}
            selectedHash="1111111"
            submitting={false}
            detailsLoading={false}
            selectedDiffPath="src/app.ts"
            selectedDetails={{
              mode: "single",
              detail: {
                hash: "1111111",
                shortHash: "1111111",
                parents: ["base"],
                authorName: "CodexFlow",
                authorEmail: "codexflow@example.com",
                authorDate: "2026-03-11T10:00:00.000Z",
                subject: "first",
                body: "first body detail",
                files: [{ status: "M", path: "src/app.ts" }],
                lineStats: { additions: 1, deletions: 0 },
                branches: ["main"],
                tags: [],
              },
            }}
            onOpenChange={() => {}}
            onSelectHash={() => {}}
            onMoveEntry={() => {}}
            onMoveEntryToEdge={() => {}}
            onChangeAction={onChangeAction}
            onChangeMessage={() => {}}
            onSelectDiffPath={() => {}}
            onOpenDiff={onOpenDiff}
            onFillSuggestedMessage={() => {}}
            onReset={() => {}}
            onSubmit={() => {}}
            onRequestCancel={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLButtonElement>("interactive-rebase-quick-fixup").disabled).toBe(true);
      expect(getByTestId<HTMLButtonElement>("interactive-rebase-quick-squash").disabled).toBe(true);

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }));
      });

      expect(onChangeAction).toHaveBeenCalledWith("1111111", "reword");
      expect(onOpenDiff).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });
});
