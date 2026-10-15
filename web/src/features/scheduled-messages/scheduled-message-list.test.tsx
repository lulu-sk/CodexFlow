// @vitest-environment jsdom
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import ICU from "i18next-icu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import terminal from "@/locales/zh/terminal.json";
import common from "@/locales/zh/common.json";
import { ScheduledMessageQueue, type ScheduledMessage, type ScheduledMessageRepeatEnd } from "../../../../electron/scheduledMessages";
import { ScheduledMessageList } from "./scheduled-message-list";
import { formatCountdown } from "./schedule-time";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const language = i18next.createInstance();
let root: Root;

/** 用真实队列驱动列表，验证追加后的广播、倒计时和循环快照。 */
async function mount(failExtend = false, repeatEnd?: ScheduledMessageRepeatEnd) {
  const listeners = new Set<(tasks: ScheduledMessage[]) => void>();
  const queue = new ScheduledMessageQueue(() => true, () => { for (const notify of listeners) notify(queue.list()); });
  const task = queue.save({ tabId: "tab", tabName: "Example", providerId: "codex", projectId: "project", projectName: "Example", projectWinRoot: "", projectWslRoot: "/repo/example", ptyId: "pty", text: "检查任务进度并继续", attachmentPaths: [], imagePaths: [], scheduledAt: Date.now() + 20 * 60_000, repeatEveryMs: 30 * 60_000, repeatEnd }).task!;
  const onEdit = vi.fn();
  const onCancel = vi.fn(async (id: string) => queue.cancel(id));
  const onExtend = vi.fn(async (id: string, ms: number, base: number) => failExtend ? { ok: false } : queue.extend(id, ms, base));
  /** 订阅真实变更，避免测试手动伪造追加后的界面状态。 */
  function View() {
    const [tasks, setTasks] = useState(queue.list());
    useEffect(() => { listeners.add(setTasks); return () => { listeners.delete(setTasks); }; }, []);
    return <I18nextProvider i18n={language}><ScheduledMessageList tasks={tasks} onEdit={onEdit} onCancel={onCancel} onExtend={onExtend} /></I18nextProvider>;
  }
  await act(async () => root.render(<View />));
  return { queue, task, onEdit, onExtend, onCancel };
}

/** 通过可访问名称触发操作，不依赖布局和图标。 */
async function click(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll("button")).find((element) => element.getAttribute("aria-label") === label || element.textContent === label);
  if (!button) throw new Error(`找不到按钮：${label}`);
  await act(async () => button.click());
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2030, 0, 1, 10, 30));
  await language.use(ICU).use(initReactI18next).init({ lng: "zh", resources: { zh: { terminal, common } }, interpolation: { escapeValue: false } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); });

describe("紧凑定时列表", () => {
  it("持续倒计时，正文默认收起且支持查看全文和循环间隔", async () => {
    const h = await mount();
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:20:00");
    expect(document.querySelector('[aria-expanded="false"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="每 30分钟 循环发送"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(61_000));
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:18:59");
    await click("查看完整内容");
    expect(document.querySelector('[aria-expanded="true"]')).not.toBeNull();
    await click("修改时间");
    expect(h.onEdit).toHaveBeenCalledWith(h.task);
  });

  it("快捷追加预览新任务时间，确认后保留原循环及其倒计时", async () => {
    const h = await mount();
    await act(async () => vi.advanceTimersByTime(2 * 60_000));
    await click("追加一条定时");
    expect(document.querySelector('[role="dialog"] [role="timer"]')?.textContent).toBe("00:28:00");
    await click("+10分钟");
    expect(h.queue.list()).toHaveLength(1);
    await click("新增定时");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.queue.list()[0]).toEqual(h.task);
    expect(h.queue.list()[1].scheduledAt).toBe(h.task.scheduledAt + 10 * 60_000);
    expect(h.queue.list()[1].repeatEveryMs).toBeUndefined();
    expect(Array.from(document.querySelectorAll('[role="timer"]'), (timer) => timer.textContent)).toEqual(["00:18:00", "00:28:00"]);
  });

  it("自定义追加使用所选单位和时长，失败时保留原时间与弹窗", async () => {
    const h = await mount(true);
    await click("追加一条定时");
    const field = document.querySelector<HTMLInputElement>('input[aria-label="相隔时长"]')!;
    const unit = document.querySelector<HTMLSelectElement>('select[aria-label="相隔时长单位"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "2");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      unit.value = "hour";
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("新增定时");
    expect(h.onExtend).toHaveBeenCalledWith(h.task.id, 2 * 60 * 60_000, h.task.scheduledAt);
    expect(h.queue.list()[0].scheduledAt).toBe(h.task.scheduledAt);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("追加失败");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("正在发送时不能追加，循环完成后显示下一次倒计时，取消后移除", async () => {
    const h = await mount();
    await act(async () => { vi.advanceTimersByTime(20 * 60_000); h.queue.tick(); h.queue.claim(h.task.id, 1); });
    expect((document.querySelector('button[aria-label="追加一条定时"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("发送中");
    await act(async () => h.queue.finish(h.task.id, 1, true));
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:30:00");
    expect(document.body.textContent).toContain("下次");
    await click("查看完整内容");
    expect(document.body.textContent).toContain("已发送 1 次");
    await click("取消并放回输入框");
    expect(h.queue.list()).toEqual([]);
    expect(document.querySelector('[aria-label="定时消息"]')).toBeNull();
  });

  it("倒计时正确显示跨天与不足一秒的剩余时间，过期不显示负数", () => {
    expect(formatCountdown(86_400_000 + 3_661_000, 0, "zh")).toBe("1天 01:01:01");
    expect(formatCountdown(1, 0, "en")).toBe("00:00:01");
    expect(formatCountdown(0, 1000, "en")).toBe("00:00:00");
  });

  it("有限循环显示剩余次数，成功后实时减少，最后一次没有范围外的预览", async () => {
    const h = await mount(false, { mode: "count", count: 2 });
    expect(document.body.textContent).toContain("还剩 2 次");
    await act(async () => { vi.advanceTimersByTime(20 * 60_000); h.queue.claim(h.task.id, 1); h.queue.finish(h.task.id, 1, true); });
    expect(document.body.textContent).toContain("还剩 1 次");
    await click("查看完整内容");
    expect(document.body.textContent).not.toContain("再下一次");
    expect(document.body.textContent).toContain("预计最后发送");
    await act(async () => { vi.advanceTimersByTime(30 * 60_000); h.queue.claim(h.task.id, 1); h.queue.finish(h.task.id, 1, true); });
    expect(document.querySelector('[aria-label="定时消息"]')).toBeNull();
  });

  it("截止循环显示截止时间且只预览范围内的时刻，超时后移除", async () => {
    const h = await mount(false, { mode: "at", at: Date.now() + 25 * 60_000 });
    expect(document.body.textContent).toContain("截止");
    await click("查看完整内容");
    expect(document.body.textContent).not.toContain("再下一次");
    await act(async () => { vi.advanceTimersByTime(25 * 60_000 + 1000); h.queue.tick(); });
    expect(document.querySelector('[aria-label="定时消息"]')).toBeNull();
  });
});
