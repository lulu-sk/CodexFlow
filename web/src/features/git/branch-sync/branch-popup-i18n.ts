// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

type GitBranchPopupTextResolver = (key: string, fallback: string) => string;

const BRANCH_POPUP_QUICK_ACTION_TEXT: Record<string, { key: string; fallback: string }> = {
  update: {
    key: "workbench.topToolbar.updateProject",
    fallback: "Update Project",
  },
  commit: {
    key: "workbench.topToolbar.commitWithEllipsis",
    fallback: "Commit...",
  },
  push: {
    key: "workbench.branches.context.pushWithEllipsis",
    fallback: "Push...",
  },
  newBranch: {
    key: "workbench.branches.panel.menu.newBranch",
    fallback: "New Branch...",
  },
  checkoutRevision: {
    key: "details.actions.checkoutRevision",
    fallback: "Checkout Tag or Revision...",
  },
  configureRemotes: {
    key: "workbench.branches.context.configureRemotes",
    fallback: "Configure Remotes...",
  },
};

/**
 * 统一解析分支弹窗 quick action 文案；优先使用前端 i18n key，未知动作再回退宿主快照标签。
 */
export function resolveBranchPopupQuickActionLabel(
  actionId: string,
  fallbackLabel: string,
  resolveText?: GitBranchPopupTextResolver,
): string {
  const normalizedActionId = String(actionId || "").trim();
  const fallback = String(fallbackLabel || "").trim();
  const meta = BRANCH_POPUP_QUICK_ACTION_TEXT[normalizedActionId];
  if (!meta) return fallback;
  if (!resolveText) return meta.fallback;
  return resolveText(meta.key, meta.fallback);
}
