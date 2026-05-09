// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type {
  GitInteractiveRebaseAction,
  GitInteractiveRebaseEntry,
  GitInteractiveRebasePlan,
} from "./types";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export const INTERACTIVE_REBASE_ACTION_OPTIONS: Array<{ value: GitInteractiveRebaseAction; label: string }> = [
  { value: "pick", label: "pick" },
  { value: "edit", label: "edit" },
  { value: "reword", label: "reword" },
  { value: "squash", label: "squash" },
  { value: "fixup", label: "fixup" },
  { value: "drop", label: "drop" },
];

export type InteractiveRebaseActionAvailability = Record<GitInteractiveRebaseAction, {
  enabled: boolean;
  reason?: string;
}>;

/**
 * 判断当前 action 是否会显示提交消息编辑区。
 */
export function isInteractiveRebaseMessageAction(action: GitInteractiveRebaseAction): boolean {
  return action === "reword" || action === "squash";
}

/**
 * 判断当前 action 是否会在 replay 过程中产生一个可继续附着的提交节点。
 */
function isInteractiveRebaseKeepAction(action: GitInteractiveRebaseAction): boolean {
  return action === "pick" || action === "edit" || action === "reword";
}

/**
 * 复制一份可编辑的 rebase entries，避免 UI 直接修改后端快照对象。
 */
export function cloneInteractiveRebaseEntries(entries: GitInteractiveRebaseEntry[]): GitInteractiveRebaseEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

/**
 * 将提交消息中的 subject 提取出来，供 squash 建议文案与兜底显示复用。
 */
function getCommitMessageSubject(message: string): string {
  return String(message || "").split(/\r?\n/, 1)[0] || "";
}

/**
 * 判断消息是否为 autosquash 前缀，便于生成更接近 IDEA 的 squash 初始文案。
 */
function isAutosquashCommitMessage(message: string): boolean {
  return /^(fixup|squash|amend)! /i.test(getCommitMessageSubject(message));
}

/**
 * 当 autosquash 目标提交也在消息集合中时，仅保留正文，减少重复噪音。
 */
function trimAutosquashCommitMessage(message: string): string {
  if (!isAutosquashCommitMessage(message)) return String(message || "");
  return String(message || "").split(/\r?\n/).slice(1).join("\n").trim();
}

/**
 * 按 IDEA `pretty squash` 的思路生成消息建议，用于 squash 文本区提示。
 */
function buildPrettySquashMessage(messagesInput: string[]): string {
  const messages = messagesInput.map((one) => String(one || "")).filter((one) => one.length > 0);
  const distinctSubjects = new Set(
    messages
      .map((one) => (isAutosquashCommitMessage(one) ? "" : getCommitMessageSubject(one)))
      .filter(Boolean),
  );
  const uniqueMessages: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    let normalized = message;
    const subject = getCommitMessageSubject(message);
    const autosquashMatch = subject.match(/^(fixup|squash|amend)! (.+)$/i);
    if (autosquashMatch && distinctSubjects.has(String(autosquashMatch[2] || "").trim())) {
      normalized = trimAutosquashCommitMessage(message);
    }
    const clean = String(normalized || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    uniqueMessages.push(clean);
  }
  return uniqueMessages.join("\n\n\n");
}

/**
 * 解析某条 entry 当前的“有效消息”，优先使用用户已编辑内容，否则回退原始 commit message。
 */
function resolveInteractiveRebaseEffectiveMessage(entry: GitInteractiveRebaseEntry): string {
  const edited = String(entry.message || "");
  if (edited.trim()) return edited;
  return String(entry.fullMessage || "");
}

/**
 * 读取消息输入框里应展示的值；squash 默认留空，避免强行覆盖 Git 的动态默认消息。
 */
export function resolveInteractiveRebaseMessageValue(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
): string {
  const target = entries.find((entry) => entry.hash === hash);
  if (!target) return "";
  if (target.action === "reword") return resolveInteractiveRebaseEffectiveMessage(target);
  if (target.action === "squash") return String(target.message || "");
  return "";
}

/**
 * 为当前选中的 squash/reword 行生成建议消息，供 UI 做提示与“一键填充”。
 */
export function resolveInteractiveRebaseSuggestedMessage(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
): string {
  const index = entries.findIndex((entry) => entry.hash === hash);
  if (index < 0) return "";
  const target = entries[index];
  if (!target) return "";
  if (target.action === "reword") return resolveInteractiveRebaseEffectiveMessage(target);
  if (target.action !== "squash") return "";

  const messages: string[] = [];
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (!entry) continue;
    if (entry.action === "drop") break;
    if (entry.action === "fixup") continue;
    if (entry.action === "squash") {
      messages.unshift(resolveInteractiveRebaseEffectiveMessage(entry) || entry.subject);
      continue;
    }
    messages.unshift(resolveInteractiveRebaseEffectiveMessage(entry) || entry.subject);
    break;
  }
  if (messages.length <= 0) messages.push(resolveInteractiveRebaseEffectiveMessage(target) || target.subject);
  return buildPrettySquashMessage(messages);
}

/**
 * 更新某条 entry 的 action；切到非消息动作时会清理 message 覆盖值。
 */
export function updateInteractiveRebaseEntryAction(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
  action: GitInteractiveRebaseAction,
): GitInteractiveRebaseEntry[] {
  return entries.map((entry) => {
    if (entry.hash !== hash) return entry;
    return {
      ...entry,
      action,
      message: isInteractiveRebaseMessageAction(action) ? entry.message : undefined,
    };
  });
}

/**
 * 更新某条 entry 的消息覆盖值；保留原始换行，只在真正提交时再做 trim。
 */
export function updateInteractiveRebaseEntryMessage(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
  message: string,
): GitInteractiveRebaseEntry[] {
  return entries.map((entry) => (entry.hash === hash ? { ...entry, message } : entry));
}

/**
 * 按目标方向移动一条 rebase entry，供上下箭头按钮复用。
 */
export function moveInteractiveRebaseEntry(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
  offset: -1 | 1,
): GitInteractiveRebaseEntry[] {
  const currentIndex = entries.findIndex((entry) => entry.hash === hash);
  if (currentIndex < 0) return entries;
  const nextIndex = currentIndex + offset;
  if (nextIndex < 0 || nextIndex >= entries.length) return entries;
  const nextEntries = [...entries];
  const [item] = nextEntries.splice(currentIndex, 1);
  nextEntries.splice(nextIndex, 0, item);
  return nextEntries;
}

/**
 * 把某条 entry 直接移动到顶部或底部，供上下文动作与快速重排按钮复用。
 */
export function moveInteractiveRebaseEntryToEdge(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
  edge: "top" | "bottom",
): GitInteractiveRebaseEntry[] {
  const currentIndex = entries.findIndex((entry) => entry.hash === hash);
  if (currentIndex < 0) return entries;
  const nextEntries = [...entries];
  const [item] = nextEntries.splice(currentIndex, 1);
  if (!item) return entries;
  if (edge === "top") nextEntries.unshift(item);
  else nextEntries.push(item);
  return nextEntries;
}

/**
 * 按当前草稿前缀判断目标行是否存在可附着的前序提交，供 fixup/squash enable 语义复用。
 */
function canAttachInteractiveRebaseEntry(entries: GitInteractiveRebaseEntry[], hash: string): boolean {
  let canAttachToPrevious = false;
  for (const entry of entries) {
    if (entry.hash === hash) return canAttachToPrevious;
    if (entry.action === "drop") {
      canAttachToPrevious = false;
      continue;
    }
    if (entry.action === "fixup" || entry.action === "squash") continue;
    canAttachToPrevious = isInteractiveRebaseKeepAction(entry.action);
  }
  return false;
}

/**
 * 计算某条 entry 上下文动作当前是否可用，对齐前序可附着目标这一类 IDEA gating。
 */
export function getInteractiveRebaseActionAvailability(
  entries: GitInteractiveRebaseEntry[],
  hash: string,
  gt?: GitTranslate,
): InteractiveRebaseActionAvailability {
  const attachable = canAttachInteractiveRebaseEntry(entries, hash);
  const attachReason = attachable
    ? undefined
    : (gt ? gt("dialogs.interactiveRebase.actions.attachTargetMissing", "前方缺少可附着的目标提交") : "前方缺少可附着的目标提交");
  return {
    pick: { enabled: true },
    edit: { enabled: true },
    reword: { enabled: true },
    squash: { enabled: attachable, reason: attachReason },
    fixup: { enabled: attachable, reason: attachReason },
    drop: { enabled: true },
  };
}

/**
 * 在 entries 更新后恢复一个稳定的选中提交，优先保留旧选区，否则回退到兜底哈希或首行。
 */
export function restoreInteractiveRebaseSelection(
  entries: GitInteractiveRebaseEntry[],
  preferredHash?: string,
  fallbackHash?: string,
): string {
  const preferred = String(preferredHash || "").trim();
  if (preferred && entries.some((entry) => entry.hash === preferred)) return preferred;
  const fallback = String(fallbackHash || "").trim();
  if (fallback && entries.some((entry) => entry.hash === fallback)) return fallback;
  return entries[0]?.hash || "";
}

/**
 * 判断当前草稿是否相对初始计划发生改动，供取消前放弃确认复用。
 */
export function hasInteractiveRebaseDraftChanges(
  initialEntries: GitInteractiveRebaseEntry[],
  currentEntries: GitInteractiveRebaseEntry[],
): boolean {
  if (initialEntries.length !== currentEntries.length) return true;
  for (let index = 0; index < initialEntries.length; index += 1) {
    const initial = initialEntries[index];
    const current = currentEntries[index];
    if (!initial || !current) return true;
    if (initial.hash !== current.hash) return true;
    if (initial.action !== current.action) return true;
    if (String(initial.message || "") !== String(current.message || "")) return true;
  }
  return false;
}

/**
 * 汇总当前 rebase 草稿的动作分布，便于 UI 给出历史改写影响预览。
 */
export function summarizeInteractiveRebaseEntries(entries: GitInteractiveRebaseEntry[]): {
  keepCount: number;
  rewriteCount: number;
  dropCount: number;
  autosquashCount: number;
} {
  let keepCount = 0;
  let rewriteCount = 0;
  let dropCount = 0;
  let autosquashCount = 0;
  for (const entry of entries) {
    if (entry.autosquashCandidate) autosquashCount += 1;
    if (entry.action === "drop") {
      dropCount += 1;
      continue;
    }
    keepCount += 1;
    if (entry.action !== "pick") rewriteCount += 1;
  }
  return {
    keepCount,
    rewriteCount,
    dropCount,
    autosquashCount,
  };
}

/**
 * 校验 interactive rebase 草稿，前端先做一轮即时校验，避免无意义地发起主进程执行。
 */
export function validateInteractiveRebasePlanEntries(
  entries: GitInteractiveRebaseEntry[],
  gt?: GitTranslate,
): string {
  if (entries.length <= 0) return gt ? gt("interactiveRebase.validation.emptyPlan", "交互式变基计划不能为空") : "交互式变基计划不能为空";
  let canAttachToPrevious = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.action === "drop") {
      canAttachToPrevious = false;
      continue;
    }
    if (entry.action === "fixup" || entry.action === "squash") {
      if (!canAttachToPrevious) {
        return gt
          ? gt("interactiveRebase.validation.attachTargetMissing", "第 {{index}} 条提交前缺少可合并的目标提交", { index: index + 1 })
          : `第 ${index + 1} 条提交前缺少可合并的目标提交`;
      }
      continue;
    }
    if (entry.action === "reword") {
      const message = resolveInteractiveRebaseEffectiveMessage(entry).trim();
      if (!message) {
        return gt
          ? gt("interactiveRebase.validation.messageMissing", "第 {{index}} 条提交的提交信息不能为空", { index: index + 1 })
          : `第 ${index + 1} 条提交的提交信息不能为空`;
      }
    }
    canAttachToPrevious = isInteractiveRebaseKeepAction(entry.action);
  }
  return "";
}

/**
 * 把当前草稿组装为主进程 `log.rebasePlan.run` 需要的最小 payload。
 */
export function buildInteractiveRebaseRunPayload(
  plan: GitInteractiveRebasePlan,
  entries: GitInteractiveRebaseEntry[],
): {
  targetHash: string;
  headHash: string;
  entries: Array<{ hash: string; action: GitInteractiveRebaseAction; message?: string }>;
} {
  return {
    targetHash: plan.targetHash,
    headHash: plan.headHash,
    entries: entries.map((entry) => {
      const trimmedMessage = String(entry.message || "").trim();
      return {
        hash: entry.hash,
        action: entry.action,
        message: trimmedMessage || undefined,
      };
    }),
  };
}
