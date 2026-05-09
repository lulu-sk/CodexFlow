// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitChangedFile, GitLogDetailsSingle, GitStatusEntry } from "../types";
import { resolveGitText } from "../git-i18n";

export const COMMIT_AMEND_SOURCE_ID = "amend";
const COMMIT_AMEND_CHANGE_LIST_ID = "__amend__";

export type CommitAmendDetails = {
  hash: string;
  shortHash: string;
  subject: string;
  fullMessage: string;
  author: string;
  entries: GitStatusEntry[];
};

export type CommitAmendRestoreSnapshot = {
  beforeMessage: string;
  amendMessage: string;
  beforeAuthor: string;
  amendAuthor: string;
};

/**
 * 规整 amend 场景里复用的文本输入，统一去掉首尾空白，避免比较逻辑被脏空格干扰。
 */
function normalizeCommitAmendText(value: string): string {
  return String(value || "").trim();
}

/**
 * 把提交哈希规整为统一比较键；当前桥接层应传入 canonical hash，因此这里仅保留大小写与空白归一化。
 */
function normalizeCommitHashIdentity(value: string): string {
  return normalizeCommitAmendText(value).toLowerCase();
}

/**
 * 按 IDEA `equalsIgnoreWhitespaces` 近似语义压平提交消息中的连续空白，供 amend 消息回填判定复用。
 */
function normalizeCommitAmendMessageForCompare(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * 从 Git changed file 的状态文本中提取稳定状态码，兼容 `R100` 这类带相似度后缀的值。
 */
function resolveCommitAmendFileStatusCode(statusRaw: string): string {
  const clean = normalizeCommitAmendText(statusRaw);
  return clean ? clean.charAt(0).toUpperCase() : "M";
}

/**
 * 把 Git changed file 的状态码转换为提交树里可读的中文状态文案。
 */
function resolveCommitAmendFileStatusText(statusRaw: string): string {
  switch (resolveCommitAmendFileStatusCode(statusRaw)) {
    case "A":
      return resolveGitText("workbench.statusCodes.added", "新增");
    case "D":
      return resolveGitText("workbench.statusCodes.deleted", "删除");
    case "R":
      return resolveGitText("workbench.statusCodes.renamed", "重命名");
    case "C":
      return resolveGitText("workbench.statusCodes.copied", "复制");
    case "T":
      return resolveGitText("workbench.statusCodes.typeChanged", "类型变更");
    default:
      return resolveGitText("workbench.statusCodes.modified", "修改");
  }
}

/**
 * 把提交详情中的作者姓名与邮箱格式化为 Git `--author` 可直接复用的标准文本。
 */
export function formatCommitAmendAuthor(authorName: string, authorEmail: string): string {
  const name = normalizeCommitAmendText(authorName);
  const email = normalizeCommitAmendText(authorEmail);
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

/**
 * 把 amend 目标提交中的单个 changed file 映射为提交树可渲染的虚拟状态条目。
 */
export function createCommitAmendEntry(file: GitChangedFile): GitStatusEntry {
  const statusCode = resolveCommitAmendFileStatusCode(file.status);
  return {
    path: normalizeCommitAmendText(file.path),
    oldPath: normalizeCommitAmendText(file.oldPath || "") || undefined,
    x: statusCode,
    y: ".",
    staged: false,
    unstaged: false,
    untracked: false,
    ignored: false,
    renamed: statusCode === "R",
    deleted: statusCode === "D",
    statusText: resolveCommitAmendFileStatusText(file.status),
    changeListId: COMMIT_AMEND_CHANGE_LIST_ID,
  };
}

/**
 * 把单提交日志详情规整为 amend 模型，统一供提交树 helper 节点、消息回填与作者回填复用。
 */
export function buildCommitAmendDetails(detail: GitLogDetailsSingle["detail"]): CommitAmendDetails {
  const subject = normalizeCommitAmendText(detail.subject) || normalizeCommitAmendText(detail.shortHash) || resolveGitText("commit.amend.previousCommit", "上一提交");
  const body = String(detail.body || "");
  return {
    hash: normalizeCommitAmendText(detail.hash),
    shortHash: normalizeCommitAmendText(detail.shortHash),
    subject,
    fullMessage: body.trim() ? `${subject}\n\n${body}` : subject,
    author: formatCommitAmendAuthor(detail.authorName, detail.authorEmail),
    entries: (detail.files || [])
      .map((file) => createCommitAmendEntry(file))
      .filter((entry) => !!entry.path),
  };
}

/**
 * 判断两个提交哈希是否指向同一提交。
 * IDEA 比较的是 canonical `Hash` 对象；这里应保持同样的“精确身份”语义，不把短前缀适配成同一提交。
 */
export function isSameCommitHashIdentity(leftHash: string, rightHash: string): boolean {
  const left = normalizeCommitHashIdentity(leftHash);
  const right = normalizeCommitHashIdentity(rightHash);
  if (!left || !right) return false;
  return left === right;
}

/**
 * 构造 amend 模式退出时用于恢复草稿的快照，仅保存“进入 amend 前”的 message/author 与 amend 写入值。
 */
export function createCommitAmendRestoreSnapshot(
  beforeMessage: string,
  beforeAuthor: string,
  details: CommitAmendDetails,
): CommitAmendRestoreSnapshot {
  return {
    beforeMessage: String(beforeMessage || ""),
    amendMessage: String(details.fullMessage || ""),
    beforeAuthor: normalizeCommitAmendText(beforeAuthor),
    amendAuthor: normalizeCommitAmendText(details.author),
  };
}

/**
 * 判断当前节点是否属于 amend helper 来源，供主链路切换到 commit diff 模式时复用。
 */
export function isCommitAmendNode(
  node: Pick<{ sourceKind?: string; sourceId?: string }, "sourceKind" | "sourceId"> | null | undefined,
): boolean {
  return String(node?.sourceKind || "") === "modifier" && String(node?.sourceId || "") === COMMIT_AMEND_SOURCE_ID;
}

/**
 * 判断加载完成后是否需要用 amend 消息覆盖当前提交消息，对齐 IDEA non-modal amend 的“忽略空白差异”判定。
 */
export function shouldApplyCommitAmendMessage(currentMessage: string, amendMessage: string): boolean {
  const nextMessage = String(amendMessage || "");
  if (!nextMessage.trim()) return false;
  return normalizeCommitAmendMessageForCompare(currentMessage) !== normalizeCommitAmendMessageForCompare(nextMessage);
}

/**
 * 仅当当前消息仍等于 amend 写入值时才恢复旧草稿，避免覆盖用户在 amend 模式下主动编辑过的新消息。
 */
export function shouldRestoreCommitAmendMessage(
  currentMessage: string,
  snapshot: CommitAmendRestoreSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  return String(currentMessage || "") === String(snapshot.amendMessage || "");
}

/**
 * 仅当当前作者仍等于 amend 写入值时才恢复旧作者，避免覆盖用户在 amend 模式下手动改过的作者字段。
 */
export function shouldRestoreCommitAmendAuthor(
  currentAuthor: string,
  snapshot: CommitAmendRestoreSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  return normalizeCommitAmendText(currentAuthor) === normalizeCommitAmendText(snapshot.amendAuthor);
}

/**
 * 生成 amend helper 分组标题，统一在提交树中标识当前被修改的目标提交。
 */
export function buildCommitAmendGroupLabel(details: CommitAmendDetails): string {
  const shortHash = normalizeCommitAmendText(details.shortHash);
  const subject = normalizeCommitAmendText(details.subject) || shortHash || "上一提交";
  return shortHash
    ? resolveGitText("commit.amend.groupWithHash", "上一提交 {{hash}} · {{subject}}", { hash: shortHash, subject })
    : resolveGitText("commit.amend.groupWithoutHash", "上一提交 · {{subject}}", { subject });
}

/**
 * 根据 amend、push 与 commit-all 语义生成提交动作文案；
 * 仅主提交按钮会在非 amend 的 commit-all 场景切换为“全部提交”，副动作仍保持“提交并推送...”。
 */
export function buildCommitActionLabel(amendEnabled: boolean, pushAfter: boolean, commitAll: boolean = false): string {
  if (pushAfter) return amendEnabled
    ? resolveGitText("commit.action.amendAndPush", "修改并推送...")
    : resolveGitText("commit.action.commitAndPush", "提交并推送...");
  if (amendEnabled) return resolveGitText("commit.action.amend", "修改提交");
  return commitAll
    ? resolveGitText("commit.action.commitAll", "全部提交")
    : resolveGitText("commit.action.commit", "提交");
}
