// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitBranchItem, GitBranchSyncState } from "../types";
import { resolveGitText } from "../git-i18n";
import { interpolateI18nText } from "@/lib/translate";

type GitBranchTextResolver = (key: string, fallback: string, values?: Record<string, unknown>) => string;

export type GitBranchSyncBadgePresentation = {
  kind: "incoming" | "outgoing";
  visible: boolean;
  text: string;
  tooltip: string;
};

export type GitCurrentBranchPresentation = {
  label: string;
  tooltip?: string;
  sync?: GitBranchSyncState;
};

export type GitBranchRowPresentation = {
  label: string;
  secondaryText?: string;
  tooltip?: string;
  sync?: GitBranchSyncState;
  incomingBadge: GitBranchSyncBadgePresentation | null;
  outgoingBadge: GitBranchSyncBadgePresentation | null;
};

export type GitBranchPopupWarningPresentation = {
  visible: boolean;
  text: string;
};

/**
 * 构建顶栏当前分支按钮的展示模型，统一封装分支名与 tooltip 拼装逻辑。
 */
export function buildCurrentBranchPresentation(args: {
  branchName: string;
  detached: boolean;
  sync?: GitBranchSyncState;
  resolveText?: GitBranchTextResolver;
}): GitCurrentBranchPresentation {
  const branchName = String(args.branchName || "").trim() || "HEAD";
  const resolveText = args.resolveText;
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? interpolateI18nText(resolveText(key, fallback, values), values) : interpolateI18nText(fallback, values);
  };
  const label = args.detached
    ? resolveLabel("workbench.branches.common.detachedBranch", "Detached {{branch}}", { branch: branchName })
    : branchName;
  const tooltipLines = [
    args.detached
      ? resolveLabel("workbench.branches.common.detachedHead", "游离 HEAD")
      : resolveLabel("workbench.branches.common.currentBranch", "当前分支：{{branch}}", { branch: branchName }),
  ];
  const syncTooltip = String(args.sync?.tooltip || "").trim();
  if (syncTooltip) tooltipLines.push(syncTooltip);
  return {
    label,
    tooltip: tooltipLines.join("\n"),
    sync: args.sync,
  };
}

/**
 * 构建分支树/分支弹窗行的展示模型，统一 tooltip 与同步标签格式。
 */
export function buildBranchRowPresentation(item: GitBranchItem, resolveText?: GitBranchTextResolver): GitBranchRowPresentation {
  const label = String(item.name || "").trim();
  const sync = item.sync;
  const tooltip = resolveBranchRowTooltip(item, resolveText);
  const secondaryText = String(item.secondaryText || item.upstream || item.sync?.upstream || "").trim() || undefined;
  return {
    label,
    secondaryText,
    tooltip,
    sync,
    incomingBadge: buildIncomingBranchSyncBadge(sync, resolveText),
    outgoingBadge: buildOutgoingBranchSyncBadge(sync, resolveText),
  };
}

/**
 * 收敛分支行 tooltip，优先复用同步说明，并在缺失时补上 tracked branch 信息。
 */
function resolveBranchRowTooltip(item: GitBranchItem, resolveText?: GitBranchTextResolver): string | undefined {
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : resolveGitText(key, fallback, values);
  };
  const upstream = String(item.upstream || item.sync?.upstream || "").trim();
  const syncTooltip = String(item.sync?.tooltip || "").trim();
  if (syncTooltip) {
    if (!upstream || syncTooltip.includes(upstream))
      return syncTooltip;
    return `${resolveLabel("workbench.branches.common.trackingBranch", "跟踪分支：{{branch}}", { branch: upstream })}\n${syncTooltip}`;
  }
  return upstream ? resolveLabel("workbench.branches.common.trackingBranch", "跟踪分支：{{branch}}", { branch: upstream }) : undefined;
}

/**
 * 按 IDEA `99+` 规则格式化同步计数。
 */
export function formatBranchSyncCount(count: number): string {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  if (normalized > 99) return "99+";
  return String(normalized);
}

/**
 * 构建 incoming 标签展示模型；当 `hasUnfetched` 为真时保留图标但不显示数字。
 */
export function buildIncomingBranchSyncBadge(sync?: GitBranchSyncState, resolveText?: GitBranchTextResolver): GitBranchSyncBadgePresentation | null {
  if (!sync || sync.gone) return null;
  const incoming = Math.max(0, Math.floor(Number(sync.incoming) || 0));
  const visible = incoming > 0 || sync.hasUnfetched;
  if (!visible) return null;
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : fallback;
  };
  return {
    kind: "incoming",
    visible: true,
    text: incoming > 0 ? formatBranchSyncCount(incoming) : "",
    tooltip: sync.hasUnfetched
      ? resolveLabel("workbench.branches.common.unfetchedIncoming", "存在未获取的传入提交")
      : resolveLabel("workbench.branches.common.incomingCommits", "传入提交 {{count}}", { count: incoming }),
  };
}

/**
 * 构建 outgoing 标签展示模型；与 IDEA 一样只有存在待推送提交时才展示。
 */
export function buildOutgoingBranchSyncBadge(sync?: GitBranchSyncState, resolveText?: GitBranchTextResolver): GitBranchSyncBadgePresentation | null {
  if (!sync || sync.gone) return null;
  const outgoing = Math.max(0, Math.floor(Number(sync.outgoing) || 0));
  if (outgoing <= 0) return null;
  const resolveLabel = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveText ? resolveText(key, fallback, values) : fallback;
  };
  return {
    kind: "outgoing",
    visible: true,
    text: formatBranchSyncCount(outgoing),
    tooltip: resolveLabel("workbench.branches.common.outgoingCommits", "传出提交 {{count}}", { count: outgoing }),
  };
}

/**
 * 为分支弹窗构建 diverged warning banner；仅当前分支双向分叉时显示。
 */
export function buildBranchPopupWarningPresentation(sync?: GitBranchSyncState, resolveText?: GitBranchTextResolver): GitBranchPopupWarningPresentation | null {
  if (!sync || sync.gone || sync.status !== "diverged") return null;
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : resolveGitText(key, fallback);
  };
  return {
    visible: true,
    text: resolveLabel(
      "workbench.branches.common.divergedWarning",
      "当前分支与上游已分叉，请先查看 incoming / outgoing 变化后再执行签出或更新。",
    ),
  };
}
