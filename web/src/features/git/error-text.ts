// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { interpolateI18nText } from "@/lib/translate";
import { resolveGitText } from "./git-i18n";

type GitErrorTranslationRule = {
  exact?: string;
  pattern?: RegExp;
  key: string;
  fallback: string;
  buildValues?: (match: RegExpMatchArray) => Record<string, unknown>;
};

const GIT_ERROR_TRANSLATION_RULES: GitErrorTranslationRule[] = [
  {
    exact: "缺少仓库路径",
    key: "errors.backend.missingRepoPath",
    fallback: "缺少仓库路径",
  },
  {
    exact: "missing repoMainPath",
    key: "errors.backend.missingRepoPath",
    fallback: "缺少仓库路径",
  },
  {
    exact: "missing repoDir",
    key: "errors.backend.missingRepoPath",
    fallback: "缺少仓库路径",
  },
  {
    exact: "读取目标提交父提交失败",
    key: "errors.backend.readTargetParentCommitFailed",
    fallback: "读取目标提交父提交失败",
  },
  {
    exact: "读取父提交失败",
    key: "errors.backend.readParentCommitFailed",
    fallback: "读取父提交失败",
  },
  {
    exact: "写入重放提交失败",
    key: "errors.backend.writeReplayCommitFailed",
    fallback: "写入重放提交失败",
  },
  {
    exact: "写入提取提交失败",
    key: "errors.backend.writeExtractCommitFailed",
    fallback: "写入提取提交失败",
  },
  {
    exact: "提交失败",
    key: "workbench.commit.failed",
    fallback: "提交失败",
  },
  {
    exact: "创建 Fixup 提交失败",
    key: "errors.backend.fixupCommitFailed",
    fallback: "创建 Fixup 提交失败",
  },
  {
    exact: "创建 Squash 提交失败",
    key: "errors.backend.squashCommitFailed",
    fallback: "创建 Squash 提交失败",
  },
  {
    exact: "摘取提交失败",
    key: "errors.backend.cherryPickCommitFailed",
    fallback: "优选提交失败",
  },
  {
    exact: "还原提交失败",
    key: "errors.backend.revertCommitFailed",
    fallback: "还原提交失败",
  },
  {
    exact: "删除提交失败",
    key: "errors.backend.deleteCommitFailed",
    fallback: "删除提交失败",
  },
  {
    exact: "撤销删除提交失败",
    key: "workbench.historyRewrite.undoDeleteCommitFailed",
    fallback: "撤销删除提交失败",
  },
  {
    exact: "撤销提交失败",
    key: "errors.backend.undoCommitFailed",
    fallback: "撤销提交失败",
  },
  {
    exact: "跳过空优选提交失败",
    key: "errors.backend.skipEmptyCherryPickFailed",
    fallback: "跳过空优选提交失败",
  },
  {
    exact: "存在未解决冲突文件，请先解决后再提交",
    key: "errors.backend.unresolvedConflictsBeforeCommit",
    fallback: "存在未解决冲突文件，请先解决后再提交",
  },
  {
    exact: "当前仓库仍有合并变更未纳入本次提交，请确认后重试",
    key: "errors.backend.mergeChangesExcludedFromCommit",
    fallback: "当前仓库仍有合并变更未纳入本次提交，请确认后重试",
  },
  {
    pattern: /^文件移动已单独提交，但主提交失败[:：](.+)$/u,
    key: "errors.backend.renameCommitPartialFailure",
    fallback: "文件移动已单独提交，但主提交失败：{{detail}}",
    buildValues: (match) => ({
      detail: String(match[1] || "").trim(),
    }),
  },
  {
    pattern: /^部分仓库已提交，但仓库 ['‘“]?(.+?)['’”]? 提交失败[:：](.+)$/u,
    key: "errors.backend.multiRepoCommitPartialFailure",
    fallback: "部分仓库已提交，但仓库 '{{repoRoot}}' 提交失败：{{detail}}",
    buildValues: (match) => ({
      repoRoot: String(match[1] || "").trim(),
      detail: String(match[2] || "").trim(),
    }),
  },
];

/**
 * 清洗主进程或宿主层回传的错误文本，去掉 `%x00/%x1e` 协议占位符与控制字符。
 */
export function sanitizeGitErrorText(raw: unknown): string {
  return String(raw || "")
    .replace(/%x(?:00|1e)/gi, " ")
    .replace(/\x00|\x1e/g, "\n")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 把后端直接返回的已知原始错误翻译为当前语言，避免英文界面出现中文透传错误。
 */
function translateKnownGitErrorText(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  for (const rule of GIT_ERROR_TRANSLATION_RULES) {
    if (rule.exact && text === rule.exact) {
      return resolveGitText(rule.key, rule.fallback);
    }
    if (!rule.pattern) continue;
    const match = text.match(rule.pattern);
    if (!match) continue;
    const values = rule.buildValues ? rule.buildValues(match) : undefined;
    return interpolateI18nText(resolveGitText(rule.key, rule.fallback, values), values);
  }
  return "";
}

/**
 * 把任意错误对象规整为 UI 可展示文本；若清洗后为空则回退到调用方提供的兜底文案。
 */
export function toErrorText(raw: unknown, fallback: string): string {
  const sanitized = sanitizeGitErrorText(raw);
  return translateKnownGitErrorText(sanitized) || sanitized || String(fallback || "").trim();
}
