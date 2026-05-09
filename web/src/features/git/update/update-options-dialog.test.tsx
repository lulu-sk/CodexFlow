// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { UpdateOptionsDialog } from "./update-options-dialog";
import type { GitUpdateOptions, GitUpdateOptionsSnapshot, GitUpdateScopePreview } from "./types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供 Update Options 对话框在 jsdom 中渲染。
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

/**
 * 按文本内容定位 label 内的 radio 输入，便于驱动选项切换。
 */
function getRadioByText(text: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const matched = labels.find((label) => label.textContent?.includes(text));
  const input = matched?.querySelector("input[type='radio']");
  if (!input) throw new Error(`missing radio: ${text}`);
  return input as HTMLInputElement;
}

/**
 * 按文本内容定位 label 内的 checkbox 输入，便于驱动多仓范围勾选。
 */
function getCheckboxByText(text: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const matched = labels.find((label) => label.textContent?.includes(text));
  const input = matched?.querySelector("input[type='checkbox']");
  if (!input) throw new Error(`missing checkbox: ${text}`);
  return input as HTMLInputElement;
}

/**
 * 构造最小 Update Options 快照，避免每个用例重复拼接无关字段。
 */
function createSnapshot(scopePreview?: Partial<GitUpdateScopePreview>): GitUpdateOptionsSnapshot {
  return {
    options: {
      updateMethod: "merge",
      saveChangesPolicy: "shelve",
      pull: {
        mode: "merge",
        options: [],
      },
      scope: {
        syncStrategy: "current",
        linkedRepoRoots: [],
        skippedRepoRoots: [],
        includeNestedRoots: false,
        rootScanMaxDepth: 8,
      },
    },
    methodResolution: {
      selectedMethod: "merge",
      selectionSource: "stored",
      resolvedMethod: "merge",
      resolvedSource: "explicit",
      currentBranch: "main",
      saveChangesPolicy: "shelve",
    },
    scopePreview: {
      requestedRepoRoot: "/repo",
      multiRoot: false,
      includedRepoRoots: ["/repo"],
      skippedRoots: [],
      roots: [
        {
          repoRoot: "/repo",
          rootName: "repo",
          kind: "repository",
          depth: 0,
          detachedHead: false,
          source: "current",
          included: true,
        },
      ],
      ...(scopePreview || {}),
    },
    pullCapabilities: {
      noVerify: true,
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  (window as any).host = undefined;
});

describe("UpdateOptionsDialog", () => {
  it("应提交多仓默认范围、关联仓与跳过规则", async () => {
    const mounted = createMountedRoot();
    const onConfirm = vi.fn();
    const previewResult: GitUpdateScopePreview = {
      requestedRepoRoot: "/repo",
      multiRoot: true,
      includedRepoRoots: ["/repo", "/repo-lib"],
      skippedRoots: [],
      roots: [
        {
          repoRoot: "/repo",
          rootName: "repo",
          kind: "repository",
          depth: 0,
          detachedHead: false,
          source: "current",
          included: true,
        },
        {
          repoRoot: "/repo-lib",
          rootName: "repo-lib",
          kind: "repository",
          depth: 0,
          detachedHead: false,
          source: "linked",
          included: true,
        },
      ],
    };
    const onRequestScopePreview = vi.fn(async (_options: GitUpdateOptions) => previewResult);
    (window as any).host = {
      utils: {
        chooseFolder: vi.fn(async () => ({ ok: true, path: "/repo-lib" })),
      },
    };

    await act(async () => {
      mounted.root.render(
        <UpdateOptionsDialog
          open={true}
          snapshot={createSnapshot()}
          submitting={false}
          onClose={() => {}}
          onRequestScopePreview={onRequestScopePreview}
          onConfirm={(options) => {
            onConfirm(options);
          }}
        />,
      );
    });

    await act(async () => {
      getRadioByText("联动关联仓").click();
    });
    await act(async () => {
      getButton("添加仓库").click();
    });
    await act(async () => {
      getButton("刷新预览").click();
    });
    await act(async () => {
      getCheckboxByText("repo-lib").click();
    });
    await act(async () => {
      getButton("保存").click();
    });

    expect(onRequestScopePreview).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({
        syncStrategy: "linked",
        linkedRepoRoots: ["/repo-lib"],
      }),
    }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      updateMethod: "merge",
      saveChangesPolicy: "shelve",
      scope: {
        syncStrategy: "linked",
        linkedRepoRoots: ["/repo-lib"],
        skippedRepoRoots: ["/repo-lib"],
        includeNestedRoots: false,
        rootScanMaxDepth: 8,
      },
    }));

    mounted.unmount();
  });
});
