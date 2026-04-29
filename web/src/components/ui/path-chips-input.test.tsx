// @vitest-environment jsdom

import React, { act, useState } from "react";
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

vi.mock("@/components/ui/interactive-image-preview", () => ({
  __esModule: true,
  default: ({ src, fallbackSrc, alt, dialogTitle, dialogDescription, dialogMeta, children }: any) => {
    const primarySrc = String(src || "");
    const stableFallbackSrc = String(fallbackSrc || "");
    const [resolvedSrc, setResolvedSrc] = React.useState<string>(primarySrc || stableFallbackSrc);
    React.useEffect(() => {
      setResolvedSrc(primarySrc || stableFallbackSrc);
    }, [primarySrc, stableFallbackSrc]);
    return (
      <div
        data-testid="interactive-image-preview"
        data-dialog-title={String(dialogTitle || "")}
        data-dialog-description={String(dialogDescription || "")}
      >
        <div data-testid="interactive-image-preview-meta">{dialogMeta}</div>
        {children({
          hasPreview: !!resolvedSrc,
          resolvedSrc,
          isUsingFallback: !!stableFallbackSrc && resolvedSrc === stableFallbackSrc && resolvedSrc !== primarySrc,
          hoverTriggerProps: {
            onMouseEnter: () => {},
            onMouseLeave: () => {},
          },
          openDialog: () => {},
          imageProps: {
            src: resolvedSrc,
            alt: String(alt || ""),
            onError: () => {
              if (stableFallbackSrc && resolvedSrc !== stableFallbackSrc) setResolvedSrc(stableFallbackSrc);
            },
          },
        })}
      </div>
    );
  },
}));

/**
 * 中文说明：启用 React 18 的 act 环境标记，避免测试输出告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 中文说明：在单测中将 requestAnimationFrame 改为同步执行，确保撤回后的选区恢复及时生效。
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
 * 中文说明：卸载并清理 React Root，避免不同用例之间相互污染。
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
 * 中文说明：创建并挂载一个独立的 React Root。
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
 * 中文说明：渲染最小化的 `PathChipsInput` 场景，只保留复制文件名验证所需的受控属性。
 */
async function renderPathChipsInput(chips: PathChip[], props?: Partial<React.ComponentProps<typeof PathChipsInput>>): Promise<() => void> {
  const mounted = createMountedRoot();
  await act(async () => {
    mounted.root.render(
      <PathChipsInput
        chips={chips}
        onChipsChange={() => {}}
        draft=""
        onDraftChange={() => {}}
        {...props}
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

/**
 * 中文说明：测试用受控包装器，模拟真实页面里 `draft/chips` 由父组件托管的场景。
 */
function Harness(props: { initialDraft?: string; initialChips?: PathChip[] }): React.ReactElement {
  const [draft, setDraft] = useState(props.initialDraft ?? "");
  const [chips, setChips] = useState<PathChip[]>(props.initialChips ?? []);
  return (
    <div>
      <PathChipsInput
        draft={draft}
        onDraftChange={setDraft}
        chips={chips}
        onChipsChange={setChips}
        multiline
      />
      <div data-testid="chips-count">{chips.length}</div>
    </div>
  );
}

/**
 * 中文说明：从容器中获取实际编辑器（当前组件在测试里使用 textarea）。
 */
function getEditor(host: HTMLElement): HTMLTextAreaElement | HTMLInputElement {
  const editor = host.querySelector("textarea, input");
  if (!editor) throw new Error("missing editor");
  return editor as HTMLTextAreaElement | HTMLInputElement;
}

/**
 * 中文说明：读取当前 Chip 数量，便于断言删除/撤回结果。
 */
function getChipCount(host: HTMLElement): number {
  const el = host.querySelector("[data-testid=\"chips-count\"]");
  if (!el) throw new Error("missing chips count");
  return Number(el.textContent || "0");
}

/**
 * 中文说明：查找当前可见的 Chip 删除按钮。
 */
function getChipRemoveButton(host: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(host.querySelectorAll("button")) as HTMLButtonElement[];
  const button = buttons.find((candidate) => (candidate.textContent || "").includes("×"));
  if (!button) throw new Error("missing chip remove button");
  return button;
}

/**
 * 中文说明：获取 Chip 上显示的缩略图元素。
 */
function getChipPreviewImage(host: HTMLElement): HTMLImageElement {
  const image = host.querySelector("img");
  if (!image) throw new Error("missing chip preview image");
  return image as HTMLImageElement;
}

/**
 * 中文说明：派发一次键盘事件，用于模拟 Backspace / Ctrl+Z / Ctrl+Y。
 */
async function dispatchKeyDown(
  target: HTMLElement,
  init: KeyboardEventInit,
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * 中文说明：派发一次输入事件，并附带 inputType 供历史合并逻辑识别。
 */
async function dispatchInput(
  editor: HTMLTextAreaElement | HTMLInputElement,
  nextValue: string,
  inputType: string,
): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
    if (!setter) throw new Error("missing native value setter");
    setter.call(editor, nextValue);
    try { editor.setSelectionRange(nextValue.length, nextValue.length); } catch {}
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, cancelable: true, inputType })
      : new Event("input", { bubbles: true, cancelable: true });
    if (!("inputType" in event)) {
      Object.defineProperty(event, "inputType", { value: inputType });
    }
    editor.dispatchEvent(event);
  });
}

/**
 * 中文说明：依次派发 mousedown + click，模拟用户点击删除按钮。
 */
async function clickElement(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/**
 * 中文说明：派发右键菜单事件，返回事件是否未被 preventDefault。
 */
async function dispatchContextMenu(target: HTMLElement): Promise<{ allowed: boolean; defaultPrevented: boolean }> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  let allowed = false;
  await act(async () => {
    allowed = target.dispatchEvent(event);
  });
  return { allowed, defaultPrevented: event.defaultPrevented };
}

describe("PathChipsInput（复制名称按钮）", () => {
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

  it("目录 Chip 显示带 aria-label 的复制文件夹名称按钮", async () => {
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

    const copyButton = document.querySelector('button[aria-label="common:files.copyFolderName"]');
    expect(copyButton).not.toBeNull();
  });

  it("普通文件 Chip 即便带有预览字段也不应渲染图片缩略图", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "plain-file-chip",
        chipKind: "file",
        fileName: "notes.md",
        winPath: "C:\\repo\\notes.md",
        wslPath: "/mnt/c/repo/notes.md",
        previewUrl: "blob:unexpected-file-preview",
        type: "text/markdown",
      }),
    ]);

    expect(document.querySelector("img")).toBeNull();
  });

  it("WSL 模式下图片 Chip 弹窗元信息显示 WSL 路径", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "image-chip",
        chipKind: "image",
        fileName: "image.png",
        previewUrl: "blob:test-image",
        type: "image/png",
        winPath: "C:\\repo\\image.png",
        wslPath: "/mnt/c/repo/image.png",
      }),
    ], {
      runEnv: "wsl",
    });

    const previewHost = document.querySelector('[data-testid="interactive-image-preview"]') as HTMLElement | null;
    const previewMeta = document.querySelector('[data-testid="interactive-image-preview-meta"]') as HTMLElement | null;
    expect(previewHost?.dataset.dialogDescription || "").toBe("");
    expect(previewMeta?.textContent || "").toContain("/mnt/c/repo/image.png");
    expect(previewMeta?.textContent || "").not.toContain("C:\\repo\\image.png");
  });

  it("PowerShell 模式下图片 Chip 弹窗元信息显示 Windows 路径", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "image-chip-pwsh",
        chipKind: "image",
        fileName: "image.png",
        previewUrl: "blob:test-image-pwsh",
        type: "image/png",
        winPath: "C:\\repo\\image.png",
        wslPath: "/mnt/c/repo/image.png",
      }),
    ], {
      runEnv: "pwsh",
    });

    const previewMeta = document.querySelector('[data-testid="interactive-image-preview-meta"]') as HTMLElement | null;
    expect(previewMeta?.textContent || "").toContain("C:\\repo\\image.png");
    expect(previewMeta?.textContent || "").not.toContain("/mnt/c/repo/image.png");
  });

  it("PowerShell 相对路径图片在无 blob 时仍回退到绝对 Windows 预览地址", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "image-chip-pwsh-relative",
        chipKind: "image",
        fileName: "image.png",
        previewUrl: "",
        type: "image/png",
        winPath: "assets\\image.png",
        wslPath: "assets/image.png",
      }),
    ], {
      runEnv: "pwsh",
      winRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
      projectPathStyle: "relative",
    });

    const previewImage = getChipPreviewImage(document.body);
    expect(previewImage.getAttribute("src") || "").toBe("file:///C:/repo/assets/image.png");
  });
});

describe("PathChipsInput 撤回历史", () => {
  let cleanup: (() => void) | null = null;
  let restoreRaf: (() => void) | null = null;

  afterEach(() => {
    try { restoreRaf?.(); } catch {}
    restoreRaf = null;
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("Backspace 删除的 chip 可以通过 Ctrl+Z 撤回", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    const initialChip: PathChip = {
      id: "file-1",
      blob: new Blob(),
      previewUrl: "",
      type: "text/path",
      size: 0,
      saved: true,
      fromPaste: false,
      wslPath: "/repo/README.md",
      fileName: "README.md",
      chipKind: "file",
    } as PathChip;

    await act(async () => {
      mounted.root.render(<Harness initialChips={[initialChip]} />);
    });

    const editor = getEditor(mounted.host);
    editor.focus();

    await dispatchKeyDown(editor, { key: "Backspace" });
    expect(getChipCount(mounted.host)).toBe(0);
    expect(mounted.host.textContent || "").not.toContain("README.md");

    await dispatchKeyDown(editor, { key: "z", ctrlKey: true });
    expect(getChipCount(mounted.host)).toBe(1);
    expect(mounted.host.textContent || "").toContain("README.md");
  });

  it("鼠标删除的图片 chip 可以撤回，且焦点保持在输入框", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    const imageChip: PathChip = {
      id: "image-1",
      blob: new Blob(),
      previewUrl: "blob:test-image",
      type: "image/png",
      size: 12,
      saved: true,
      fromPaste: true,
      wslPath: "/repo/image.png",
      winPath: "C:\\repo\\image.png",
      fileName: "image.png",
      chipKind: "image",
    } as PathChip;

    await act(async () => {
      mounted.root.render(<Harness initialChips={[imageChip]} />);
    });

    const editor = getEditor(mounted.host);
    editor.focus();
    const removeButton = getChipRemoveButton(mounted.host);

    await clickElement(removeButton);
    expect(getChipCount(mounted.host)).toBe(0);
    expect(document.activeElement).toBe(editor);

    await dispatchKeyDown(editor, { key: "z", ctrlKey: true });
    expect(getChipCount(mounted.host)).toBe(1);
    expect(mounted.host.textContent || "").toContain("image.png");
  });

  it("文字输入支持连续撤回与 Ctrl+Y 重做", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<Harness />);
    });

    const editor = getEditor(mounted.host);
    editor.focus();

    await dispatchInput(editor, "a", "insertText");
    await dispatchInput(editor, "ab", "insertText");
    await dispatchInput(editor, "abc", "insertText");
    expect(editor.value).toBe("abc");

    await dispatchKeyDown(editor, { key: "z", ctrlKey: true });
    expect(editor.value).toBe("");

    await dispatchKeyDown(editor, { key: "y", ctrlKey: true });
    expect(editor.value).toBe("abc");
  });

  it("图片 blob 预览失效后应回退到 file 预览", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    const imageChip: PathChip = {
      id: "image-fallback-1",
      blob: new Blob(),
      previewUrl: "blob:revoked-image",
      type: "image/png",
      size: 12,
      saved: true,
      fromPaste: true,
      wslPath: "/repo/image.png",
      winPath: "C:\\repo\\image.png",
      fileName: "image.png",
      chipKind: "image",
    } as PathChip;

    await act(async () => {
      mounted.root.render(<Harness initialChips={[imageChip]} />);
    });

    const image = getChipPreviewImage(mounted.host);
    expect(image.getAttribute("src")).toBe("blob:revoked-image");

    await act(async () => {
      image.dispatchEvent(new Event("error", { bubbles: false, cancelable: false }));
    });

    expect(image.getAttribute("src")).toBe("file:///C:/repo/image.png");
  });
});

describe("PathChipsInput 右键菜单事件", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("输入区右键应放行原生菜单，并阻止父级右键菜单截获", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    const parentContextMenu = vi.fn((event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
    });

    await act(async () => {
      mounted.root.render(
        <div onContextMenu={parentContextMenu}>
          <Harness initialDraft="hello" />
        </div>
      );
    });

    const editor = getEditor(mounted.host);
    const result = await dispatchContextMenu(editor);

    expect(parentContextMenu).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
    expect(result.defaultPrevented).toBe(false);
  });

  it("目录 Chip 右键菜单提供复制文件夹名称选项", async () => {
    cleanup = await renderPathChipsInput([
      createPathChip({
        id: "dir-context-chip",
        chipKind: "file",
        fileName: "docs",
        winPath: "C:\\repo\\docs\\",
        wslPath: "/mnt/c/repo/docs/",
        isDir: true,
      }),
    ]);

    const label = Array.from(document.querySelectorAll("span")).find((span) => span.textContent === "docs");
    if (!label) throw new Error("missing directory chip label");

    const result = await dispatchContextMenu(label as HTMLElement);
    const menuItem = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "common:files.copyFolderName");

    expect(result.defaultPrevented).toBe(true);
    expect(menuItem).not.toBeUndefined();
  });
});
