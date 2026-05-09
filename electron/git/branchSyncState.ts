// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitBranchSyncStatus = "untracked" | "synced" | "incoming" | "outgoing" | "diverged";

export type GitBranchSyncState = {
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  incoming?: number;
  outgoing?: number;
  hasUnfetched: boolean;
  gone?: boolean;
  status: GitBranchSyncStatus;
  tooltip?: string;
};

type BuildGitBranchSyncStateArgs = {
  upstream?: string;
  remote?: string;
  remoteBranch?: string;
  incoming?: number | null;
  outgoing?: number | null;
  hasUnfetched?: boolean;
  gone?: boolean;
};

/**
 * 将 `git ls-remote --heads` 输出解析为 `branch -> hash` 映射。
 */
export function parseGitLsRemoteHeads(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const rows = String(stdout || "").split(/\r?\n/);
  for (const row of rows) {
    const clean = String(row || "").trim();
    if (!clean) continue;
    const parts = clean.split(/\s+/);
    const hash = String(parts[0] || "").trim();
    const ref = String(parts[1] || "").trim();
    if (!hash || !ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length).trim();
    if (!branch) continue;
    out.set(branch, hash);
  }
  return out;
}

/**
 * 基于 upstream 与计数信息构建分支同步状态快照，供前端统一展示。
 */
export function buildGitBranchSyncState(args: BuildGitBranchSyncStateArgs): GitBranchSyncState | undefined {
  const upstream = String(args.upstream || "").trim();
  if (!upstream) return undefined;

  const gone = args.gone === true;
  const outgoing = normalizeGitBranchSyncCount(args.outgoing);
  let incoming = normalizeGitBranchSyncCount(args.incoming);
  const hasUnfetched = !gone && args.hasUnfetched === true;
  if (hasUnfetched) incoming = 0;

  return {
    upstream,
    remote: normalizeGitBranchSyncText(args.remote),
    remoteBranch: normalizeGitBranchSyncText(args.remoteBranch),
    incoming,
    outgoing,
    hasUnfetched,
    gone: gone || undefined,
    status: resolveGitBranchSyncStatus({ incoming, outgoing, hasUnfetched, gone }),
    tooltip: buildGitBranchSyncTooltip({ upstream, incoming, outgoing, hasUnfetched, gone }),
  };
}

/**
 * 规整分支同步文本字段，空串统一回退为 `undefined`。
 */
function normalizeGitBranchSyncText(value: string | undefined): string | undefined {
  const clean = String(value || "").trim();
  return clean || undefined;
}

/**
 * 规整分支同步计数，负数与无效值统一视为缺失。
 */
function normalizeGitBranchSyncCount(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const count = Math.max(0, Math.floor(value));
  return count;
}

/**
 * 按 incoming / outgoing / unfetched / gone 状态归并为前端可消费的单一状态位。
 */
function resolveGitBranchSyncStatus(args: {
  incoming?: number;
  outgoing?: number;
  hasUnfetched: boolean;
  gone: boolean;
}): GitBranchSyncStatus {
  if (args.gone) return "untracked";
  const incoming = Number(args.incoming || 0);
  const outgoing = Number(args.outgoing || 0);
  if (args.hasUnfetched) return outgoing > 0 ? "diverged" : "incoming";
  if (incoming > 0 && outgoing > 0) return "diverged";
  if (incoming > 0) return "incoming";
  if (outgoing > 0) return "outgoing";
  return "synced";
}

/**
 * 生成顶栏与分支树共用的同步状态 tooltip 文案。
 */
function buildGitBranchSyncTooltip(args: {
  upstream: string;
  incoming?: number;
  outgoing?: number;
  hasUnfetched: boolean;
  gone: boolean;
}): string {
  const lines = [`跟踪分支：${args.upstream}`];
  const incoming = Number(args.incoming || 0);
  const outgoing = Number(args.outgoing || 0);

  if (args.gone) {
    lines.push("跟踪分支已不存在。");
    return lines.join("\n");
  }

  if (args.hasUnfetched) {
    lines.push("存在未获取的传入提交。");
    if (outgoing > 0) lines.push(`本地领先 ${outgoing} 个提交。`);
    return lines.join("\n");
  }

  if (incoming > 0 && outgoing > 0) {
    lines.push(`落后 ${incoming} 个提交，领先 ${outgoing} 个提交。`);
    return lines.join("\n");
  }
  if (incoming > 0) {
    lines.push(`落后 ${incoming} 个提交。`);
    return lines.join("\n");
  }
  if (outgoing > 0) {
    lines.push(`领先 ${outgoing} 个提交。`);
    return lines.join("\n");
  }
  lines.push("与跟踪分支同步。");
  return lines.join("\n");
}
