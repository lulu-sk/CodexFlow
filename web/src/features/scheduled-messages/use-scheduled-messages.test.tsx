// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledMessageQueue, type ScheduledMessage, type ScheduledMessageInput } from "../../../../electron/scheduledMessages";
import { useScheduledMessages } from "./use-scheduled-messages";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];

/** 用实际队列模拟桥接接口，观察页面重挂载与多窗口领取。 */
function setup(options: Partial<ScheduledMessageInput> = {}) {
  let now = 1000;
  const sender = 1;
  const listeners = new Set<(tasks: ScheduledMessage[]) => void>();
  const queue = new ScheduledMessageQueue(() => true, () => { for (const listener of listeners) listener(queue.list()); }, () => now);
  queue.save({ tabId: "tab", tabName: "Example", providerId: "codex", projectId: "project", projectName: "Example", projectWinRoot: "", projectWslRoot: "/repo/example", ptyId: "pty", text: "正文", attachmentPaths: [], imagePaths: [], scheduledAt: 2000, ...options });
  const api = {
    list: async () => ({ ok: true, tasks: queue.list() }),
    claim: vi.fn(async (id: string) => queue.claim(id, sender)),
    finish: vi.fn(async (id: string, success: boolean) => queue.finish(id, sender, success)),
    onChanged: (callback: (tasks: ScheduledMessage[]) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  (window as any).host = { scheduledMessages: api };
  return { queue, api, due: (time = 2000) => { now = time; queue.tick(); } };
}

/** 挂载真实预约订阅逻辑，代替依赖整个应用的复杂初始化。 */
async function mount(send: (task: ScheduledMessage) => Promise<boolean>, canSend = () => true) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  /** 渲染订阅结果，便于验证重挂载恢复。 */
  function Subscriber() {
    const tasks = useScheduledMessages(send, canSend);
    return <span>{tasks.map((task) => task.status).join(",")}</span>;
  }
  await act(async () => root.render(<Subscriber />));
  return root;
}

afterEach(() => { for (const root of roots) act(() => root.unmount()); roots.length = 0; document.body.innerHTML = ""; delete (window as any).host; });

describe("预约页面订阅", () => {
  it("多个页面订阅有限循环时只发送指定次数，结束后重挂载也不复活", async () => {
    const h = setup({ repeatEveryMs: 60_000, repeatEnd: { mode: "count", count: 2 } });
    const send = vi.fn(async () => true);
    await mount(send);
    await mount(send);
    await act(async () => h.due());
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => h.due(62_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.queue.list()).toEqual([]);
    await mount(send);
    await act(async () => h.due(122_000));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("到点发送并回报成功，页面重挂载不会重复发送", async () => {
    const h = setup();
    const send = vi.fn(async () => true);
    const root = await mount(send);
    expect(send).not.toHaveBeenCalled();
    await act(async () => h.due());
    expect(send).toHaveBeenCalledOnce();
    expect(h.queue.list()).toEqual([]);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await mount(send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("刷新期间错过到点通知后，通过读取主进程列表恢复发送", async () => {
    const h = setup();
    h.due();
    const send = vi.fn(async () => true);
    await mount(send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("多个页面收到到点通知时仍只发送一次", async () => {
    const h = setup();
    const send = vi.fn(async () => true);
    await mount(send);
    await mount(send);
    await act(async () => h.due());
    expect(send).toHaveBeenCalledOnce();
    expect(h.queue.list()).toEqual([]);
  });

  it("不属于当前窗口或终端尚未准备好时，保留任务等待", async () => {
    const h = setup();
    const send = vi.fn(async () => true);
    await mount(send, () => false);
    await act(async () => h.due());
    expect(send).not.toHaveBeenCalled();
    expect(h.queue.list()[0].status).toBe("due");
  });

  it("发送异常回报失败，后续通知不触发自动重试", async () => {
    const h = setup();
    const send = vi.fn(async () => { throw new Error("failed"); });
    await mount(send);
    await act(async () => h.due());
    expect(h.queue.list()[0].error).toBe("sendFailed");
    await act(async () => h.queue.tick());
    expect(send).toHaveBeenCalledOnce();
  });

  it("循环在下一次时间重新派发，多页面仍只发送一次，取消后停止", async () => {
    const h = setup({ repeatEveryMs: 60_000 });
    const send = vi.fn(async () => true);
    await mount(send);
    await mount(send);
    await act(async () => h.due());
    expect(send).toHaveBeenCalledOnce();
    expect(h.queue.list()[0]).toMatchObject({ status: "pending", scheduledAt: 62_000 });
    await act(async () => h.due(61_000));
    expect(send).toHaveBeenCalledOnce();
    await act(async () => h.due(62_000));
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => h.queue.cancel(h.queue.list()[0].id));
    await act(async () => h.due(122_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toBe("");
  });
});
