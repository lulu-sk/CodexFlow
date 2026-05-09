// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { buildConflictMergeMetadata } from "../../../../../electron/git/commitPanel/conflictMergeMetadata";
import { ConflictMergeDialog } from "./conflict-merge-dialog";
import type { GitConflictMergeSnapshot } from "../types";

vi.mock("monaco-editor", () => ({}));
vi.mock("@monaco-editor/react", async () => {
  return {
    loader: {
      config: () => {},
    },
    Editor: (props: { value?: string; options?: { readOnly?: boolean }; onChange?: (value?: string) => void }) => (
      props.options?.readOnly
        ? <pre>{props.value || ""}</pre>
        : (
          <textarea
            data-testid="conflict-merge-editor"
            value={props.value || ""}
            onChange={(event) => props.onChange?.(event.target.value)}
          />
        )
    ),
  };
});

/**
 * 启用 React 18 的 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 统一构造 dialog 测试用冲突快照，避免每个场景重复手写 revision 与 merge metadata。
 */
function createDialogSnapshot(args: {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  working?: string;
}): GitConflictMergeSnapshot {
  return {
    path: args.path,
    base: { label: "基线", text: args.base, available: true },
    ours: { label: "你的更改", text: args.ours, available: true },
    theirs: { label: "他们的更改", text: args.theirs, available: true },
    working: { label: "结果", text: args.working ?? args.base, available: true },
    merge: buildConflictMergeMetadata({
      path: args.path,
      baseText: args.base,
      oursText: args.ours,
      theirsText: args.theirs,
    }),
  };
}

const SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "src/conflict.ts",
  base: "base\n",
  ours: "ours\n",
  theirs: "theirs\n",
  working: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
});

const NON_CONFLICT_SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "src/non-conflict.ts",
  base: "start\nbase-left\nmid\nbase-right\nend\n",
  ours: "start\nours-left\nmid\nbase-right\nend\n",
  theirs: "start\nbase-left\nmid\ntheirs-right\nend\n",
});

const AUTO_RESOLVE_SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "src/auto.ts",
  base: "version: 1.0.0\n",
  ours: "version: 2.0.0\n",
  theirs: "version: 1.0.4\n",
  working: "<<<<<<< ours\nversion: 2.0.0\n=======\nversion: 1.0.4\n>>>>>>> theirs\n",
});

const PROPERTIES_SEMANTIC_SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "src/messages.properties",
  base: "",
  ours: "left.key = left value\n",
  theirs: "right.key = right value\n",
  working: "<<<<<<< ours\nleft.key = left value\n=======\nright.key = right value\n>>>>>>> theirs\n",
});

const TSX_FALLBACK_SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "web/src/App.tsx",
  base: [
    "import {",
    "  GitMerge,",
    "  Loader2,",
    "} from \"lucide-react\";",
    "import {",
    "  loadWorktreeDeletePrefs,",
    "  saveWorktreeDeletePrefs,",
    "} from \"./prefs\";",
    "import type {",
    "  DialogState,",
    "} from \"./types\";",
    "",
    "const icon = GitMerge;",
    "const spacer = keepBase();",
    "const deletePrefs = loadWorktreeDeletePrefs();",
    "",
  ].join("\n"),
  ours: [
    "import {",
    "  GitMerge,",
    "  GitBranch,",
    "  Loader2,",
    "} from \"lucide-react\";",
    "import {",
    "  loadWorktreeDeletePrefs,",
    "  saveWorktreeDeletePrefs,",
    "} from \"./prefs\";",
    "import { resolveWorktreeDeleteResetTargetBranch } from \"./delete\";",
    "import type {",
    "  DialogState,",
    "} from \"./types\";",
    "",
    "const icon = GitBranch;",
    "const spacer = keepBase();",
    "const deletePrefs = resolveWorktreeDeleteResetTargetBranch(loadWorktreeDeletePrefs());",
    "",
  ].join("\n"),
  theirs: [
    "import {",
    "  GitMerge,",
    "  Loader2,",
    "} from \"lucide-react\";",
    "import {",
    "  loadWorktreeDeletePrefs,",
    "  saveWorktreeDeletePrefs,",
    "} from \"./prefs\";",
    "import type {",
    "  DialogState,",
    "} from \"./types\";",
    "",
    "const icon = GitMerge;",
    "const spacer = keepBase();",
    "const deletePrefs = loadWorktreeDeletePrefs();",
    "",
  ].join("\n"),
});

const PARTIAL_AUTO_RESOLVE_SNAPSHOT: GitConflictMergeSnapshot = createDialogSnapshot({
  path: "src/partial-auto.ts",
  base: "header\nbase-left\nmid\nshared\nfooter\n",
  ours: "header\nours-left\nmid\nours-shared\nfooter\n",
  theirs: "header\nbase-left\nmid\ntheirs-shared\nfooter\n",
  working: "header\nbase-left\nmid\n<<<<<<< ours\nours-shared\n=======\ntheirs-shared\n>>>>>>> theirs\nfooter\n",
});

/**
 * 把 requestAnimationFrame 改为同步执行，避免 Dialog 动画延迟干扰断言。
 */
function installSyncRequestAnimationFrame(): () => void {
  const originalRaf = (window as any).requestAnimationFrame as ((cb: FrameRequestCallback) => number) | undefined;
  const originalCancel = (window as any).cancelAnimationFrame as ((id: number) => void) | undefined;
  let seq = 0;
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    seq += 1;
    try { cb(0); } catch {}
    return seq;
  };
  (window as any).cancelAnimationFrame = () => {};
  return () => {
    (window as any).requestAnimationFrame = originalRaf;
    (window as any).cancelAnimationFrame = originalCancel;
  };
}

/**
 * 创建并挂载测试根节点，供 Dialog portal 与组件状态更新共同使用。
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
    },
  };
}

/**
 * 按 data-testid 获取目标元素，缺失时直接抛错，便于快速定位断言失败原因。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element data-testid=${id}`);
  return element as T;
}

/**
 * 按 data-testid 查询元素，缺失时返回 null，供异步等待 merge viewer 就绪使用。
 */
function queryByTestId<T extends HTMLElement>(id: string): T | null {
  return document.querySelector(`[data-testid="${id}"]`) as T | null;
}

/**
 * 点击指定 test id 的元素，并用 act 包裹状态更新。
 */
async function clickByTestId(id: string): Promise<void> {
  await act(async () => {
    getByTestId<HTMLElement>(id).click();
  });
}

/**
 * 等待异步构建的 merge viewer 完成挂载，避免在 viewerState 尚未生成时就开始断言或点击。
 */
async function waitForConflictMergeViewerReadyAsync(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (queryByTestId("conflict-merge-left-host")
      && (queryByTestId("conflict-merge-editor") || queryByTestId("conflict-merge-result-host"))) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    });
  }
  throw new Error("merge viewer did not become ready in time");
}

/**
 * 统一渲染冲突合并对话框，按需覆写 snapshot 与回调，减少测试重复样板。
 */
function renderConflictMergeDialog(props?: {
  snapshot?: GitConflictMergeSnapshot;
  onResolve?: (value: string) => void;
  onResolveWithSource?: (source: "ours" | "theirs") => void;
  onRefresh?: () => void;
  loading?: boolean;
  saving?: boolean;
}): { mounted: { host: HTMLDivElement; root: Root; unmount: () => void } } {
  const mounted = createMountedRoot();
  act(() => {
    mounted.root.render(
      <ConflictMergeDialog
        open={true}
        loading={props?.loading ?? false}
        saving={props?.saving ?? false}
        snapshot={props?.snapshot || SNAPSHOT}
        onOpenChange={() => {}}
        onRefresh={props?.onRefresh || (() => {})}
        onResolve={props?.onResolve || (() => {})}
        onResolveWithSource={props?.onResolveWithSource}
      />,
    );
  });
  return { mounted };
}

describe("ConflictMergeDialog", () => {
  let cleanup: (() => void) | null = null;
  let restoreRaf: (() => void) | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    try { restoreRaf?.(); } catch {}
    restoreRaf = null;
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("应渲染新的工具条与结果列，并默认以基线初始化结果视图", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog();
    cleanup = mounted.unmount;

    expect(getByTestId<HTMLElement>("conflict-merge-toolbar-row")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-footer-row")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-main-viewer")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-bottom-inspector")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-inspector-column")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-block-list")).toBeTruthy();
    expect(getByTestId<HTMLElement>("conflict-merge-bottom-inspector").className).toContain("overflow-y-auto");
    expect(getByTestId<HTMLElement>("conflict-merge-block-list").className).toContain("max-h-[42vh]");
    await waitForConflictMergeViewerReadyAsync();
    expect(getByTestId<HTMLElement>("conflict-merge-left-host").className).toContain("h-full");
    expect(getByTestId<HTMLElement>("conflict-merge-result-host").className).toContain("h-full");
    expect(getByTestId<HTMLElement>("conflict-merge-right-host").className).toContain("h-full");
    expect(getByTestId<HTMLElement>("conflict-merge-left-host").textContent).toContain("ours");
    expect(getByTestId<HTMLElement>("conflict-merge-right-host").textContent).toContain("theirs");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("base\n");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).not.toContain("<<<<<<<");
    expect(document.body.textContent).toContain("应用不冲突的更改:");
    expect(getByTestId<HTMLButtonElement>("conflict-apply-non-conflicts-ours").getAttribute("title")).toContain("应用你的更改中的不冲突更改");
    expect(getByTestId<HTMLButtonElement>("conflict-apply-non-conflicts-all").getAttribute("title")).toBe("应用所有不冲突的更改");
    expect(getByTestId<HTMLButtonElement>("conflict-apply-non-conflicts-theirs").getAttribute("title")).toContain("应用他们的更改中的不冲突更改");
    expect(getByTestId<HTMLButtonElement>("conflict-collapse-unchanged").textContent).toContain("收起未更改的片段");
    expect(getByTestId<HTMLButtonElement>("conflict-collapse-unchanged").getAttribute("title")).toBe("收起未更改的片段");
    expect(getByTestId<HTMLButtonElement>("conflict-collapse-unchanged").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId<HTMLButtonElement>("conflict-auto-resolve-toolbar").getAttribute("title")).toBe("解决简单的冲突");
    expect(document.body.textContent).toContain("查看来源");
    expect(document.body.textContent).toContain("处理当前块");
    expect(document.body.textContent).toContain("当前块采用他们的更改");
    expect(document.body.textContent).toContain("整份采用你的更改");
    expect(document.body.textContent).toContain("基线 = 你和对方开始各自修改前的共同原文");

    await clickByTestId("conflict-collapse-unchanged");
    expect(getByTestId<HTMLButtonElement>("conflict-collapse-unchanged").getAttribute("aria-pressed")).toBe("false");
  });

  it("应支持应用全部不冲突更改，并把最终结果回传给上层", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const onResolve = vi.fn();
    const { mounted } = renderConflictMergeDialog({
      snapshot: NON_CONFLICT_SNAPSHOT,
      onResolve,
    });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    await clickByTestId("conflict-apply-non-conflicts-all");

    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("start\nours-left\nmid\ntheirs-right\nend\n");

    await clickByTestId("conflict-resolve");
    expect(onResolve).toHaveBeenCalledWith("start\nours-left\nmid\ntheirs-right\nend\n");
  });

  it("在只有普通更改块时，解决简单的冲突按钮也应保持可用", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog({
      snapshot: NON_CONFLICT_SNAPSHOT,
    });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(getByTestId<HTMLButtonElement>("conflict-auto-resolve-toolbar").disabled).toBe(false);

    await clickByTestId("conflict-auto-resolve-toolbar");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("start\nours-left\nmid\ntheirs-right\nend\n");
  });

  it("应支持底部接受左侧/右侧动作并回传来源类型", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const onResolveWithSource = vi.fn();
    const { mounted } = renderConflictMergeDialog({ onResolveWithSource });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(document.body.textContent).toContain("整份采用你的更改");
    expect(document.body.textContent).toContain("整份采用他们的更改");
    await clickByTestId("conflict-resolve-left");
    await clickByTestId("conflict-resolve-right");

    expect(onResolveWithSource).toHaveBeenNthCalledWith(1, "ours");
    expect(onResolveWithSource).toHaveBeenNthCalledWith(2, "theirs");
  });

  it("应支持对当前冲突块快速接受右侧，并在部分解决时给出确认", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const onResolve = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { mounted } = renderConflictMergeDialog({ onResolve });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    await clickByTestId("conflict-block-action-theirs");

    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("theirs\n");
    expect(document.body.textContent).toContain("单侧已应用");

    await clickByTestId("conflict-resolve");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();

    await clickByTestId("conflict-resolve");
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenCalledWith("theirs\n");
    confirmSpy.mockRestore();
  });

  it("应支持一键解决简单冲突", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog({ snapshot: AUTO_RESOLVE_SNAPSHOT });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    await clickByTestId("conflict-auto-resolve-toolbar");

    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("version: 2.0.4\n");
  });

  it("真实 .properties semantic 块应被顶部与当前块两个自动处理入口统一处理", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const firstRender = renderConflictMergeDialog({ snapshot: PROPERTIES_SEMANTIC_SNAPSHOT });
    cleanup = firstRender.mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(getByTestId<HTMLButtonElement>("conflict-auto-resolve-toolbar").disabled).toBe(false);
    await clickByTestId("conflict-auto-resolve-toolbar");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("left.key=left value\nright.key=right value");

    cleanup();
    cleanup = null;

    const secondRender = renderConflictMergeDialog({ snapshot: PROPERTIES_SEMANTIC_SNAPSHOT });
    cleanup = secondRender.mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(getByTestId<HTMLButtonElement>("conflict-selected-auto-resolve").disabled).toBe(false);
    await clickByTestId("conflict-selected-auto-resolve");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toBe("left.key=left value\nright.key=right value");
  });

  it("saving 状态下顶部按钮、当前块按钮与 gutter magic resolve 应统一禁用或隐藏", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog({
      snapshot: PROPERTIES_SEMANTIC_SNAPSHOT,
      saving: true,
    });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(getByTestId<HTMLButtonElement>("conflict-auto-resolve-toolbar").disabled).toBe(true);
    expect(getByTestId<HTMLButtonElement>("conflict-selected-auto-resolve").disabled).toBe(true);
    expect(queryByTestId("conflict-gutter-resolve-0")).toBeNull();
  });

  it("TS/TSX 退回文本层后仍应通过普通块应用保持单份 import block", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog({ snapshot: TSX_FALLBACK_SNAPSHOT });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    await clickByTestId("conflict-auto-resolve-toolbar");

    const resultText = getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value;
    const lucideImportMatches = resultText.match(/import \{\n  GitMerge,\n  GitBranch,\n  Loader2,\n\} from "lucide-react";\n/g) || [];
    const typeImportMatches = resultText.match(/import type \{\n  DialogState,\n\} from "\.\/types";\n/g) || [];

    expect(lucideImportMatches).toHaveLength(1);
    expect(typeImportMatches).toHaveLength(1);
    expect(resultText).toContain("const icon = GitBranch;\n");
    expect(resultText).toContain("const deletePrefs = resolveWorktreeDeleteResetTargetBranch(loadWorktreeDeletePrefs());\n");
  });

  it("批量自动处理后若没有剩余块应进入完成状态", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const { mounted } = renderConflictMergeDialog({ snapshot: PARTIAL_AUTO_RESOLVE_SNAPSHOT });
    cleanup = mounted.unmount;

    await waitForConflictMergeViewerReadyAsync();
    expect(document.body.textContent).toContain("当前聚焦：第 1 块");

    await clickByTestId("conflict-auto-resolve-toolbar");

    expect(document.body.textContent).toContain("当前块没有待处理块");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toContain("ours-left");
    expect(getByTestId<HTMLTextAreaElement>("conflict-merge-editor").value).toContain("ours-theirs-shared\n");
  });
});
