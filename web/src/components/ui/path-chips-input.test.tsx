// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import PathChipsInput, { type PathChip } from "./path-chips-input";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/components/at-mention-new/AtCommandPalette", () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

/**
 * 中文说明：启用 React 18 的 act 环境标记，避免测试输出告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 中文说明：卸载并清理 React Root，避免测试间 DOM 相互污染。
 */
function safeUnmountRoot(root: Root, host: HTMLElement): void {
  try {
    act(() => {
      try { root.unmount(); } catch {}
    });
  } catch {
    try { root.unmount(); } catch {}
  }
  try { host.remove(); } catch {}
}

/**
 * 中文说明：创建并挂载一个 React Root，便于在 jsdom 中验证组件渲染结果。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      safeUnmountRoot(root, host);
    },
  };
}

/**
 * 中文说明：渲染最小化的 `PathChipsInput` 场景，只保留本次验证所需的受控属性。
 */
async function renderPathChipsInput(chips: PathChip[]): Promise<() => void> {
  const mounted = createMountedRoot();
  await act(async () => {
    mounted.root.render(
      <PathChipsInput
        chips={chips}
        onChipsChange={() => {}}
        draft=""
        onDraftChange={() => {}}
      />
    );
  });
  return mounted.unmount;
}

/**
 * 中文说明：构造满足 `PathChip` 类型要求的最小测试对象，避免测试样例掺入无关字段。
 */
function createPathChip(overrides: Partial<PathChip> & { isDir?: boolean }): PathChip {
  return {
    id: "test-chip",
    blob: new Blob(["test"], { type: "text/plain" }),
    previewUrl: "",
    type: "text/plain",
    size: 4,
    ...overrides,
  } as PathChip;
}

describe("PathChipsInput（复制文件名按钮）", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("文件 Chip 显示带 aria-label 的复制文件名按钮", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "file-chip",
        chipKind: "file",
        fileName: "README.md",
        winPath: "C:\\repo\\README.md",
        wslPath: "/mnt/c/repo/README.md",
      }),
    ]);

    const copyButton = document.querySelector('button[aria-label="common:files.copyFileNameWithExt"]');
    expect(copyButton).not.toBeNull();
  });

  it("目录 Chip 不显示复制文件名按钮", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "dir-chip",
        chipKind: "file",
        fileName: "docs",
        winPath: "C:\\repo\\docs\\",
        wslPath: "/mnt/c/repo/docs/",
        isDir: true,
      }),
    ]);

    const copyButton = document.querySelector('button[aria-label="common:files.copyFileNameWithExt"]');
    expect(copyButton).toBeNull();
  });
});
