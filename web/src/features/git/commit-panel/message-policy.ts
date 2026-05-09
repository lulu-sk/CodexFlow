// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { normalizeCommitMessageForPolicy } from "./checks";

const LAST_COMMIT_MESSAGE_STORAGE_KEY = "cf.git.commit.lastMessage";

type CommitMessageStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * 把提交消息规整为稳定的持久化文本，统一修正换行符。
 */
export function normalizePersistedCommitMessage(message: string): string {
  return String(message || "").replace(/\r\n?/g, "\n");
}

/**
 * 读取最近一次持久化的 staging 提交消息，供非 changelist 模式与外部入口预热复用。
 */
export function readLastCommitMessage(storage?: CommitMessageStorage | null): string {
  if (!storage) return "";
  try {
    return normalizePersistedCommitMessage(storage.getItem(LAST_COMMIT_MESSAGE_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

/**
 * 按统一策略写入最近一次提交消息；空白消息会直接清理，避免污染下次打开时的默认值。
 */
export function writeLastCommitMessage(storage: CommitMessageStorage | null | undefined, message: string): void {
  if (!storage) return;
  const normalized = normalizePersistedCommitMessage(message).trim();
  try {
    if (!normalized) {
      storage.removeItem(LAST_COMMIT_MESSAGE_STORAGE_KEY);
      return;
    }
    storage.setItem(LAST_COMMIT_MESSAGE_STORAGE_KEY, normalized);
  } catch {}
}

/**
 * 判断当前提交消息是否值得进入“最近一次消息”存储；会复用 cleanup 规则过滤注释模板。
 */
export function shouldPersistLastCommitMessage(message: string, cleanupMessage: boolean): boolean {
  return !!normalizeCommitMessageForPolicy(message, cleanupMessage);
}

/**
 * 在非 changelist 草稿模式下，为 GitWorkbench 推导初始提交消息。
 */
export function resolveInitialCommitMessage(args: {
  currentMessage: string;
  persistedMessage: string;
  changeListDraftMessage?: string;
  changeListsEnabled: boolean;
  stagingAreaEnabled: boolean;
  commitAmendEnabled: boolean;
}): string {
  const currentMessage = String(args.currentMessage || "");
  if (currentMessage.trim()) return currentMessage;
  if (args.commitAmendEnabled) return currentMessage;
  if (args.changeListsEnabled && !args.stagingAreaEnabled) {
    return String(args.changeListDraftMessage || "");
  }
  return normalizePersistedCommitMessage(args.persistedMessage);
}
