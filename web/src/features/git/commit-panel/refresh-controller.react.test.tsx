// @vitest-environment jsdom

import React, { act, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { createCommitRefreshController, useLatestAsyncRunner } from "./refresh-controller";

/**
 * 启用 React 18 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建 jsdom 挂载根节点，供 hook 回归测试复用。
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
 * 测试桩组件，暴露稳定异步调用入口，便于验证回调重建后的身份与调用目标。
 */
function StableRunnerHarness(props: {
  runner: (label: string) => Promise<void>;
  captures: Array<(label: string) => Promise<void>>;
}): JSX.Element | null {
  const stableRunner = useLatestAsyncRunner(props.runner);
  props.captures.push(stableRunner);
  return null;
}

/** 模拟工作台在刷新途中更新仓库状态，验证控制器仍串行运行且使用最新回调。 */
function RefreshControllerHarness(props: {
  runner: (options?: { keepLog?: boolean }) => Promise<void>;
  captures: Array<ReturnType<typeof createCommitRefreshController<{ keepLog?: boolean }>>>;
}): JSX.Element | null {
  const stableRunner = useLatestAsyncRunner(props.runner);
  const controller = useMemo(() => createCommitRefreshController(stableRunner, (_running, pending) => pending), [stableRunner]);
  props.captures.push(controller);
  return null;
}

describe("useLatestAsyncRunner", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("回调重建后应保持入口稳定，并调用最新实现", async () => {
    const captures: Array<(label: string) => Promise<void>> = [];
    const firstRunner = vi.fn(async (_label: string) => {});
    const secondRunner = vi.fn(async (_label: string) => {});
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(
        <StableRunnerHarness runner={firstRunner} captures={captures} />,
      );
    });
    await act(async () => {
      mounted.root.render(
        <StableRunnerHarness runner={secondRunner} captures={captures} />,
      );
    });

    expect(captures).toHaveLength(2);
    expect(captures[0]).toBe(captures[1]);

    await act(async () => {
      await captures[1]("refresh");
    });

    expect(firstRunner).not.toHaveBeenCalled();
    expect(secondRunner).toHaveBeenCalledTimes(1);
    expect(secondRunner).toHaveBeenCalledWith("refresh");
  });

  it("刷新途中重渲染不能创建并行控制器，排队请求应调用最新实现", async () => {
    const captures: Array<ReturnType<typeof createCommitRefreshController<{ keepLog?: boolean }>>> = [];
    let release!: () => void;
    const firstRunner = vi.fn(async () => await new Promise<void>((resolve) => { release = resolve; }));
    const secondRunner = vi.fn(async () => {});
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;
    await act(async () => {
      mounted.root.render(<RefreshControllerHarness runner={firstRunner} captures={captures} />);
    });
    const firstRequest = captures[0].request({ keepLog: false });
    await act(async () => {
      mounted.root.render(<RefreshControllerHarness runner={secondRunner} captures={captures} />);
    });
    expect(captures[1]).toBe(captures[0]);
    expect(captures[1].isBusy()).toBe(true);
    const nextRequest = captures[1].request({ keepLog: true });
    expect(secondRunner).not.toHaveBeenCalled();
    release();
    await Promise.all([firstRequest, nextRequest]);
    expect(firstRunner).toHaveBeenCalledTimes(1);
    expect(secondRunner).toHaveBeenCalledTimes(1);
    expect(secondRunner).toHaveBeenCalledWith({ keepLog: true });
    expect(captures[1].isBusy()).toBe(false);
  });
});
