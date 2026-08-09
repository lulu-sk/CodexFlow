// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import HistoryTurnDiffCard from "./history-turn-diff-card";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => key === "history:turnDiffUnmodifiedLines"
      ? `${Number(options?.count || 0)} unmodified lines`
      : key,
  }),
}));

/**
 * 启用 React 18 的 act 环境标记，避免测试输出异步更新告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个独立 React Root，供差异审核弹窗测试使用。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/**
 * 按可见文本查找按钮，模拟用户打开审核弹窗。
 */
function findButtonByText(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => String(button.textContent || "").includes(text)) as HTMLButtonElement | null;
}

/**
 * 挂载差异卡片并打开审核弹窗，供各交互测试复用。
 */
async function mountReviewDiff(diffText: string): Promise<ReturnType<typeof createMountedRoot>> {
  const mounted = createMountedRoot();
  await act(async () => {
    mounted.root.render(
      <HistoryTurnDiffCard
        diffText={diffText}
        cwd="C:\\workspace\\project"
        projectWinPath="C:\\workspace\\project"
        patchable={false}
      />,
    );
  });
  const reviewButton = findButtonByText("history:turnDiffReview");
  if (!reviewButton) {
    mounted.unmount();
    throw new Error("未找到审核按钮");
  }
  await act(async () => reviewButton.click());
  return mounted;
}

const TWO_FILE_DIFF = [
  "diff --git a/src/first.ts b/src/first.ts",
  "--- a/src/first.ts",
  "+++ b/src/first.ts",
  "@@ -1,2 +1,3 @@",
  "-old-one",
  "+new-one",
  "+new-extra",
  " context-one",
  "diff --git a/src/second.ts b/src/second.ts",
  "--- a/src/second.ts",
  "+++ b/src/second.ts",
  "@@ -4 +4 @@",
  "-old-two",
  "+new-two",
].join("\n");

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("HistoryTurnDiffCard", () => {
  it("左侧 Git 按钮只打开 Git 工作台，右侧审核按钮仍打开差异弹窗", async () => {
    const mounted = createMountedRoot();
    const onOpenGit = vi.fn();
    await act(async () => {
      mounted.root.render(
        <HistoryTurnDiffCard
          diffText={TWO_FILE_DIFF}
          cwd="C:\\workspace\\project"
          projectWinPath="C:\\workspace\\project"
          patchable={false}
          onOpenGit={onOpenGit}
        />,
      );
    });

    try {
      const gitButton = document.querySelector<HTMLButtonElement>('button[aria-label="git:workbench.misc.bottomTabs.git"]');
      if (!gitButton) throw new Error("未找到 Git 按钮");
      await act(async () => gitButton.click());
      expect(onOpenGit).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-cf-dialog-content="true"]')).toBeNull();

      const reviewButton = findButtonByText("history:turnDiffReview");
      if (!reviewButton) throw new Error("未找到审核按钮");
      await act(async () => reviewButton.click());
      expect(onOpenGit).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-cf-dialog-content="true"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("审核视图隐藏差异元数据，并将 hunk 头显示为未修改行数", async () => {
    const diffText = [
      "diff --git a/C:/workspace/project/src/example.ts b/C:/workspace/project/src/example.ts",
      "--- a/C:/workspace/project/src/example.ts",
      "+++ b/C:/workspace/project/src/example.ts",
      "@@ -25,2 +25,2 @@",
      "-before",
      "+after",
      " context",
    ].join("\n");
    const mounted = await mountReviewDiff(diffText);

    try {
      const dialog = document.querySelector('[data-cf-dialog-content="true"]');
      const dialogText = String(dialog?.textContent || "");
      expect(dialog?.className).toContain("h-[calc(100vh-1rem)]");
      expect((dialog as HTMLElement | null)?.style.maxHeight).toBe("none");
      expect(dialogText).toContain("24 unmodified lines");
      expect(dialogText).not.toContain("diff --git");
      expect(dialogText).not.toContain("--- a/");
      expect(dialogText).not.toContain("+++ b/");
      expect(dialogText).not.toContain("@@ -25");

      const codeRows = Array.from(dialog?.querySelectorAll("code") || []);
      const deletionCode = codeRows.find((code) => String(code.textContent || "").includes("before"));
      const additionCode = codeRows.find((code) => String(code.textContent || "").includes("after"));
      expect(deletionCode?.lastChild?.textContent).toBe("before");
      expect(additionCode?.lastChild?.textContent).toBe("after");
      expect(deletionCode?.querySelector(".sr-only")?.textContent).toBe("- ");
      expect(additionCode?.querySelector(".sr-only")?.textContent).toBe("+ ");
    } finally {
      mounted.unmount();
    }
  });

  it("文件列表默认不占空间，并可由用户展开和收起", async () => {
    const mounted = await mountReviewDiff(TWO_FILE_DIFF);

    try {
      const dialog = document.querySelector('[data-cf-dialog-content="true"]');
      const showListButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="history:turnDiffShowFileList"]');
      expect(showListButton?.getAttribute("aria-expanded")).toBe("false");
      expect(dialog?.querySelector("aside")).toBeNull();

      if (!showListButton) throw new Error("未找到文件列表开关");
      await act(async () => showListButton.click());
      const aside = dialog?.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside?.classList.contains("bg-[var(--cf-surface-solid)]")).toBe(true);
      expect(aside?.querySelectorAll("[data-history-diff-file-selection]")).toHaveLength(3);

      const hideListButton = aside?.querySelector<HTMLButtonElement>('button[aria-label="history:turnDiffHideFileList"]');
      if (!hideListButton) throw new Error("未找到文件列表收起按钮");
      await act(async () => hideListButton.click());
      expect(dialog?.querySelector("aside")).toBeNull();
      expect(dialog?.querySelector('button[aria-label="history:turnDiffShowFileList"]')?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      mounted.unmount();
    }
  });

  it("支持从文件列表或文件标题聚焦单个文件，并可恢复全部文件", async () => {
    const mounted = await mountReviewDiff(TWO_FILE_DIFF);

    try {
      const dialog = document.querySelector('[data-cf-dialog-content="true"]');
      const content = dialog?.querySelector('[data-history-diff-content="true"]');
      const showListButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="history:turnDiffShowFileList"]');
      if (!showListButton) throw new Error("未找到文件列表开关");
      await act(async () => showListButton.click());

      const secondFileButton = dialog?.querySelector<HTMLButtonElement>('aside button[data-history-diff-file-selection="1"]');
      if (!secondFileButton) throw new Error("未找到第二个文件");
      await act(async () => secondFileButton.click());
      expect(content?.querySelectorAll("[data-history-diff-file-index]")).toHaveLength(1);
      expect(content?.querySelector('[data-history-diff-file-index="1"]')).not.toBeNull();

      const showAllButton = dialog?.querySelector<HTMLButtonElement>('aside button[data-history-diff-file-selection="all"]');
      if (!showAllButton) throw new Error("未找到显示全部文件按钮");
      await act(async () => showAllButton.click());
      expect(content?.querySelectorAll("[data-history-diff-file-index]")).toHaveLength(2);

      const firstFileFocusButton = content?.querySelector<HTMLButtonElement>('[data-history-diff-file-index="0"] button[aria-label="history:turnDiffFocusFile"]');
      if (!firstFileFocusButton) throw new Error("未找到文件标题的聚焦按钮");
      await act(async () => firstFileFocusButton.click());
      expect(content?.querySelectorAll("[data-history-diff-file-index]")).toHaveLength(1);
      expect(content?.querySelector('[data-history-diff-file-index="0"]')).not.toBeNull();

      const focusedHeaderButton = content?.querySelector<HTMLButtonElement>('[data-history-diff-file-index="0"] button[aria-label="history:turnDiffShowAllFiles"]');
      if (!focusedHeaderButton) throw new Error("未找到文件标题的显示全部按钮");
      await act(async () => focusedHeaderButton.click());
      expect(content?.querySelectorAll("[data-history-diff-file-index]")).toHaveLength(2);
    } finally {
      mounted.unmount();
    }
  });

  it("可在上下与左右比较间切换，并正确渲染左右配对行", async () => {
    const mounted = await mountReviewDiff(TWO_FILE_DIFF);

    try {
      const dialog = document.querySelector('[data-cf-dialog-content="true"]');
      const unifiedButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="history:turnDiffUnifiedView"]');
      const splitButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="history:turnDiffSplitView"]');
      expect(unifiedButton?.getAttribute("aria-pressed")).toBe("true");
      expect(splitButton?.getAttribute("aria-pressed")).toBe("false");

      if (!splitButton) throw new Error("未找到左右比较按钮");
      await act(async () => splitButton.click());
      expect(splitButton.getAttribute("aria-pressed")).toBe("true");
      expect(unifiedButton?.getAttribute("aria-pressed")).toBe("false");

      const firstFile = dialog?.querySelector('[data-history-diff-file-index="0"]');
      const splitView = firstFile?.querySelector('[data-history-diff-view="split"]');
      const leftPane = splitView?.querySelector('[data-history-diff-pane="left"]');
      const rightPane = splitView?.querySelector('[data-history-diff-pane="right"]');
      const leftRows = leftPane?.querySelectorAll('[data-history-diff-row="content"]');
      const rightRows = rightPane?.querySelectorAll('[data-history-diff-row="content"]');
      expect(splitView).not.toBeNull();
      expect(splitView?.classList.contains("grid-cols-2")).toBe(true);
      expect(splitView?.classList.contains("w-max")).toBe(false);
      expect(leftPane?.classList.contains("overflow-x-auto")).toBe(true);
      expect(rightPane?.classList.contains("overflow-x-auto")).toBe(true);
      expect(leftRows).toHaveLength(3);
      expect(rightRows).toHaveLength(3);
      expect(leftRows?.[0]?.querySelector("code")?.textContent).toContain("old-one");
      expect(rightRows?.[0]?.querySelector("code")?.textContent).toContain("new-one");
      expect(leftRows?.[1]?.querySelector("code")?.textContent).toBe(" ");
      expect(rightRows?.[1]?.querySelector("code")?.textContent).toContain("new-extra");

      if (!unifiedButton) throw new Error("未找到上下比较按钮");
      await act(async () => unifiedButton.click());
      expect(firstFile?.querySelector('[data-history-diff-view="unified"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
