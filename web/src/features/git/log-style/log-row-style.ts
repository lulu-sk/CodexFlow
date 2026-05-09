// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitLogRowStyle = {
  highlightCurrentBranch: boolean;
  selected: boolean;
  classNames: string[];
  graphSelected: boolean;
};

/**
 * 判断当前日志视图是否应启用 current branch 高亮，语义对齐 IDEA `CurrentBranchHighlighter.update()`。
 */
export function shouldHighlightCurrentBranch(args: {
  currentBranch: string;
  branchFilter: string;
}): boolean {
  const currentBranch = String(args.currentBranch || "").trim();
  const branchFilter = String(args.branchFilter || "").trim();
  if (!currentBranch) return false;
  if (!branchFilter || branchFilter === "all") return true;
  if (branchFilter === "HEAD") return false;
  return branchFilter !== currentBranch;
}

/**
 * 构建日志行视觉状态，把 current branch 高亮与 selected 统一收口为单一展示模型。
 */
export function buildGitLogRowStyle(args: {
  selected: boolean;
  currentBranch: string;
  branchFilter: string;
  containedInCurrentBranch?: boolean;
}): GitLogRowStyle {
  const selected = args.selected === true;
  const highlightCurrentBranch = !selected
    && shouldHighlightCurrentBranch({
      currentBranch: args.currentBranch,
      branchFilter: args.branchFilter,
    })
    && args.containedInCurrentBranch === true;

  const classNames: string[] = [];
  if (highlightCurrentBranch) classNames.push("cf-git-row-current-branch");
  if (selected) classNames.push("cf-git-row-selected");

  return {
    highlightCurrentBranch,
    selected,
    classNames,
    graphSelected: selected,
  };
}
