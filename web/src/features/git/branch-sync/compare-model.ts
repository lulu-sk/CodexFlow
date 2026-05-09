// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ActionDialogConfig, ActionDialogOption } from "../action-dialog";
import type { GitBranchItem, GitBranchPopupRepository } from "../types";
import { resolveGitText } from "../git-i18n";

export type BranchCompareMode = "commits" | "files";

export type BranchCompareRefOption = {
  value: string;
  label: string;
  description?: string;
  section: "local" | "remote";
};

/**
 * 按分支条目构造对话框选项，统一补齐当前分支与上游提示，避免 UI 层重复拼接说明文案。
 */
function buildBranchCompareRefOption(
  item: GitBranchItem,
  section: "local" | "remote",
  currentBranch: string,
): BranchCompareRefOption | null {
  const value = String(item.name || "").trim();
  if (!value) return null;
  const descriptionParts: string[] = [];
  if (section === "local" && value === currentBranch) descriptionParts.push(resolveGitText("dialogs.branchCompare.currentBranch", "当前分支"));
  if (item.secondaryText) descriptionParts.push(String(item.secondaryText).trim());
  return {
    value,
    label: value,
    description: descriptionParts.filter(Boolean).join(" · ") || undefined,
    section,
  };
}

/**
 * 从当前仓库快照收集可供比较的引用选项；本地分支优先，远端分支随后，且按引用名去重。
 */
export function collectBranchCompareRefOptions(
  repository: GitBranchPopupRepository | null | undefined,
): BranchCompareRefOption[] {
  if (!repository) return [];
  const currentBranch = String(repository.currentBranch || "").trim();
  const options: BranchCompareRefOption[] = [];
  const seen = new Set<string>();
  const pushItems = (items: GitBranchItem[] | undefined, section: "local" | "remote"): void => {
    for (const item of items || []) {
      const option = buildBranchCompareRefOption(item, section, currentBranch);
      if (!option || seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
    }
  };
  pushItems(repository.groups.local, "local");
  pushItems(repository.groups.remote, "remote");
  return options;
}

/**
 * 在“任选另一分支”场景下推导默认目标，优先当前分支，否则选择第一个不等于目标引用的候选项。
 */
export function resolveDefaultBranchCompareRef(args: {
  repository: GitBranchPopupRepository | null | undefined;
  targetRef: string;
}): string {
  const targetRef = String(args.targetRef || "").trim();
  const currentBranch = String(args.repository?.currentBranch || "").trim();
  if (currentBranch && currentBranch !== targetRef) return currentBranch;
  const firstAlternative = collectBranchCompareRefOptions(args.repository).find((option) => option.value !== targetRef);
  return firstAlternative?.value || "";
}

/**
 * 把左右引用转换为日志 revision 范围，统一采用三点语义承接“比较差异提交”视图。
 */
export function buildBranchCompareRevision(leftRef: string, rightRef: string): string {
  const left = String(leftRef || "").trim();
  const right = String(rightRef || "").trim();
  if (!left || !right) return "";
  return `${left}...${right}`;
}

/**
 * 格式化比较摘要标题，供日志筛选徽标、文件对话框标题等位置复用。
 */
export function formatBranchCompareLabel(leftRef: string, rightRef?: string): string {
  const left = String(leftRef || "").trim();
  const right = String(rightRef || "").trim();
  if (!left) return "";
  if (!right) return `${left} ↔ Working Tree`;
  return `${left} ↔ ${right}`;
}

/**
 * 为“与任意另一分支比较”构造统一对话框配置，复用当前 action-dialog 渲染能力而不新增临时表单实现。
 */
export function buildBranchCompareDialogConfig(args: {
  repository: GitBranchPopupRepository | null | undefined;
  targetRef: string;
  mode: BranchCompareMode;
}): ActionDialogConfig | null {
  const targetRef = String(args.targetRef || "").trim();
  if (!targetRef) return null;
  const repository = args.repository;
  const options: ActionDialogOption[] = collectBranchCompareRefOptions(repository)
    .filter((option) => option.value !== targetRef)
    .map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      badge: option.section === "remote"
        ? resolveGitText("dialogs.branchCompare.badges.remote", "远端")
        : resolveGitText("dialogs.branchCompare.badges.local", "本地"),
      badgeVariant: option.section === "remote" ? "secondary" : "info",
    }));
  if (options.length <= 0) return null;
  const defaultRef = resolveDefaultBranchCompareRef({
    repository,
    targetRef,
  }) || options[0]?.value || "";
  return {
    title: args.mode === "files"
      ? resolveGitText("dialogs.branchCompare.titleFiles", "选择另一分支以比较文件")
      : resolveGitText("dialogs.branchCompare.titleCommits", "选择另一分支以比较提交"),
    description: args.mode === "files"
      ? resolveGitText("dialogs.branchCompare.descriptionFiles", "将展示 {{target}} 与另一分支之间的文件差异", { target: targetRef })
      : resolveGitText("dialogs.branchCompare.descriptionCommits", "将展示 {{target}} 与另一分支之间的提交差异", { target: targetRef }),
    confirmText: args.mode === "files"
      ? resolveGitText("dialogs.branchCompare.confirmFiles", "查看文件差异")
      : resolveGitText("dialogs.branchCompare.confirmCommits", "查看提交差异"),
    fields: [{
      key: "otherRef",
      label: resolveGitText("dialogs.branchCompare.otherBranch", "另一分支"),
      type: "select",
      options,
      required: true,
    }],
    defaults: {
      otherRef: defaultRef,
    },
  };
}
