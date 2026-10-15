import { describe, expect, it, vi } from "vitest";
import { ScheduledMessageQueue, parseScheduledMessageInput, type ScheduledMessageInput } from "./scheduledMessages";

const START = new Date("2030-01-01T08:00:00Z").getTime();

/** 创建不依赖本地环境的预约快照。 */
function input(scheduledAt = START + 60_000): ScheduledMessageInput {
  return { tabId: "tab-example", tabName: "Example", providerId: "codex", projectId: "project-example", projectName: "Example", projectWinRoot: "", projectWslRoot: "/repo/example", ptyId: "pty-example", text: "预约正文", attachmentPaths: [], imagePaths: [], scheduledAt };
}

/** 使用可推进时钟和终端存活状态验证队列。 */
function harness() {
  let now = START;
  let alive = true;
  const changed = vi.fn();
  const queue = new ScheduledMessageQueue(() => alive, changed, () => now);
  return { queue, changed, advance: (ms: number) => { now += ms; queue.tick(); }, endTerminal: () => { alive = false; queue.tick(); } };
}

describe("定时消息队列", () => {
  it("到点前不领取，到点后只允许一个窗口领取并确认", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    expect(h.queue.claim(task.id, 1).ok).toBe(false);
    h.advance(60_000);
    expect(h.queue.claim(task.id, 1).ok).toBe(true);
    expect(h.queue.claim(task.id, 2).ok).toBe(false);
    expect(h.queue.finish(task.id, 2, true).ok).toBe(false);
    expect(h.queue.finish(task.id, 1, true).ok).toBe(true);
    expect(h.queue.list()).toEqual([]);
  });

  it("取消后不会发送，修改时间后遵守新时间", () => {
    const h = harness();
    const first = h.queue.save(input()).task!;
    h.queue.cancel(first.id);
    h.advance(60_000);
    expect(h.queue.claim(first.id, 1).ok).toBe(false);
    const second = h.queue.save(input(START + 120_000)).task!;
    expect(h.queue.save(input(START + 180_000), second.id).ok).toBe(true);
    h.advance(60_000);
    expect(h.queue.list()[0].status).toBe("pending");
    h.advance(60_000);
    expect(h.queue.list()[0].status).toBe("due");
  });

  it("拒绝篡改目标、空正文、无效时间和超大数据", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    expect(h.queue.save({ ...input(), tabId: "other" }, task.id).ok).toBe(false);
    for (const invalid of [{ ...input(), text: " " }, { ...input(), scheduledAt: START }, { ...input(), scheduledAt: NaN }, { ...input(), scheduledAt: START + 31 * 24 * 60 * 60_000 }, { ...input(), attachmentPaths: [7] }, { ...input(), text: "a".repeat(1_200_001) }])
      expect(parseScheduledMessageInput(invalid, START)).toBeNull();
  });

  it("捕获内容快照，不受调用方后续修改影响", () => {
    const h = harness();
    const value = { ...input(), attachmentPaths: ["/attachments/example.png"] };
    h.queue.save(value);
    value.text = "新的输入";
    value.attachmentPaths.push("/attachments/other.png");
    const listed = h.queue.list();
    listed[0].attachmentPaths.push("/attachments/changed.png");
    expect(h.queue.list()[0].text).toBe("预约正文");
    expect(h.queue.list()[0].attachmentPaths).toEqual(["/attachments/example.png"]);
  });

  it("休眠后小幅迟到可发送，超过五分钟保留内容并停止", () => {
    const h = harness();
    h.queue.save(input());
    h.advance(90_000);
    expect(h.queue.list()[0].status).toBe("due");
    h.advance(5 * 60_000);
    expect(h.queue.list()[0]).toMatchObject({ status: "failed", error: "missed", text: "预约正文" });
  });

  it("终端退出保留失败内容，手动关闭终端取消预约", () => {
    const h = harness();
    h.queue.save(input());
    h.endTerminal();
    expect(h.queue.list()[0].error).toBe("unavailable");
    expect(h.queue.save(input()).ok).toBe(false);
    h.queue.cancelForPty("pty-example");
    expect(h.queue.list()).toEqual([]);
  });

  it("已领取预约不能取消或修改，发送失败不会自动重试", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    expect(h.queue.cancel(task.id).ok).toBe(false);
    expect(h.queue.save(input(START + 120_000), task.id).ok).toBe(false);
    h.queue.finish(task.id, 1, false);
    h.advance(1000);
    expect(h.queue.list()[0]).toMatchObject({ status: "failed", error: "sendFailed" });
    expect(h.queue.claim(task.id, 1).ok).toBe(false);
  });

  it("页面刷新后的未知发送结果保持失败，不再次发送", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.advance(2 * 60_000 + 1);
    expect(h.queue.list()[0].error).toBe("interrupted");
    expect(h.queue.claim(task.id, 2).ok).toBe(false);
    expect(h.queue.finish(task.id, 1, true).ok).toBe(false);
  });

  it("保护预约和可撤销取消中的图片，关闭终端后解除保护", () => {
    const h = harness();
    const path = "/attachments/example.png";
    const task = h.queue.save({ ...input(), imagePaths: [path] }).task!;
    expect(h.queue.protectsImage(path)).toBe(true);
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.finish(task.id, 1, false);
    expect(h.queue.protectsImage(path)).toBe(true);
    h.queue.cancel(task.id);
    expect(h.queue.protectsImage(path)).toBe(true);
    h.queue.cancelForPty("pty-example");
    expect(h.queue.protectsImage(path)).toBe(false);
  });

  it("手动关闭正在发送的终端后清理记录，不接受迟到结果", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.cancelForPty("pty-example");
    expect(h.queue.list()).toEqual([]);
    expect(h.queue.finish(task.id, 1, true).ok).toBe(false);
  });

  it("追加保留原条目，生成独立单次任务，可在新增条目后继续追加", () => {
    const h = harness();
    const task = h.queue.save({ ...input(START + 10 * 60_000), repeatEveryMs: 30 * 60_000, repeatEnd: { mode: "count", count: 5 }, attachmentPaths: ["/attachments/example.png"], imagePaths: ["/attachments/example.png"] }).task!;
    h.advance(2 * 60_000);
    const appended = h.queue.extend(task.id, 5 * 60_000, task.scheduledAt).task!;
    expect(appended.id).not.toBe(task.id);
    expect(appended.scheduledAt).toBe(START + 15 * 60_000);
    expect(appended.repeatEveryMs).toBeUndefined();
    expect(appended.repeatEnd).toBeUndefined();
    expect(appended.imagePaths).toEqual(task.imagePaths);
    expect(h.queue.extend(appended.id, 10 * 60_000, appended.scheduledAt).task?.scheduledAt).toBe(START + 25 * 60_000);
    expect(h.queue.list()).toHaveLength(3);
    expect(h.queue.list()[0]).toEqual(task);
    expect(h.queue.extend(task.id, 5 * 60_000, task.scheduledAt + 1)).toMatchObject({ ok: false });
  });

  it("拒绝无效、过期或越界追加，发送中和失败的任务不能被追加恢复", () => {
    const h = harness();
    const task = h.queue.save(input()).task!;
    for (const delay of [0, -60_000, 59_999, NaN, Infinity, 60_000.5, 30 * 24 * 60 * 60_000])
      expect(h.queue.extend(task.id, delay)).toMatchObject({ ok: false, error: "invalid" });
    expect(h.queue.list()[0].scheduledAt).toBe(task.scheduledAt);
    h.advance(3 * 60_000);
    expect(h.queue.extend(task.id, 60_000).ok).toBe(false);
    h.queue.claim(task.id, 1);
    expect(h.queue.extend(task.id, 10 * 60_000).ok).toBe(false);
    h.queue.finish(task.id, 1, false);
    expect(h.queue.extend(task.id, 10 * 60_000).ok).toBe(false);
    expect(h.queue.list()[0].error).toBe("sendFailed");
  });

  it("循环成功后仍保留同一任务和图片，到下次时刻才再次允许领取", () => {
    const h = harness();
    const task = h.queue.save({ ...input(), repeatEveryMs: 10 * 60_000, imagePaths: ["/attachments/example.png"] }).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.advance(5000);
    h.queue.finish(task.id, 1, true);
    expect(h.queue.list()).toEqual([{ ...task, scheduledAt: START + 11 * 60_000, sentCount: 1 }]);
    expect(h.queue.protectsImage("/attachments/example.png")).toBe(true);
    expect(h.queue.claim(task.id, 2).ok).toBe(false);
    expect(h.queue.finish(task.id, 1, true).ok).toBe(false);
    h.advance(10 * 60_000 - 5000);
    expect(h.queue.claim(task.id, 2).ok).toBe(true);
    h.queue.finish(task.id, 2, true);
    expect(h.queue.list()[0].scheduledAt).toBe(START + 21 * 60_000);
    h.queue.cancel(task.id);
    h.queue.cancelForPty("pty-example");
    expect(h.queue.protectsImage("/attachments/example.png")).toBe(false);
  });

  it("延迟完成的循环跳过错过轮次，不补发积压消息", () => {
    const h = harness();
    const task = h.queue.save({ ...input(), repeatEveryMs: 60_000 }).task!;
    h.advance(90_000);
    h.queue.claim(task.id, 1);
    h.advance(90_000);
    h.queue.finish(task.id, 1, true);
    expect(h.queue.list()[0]).toMatchObject({ status: "pending", scheduledAt: START + 240_000 });
    expect(h.queue.claim(task.id, 1).ok).toBe(false);
  });

  it("循环失败或错过时间后停止，修改为单次发送可解除循环", () => {
    const h = harness();
    const task = h.queue.save({ ...input(), repeatEveryMs: 60_000 }).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.finish(task.id, 1, false);
    h.advance(10 * 60_000);
    expect(h.queue.list()[0]).toMatchObject({ status: "failed", error: "sendFailed" });
    h.queue.save({ ...input(START + 12 * 60_000), repeatEveryMs: undefined }, task.id);
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.finish(task.id, 1, true);
    expect(h.queue.list()).toEqual([]);
    h.queue.save({ ...input(START + 13 * 60_000), repeatEveryMs: 60_000 });
    h.advance(7 * 60_000);
    expect(h.queue.list()[0]).toMatchObject({ status: "failed", error: "missed" });
  });

  it("校验跨进程循环间隔，旧的单次预约仍兼容", () => {
    for (const repeatEveryMs of [null, "60000", 0, -1, 59_999, 60_000.5, NaN, Infinity, 31 * 24 * 60 * 60_000])
      expect(parseScheduledMessageInput({ ...input(), repeatEveryMs }, START)).toBeNull();
    expect(parseScheduledMessageInput(input(), START)).toEqual(input());
    expect(parseScheduledMessageInput({ ...input(), repeatEveryMs: 60_000 }, START)?.repeatEveryMs).toBe(60_000);
    const max = 30 * 24 * 60 * 60_000;
    expect(parseScheduledMessageInput({ ...input(), repeatEveryMs: max }, START)?.repeatEveryMs).toBe(max);
  });

  it("连续撤销重做创建、改期、追加、取消，保持各条目的原定时间", () => {
    const h = harness();
    const created = h.queue.save({ ...input(START + 10 * 60_000), repeatEveryMs: 30 * 60_000 });
    const edited = h.queue.save({ ...created.task!, scheduledAt: START + 20 * 60_000 }, created.task!.id);
    const appended = h.queue.extend(created.task!.id, 10 * 60_000);
    const canceled = h.queue.cancel(created.task!.id);
    h.advance(60_000);
    for (const operation of [canceled, appended, edited, created]) expect(h.queue.restoreHistory(operation.historyToken!, "undo").ok).toBe(true);
    expect(h.queue.list()).toEqual([]);
    for (const operation of [created, edited, appended, canceled]) expect(h.queue.restoreHistory(operation.historyToken!, "redo").ok).toBe(true);
    expect(h.queue.list()).toEqual([appended.task]);
    expect(h.queue.restoreHistory(canceled.historyToken!, "undo").ok).toBe(true);
    expect(h.queue.list()[0]).toMatchObject({ id: created.task!.id, scheduledAt: START + 20 * 60_000, repeatEveryMs: 30 * 60_000 });
  });

  it("恢复过期预约时保留原时间并停止，不在按重做后立刻发送", () => {
    const h = harness();
    const created = h.queue.save(input());
    expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(true);
    h.advance(90_000);
    expect(h.queue.restoreHistory(created.historyToken!, "redo").ok).toBe(true);
    expect(h.queue.list()[0]).toMatchObject({ scheduledAt: START + 60_000, status: "failed", error: "missed" });
    expect(h.queue.claim(created.task!.id, 1).ok).toBe(false);
  });

  it("领取发送立即使旧历史失效，后续循环仍可记录新的编辑与取消", () => {
    const h = harness();
    const created = h.queue.save({ ...input(), repeatEveryMs: 10 * 60_000 });
    h.advance(60_000);
    h.queue.claim(created.task!.id, 1);
    expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(false);
    h.queue.finish(created.task!.id, 1, true);
    expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(false);
    const canceled = h.queue.cancel(created.task!.id);
    expect(h.queue.restoreHistory(canceled.historyToken!, "undo").ok).toBe(true);
    expect(h.queue.list()[0]).toMatchObject({ scheduledAt: START + 11 * 60_000, sentCount: 1 });
  });

  it("关闭终端清理已取消的历史，恢复不能越过其他窗口的新编辑", () => {
    const h = harness();
    const created = h.queue.save(input());
    const edited = h.queue.save(input(START + 120_000), created.task!.id);
    expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(false);
    const canceled = h.queue.cancel(edited.task!.id);
    h.queue.cancelForPty("pty-example");
    expect(h.queue.restoreHistory(canceled.historyToken!, "undo").ok).toBe(false);
    expect(h.queue.list()).toEqual([]);
  });

  it.each([1, 3])("按成功次数结束：总共发送 %i 次，完成后不再领取", (count) => {
    const h = harness();
    const created = h.queue.save({ ...input(), repeatEveryMs: 60_000, repeatEnd: { mode: "count", count } });
    const id = created.task!.id;
    for (let index = 0; index < count; index++) {
      h.advance(60_000);
      expect(h.queue.claim(id, 1).ok).toBe(true);
      expect(h.queue.claim(id, 2).ok).toBe(false);
      h.queue.finish(id, 1, true);
      if (index < count - 1) expect(h.queue.list()[0].sentCount).toBe(index + 1);
    }
    expect(h.queue.list()).toEqual([]);
    h.advance(60_000);
    expect(h.queue.claim(id, 1).ok).toBe(false);
    expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(false);
  });

  it("跳过的轮次不消耗次数，失败不计数，编辑不能把总数设为已完成次数", () => {
    const h = harness();
    const task = h.queue.save({ ...input(), repeatEveryMs: 60_000, repeatEnd: { mode: "count", count: 3 } }).task!;
    h.advance(90_000);
    h.queue.claim(task.id, 1);
    h.advance(90_000);
    h.queue.finish(task.id, 1, true);
    const next = h.queue.list()[0];
    expect(next).toMatchObject({ scheduledAt: START + 240_000, sentCount: 1 });
    expect(h.queue.save({ ...next, repeatEnd: { mode: "count", count: 1 } }, task.id)).toMatchObject({ ok: false, error: "invalidEnd" });
    expect(h.queue.save({ ...next, repeatEnd: { mode: "count", count: 2 } }, task.id).task?.sentCount).toBe(1);
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.finish(task.id, 1, false);
    expect(h.queue.list()[0]).toMatchObject({ status: "failed", sentCount: 1, repeatEnd: { mode: "count", count: 2 } });
  });

  it("截止边界仍允许开始发送，最后一轮跨过截止完成后不会再循环", () => {
    const h = harness();
    const task = h.queue.save({ ...input(), repeatEveryMs: 60_000, repeatEnd: { mode: "at", at: START + 120_000 } }).task!;
    h.advance(60_000);
    h.queue.claim(task.id, 1);
    h.queue.finish(task.id, 1, true);
    h.advance(60_000);
    expect(h.queue.claim(task.id, 1).ok).toBe(true);
    h.advance(1000);
    expect(h.queue.list()[0].status).toBe("sending");
    h.queue.finish(task.id, 1, true);
    expect(h.queue.list()).toEqual([]);
  });

  it("到点未领取或休眠恢复超过截止时不补发，并废弃相关历史", () => {
    for (const sleep of [false, true]) {
      const h = harness();
      const created = h.queue.save({ ...input(), repeatEveryMs: 60_000, repeatEnd: { mode: "at", at: START + 90_000 } });
      if (!sleep) h.advance(60_000);
      h.advance(sleep ? 90_001 : 30_001);
      expect(h.queue.claim(created.task!.id, 1).ok).toBe(false);
      expect(h.queue.list()).toEqual([]);
      expect(h.queue.restoreHistory(created.historyToken!, "undo").ok).toBe(false);
    }
  });

  it("下一计划超出截止时立即结束，失败或超时则保留内容供恢复", () => {
    for (const result of ["success", "failure", "timeout"] as const) {
      const h = harness();
      const task = h.queue.save({ ...input(), repeatEveryMs: 60_000, repeatEnd: { mode: "at", at: START + 90_000 } }).task!;
      h.advance(60_000);
      h.queue.claim(task.id, 1);
      if (result === "timeout") h.advance(120_001);
      else h.queue.finish(task.id, 1, result === "success");
      if (result === "success") expect(h.queue.list()).toEqual([]);
      else {
        h.advance(180_000);
        expect(h.queue.list()[0]).toMatchObject({ status: "failed", sentCount: 0, text: "预约正文", error: result === "timeout" ? "interrupted" : "sendFailed" });
      }
    }
  });

  it("严格校验结束条件、总数和截止日期范围，兼容手动停止", () => {
    const base = { ...input(), repeatEveryMs: 60_000 };
    for (const repeatEnd of [null, {}, { mode: "unknown" }, ...[0, -1, 1.5, 10001, NaN, Infinity, "5"].map((count) => ({ mode: "count", count })), ...[NaN, Infinity, START, START + 366 * 24 * 60 * 60_000].map((at) => ({ mode: "at", at }))])
      expect(parseScheduledMessageInput({ ...base, repeatEnd }, START)).toBeNull();
    expect(parseScheduledMessageInput({ ...input(), repeatEnd: { mode: "count", count: 5 } }, START)).toBeNull();
    expect(parseScheduledMessageInput(base, START)).toEqual(base);
    expect(parseScheduledMessageInput({ ...base, repeatEnd: { mode: "count", count: 10000, extra: true } }, START)?.repeatEnd).toEqual({ mode: "count", count: 10000 });
    for (const at of [base.scheduledAt, START + 365 * 24 * 60 * 60_000])
      expect(parseScheduledMessageInput({ ...base, repeatEnd: { mode: "at", at } }, START)?.repeatEnd).toEqual({ mode: "at", at });
  });

  it("结束条件与历史快照隔离，撤销重做恢复原次数、截止时间，不重新起算", () => {
    const h = harness();
    const value = { ...input(START + 10 * 60_000), repeatEveryMs: 60_000, repeatEnd: { mode: "count" as const, count: 5 } };
    const created = h.queue.save(value);
    value.repeatEnd.count = 99;
    (created.task!.repeatEnd as { count: number }).count = 98;
    const listed = h.queue.list()[0];
    (listed.repeatEnd as { count: number }).count = 97;
    expect(h.queue.list()[0].repeatEnd).toEqual({ mode: "count", count: 5 });
    const at = START + 20 * 60_000;
    const edited = h.queue.save({ ...value, repeatEnd: { mode: "at", at } }, created.task!.id);
    h.advance(60_000);
    h.queue.restoreHistory(edited.historyToken!, "undo");
    expect(h.queue.list()[0].repeatEnd).toEqual({ mode: "count", count: 5 });
    h.queue.restoreHistory(edited.historyToken!, "redo");
    expect(h.queue.list()[0]).toMatchObject({ scheduledAt: value.scheduledAt, repeatEnd: { mode: "at", at } });
    h.advance(9 * 60_000);
    const claimed = h.queue.claim(created.task!.id, 1).task!;
    (claimed.repeatEnd as { at: number }).at = START;
    expect(h.queue.list()[0].repeatEnd).toEqual({ mode: "at", at });
  });
});
