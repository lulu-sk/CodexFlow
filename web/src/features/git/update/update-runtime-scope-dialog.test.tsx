// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { GitUpdateOptionsSnapshot } from "./types";
import { UpdateRuntimeScopeDialog } from "./update-runtime-scope-dialog";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供运行期范围对话框在 jsdom 中渲染。
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
 * 按文本内容定位 label 内的 checkbox 输入，便于驱动范围切换。
 */
function getCheckboxByText(text: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const matched = labels.find((label) => label.textContent?.includes(text));
  const input = matched?.querySelector("input[type='checkbox']");
  if (!input) throw new Error(`missing checkbox: ${text}`);
  return input as HTMLInputElement;
}

/**
 * 按按钮文案查找按钮元素，供触发提交动作复用。
 */
function getButton(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(label));
  if (!matched) throw new Error(`missing button: ${label}`);
  return matched as HTMLButtonElement;
}

/**
 * 构造运行期范围选择所需的最小快照。
 */
function createSnapshot(): GitUpdateOptionsSnapshot {
  return {
    options: {
      updateMethod: "rebase",
      saveChangesPolicy: "shelve",
      pull: {
        mode: "merge",
        options: [],
      },
      scope: {
        syncStrategy: "linked",
        linkedRepoRoots: ["/repo-lib"],
        skippedRepoRoots: [],
        includeNestedRoots: true,
        rootScanMaxDepth: 8,
      },
    },
    methodResolution: {
      selectedMethod: "rebase",
      selectionSource: "stored",
      resolvedMethod: "rebase",
      resolvedSource: "explicit",
      currentBranch: "main",
      saveChangesPolicy: "shelve",
    },
    scopePreview: {
      requestedRepoRoot: "/repo",
      multiRoot: true,
      includedRepoRoots: ["/repo", "/repo-lib", "/repo/submodule-a"],
      skippedRoots: [
        {
          repoRoot: "/repo-detached",
          rootName: "repo-detached",
          kind: "repository",
          reasonCode: "detached-head",
          reason: "游离 HEAD，已跳过",
        },
      ],
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
        {
          repoRoot: "/repo/submodule-a",
          rootName: "submodule-a",
          kind: "submodule",
          parentRepoRoot: "/repo",
          depth: 1,
          detachedHead: true,
          source: "submodule",
          included: true,
        },
      ],
    },
    pullCapabilities: {
      noVerify: true,
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("UpdateRuntimeScopeDialog", () => {
  it("应把本次勾选结果转换为运行期 payload patch", async () => {
    const mounted = createMountedRoot();
    const onConfirm = vi.fn();

    await act(async () => {
      mounted.root.render(
        <UpdateRuntimeScopeDialog
          open={true}
          snapshot={createSnapshot()}
          submitting={false}
          onClose={() => {}}
          onConfirm={onConfirm}
        />,
      );
    });

    await act(async () => {
      getCheckboxByText("repo-lib").click();
    });
    await act(async () => {
      getButton("按当前选择继续").click();
    });

    expect(document.body.textContent).toContain("执行风险");
    expect(document.body.textContent).toContain("游离 HEAD");
    expect(document.body.textContent).toContain("本次默认跳过");
    expect(document.body.textContent).toContain("repo-detached");

    expect(onConfirm).toHaveBeenCalledWith({
      repoRoots: ["/repo", "/repo/submodule-a"],
      skipRoots: ["/repo-lib"],
      includeNestedRoots: true,
      rootScanMaxDepth: 8,
    });

    mounted.unmount();
  });
});
