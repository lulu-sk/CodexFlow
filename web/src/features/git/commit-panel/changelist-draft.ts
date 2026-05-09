// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitChangeList } from "../types";

const CHANGE_LIST_DRAFT_AUTHOR_KEY = "commitAuthor";
const CHANGE_LIST_DRAFT_AUTHOR_DATE_KEY = "commitAuthorDate";
const CHANGE_LIST_DRAFT_COMMIT_RENAMES_SEPARATELY_KEY = "commitRenamesSeparately";

export type GitChangeListCommitDraft = {
  message: string;
  author: string;
  authorDate: string;
  commitRenamesSeparately: boolean;
};

/**
 * 读取 changelist 上保存的提交草稿，统一承接 comment 与 data 两类字段。
 */
export function readChangeListCommitDraft(changeList?: GitChangeList | null): GitChangeListCommitDraft {
  const data = changeList?.data && typeof changeList.data === "object"
    ? changeList.data
    : {};
  return {
    message: String(changeList?.comment || ""),
    author: String(data[CHANGE_LIST_DRAFT_AUTHOR_KEY] || "").trim(),
    authorDate: String(data[CHANGE_LIST_DRAFT_AUTHOR_DATE_KEY] || "").trim(),
    commitRenamesSeparately: data[CHANGE_LIST_DRAFT_COMMIT_RENAMES_SEPARATELY_KEY] === true,
  };
}

/**
 * 比较两份 changelist 提交草稿是否等价，供 debounce 持久化时跳过无效写回。
 */
export function areChangeListCommitDraftsEqual(
  left?: GitChangeListCommitDraft | null,
  right?: GitChangeListCommitDraft | null,
): boolean {
  return String(left?.message || "") === String(right?.message || "")
    && String(left?.author || "") === String(right?.author || "")
    && String(left?.authorDate || "") === String(right?.authorDate || "")
    && (left?.commitRenamesSeparately === true) === (right?.commitRenamesSeparately === true);
}

/**
 * 把当前提交草稿转换为 changelist comment/data patch，并保留其他未识别的扩展字段。
 */
export function buildChangeListCommitDraftPatch(
  changeList: GitChangeList | null | undefined,
  draft: GitChangeListCommitDraft,
): { comment: string; data: Record<string, any> | null } {
  const currentData = changeList?.data && typeof changeList.data === "object"
    ? { ...changeList.data }
    : {};
  const nextData = { ...currentData };
  if (draft.author) nextData[CHANGE_LIST_DRAFT_AUTHOR_KEY] = draft.author;
  else delete nextData[CHANGE_LIST_DRAFT_AUTHOR_KEY];
  if (draft.authorDate) nextData[CHANGE_LIST_DRAFT_AUTHOR_DATE_KEY] = draft.authorDate;
  else delete nextData[CHANGE_LIST_DRAFT_AUTHOR_DATE_KEY];
  if (draft.commitRenamesSeparately) nextData[CHANGE_LIST_DRAFT_COMMIT_RENAMES_SEPARATELY_KEY] = true;
  else delete nextData[CHANGE_LIST_DRAFT_COMMIT_RENAMES_SEPARATELY_KEY];
  return {
    comment: String(draft.message || ""),
    data: Object.keys(nextData).length > 0 ? nextData : null,
  };
}
