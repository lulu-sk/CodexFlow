// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import ICU from "i18next-icu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import terminal from "@/locales/zh/terminal.json";
import common from "@/locales/zh/common.json";
import { ScheduleMessageDialog } from "./schedule-message-dialog";
import { localDateTimeFields, presetScheduleTime } from "./schedule-time";
import type { ScheduledMessageInput } from "@/types/host";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const language = i18next.createInstance();
let root: Root;
const input: ScheduledMessageInput = { tabId: "example", tabName: "Example", providerId: "codex", projectId: "project", projectName: "Example", projectWinRoot: "", projectWslRoot: "/repo/example", ptyId: "pty-example", text: "预约正文", attachmentPaths: [], imagePaths: [], scheduledAt: 1 };

/** 以真实中文文案挂载弹窗，检查键盘和表单交互。 */
async function mount(onSubmit = vi.fn(async () => ({ ok: true })), onClose = vi.fn(), value: ScheduledMessageInput & { sentCount?: number } = input, editing = false) {
  await act(async () => root.render(<I18nextProvider i18n={language}><ScheduleMessageDialog input={value} editing={editing} onClose={onClose} onSubmit={onSubmit} /></I18nextProvider>));
  return { onSubmit, onClose };
}

/** 根据完整文字查找操作按钮，避免依赖布局或样式类。 */
function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text);
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

/** 通过原生输入事件模拟用户编辑，触发 React 的受控表单更新。 */
async function changeInput(label: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 模拟用户从小时或分钟下拉框选择选项。 */
async function changeSelect(label: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
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

describe("预约弹窗", () => {
  it("快捷时间按本地日历处理，明早固定九点且不受 UTC 日期影响", () => {
    const now = new Date(2030, 0, 1, 23, 58, 20).getTime();
    expect(localDateTimeFields(presetScheduleTime("tomorrow", now))).toEqual({ date: "2030-01-02", time: "09:00" });
    expect(presetScheduleTime("tenMinutes", now) - now).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("展示目标和正文，快捷选择后提交相同正文和目标", async () => {
    const h = await mount();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("定时发送");
    expect(document.body.textContent).toContain("Example");
    expect(document.body.textContent).toContain("预约正文");
    await act(async () => button("1 小时后").click());
    expect(button("1 小时后").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...input, scheduledAt: presetScheduleTime("oneHour"), repeatEveryMs: undefined });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("选定时间过期后禁用提交且显示原因", async () => {
    const h = await mount();
    await act(async () => vi.advanceTimersByTime(11 * 60_000));
    expect(button("确认定时发送").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("未来 30 天");
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("保存失败后保持弹窗和草稿，用户可以重试", async () => {
    const submit = vi.fn(async () => ({ ok: false }));
    const h = await mount(submit);
    await act(async () => button("确认定时发送").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("预约保存失败");
    expect(document.body.textContent).toContain("预约正文");
    expect(h.onClose).not.toHaveBeenCalled();
    expect(button("确认定时发送").disabled).toBe(false);
  });

  it("取消仅关闭弹窗，不创建预约", async () => {
    const h = await mount();
    await act(async () => button("取消").click());
    expect(h.onSubmit).not.toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalledOnce();
  });

  it("设置时每秒实时倒数，输入时长后同步更新预览及提交时间", async () => {
    const h = await mount();
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:10:00");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:09:58");
    await changeInput("等待时长", "45");
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:45:00");
    const target = Date.now() + 45 * 60_000;
    await act(async () => vi.advanceTimersByTime(3000));
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...input, scheduledAt: target, repeatEveryMs: undefined });
  });

  it("点击月历选日期，再用小时和分钟下拉框完成指定时间", async () => {
    const h = await mount();
    await act(async () => button("指定时间").click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="日期"]')!.click());
    expect(document.querySelector('[aria-label="选择日期"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="2030-01-03"]')!.click());
    expect(document.querySelector('[aria-label="选择日期"]')).toBeNull();
    await changeSelect("小时", "16");
    await changeSelect("分钟", "45");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...input, scheduledAt: new Date(2030, 0, 3, 16, 45).getTime(), repeatEveryMs: undefined });
  });

  it("快捷日期同步月历和时间下拉框，可切回相对时长", async () => {
    await mount();
    await act(async () => button("明早 9 点").click());
    expect(document.querySelector('button[aria-label="日期"]')?.textContent).toBe("2030-01-02");
    expect((document.querySelector('select[aria-label="小时"]') as HTMLSelectElement).value).toBe("09");
    expect((document.querySelector('select[aria-label="分钟"]') as HTMLSelectElement).value).toBe("00");
    expect(button("确认定时发送").disabled).toBe(false);
    await act(async () => button("多久后发送").click());
    expect(document.querySelector('input[aria-label="等待时长"]')).not.toBeNull();
  });

  it("循环需要有效间隔，提交保留原正文与附件快照", async () => {
    const value = { ...input, attachmentPaths: ["/attachments/example.png"], imagePaths: ["/attachments/example.png"] };
    const h = await mount(undefined, undefined, value);
    await act(async () => button("循环发送").click());
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:30:00");
    await changeInput("循环间隔", "0");
    expect(button("确认定时发送").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("循环间隔");
    await changeInput("循环间隔", "15");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...value, scheduledAt: Date.now() + 15 * 60_000, repeatEveryMs: 15 * 60_000, repeatEnd: { mode: "count", count: 5 } });
  });

  it("循环可单独指定首次时间，间隔变化不改动自定义首发，并预览后续两次", async () => {
    const h = await mount();
    await act(async () => button("循环发送").click());
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await changeInput("等待时长", "5");
    await changeInput("循环间隔", "20");
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:05:00");
    expect(document.body.textContent).toContain("第 2 次");
    expect(document.body.textContent).toContain("10:55");
    expect(document.body.textContent).toContain("11:15");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(document.querySelector('[role="timer"]')?.textContent).toBe("00:04:58");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...input, scheduledAt: new Date(2030, 0, 1, 10, 35).getTime(), repeatEveryMs: 20 * 60_000, repeatEnd: { mode: "count", count: 5 } });
  });

  it("编辑循环任务准确回显间隔和时间，关闭循环后保存为单次发送", async () => {
    const value = { ...input, scheduledAt: Date.now() + 60_123, repeatEveryMs: 2 * 60 * 60_000 };
    const h = await mount(undefined, undefined, value, true);
    expect(button("循环发送").getAttribute("aria-pressed")).toBe("true");
    expect((document.querySelector('input[aria-label="循环间隔"]') as HTMLInputElement).value).toBe("2");
    expect((document.querySelector('select[aria-label="循环间隔单位"]') as HTMLSelectElement).value).toBe("hour");
    await act(async () => button("单次定时").click());
    await act(async () => button("保存时间").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...value, repeatEveryMs: undefined });
  });

  it.each(["select", "summary", 'input[type="checkbox"]', 'button[aria-label="日期"]', 'select[aria-label="小时"]', 'select[aria-label="分钟"]'])("在 %s 上按回车仅操作控件，不会意外创建预约", async (selector) => {
    const h = await mount();
    if (selector.includes("checkbox")) await act(async () => button("循环发送").click());
    if (selector.includes("aria-label")) await act(async () => button("指定时间").click());
    const field = document.querySelector<HTMLElement>(selector)!;
    field.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("月历限制过去和三十天之外的日期，并支持跨月选择", async () => {
    vi.setSystemTime(new Date(2030, 0, 20, 10, 30));
    await mount();
    await act(async () => button("指定时间").click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="日期"]')!.click());
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="2030-01-19"]')!.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="下个月"]')!.click());
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="2030-02-20"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="下个月"]')!.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="2030-02-02"]')!.click());
    expect(document.querySelector('button[aria-label="日期"]')?.textContent).toBe("2030-02-02");
  });

  it("时长输入框中仍可按回车确认预约", async () => {
    const h = await mount();
    const field = document.querySelector('input[aria-label="等待时长"]')!;
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(h.onSubmit).toHaveBeenCalledOnce();
  });

  it("新循环默认发送五次，可改为一次，预览不越过结束次数", async () => {
    const h = await mount();
    await act(async () => button("循环发送").click());
    expect(document.querySelector<HTMLSelectElement>('[aria-label="结束条件"]')!.value).toBe("count");
    expect(document.querySelector<HTMLInputElement>('[aria-label="总发送次数（含首次）"]')!.value).toBe("5");
    expect(document.body.textContent).toContain("还将发送 5 次");
    expect(document.body.textContent).toContain("预计最后发送");
    await changeInput("总发送次数（含首次）", "1");
    expect(document.body.textContent).not.toContain("第 2 次");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ repeatEnd: { mode: "count", count: 1 } }));
  });

  it.each(["", "0", "1.5", "10001"])("无效总次数 %s 禁止确认", async (value) => {
    const h = await mount();
    await act(async () => button("循环发送").click());
    await changeInput("总发送次数（含首次）", value);
    expect(button("确认定时发送").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("总次数须为");
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("编辑总次数保留成功进度，不能设为已发送次数，单次模式清除条件", async () => {
    const value: ScheduledMessageInput & { sentCount?: number } = { ...input, scheduledAt: Date.now() + 60_000, repeatEveryMs: 60_000, repeatEnd: { mode: "count", count: 5 }, sentCount: 3 };
    const h = await mount(undefined, undefined, value, true);
    expect(document.body.textContent).toContain("已发送 3 次，还将发送 2 次");
    expect(document.body.textContent).toContain("第 5 次");
    expect(document.body.textContent).not.toContain("第 6 次");
    await changeInput("总发送次数（含首次）", "3");
    expect(button("保存时间").disabled).toBe(true);
    await act(async () => button("单次定时").click());
    await act(async () => button("保存时间").click());
    expect(h.onSubmit).toHaveBeenCalledWith({ ...input, sentCount: 3, scheduledAt: value.scheduledAt, repeatEveryMs: undefined });
  });

  it("旧无限循环回显手动停止，有限循环也可明确改为手动停止", async () => {
    const value = { ...input, scheduledAt: Date.now() + 60_000, repeatEveryMs: 60_000 };
    const h = await mount(undefined, undefined, value, true);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="结束条件"]')!.value).toBe("manual");
    expect(document.body.textContent).toContain("直到手动停止");
    await changeSelect("结束条件", "count");
    await changeSelect("结束条件", "manual");
    await act(async () => button("保存时间").click());
    expect(h.onSubmit).toHaveBeenCalledWith(value);
  });

  it("长间隔的默认截止不早于首发，结束月历和时分允许超过三十天", async () => {
    const h = await mount();
    await act(async () => button("循环发送").click());
    await changeInput("循环间隔", "1");
    await changeSelect("循环间隔单位", "day");
    await changeSelect("结束条件", "at");
    expect(button("确认定时发送").disabled).toBe(false);
    expect(document.querySelector('[aria-label="结束日期"]')?.textContent).toBe("2030-01-06");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="结束日期"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下个月"]')!.click());
    expect(document.querySelector<HTMLButtonElement>('[aria-label="2030-02-10"]')!.disabled).toBe(false);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2030-02-10"]')!.click());
    await changeSelect("结束小时", "12");
    await changeSelect("结束分钟", "45");
    await act(async () => button("确认定时发送").click());
    expect(h.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ repeatEnd: { mode: "at", at: new Date(2030, 1, 10, 12, 45).getTime() } }));
  });

  it("截止不能早于首发，等于首发有效且不预览第二轮", async () => {
    const value: ScheduledMessageInput = { ...input, scheduledAt: new Date(2030, 0, 1, 11).getTime(), repeatEveryMs: 60_000, repeatEnd: { mode: "at", at: new Date(2030, 0, 1, 11).getTime() } };
    await mount(undefined, undefined, value, true);
    expect(button("保存时间").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("第 2 次");
    await changeSelect("结束小时", "10");
    expect(button("保存时间").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("不能早于本次发送");
  });
});
