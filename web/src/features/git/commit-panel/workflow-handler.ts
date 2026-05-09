// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitStatusEntry } from "../types";
import type { GitPostCommitPushResult } from "../types";
import { resolveGitText } from "../git-i18n";
import type { CommitWorkflowPayload, GitCommitIntent } from "./commit-workflow";
import { buildPostCommitChecks, findBlockingCommitCheck, runBeforeCommitChecks, type GitCommitCheck } from "./checks";
import { shouldPersistLastCommitMessage } from "./message-policy";

export type PrepareGitCommitWorkflowArgs = {
  message: string;
  intent: GitCommitIntent;
  cleanupMessage: boolean;
  explicitAuthor: string;
  defaultAuthor: string;
  authorDate: string;
  entries?: GitStatusEntry[];
  resolvePayloadAsync: (args: {
    message: string;
    intent: GitCommitIntent;
    entries?: GitStatusEntry[];
  }) => Promise<{ ok: true; payload: CommitWorkflowPayload } | { ok: false; error: string }>;
};

export type PreparedGitCommitWorkflow = {
  message: string;
  payload: CommitWorkflowPayload;
  checks: GitCommitCheck[];
};

/**
 * 在真正调用后端提交前统一执行 checks + payload 解析，避免 GitWorkbench 各入口重复拼装相同流程。
 */
export async function prepareGitCommitWorkflowAsync(
  args: PrepareGitCommitWorkflowArgs,
): Promise<
  | { ok: true; workflow: PreparedGitCommitWorkflow }
  | { ok: false; error: string; checks: GitCommitCheck[]; blockingCheck: GitCommitCheck | null }
> {
  const message = String(args.message || "");
  const checks = runBeforeCommitChecks({
    message,
    cleanupMessage: args.cleanupMessage,
    explicitAuthor: args.explicitAuthor,
    defaultAuthor: args.defaultAuthor,
    authorDate: args.authorDate,
  });
  const blockingCheck = findBlockingCommitCheck(checks);
  if (blockingCheck) {
    return {
      ok: false,
      error: blockingCheck.message,
      checks,
      blockingCheck,
    };
  }

  const payloadRes = await args.resolvePayloadAsync({
    message: message.trim(),
    intent: args.intent,
    entries: args.entries,
  });
  if (!payloadRes.ok) {
    return {
      ok: false,
      error: payloadRes.error,
      checks,
      blockingCheck: null,
    };
  }

  if (!String(payloadRes.payload.message || "").trim()) {
    return {
      ok: false,
      error: resolveGitText("commit.checks.emptyMessage", "提交信息不能为空。"),
      checks,
      blockingCheck: null,
    };
  }

  return {
    ok: true,
    workflow: {
      message,
      payload: payloadRes.payload,
      checks,
    },
  };
}

/**
 * 统一收口提交成功后的 checks 与最近消息持久化决策，供主提交按钮与右键提交入口复用。
 */
export function finalizeGitCommitWorkflowSuccess(args: {
  message: string;
  cleanupMessage: boolean;
  amend: boolean;
  intent: GitCommitIntent;
  commitHash: string;
  postCommitPush?: GitPostCommitPushResult;
}): {
  postChecks: GitCommitCheck[];
  shouldPersistMessage: boolean;
} {
  return {
    postChecks: buildPostCommitChecks({
      amend: args.amend,
      intent: args.intent,
      commitHash: args.commitHash,
      postCommitPush: args.postCommitPush,
    }),
    shouldPersistMessage: shouldPersistLastCommitMessage(args.message, args.cleanupMessage),
  };
}
