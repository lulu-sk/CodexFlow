// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  useHistoryImageContextMenu,
  type HistoryImageContextMenuPayload,
} from "./history-image-context-menu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

/**
 * 中文说明：启用 React 18 的 act 环境标记，避免测试输出告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 中文说明：渲染一个最小缩略图触发器，用于验证右键菜单与复制图片链路。
 */
function HistoryImageContextMenuHarness(props: { payload: HistoryImageContextMenuPayload }): React.ReactElement {
  const { openContextMenu, contextMenuNode } = useHistoryImageContextMenu(props.payload);
  return (
    <>
      <button type="button" data-testid="history-image-thumb" onContextMenu={openContextMenu}>
        <img data-testid="history-image-thumb-img" alt="history thumb" />
      </button>
      {contextMenuNode}
    </>
  );
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
 * 中文说明：查找菜单里的目标按钮，便于断言右键菜单是否已正确渲染。
 */
function findButtonByText(text: string): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
  return buttons.find((button) => (button.textContent || "").includes(text)) || null;
}

/**
 * 中文说明：派发一次右键事件，模拟用户在缩略图上打开上下文菜单。
 */
async function dispatchContextMenu(target: HTMLElement, init?: MouseEventInit): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 160,
      clientY: 180,
      ...init,
    }));
  });
}

/**
 * 中文说明：派发一次点击事件，用于触发菜单项动作。
 */
async function dispatchClick(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).host;
  document.body.innerHTML = "";
});

describe("useHistoryImageContextMenu", () => {
  it("右键缩略图后应显示复制图片菜单并调用宿主剪贴板接口", async () => {
    const copyToClipboard = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = {
      images: {
        copyToClipboard,
      },
      utils: {
        copyText: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <HistoryImageContextMenuHarness
            payload={{
              localPath: "C:\\repo\\image.png",
              src: "file:///C:/repo/image.png",
              fallbackSrc: "data:image/png;base64,AAAA",
            }}
          />,
        );
      });

      const thumbImage = document.querySelector("[data-testid=\"history-image-thumb-img\"]") as HTMLImageElement | null;
      if (!thumbImage) throw new Error("missing history image thumb");

      await dispatchContextMenu(thumbImage);

      const copyImageButton = findButtonByText("history:copyImage");
      expect(copyImageButton).toBeTruthy();

      if (!copyImageButton) throw new Error("missing copy image button");
      await dispatchClick(copyImageButton);

      expect(copyToClipboard).toHaveBeenCalledTimes(1);
      expect(copyToClipboard).toHaveBeenCalledWith({
        localPath: "C:\\repo\\image.png",
        src: "file:///C:/repo/image.png",
        fallbackSrc: "data:image/png;base64,AAAA",
      });
      expect(findButtonByText("history:copyImage")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
