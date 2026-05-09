// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { Dialog, DialogContent } from "./dialog";

/**
 * 启用 React 18 的 act 环境标记，避免测试输出告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 在单测中将 requestAnimationFrame 改为同步执行，避免动画导致的异步 setState 产生 act 警告。
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
 * 卸载并清理 React Root（用 act 包裹，避免 React 测试告警）。
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
 * 创建并挂载一个 React Root 容器，便于在 jsdom 中渲染组件。
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
 * 最小化 Dialog 场景组件。
 * - 背景包含 button/textarea（用于模拟“焦点仍在背景元素”）
 * - 弹窗包含 textarea/取消/确认按钮（用于验证 Enter 自动确认策略）
 */
function DialogHarness(props: { onConfirm: () => void }): React.ReactElement {
  return (
    <div>
      <button data-testid="bg-btn">Background Button</button>
      <textarea data-testid="bg-ta" />

      <Dialog open={true}>
        <DialogContent>
          <textarea data-testid="dlg-ta" />
          <button data-testid="dlg-cancel">Cancel</button>
          <button data-testid="dlg-confirm" data-cf-dialog-primary="true" onClick={props.onConfirm}>
            Confirm
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 从 DOM 中按 data-testid 获取元素，并在缺失时抛错，便于定位失败原因。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing element data-testid=${id}`);
  return el as T;
}

/**
 * 返回当前渲染出的顶层 DialogContent 节点，便于断言默认样式是否被正确覆盖。
 */
function getDialogContentElement(): HTMLDivElement {
  const el = document.querySelector('[data-cf-dialog-content="true"]');
  if (!el)
    throw new Error("missing dialog content");
  return el as HTMLDivElement;
}

describe("Dialog（全局 Enter 自动确认）", () => {
  let cleanup: (() => void) | null = null;
  let restoreRaf: (() => void) | null = null;

  afterEach(() => {
    try { restoreRaf?.(); } catch {}
    restoreRaf = null;
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("弹窗打开时：Enter 应优先触发主按钮（背景 button 聚焦）", async () => {
    let confirmed = 0;
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<DialogHarness onConfirm={() => { confirmed += 1; }} />);
    });

    const bg = getByTestId<HTMLButtonElement>("bg-btn");
    bg.focus();

    await act(async () => {
      bg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(confirmed).toBe(1);
  });

  it("弹窗打开时：Enter 应优先触发主按钮（背景 textarea 聚焦）", async () => {
    let confirmed = 0;
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<DialogHarness onConfirm={() => { confirmed += 1; }} />);
    });

    const bg = getByTestId<HTMLTextAreaElement>("bg-ta");
    bg.focus();

    await act(async () => {
      bg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(confirmed).toBe(1);
  });

  it("弹窗打开时：Enter 在弹窗 textarea 内不应触发主按钮（用于换行）", async () => {
    let confirmed = 0;
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<DialogHarness onConfirm={() => { confirmed += 1; }} />);
    });

    const dlg = getByTestId<HTMLTextAreaElement>("dlg-ta");
    dlg.focus();

    await act(async () => {
      dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(confirmed).toBe(0);
  });

  it("调用方提供自定义宽度与内边距时，不应再保留默认 w/p utility", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(
        <Dialog open={true}>
          <DialogContent className="w-[720px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
            custom
          </DialogContent>
        </Dialog>,
      );
    });

    const dialog = getDialogContentElement();
    expect(dialog.className).toContain("w-[720px]");
    expect(dialog.className).toContain("p-0");
    expect(dialog.className).not.toContain("w-[520px]");
    expect(dialog.className).not.toContain("p-6");
  });

  it("未提供自定义宽度与内边距时，应保留 DialogContent 默认样式", async () => {
    restoreRaf = installSyncRequestAnimationFrame();
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(
        <Dialog open={true}>
          <DialogContent>default</DialogContent>
        </Dialog>,
      );
    });

    const dialog = getDialogContentElement();
    expect(dialog.className).toContain("w-[520px]");
    expect(dialog.className).toContain("p-6");
    expect(dialog.className).toContain("max-h-[calc(100vh-2rem)]");
    expect(dialog.className).toContain("overflow-y-auto");
  });
});
