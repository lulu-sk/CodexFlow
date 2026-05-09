// @vitest-environment jsdom

import React, { act } from "react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { SmartOperationDialog } from "./smart-operation-dialog";
import type { GitUpdateOperationProblem } from "./types";
import zhGit from "../../../locales/zh/git.json";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 为 smart operation 对话框测试初始化 Git i18n，避免插值占位符原样渲染到断言结果中。
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

const LOCAL_CHANGES_PROBLEM: GitUpdateOperationProblem = {
  operation: "merge",
  kind: "local-changes-overwritten",
  title: "本地改动会被覆盖",
  description: "需要先处理本地改动。",
  files: ["src/app.ts"],
  source: "smart-operation",
  actions: [],
};

/**
 * 创建并挂载一个 React Root，供 smart operation 对话框在 jsdom 中渲染。
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
 * 按按钮文字查找按钮，方便验证“查看这些变更”是否暴露。
 */
function getButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const matched = buttons.find((button) => button.textContent?.includes(text));
  if (!matched)
    throw new Error(`missing button: ${text}`);
  return matched as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

beforeAll(async () => {
  await ensureGitI18nReady();
});

describe("SmartOperationDialog", () => {
  it("本地改动覆盖场景应显示“查看这些变更”入口", async () => {
    const mounted = createMountedRoot();
    const onViewChanges = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <SmartOperationDialog
            open={true}
            problem={LOCAL_CHANGES_PROBLEM}
            submitting={false}
            onClose={() => {}}
            onViewChanges={onViewChanges}
            onAction={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("本次");
      expect(document.body.textContent).toContain("合并");

      await act(async () => {
        getButtonByText("查看这些变更").click();
      });

      expect(onViewChanges).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("不同来源操作应渲染对应的中文操作名", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <SmartOperationDialog
            open={true}
            problem={{
              ...LOCAL_CHANGES_PROBLEM,
              operation: "checkout",
              files: [],
            }}
            submitting={false}
            onClose={() => {}}
            onAction={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("本次");
      expect(document.body.textContent).toContain("签出");
    } finally {
      mounted.unmount();
    }
  });

  it("Cherry-pick 本地改动覆盖场景应显示“显示文件”入口", async () => {
    const mounted = createMountedRoot();
    const onViewChanges = vi.fn();
    try {
      await act(async () => {
        mounted.root.render(
          <SmartOperationDialog
            open={true}
            problem={{
              ...LOCAL_CHANGES_PROBLEM,
              operation: "cherry-pick",
              title: "优选失败",
              description: "您的本地更改将被优选覆盖。提交、搁置或还原您的更改以继续。",
            }}
            submitting={false}
            onClose={() => {}}
            onViewChanges={onViewChanges}
            onAction={() => {}}
          />,
        );
      });

      await act(async () => {
        getButtonByText("显示文件").click();
      });

      expect(onViewChanges).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("智能签出动作存在策略说明时应在按钮旁展示", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <SmartOperationDialog
            open={true}
            problem={{
              ...LOCAL_CHANGES_PROBLEM,
              actions: [{
                kind: "smart",
                label: "智能签出",
                description: "先暂存本地改动，签出完成后再尝试恢复。",
                payloadPatch: { smartCheckout: true, saveChangesPolicy: "stash" },
                variant: "primary",
              }],
            }}
            submitting={false}
            onClose={() => {}}
            onAction={() => {}}
          />,
        );
      });

      expect(document.body.textContent).toContain("先暂存本地改动，签出完成后再尝试恢复。");
    } finally {
      mounted.unmount();
    }
  });
});
