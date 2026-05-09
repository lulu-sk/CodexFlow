// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { normalizeCommitAuthorDateInput } from "./commit-options-model";
import type { GitPostCommitPushResult } from "../types";
import type { GitCommitIntent } from "./commit-workflow";
import { resolveGitText } from "../git-i18n";

export type GitCommitCheckLevel = "error" | "warning" | "info";

export type GitCommitCheck = {
  id: string;
  level: GitCommitCheckLevel;
  message: string;
  blocking: boolean;
  confirmationRequired?: boolean;
};

export type GitCommitBeforeCheckArgs = {
  message: string;
  cleanupMessage: boolean;
  explicitAuthor: string;
  defaultAuthor: string;
  authorDate: string;
  showEmptyMessageError?: boolean;
};

export type GitCommitPostCheckArgs = {
  amend: boolean;
  intent: GitCommitIntent;
  commitHash: string;
  postCommitPush?: GitPostCommitPushResult;
};

/**
 * 按提交消息策略规整消息文本；启用 cleanup 时会额外剔除注释行，避免只剩模板注释仍被当成有效消息。
 */
export function normalizeCommitMessageForPolicy(message: string, cleanupMessage: boolean): string {
  const lines = String(message || "").replace(/\r\n?/g, "\n").split("\n");
  const normalized = cleanupMessage
    ? lines.filter((line) => !String(line || "").trim().startsWith("#"))
    : lines;
  return normalized.join("\n").trim();
}

/**
 * 运行提交前检查，统一承接消息策略、默认作者与作者时间校验，并允许调用方控制是否立即暴露空提交信息错误。
 */
export function runBeforeCommitChecks(args: GitCommitBeforeCheckArgs): GitCommitCheck[] {
  const checks: GitCommitCheck[] = [];
  const normalizedMessage = normalizeCommitMessageForPolicy(args.message, args.cleanupMessage);
  const explicitAuthor = String(args.explicitAuthor || "").trim();
  const defaultAuthor = String(args.defaultAuthor || "").trim();
  const authorDate = String(args.authorDate || "").trim();

  if (!normalizedMessage && args.showEmptyMessageError !== false) {
    checks.push({
      id: "message-empty",
      level: "error",
      blocking: true,
      message: args.cleanupMessage
        ? resolveGitText("commit.checks.emptyAfterCleanup", "清理提交消息后内容为空，请输入有效的提交信息。")
        : resolveGitText("commit.checks.emptyMessage", "提交信息不能为空。"),
    });
  }

  if (authorDate && !normalizeCommitAuthorDateInput(authorDate)) {
    checks.push({
      id: "author-date-invalid",
      level: "error",
      blocking: true,
      message: resolveGitText("commit.checks.authorDateInvalid", "作者时间格式无效，请使用有效的日期时间。"),
    });
  }

  if (!explicitAuthor && !defaultAuthor) {
    checks.push({
      id: "author-missing",
      level: "error",
      blocking: true,
      message: resolveGitText("commit.checks.authorMissing", "未配置默认作者，请先设置 Git user.name / user.email，或在提交选项里填写作者。"),
    });
  } else if (!explicitAuthor && defaultAuthor) {
    checks.push({
      id: "author-default",
      level: "info",
      blocking: false,
      message: resolveGitText("commit.checks.defaultAuthor", "默认作者：{{author}}", { author: defaultAuthor }),
    });
  }

  return checks;
}

/**
 * 返回第一个阻塞性的提交检查，供 UI 在真正提交前快速短路。
 */
export function findBlockingCommitCheck(checks: GitCommitCheck[]): GitCommitCheck | null {
  for (const check of checks) {
    if (check.blocking) return check;
  }
  return null;
}

/**
 * 提取需要用户显式确认的 warning 检查，供统一提交流程在真正调用后端前弹出一次确认。
 */
export function findConfirmationCommitChecks(checks: GitCommitCheck[]): GitCommitCheck[] {
  return checks.filter((check) => check.confirmationRequired === true);
}

/**
 * 构建提交完成后的后置检查摘要，统一承接 amend / push-after 的后续提示。
 */
export function buildPostCommitChecks(args: GitCommitPostCheckArgs): GitCommitCheck[] {
  const checks: GitCommitCheck[] = [];
  const pushAfter = args.intent === "commitAndPush";
  const shortHash = String(args.commitHash || "").trim().slice(0, 8);
  checks.push({
    id: "commit-created",
    level: "info",
    blocking: false,
    message: args.amend
      ? resolveGitText("commit.checks.updatedPrevious", "已更新上一提交{{suffix}}。", { suffix: shortHash ? `：${shortHash}` : "" })
      : resolveGitText("commit.checks.createdCommit", "已创建提交{{suffix}}。", { suffix: shortHash ? `：${shortHash}` : "" }),
  });
  if (args.postCommitPush?.mode === "pushed") {
    checks.push({
      id: "push-after-pushed",
      level: "info",
      blocking: false,
      message: resolveGitText("commit.checks.pushAfterPushed", "提交后已直接推送。"),
    });
  } else if (pushAfter || args.postCommitPush?.mode === "preview") {
    checks.push({
      id: "push-after",
      level: "info",
      blocking: false,
      message: resolveGitText("commit.checks.pushAfter", "接下来将打开推送对话框。"),
    });
  }
  return checks;
}
