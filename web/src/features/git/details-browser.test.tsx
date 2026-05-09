// @vitest-environment jsdom

import React, { act, createRef } from "react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { GitDetailsBrowser, type GitDetailsBrowserTreeNode } from "./details-browser";
import type { GitCommitDetailsActionAvailability, GitLogDetails } from "./types";
import zhGit from "../../locales/zh/git.json";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 为提交详情浏览器测试初始化最小 Git i18n，确保右键菜单与摘要文案按真实界面语言渲染。
 */
async function ensureGitI18nReady(): Promise<void> {
  if (i18next.isInitialized) {
    i18next.addResourceBundle("zh-CN", "git", zhGit, true, true);
    await i18next.changeLanguage("zh-CN");
    return;
  }

  await i18next.use(initReactI18next).init({
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    interpolation: {
      escapeValue: false,
    },
    resources: {
      "zh-CN": {
        git: zhGit,
      },
    },
  });
}

/**
 * 创建并挂载一个 React Root，供 details browser 在 jsdom 中渲染。
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
 * 等待一个 animation frame，确保 speed search 输入框自动聚焦与焦点回收副作用已经完成。
 */
async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

const DETAILS: GitLogDetails = {
  mode: "single",
  detail: {
    hash: "abc1234",
    shortHash: "abc1234",
    subject: "feat: test details browser",
    body: "body",
    authorName: "CodexFlow",
    authorEmail: "codexflow@example.com",
    authorDate: "2025-03-01T00:00:00.000Z",
    parents: ["def5678"],
    branches: ["main"],
    tags: [],
    lineStats: { additions: 1, deletions: 0 },
    files: [{ path: "src/app.ts", status: "M" }],
  },
};

const DETAIL_NODE: GitDetailsBrowserTreeNode = {
  key: "file:src/app.ts",
  name: "app.ts",
  fullPath: "src/app.ts",
  isFile: true,
  count: 1,
  status: "M",
  filePaths: ["src/app.ts"],
};

const SECOND_DETAIL_NODE: GitDetailsBrowserTreeNode = {
  key: "file:src/other.ts",
  name: "other.ts",
  fullPath: "src/other.ts",
  isFile: true,
  count: 1,
  status: "M",
  filePaths: ["src/other.ts"],
};

const AVAILABILITY: GitCommitDetailsActionAvailability = {
  actions: {
    editSource: { visible: true, enabled: false, reason: "测试禁用" },
    openRepositoryVersion: { visible: true, enabled: true },
    revertSelectedChanges: { visible: true, enabled: true },
    applySelectedChanges: { visible: true, enabled: true },
    extractSelectedChanges: { visible: true, enabled: true },
    dropSelectedChanges: { visible: true, enabled: true },
    showHistoryForRevision: { visible: true, enabled: true },
  },
};

afterEach(() => {
  document.body.innerHTML = "";
});

beforeAll(async () => {
  await ensureGitI18nReady();
});

describe("GitDetailsBrowser", () => {
  it("应按当前产品设计隐藏重复 toolbar 动作，并在点击文件时打开 Diff", async () => {
    const mounted = createMountedRoot();
    const onOpenDiff = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <GitDetailsBrowser
            details={DETAILS}
            detailFilesFlat={["src/app.ts"]}
            detailFileRows={[{ node: DETAIL_NODE, depth: 0 }]}
            detailCountMap={new Map()}
            selectedDetailNodeKeys={[DETAIL_NODE.key]}
            selectedDetailPaths={["src/app.ts"]}
            selectedDetailPrimaryPath="src/app.ts"
            detailTreeExpanded={{}}
            detailSpeedSearch=""
            detailSpeedSearchOpen={false}
            activeDetailHash="abc1234"
            showParentChanges={true}
            detailActionAvailability={AVAILABILITY}
            detailLineStatsSummary={{
              additionsText: "+1",
              deletionsText: "-0",
              totalText: "共 1 行",
              netText: "净变化 +1 行",
              netDirection: "increase",
            }}
            orderedSelectedCommitHashesNewestFirst={["abc1234"]}
            orderedSelectedCommitHashesOldestFirst={["abc1234"]}
            speedSearchRootRef={createRef<HTMLDivElement>()}
            containerRef={createRef<HTMLDivElement>()}
            renderSpeedSearchText={(text) => text}
            resolveDetailPathCommitHashes={() => ["abc1234"]}
            toCommitFileStatusText={() => "修改"}
            toLocalDateText={() => "2025-03-01"}
            resolveStatusToneClassName={() => "cf-git-tone-accent"}
            onExpandAll={() => {}}
            onCollapseAll={() => {}}
            onFocus={() => {}}
            onBlur={() => {}}
            onKeyDown={() => {}}
            onMouseDown={() => {}}
            onSpeedSearchChange={() => {}}
            onMoveSpeedSearchMatch={() => {}}
            onResetSpeedSearch={() => {}}
            onSelectNode={() => {}}
            onToggleExpanded={() => {}}
            onEnsureSelected={() => {}}
            onOpenDiff={onOpenDiff}
            onRunAction={() => {}}
            onRefresh={() => {}}
            onToggleShowParentChanges={() => {}}
          />,
        );
      });

      const buttons = Array.from(document.querySelectorAll("button"));
      expect(buttons.some((button) => button.textContent?.includes("显示差异"))).toBe(false);

      await act(async () => {
        const fileButton = buttons.find((button) => button.textContent?.includes("app.ts"));
        if (!fileButton)
          throw new Error("missing file row");
        fileButton.click();
      });

      expect(onOpenDiff).toHaveBeenCalledWith("src/app.ts", "abc1234", undefined);
    } finally {
      mounted.unmount();
    }
  });

  it("Ctrl+F 打开后应聚焦真实输入框，且树容器失焦到输入框时不应立即关闭搜索", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <TestGitDetailsBrowserSpeedSearchHarness />,
        );
      });

      const treeRoot = mounted.host.querySelector(".cf-scroll-area") as HTMLDivElement | null;
      expect(treeRoot).not.toBeNull();

      await act(async () => {
        treeRoot?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      });
      await flushAnimationFrame();

      const searchInput = mounted.host.querySelector('[data-testid="details-browser-speed-search-input"]') as HTMLInputElement | null;
      expect(searchInput).not.toBeNull();
      expect(document.activeElement).toBe(searchInput);

      await act(async () => {
        treeRoot?.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: searchInput }));
      });
      expect(mounted.host.querySelector('[data-testid="details-browser-speed-search-input"]')).not.toBeNull();

      await act(async () => {
        if (searchInput) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(searchInput, "src");
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      expect(searchInput?.value).toBe("src");
    } finally {
      mounted.unmount();
    }
  });

  it("提交详情右键菜单应对齐 IDEA 的历史与父项文案，并在多提交聚合时禁用历史动作", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <GitDetailsBrowser
            details={{
              mode: "multiple",
              selectedCount: 2,
              files: [{ path: "src/app.ts", count: 2, status: "M", hashes: ["def5678", "abc1234"] }],
            }}
            detailFilesFlat={["src/app.ts"]}
            detailFileRows={[{ node: DETAIL_NODE, depth: 0 }]}
            detailCountMap={new Map([["src/app.ts", 2]])}
            selectedDetailNodeKeys={[DETAIL_NODE.key]}
            selectedDetailPaths={["src/app.ts"]}
            selectedDetailPrimaryPath="src/app.ts"
            detailTreeExpanded={{}}
            detailSpeedSearch=""
            detailSpeedSearchOpen={false}
            activeDetailHash="abc1234"
            showParentChanges={true}
            detailActionAvailability={AVAILABILITY}
            detailLineStatsSummary={null}
            orderedSelectedCommitHashesNewestFirst={["def5678", "abc1234"]}
            orderedSelectedCommitHashesOldestFirst={["def5678", "abc1234"]}
            speedSearchRootRef={createRef<HTMLDivElement>()}
            containerRef={createRef<HTMLDivElement>()}
            renderSpeedSearchText={(text) => text}
            resolveDetailPathCommitHashes={() => ["def5678", "abc1234"]}
            toCommitFileStatusText={() => "修改"}
            toLocalDateText={() => "2025-03-01"}
            resolveStatusToneClassName={() => "cf-git-tone-accent"}
            onExpandAll={() => {}}
            onCollapseAll={() => {}}
            onFocus={() => {}}
            onBlur={() => {}}
            onKeyDown={() => {}}
            onMouseDown={() => {}}
            onSpeedSearchChange={() => {}}
            onMoveSpeedSearchMatch={() => {}}
            onResetSpeedSearch={() => {}}
            onSelectNode={() => {}}
            onToggleExpanded={() => {}}
            onEnsureSelected={() => {}}
            onOpenDiff={() => {}}
            onRunAction={() => {}}
            onRefresh={() => {}}
            onToggleShowParentChanges={() => {}}
          />,
        );
      });

      const fileButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("app.ts"));
      expect(fileButton).toBeTruthy();

      await act(async () => {
        fileButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 24, clientY: 24 }));
      });

      const menuButtons = Array.from(document.querySelectorAll(".cf-git-menu-item")) as HTMLButtonElement[];
      const compareRevisionsButton = menuButtons.find((button) => button.textContent?.includes("比较版本"));
      const pathHistoryButton = menuButtons.find((button) => button.textContent?.includes("迄今为止的历史记录"));
      const parentChangesButton = menuButtons.find((button) => button.textContent?.includes("显示对父项的更改"));
      expect(compareRevisionsButton).toBeTruthy();
      expect(compareRevisionsButton?.disabled).toBe(false);
      expect(pathHistoryButton).toBeTruthy();
      expect(pathHistoryButton?.disabled).toBe(true);
      expect(pathHistoryButton?.title).toBe("多选提交聚合详情暂不支持");
      expect(parentChangesButton).toBeTruthy();
      expect(parentChangesButton?.textContent).toContain("✓ 显示对父项的更改");
    } finally {
      mounted.unmount();
    }
  });

  it("当前右键节点属于选区时，从修订中获取应携带整个选区文件", async () => {
    const mounted = createMountedRoot();
    const onRunAction = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <GitDetailsBrowser
            details={{
              mode: "single",
              detail: {
                ...DETAILS.detail,
                files: [
                  { path: "src/app.ts", status: "M" },
                  { path: "src/other.ts", status: "M" },
                ],
              },
            }}
            detailFilesFlat={["src/app.ts", "src/other.ts"]}
            detailFileRows={[
              { node: DETAIL_NODE, depth: 0 },
              { node: SECOND_DETAIL_NODE, depth: 0 },
            ]}
            detailCountMap={new Map()}
            selectedDetailNodeKeys={[DETAIL_NODE.key, SECOND_DETAIL_NODE.key]}
            selectedDetailPaths={["src/app.ts", "src/other.ts"]}
            selectedDetailPrimaryPath="src/app.ts"
            detailTreeExpanded={{}}
            detailSpeedSearch=""
            detailSpeedSearchOpen={false}
            activeDetailHash="abc1234"
            showParentChanges={true}
            detailActionAvailability={AVAILABILITY}
            detailLineStatsSummary={null}
            orderedSelectedCommitHashesNewestFirst={["abc1234"]}
            orderedSelectedCommitHashesOldestFirst={["abc1234"]}
            speedSearchRootRef={createRef<HTMLDivElement>()}
            containerRef={createRef<HTMLDivElement>()}
            renderSpeedSearchText={(text) => text}
            resolveDetailPathCommitHashes={() => ["abc1234"]}
            toCommitFileStatusText={() => "修改"}
            toLocalDateText={() => "2025-03-01"}
            resolveStatusToneClassName={() => "cf-git-tone-accent"}
            onExpandAll={() => {}}
            onCollapseAll={() => {}}
            onFocus={() => {}}
            onBlur={() => {}}
            onKeyDown={() => {}}
            onMouseDown={() => {}}
            onSpeedSearchChange={() => {}}
            onMoveSpeedSearchMatch={() => {}}
            onResetSpeedSearch={() => {}}
            onSelectNode={() => {}}
            onToggleExpanded={() => {}}
            onEnsureSelected={() => {}}
            onOpenDiff={() => {}}
            onRunAction={onRunAction}
            onRefresh={() => {}}
            onToggleShowParentChanges={() => {}}
          />,
        );
      });

      const fileButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("other.ts"));
      expect(fileButton).toBeTruthy();

      await act(async () => {
        fileButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 24, clientY: 24 }));
      });

      const restoreButton = Array.from(document.querySelectorAll(".cf-git-menu-item"))
        .find((button) => button.textContent?.includes("从修订中获取")) as HTMLButtonElement | undefined;
      expect(restoreButton).toBeTruthy();
      expect(restoreButton?.disabled).toBe(false);

      await act(async () => {
        restoreButton?.click();
      });

      expect(onRunAction).toHaveBeenCalledWith(
        "restoreFromRevision",
        "src/other.ts",
        "abc1234",
        ["src/app.ts", "src/other.ts"],
        ["abc1234"],
      );
    } finally {
      mounted.unmount();
    }
  });

  it("多提交聚合里每个文件唯一归属单提交时，应允许打开仓库版本和从修订中获取", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <GitDetailsBrowser
            details={{
              mode: "multiple",
              selectedCount: 2,
              files: [
                { path: "src/app.ts", count: 1, status: "M", hashes: ["def5678"] },
                { path: "src/other.ts", count: 1, status: "M", hashes: ["abc1234"] },
              ],
            }}
            detailFilesFlat={["src/app.ts", "src/other.ts"]}
            detailFileRows={[
              { node: DETAIL_NODE, depth: 0 },
              { node: SECOND_DETAIL_NODE, depth: 0 },
            ]}
            detailCountMap={new Map([
              ["src/app.ts", 1],
              ["src/other.ts", 1],
            ])}
            selectedDetailNodeKeys={[DETAIL_NODE.key, SECOND_DETAIL_NODE.key]}
            selectedDetailPaths={["src/app.ts", "src/other.ts"]}
            selectedDetailPrimaryPath="src/app.ts"
            detailTreeExpanded={{}}
            detailSpeedSearch=""
            detailSpeedSearchOpen={false}
            activeDetailHash="abc1234"
            showParentChanges={true}
            detailActionAvailability={AVAILABILITY}
            detailLineStatsSummary={null}
            orderedSelectedCommitHashesNewestFirst={["abc1234", "def5678"]}
            orderedSelectedCommitHashesOldestFirst={["def5678", "abc1234"]}
            speedSearchRootRef={createRef<HTMLDivElement>()}
            containerRef={createRef<HTMLDivElement>()}
            renderSpeedSearchText={(text) => text}
            resolveDetailPathCommitHashes={(pathText) => pathText === "src/app.ts" ? ["def5678"] : ["abc1234"]}
            toCommitFileStatusText={() => "修改"}
            toLocalDateText={() => "2025-03-01"}
            resolveStatusToneClassName={() => "cf-git-tone-accent"}
            onExpandAll={() => {}}
            onCollapseAll={() => {}}
            onFocus={() => {}}
            onBlur={() => {}}
            onKeyDown={() => {}}
            onMouseDown={() => {}}
            onSpeedSearchChange={() => {}}
            onMoveSpeedSearchMatch={() => {}}
            onResetSpeedSearch={() => {}}
            onSelectNode={() => {}}
            onToggleExpanded={() => {}}
            onEnsureSelected={() => {}}
            onOpenDiff={() => {}}
            onRunAction={() => {}}
            onRefresh={() => {}}
            onToggleShowParentChanges={() => {}}
          />,
        );
      });

      const fileButton = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("other.ts"));
      expect(fileButton).toBeTruthy();

      await act(async () => {
        fileButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 24, clientY: 24 }));
      });

      const menuButtons = Array.from(document.querySelectorAll(".cf-git-menu-item")) as HTMLButtonElement[];
      const compareLocalButton = menuButtons.find((button) => button.textContent?.includes("与本地比较"));
      const openRepositoryVersionButton = menuButtons.find((button) => button.textContent?.includes("打开仓库版本"));
      const restoreFromRevisionButton = menuButtons.find((button) => button.textContent?.includes("从修订中获取"));
      expect(compareLocalButton).toBeTruthy();
      expect(compareLocalButton?.disabled).toBe(true);
      expect(openRepositoryVersionButton).toBeTruthy();
      expect(openRepositoryVersionButton?.disabled).toBe(false);
      expect(restoreFromRevisionButton).toBeTruthy();
      expect(restoreFromRevisionButton?.disabled).toBe(false);
    } finally {
      mounted.unmount();
    }
  });
});

/**
 * 构建一个最小状态托管的提交详情 speed search 测试壳，复现 git-workbench 内的打开、失焦与重置语义。
 */
function TestGitDetailsBrowserSpeedSearchHarness(): JSX.Element {
  const speedSearchRootRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [detailSpeedSearch, setDetailSpeedSearch] = React.useState<string>("");
  const [detailSpeedSearchOpen, setDetailSpeedSearchOpen] = React.useState<boolean>(false);

  /**
   * 在测试壳内统一关闭并清空搜索；需要时把焦点还给树容器，模拟真实父组件行为。
   */
  const resetSpeedSearch = (options?: { restoreFocus?: boolean }): void => {
    setDetailSpeedSearchOpen(false);
    setDetailSpeedSearch("");
    if (options?.restoreFocus)
      window.requestAnimationFrame(() => {
        containerRef.current?.focus();
      });
  };

  return (
    <GitDetailsBrowser
      details={DETAILS}
      detailFilesFlat={["src/app.ts"]}
      detailFileRows={[{ node: DETAIL_NODE, depth: 0 }]}
      detailCountMap={new Map()}
      selectedDetailNodeKeys={[DETAIL_NODE.key]}
      selectedDetailPaths={["src/app.ts"]}
      selectedDetailPrimaryPath="src/app.ts"
      detailTreeExpanded={{}}
      detailSpeedSearch={detailSpeedSearch}
      detailSpeedSearchOpen={detailSpeedSearchOpen}
      activeDetailHash="abc1234"
      showParentChanges={true}
      detailActionAvailability={AVAILABILITY}
      detailLineStatsSummary={{
        additionsText: "+1",
        deletionsText: "-0",
        totalText: "共 1 行",
        netText: "净变化 +1 行",
        netDirection: "increase",
      }}
      orderedSelectedCommitHashesNewestFirst={["abc1234"]}
      orderedSelectedCommitHashesOldestFirst={["abc1234"]}
      speedSearchRootRef={speedSearchRootRef}
      containerRef={containerRef}
      renderSpeedSearchText={(text) => text}
      resolveDetailPathCommitHashes={() => ["abc1234"]}
      toCommitFileStatusText={() => "修改"}
      toLocalDateText={() => "2025-03-01"}
      resolveStatusToneClassName={() => "cf-git-tone-accent"}
      onExpandAll={() => {}}
      onCollapseAll={() => {}}
      onFocus={() => {}}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        const root = speedSearchRootRef.current;
        if (root && nextTarget && root.contains(nextTarget)) return;
        resetSpeedSearch();
      }}
      onKeyDown={(event) => {
        const ctrl = event.ctrlKey || event.metaKey;
        if (ctrl && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setDetailSpeedSearchOpen(true);
        }
      }}
      onMouseDown={() => {}}
      onSpeedSearchChange={(nextQuery) => {
        setDetailSpeedSearch(nextQuery);
      }}
      onMoveSpeedSearchMatch={() => {}}
      onResetSpeedSearch={resetSpeedSearch}
      onSelectNode={() => {}}
      onToggleExpanded={() => {}}
      onEnsureSelected={() => {}}
      onOpenDiff={() => {}}
      onRunAction={() => {}}
      onRefresh={() => {}}
      onToggleShowParentChanges={() => {}}
    />
  );
}
