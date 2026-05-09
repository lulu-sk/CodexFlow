// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

/**
 * 启用 React 18 的 act 环境标记，避免测试输出告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 卸载并清理 React Root，确保每个用例之间 DOM 状态互不污染。
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
 * 创建并挂载一个 React Root 容器，便于在 jsdom 中验证 Select 初始渲染结果。
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
 * 最小化 Select 测试场景，复用真实 Trigger/Content/Item 组合验证首帧展示文案。
 */
function SelectHarness(props: { value?: string; placeholder?: string }): React.ReactElement {
  return (
    <Select value={props.value}>
      <SelectTrigger data-testid="select-trigger">
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">默认</SelectItem>
        <SelectItem value="feature">功能列表</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * 读取 Select 触发器文本，便于断言首帧展示是否泄漏内部 value。
 */
function getTriggerText(): string {
  const trigger = document.querySelector('[data-testid="select-trigger"]');
  if (!trigger)
    throw new Error("missing select trigger");
  return String(trigger.textContent || "").trim();
}

describe("Select", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    try { cleanup?.(); } catch {}
    cleanup = null;
  });

  it("已命中选项时应在首帧直接显示 label，而不是内部 value", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<SelectHarness value="default" placeholder="请选择" />);
    });

    expect(getTriggerText()).toBe("默认");
    expect(getTriggerText()).not.toContain("default");
  });

  it("未命中选项时应回退 placeholder，而不是泄漏内部 value", async () => {
    const mounted = createMountedRoot();
    cleanup = mounted.unmount;

    await act(async () => {
      mounted.root.render(<SelectHarness value="missing" placeholder="请选择" />);
    });

    expect(getTriggerText()).toBe("请选择");
    expect(getTriggerText()).not.toContain("missing");
  });
});
