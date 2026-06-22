// @vitest-environment jsdom

import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVirtualWindow, type VirtualWindowState } from "./use-virtual-window";

type VirtualWindowHarnessProps = {
  itemCount: number;
  rowHeight: number;
  overscan: number;
  onState: (state: VirtualWindowState) => void;
};

/**
 * 挂载虚拟列表 hook，便于在 jsdom 中验证首帧和测量后的窗口范围。
 */
function VirtualWindowHarness(props: VirtualWindowHarnessProps): JSX.Element {
  const virtual = useVirtualWindow(props.itemCount, props.rowHeight, props.overscan);
  useEffect(() => {
    props.onState(virtual.windowState);
  }, [props, virtual.windowState]);
  return <div ref={virtual.containerRef} data-testid="scroll-container" />;
}

/**
 * 等待 React effect 完成，避免断言跑在状态更新前。
 */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useVirtualWindow", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushAsync();
    });
    root = null;
    container?.remove();
    container = null;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  it("首帧不应在容器尺寸未知时渲染全部项目", async () => {
    const states: VirtualWindowState[] = [];

    await act(async () => {
      root!.render(
        <VirtualWindowHarness
          itemCount={1000}
          rowHeight={32}
          overscan={8}
          onState={(state) => states.push(state)}
        />,
      );
      await flushAsync();
    });

    expect(states[0]).toMatchObject({
      start: 0,
      end: 52,
    });
    expect(states.some((state) => state.end === 1000)).toBe(false);
  });

  it("容器完成测量后应按视口高度计算可见窗口", async () => {
    const states: VirtualWindowState[] = [];

    await act(async () => {
      root!.render(
        <VirtualWindowHarness
          itemCount={1000}
          rowHeight={32}
          overscan={4}
          onState={(state) => states.push(state)}
        />,
      );
      await flushAsync();
    });

    const scrollContainer = container!.querySelector("[data-testid='scroll-container']") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 320,
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await flushAsync();
    });

    expect(states[states.length - 1]).toMatchObject({
      start: 0,
      end: 18,
      top: 0,
      bottom: (1000 - 18) * 32,
    });
  });
});
