// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type ScheduledMessageRepeatEnd = { mode: "count"; count: number } | { mode: "at"; at: number };

export type ScheduledMessageInput = {
  tabId: string;
  tabName: string;
  providerId: string;
  projectId: string;
  projectName: string;
  projectWinRoot: string;
  projectWslRoot: string;
  ptyId: string;
  text: string;
  attachmentPaths: string[];
  imagePaths: string[];
  scheduledAt: number;
  /** 成功发送后按此间隔继续预约；省略时只发送一次。 */
  repeatEveryMs?: number;
  /** 省略时手动停止；次数含首次，截止时刻包含边界。 */
  repeatEnd?: ScheduledMessageRepeatEnd;
};
export type ScheduledMessage = ScheduledMessageInput & {
  id: string;
  /** 本次循环已成功发送的次数，用于区分首次和下一次发送。 */
  sentCount?: number;
  status: "pending" | "due" | "sending" | "failed";
  error?: "unavailable" | "sendFailed" | "interrupted" | "missed";
};
export type ScheduledMessageResult = { ok: boolean; task?: ScheduledMessage; historyToken?: string; error?: string };

type ScheduleHistoryEntry = {
  id: string;
  before?: ScheduledMessage;
  after?: ScheduledMessage;
  beforeVersion?: number;
  afterVersion: number;
  applied: boolean;
};

const MAX_DELAY_MS = 30 * 24 * 60 * 60_000;
const MAX_REPEAT_END_DELAY_MS = 365 * 24 * 60 * 60_000;
const MAX_REPEAT_COUNT = 10_000;
const LATE_GRACE_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 2 * 60_000;

/** 校验预约快照，限制时间、文本和列表大小，并舍弃未知字段。 */
export function parseScheduledMessageInput(value: unknown, now: number): ScheduledMessageInput | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const keys = ["tabId", "tabName", "providerId", "projectId", "projectName", "projectWinRoot", "projectWslRoot", "ptyId", "text"] as const;
  for (const key of keys)
    if (typeof source[key] !== "string" || (source[key] as string).length > (key === "text" ? 1_200_000 : 4096)) return null;
  if (!source.tabId || !source.projectId || !source.providerId || !source.ptyId) return null;
  for (const key of ["attachmentPaths", "imagePaths"] as const)
    if (!Array.isArray(source[key]) || source[key].length > 100 || source[key].some((entry: unknown) => typeof entry !== "string" || !entry || entry.length > 4096)) return null;
  if (!(source.text as string).trim() && !(source.attachmentPaths as string[]).length) return null;
  if (typeof source.scheduledAt !== "number" || !Number.isFinite(source.scheduledAt) || source.scheduledAt <= now || source.scheduledAt > now + MAX_DELAY_MS) return null;
  if (source.repeatEveryMs !== undefined && (typeof source.repeatEveryMs !== "number" || !Number.isSafeInteger(source.repeatEveryMs) || source.repeatEveryMs < 60_000 || source.repeatEveryMs > MAX_DELAY_MS)) return null;
  let repeatEnd: ScheduledMessageRepeatEnd | undefined;
  if (source.repeatEnd !== undefined) {
    if (!source.repeatEveryMs || !source.repeatEnd || typeof source.repeatEnd !== "object") return null;
    const end = source.repeatEnd as Record<string, unknown>;
    if (end.mode === "count" && typeof end.count === "number" && Number.isSafeInteger(end.count) && end.count >= 1 && end.count <= MAX_REPEAT_COUNT) repeatEnd = { mode: "count", count: end.count };
    else if (end.mode === "at" && typeof end.at === "number" && Number.isFinite(end.at) && end.at >= source.scheduledAt && end.at <= now + MAX_REPEAT_END_DELAY_MS) repeatEnd = { mode: "at", at: end.at };
    else return null;
  }
  const strings = Object.fromEntries(keys.map((key) => [key, source[key]]));
  return { ...strings, attachmentPaths: [...source.attachmentPaths as string[]], imagePaths: [...source.imagePaths as string[]], scheduledAt: source.scheduledAt, ...(source.repeatEveryMs === undefined ? {} : { repeatEveryMs: source.repeatEveryMs }), ...(repeatEnd ? { repeatEnd } : {}) } as ScheduledMessageInput;
}

/** 管理同一次应用运行中的预约；领取后不自动重试，避免重复发送。 */
export class ScheduledMessageQueue {
  private tasks = new Map<string, ScheduledMessage>();
  private claims = new Map<string, { senderId: number; startedAt: number }>();
  private sequence = 0;
  private history = new Map<string, ScheduleHistoryEntry>();
  private versions = new Map<string, number>();

  /** 注入时钟、终端存活检查和通知入口，便于验证睡眠与并发行为。 */
  constructor(private alive: (ptyId: string) => boolean, private changed: () => void, private now: () => number = Date.now) {}

  /** 获取按预约时间排序的快照，避免调用方修改队列内部状态。 */
  list(): ScheduledMessage[] {
    return Array.from(this.tasks.values(), (task) => this.copyTask(task)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  /** 新增或调整尚未开始发送的预约。 */
  save(input: unknown, id?: string): ScheduledMessageResult {
    const parsed = parseScheduledMessageInput(input, this.now());
    if (!parsed) return { ok: false, error: "invalid" };
    if (!this.alive(parsed.ptyId)) return { ok: false, error: "unavailable" };
    const existing = id ? this.tasks.get(id) : undefined;
    if (id && (!existing || existing.status === "sending")) return { ok: false, error: "unavailable" };
    if (existing && (parsed.tabId !== existing.tabId || parsed.ptyId !== existing.ptyId || parsed.projectId !== existing.projectId)) return { ok: false, error: "invalid" };
    if (parsed.repeatEnd?.mode === "count" && parsed.repeatEnd.count <= (existing?.sentCount || 0)) return { ok: false, error: "invalidEnd" };
    if (!id && this.tasks.size >= 100) return { ok: false, error: "limit" };
    const task: ScheduledMessage = { ...parsed, id: id || `scheduled-${this.now()}-${++this.sequence}`, sentCount: existing?.sentCount || 0, status: "pending" };
    const historyToken = this.recordChange(task.id, existing, task);
    this.tasks.set(task.id, task);
    this.changed();
    return { ok: true, task: this.copyTask(task), historyToken };
  }

  /** 保留原预约，以其指定时刻为基准新增同内容的单次预约；基准变化时拒绝悄悄改期。 */
  extend(id: string, delayMs: number, baseScheduledAt?: number): ScheduledMessageResult {
    const task = this.tasks.get(id);
    if (!task || (task.status !== "pending" && task.status !== "due")) return { ok: false, error: "unavailable" };
    if (baseScheduledAt !== undefined && baseScheduledAt !== task.scheduledAt) return { ok: false, error: "unavailable" };
    if (!Number.isSafeInteger(delayMs) || delayMs < 60_000 || delayMs > MAX_DELAY_MS) return { ok: false, error: "invalid" };
    return this.save({ ...task, scheduledAt: task.scheduledAt + delayMs, repeatEveryMs: undefined, repeatEnd: undefined });
  }

  /** 取消或移除预约；已领取的发送不会伪装成已取消。 */
  cancel(id: string): ScheduledMessageResult {
    const task = this.tasks.get(id);
    if (!task || task.status === "sending") return { ok: false, error: "unavailable" };
    const historyToken = this.recordChange(id, task, undefined);
    this.tasks.delete(id);
    this.changed();
    return { ok: true, historyToken };
  }

  /** 复制任务、附件和结束条件，隔离调用方、历史快照和运行状态。 */
  private copyTask(task: ScheduledMessage): ScheduledMessage {
    return { ...task, attachmentPaths: [...task.attachmentPaths], imagePaths: [...task.imagePaths], ...(task.repeatEnd ? { repeatEnd: { ...task.repeatEnd } } : {}) };
  }

  /** 保存单个用户操作的前后状态；版本可回退，支持连续撤销与重做。 */
  private recordChange(id: string, before?: ScheduledMessage, after?: ScheduledMessage): string {
    const afterVersion = ++this.sequence;
    const token = `schedule-history-${afterVersion}`;
    this.history.set(token, { id, before: before && this.copyTask(before), after: after && this.copyTask(after), beforeVersion: this.versions.get(id), afterVersion, applied: true });
    this.versions.set(id, afterVersion);
    if (this.history.size > 200) this.history.delete(this.history.keys().next().value!);
    return token;
  }

  /** 领取发送或关闭终端后废弃该任务的历史，防止撤销恢复已经发送的内容。 */
  private invalidateHistory(id: string): void {
    for (const [token, entry] of this.history)
      if (entry.id === id) this.history.delete(token);
    this.versions.delete(id);
  }

  /** 原子恢复原定时间；已过期的恢复任务停留在失败态，等待用户重新安排。 */
  restoreHistory(token: string, direction: "undo" | "redo"): ScheduledMessageResult {
    const entry = this.history.get(token);
    const undo = direction === "undo";
    if (!entry || entry.applied !== undo || this.versions.get(entry.id) !== (undo ? entry.afterVersion : entry.beforeVersion)) return { ok: false, error: "historyUnavailable" };
    const snapshot = undo ? entry.before : entry.after;
    if (snapshot && !this.alive(snapshot.ptyId)) return { ok: false, error: "unavailable" };
    if (snapshot && !this.tasks.has(entry.id) && this.tasks.size >= 100) return { ok: false, error: "limit" };
    let task: ScheduledMessage | undefined;
    if (snapshot) {
      task = this.copyTask(snapshot);
      if (task.scheduledAt <= this.now() && task.status !== "failed") {
        task.status = "failed";
        task.error = "missed";
      }
      this.tasks.set(entry.id, task);
    } else this.tasks.delete(entry.id);
    const version = undo ? entry.beforeVersion : entry.afterVersion;
    if (version === undefined) this.versions.delete(entry.id);
    else this.versions.set(entry.id, version);
    entry.applied = !undo;
    this.changed();
    return { ok: true, task: task && this.copyTask(task) };
  }

  /** 手动关闭终端时清理全部关联预约，防止留下不可访问的记录。 */
  cancelForPty(ptyId: string): void {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.ptyId !== ptyId) continue;
      this.tasks.delete(task.id);
      this.claims.delete(task.id);
      this.invalidateHistory(task.id);
      changed = true;
    }
    for (const entry of this.history.values())
      if ((entry.before || entry.after)?.ptyId === ptyId) this.invalidateHistory(entry.id);
    if (changed) this.changed();
  }

  /** 到点后转为可领取状态；过期、终端消失和发送中断均保留正文。 */
  tick(): void {
    const now = this.now();
    let changed = false;
    for (const task of this.tasks.values()) {
      const claim = this.claims.get(task.id);
      if (task.status === "sending") {
        if (claim && now - claim.startedAt > SEND_TIMEOUT_MS) {
          task.status = "failed";
          task.error = "interrupted";
          this.claims.delete(task.id);
          changed = true;
        }
        continue;
      }
      if (task.status === "failed") continue;
      if (task.repeatEnd?.mode === "at" && now > task.repeatEnd.at) {
        this.tasks.delete(task.id);
        this.invalidateHistory(task.id);
        changed = true;
        continue;
      }
      if (!this.alive(task.ptyId)) {
        task.status = "failed";
        task.error = "unavailable";
        changed = true;
      } else if (now - task.scheduledAt > LATE_GRACE_MS) {
        task.status = "failed";
        task.error = "missed";
        changed = true;
      } else if (task.status === "pending" && task.scheduledAt <= now) {
        task.status = "due";
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** 原子领取到点任务，多个窗口或刷新后的页面只能有一个发送者。 */
  claim(id: string, senderId: number): ScheduledMessageResult {
    this.tick();
    const task = this.tasks.get(id);
    if (!task || task.status !== "due") return { ok: false, error: "unavailable" };
    this.invalidateHistory(id);
    task.status = "sending";
    this.claims.set(id, { senderId, startedAt: this.now() });
    this.changed();
    return { ok: true, task: this.copyTask(task) };
  }

  /** 仅接受领取窗口的结果；循环任务成功后推进到下一时刻，跳过已错过的轮次。 */
  finish(id: string, senderId: number, success: boolean): ScheduledMessageResult {
    const task = this.tasks.get(id);
    if (!task || this.claims.get(id)?.senderId !== senderId) return { ok: false, error: "unavailable" };
    this.claims.delete(id);
    if (success && task.repeatEveryMs) {
      const steps = Math.max(1, Math.floor((this.now() - task.scheduledAt) / task.repeatEveryMs) + 1);
      task.scheduledAt += steps * task.repeatEveryMs;
      task.sentCount = (task.sentCount || 0) + 1;
      if ((task.repeatEnd?.mode === "count" && task.sentCount >= task.repeatEnd.count)
        || (task.repeatEnd?.mode === "at" && task.scheduledAt > task.repeatEnd.at)) this.tasks.delete(id);
      else {
        task.status = "pending";
        delete task.error;
      }
    } else if (success) this.tasks.delete(id);
    else {
      task.status = "failed";
      task.error = "sendFailed";
    }
    this.changed();
    return { ok: true };
  }

  /** 保护队列和可撤销操作中的图片，避免恢复预约后附件已经被清理。 */
  protectsImage(winPath: string): boolean {
    return Array.from(this.tasks.values()).some((task) => task.imagePaths.includes(winPath))
      || Array.from(this.history.values()).some((entry) => entry.before?.imagePaths.includes(winPath) || entry.after?.imagePaths.includes(winPath));
  }
}
