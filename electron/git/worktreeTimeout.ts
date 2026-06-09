// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { execGitAsync } from "./exec";
import { toFsPathAbs } from "./pathKey";

const KIB = 1024;
const MIB = 1024 * 1024;
const MIN_WORKTREE_ADD_TIMEOUT_MS = 3 * 60_000;
const FALLBACK_WORKTREE_ADD_TIMEOUT_MS = 15 * 60_000;
const MAX_WORKTREE_ADD_TIMEOUT_MS = 4 * 60 * 60_000;
const MAX_WORKTREE_TASK_TIMEOUT_MS = 6 * 60 * 60_000;

export type WorktreeRepoSizeMetrics = {
  trackedFileCount: number;
  checkoutFileCount: number;
  checkoutBytes: number;
  indexBytes: number;
  looseObjectBytes: number;
  packedObjectBytes: number;
  objectBytes: number;
};

export type WorktreeTimeoutEstimate = {
  worktreeCount: number;
  maxParallel: number;
  perWorktreeAddTimeoutMs: number;
  taskTimeoutMs: number;
  metrics: WorktreeRepoSizeMetrics;
};

/**
 * 解析 `git count-objects -v` 输出，提取对象库规模。
 */
export function parseGitCountObjectsOutput(output: string): Pick<WorktreeRepoSizeMetrics, "looseObjectBytes" | "packedObjectBytes" | "objectBytes"> {
  const values = new Map<string, number>();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^([^:]+):\s*(\d+)/.exec(line.trim());
    if (!match) continue;
    values.set(match[1], Math.max(0, Math.floor(Number(match[2]) || 0)));
  }
  const looseObjectBytes = (values.get("size") || 0) * KIB;
  const packedObjectBytes = (values.get("size-pack") || 0) * KIB;
  return {
    looseObjectBytes,
    packedObjectBytes,
    objectBytes: looseObjectBytes + packedObjectBytes,
  };
}

/**
 * 根据仓库规模代理指标和本次创建数量计算 worktree 创建超时。
 */
export function calculateWorktreeTimeoutEstimate(args: {
  metrics: Partial<WorktreeRepoSizeMetrics>;
  worktreeCount: number;
  maxParallel?: number;
}): WorktreeTimeoutEstimate {
  const worktreeCount = Math.max(1, Math.floor(Number(args.worktreeCount) || 1));
  const maxParallel = Math.max(1, Math.min(4, Math.floor(Number(args.maxParallel || worktreeCount) || 1), worktreeCount));
  const trackedFileCount = Math.max(0, Math.floor(Number(args.metrics?.trackedFileCount) || 0));
  const checkoutFileCount = Math.max(0, Math.floor(Number(args.metrics?.checkoutFileCount) || trackedFileCount));
  const checkoutBytes = Math.max(0, Math.floor(Number(args.metrics?.checkoutBytes) || 0));
  const indexBytes = Math.max(0, Math.floor(Number(args.metrics?.indexBytes) || 0));
  const looseObjectBytes = Math.max(0, Math.floor(Number(args.metrics?.looseObjectBytes) || 0));
  const packedObjectBytes = Math.max(0, Math.floor(Number(args.metrics?.packedObjectBytes) || 0));
  const objectBytes = Math.max(0, Math.floor(Number(args.metrics?.objectBytes) || looseObjectBytes + packedObjectBytes));
  const hasRepoSizeMetric =
    trackedFileCount > 0 ||
    checkoutFileCount > 0 ||
    checkoutBytes > 0 ||
    indexBytes > 0 ||
    looseObjectBytes > 0 ||
    packedObjectBytes > 0 ||
    objectBytes > 0;

  const effectiveFileCount = checkoutFileCount > 0 ? checkoutFileCount : trackedFileCount;
  const fileCostMs = Math.ceil(effectiveFileCount / 1000) * 2_500;
  const checkoutContentCostMs = checkoutBytes > 0 ? Math.ceil(checkoutBytes / MIB) * 120 : 0;
  const indexCostMs = Math.ceil(indexBytes / MIB) * 2_000;
  const objectFallbackCostMs = checkoutBytes > 0 ? 0 : Math.ceil(Math.min(objectBytes, 8 * 1024 * MIB) / MIB) * 80;
  const countContentionFactor = 1 + Math.min(7, worktreeCount - 1) * 0.12;
  const rawPerWorktreeMs = (90_000 + fileCostMs + checkoutContentCostMs + indexCostMs + objectFallbackCostMs) * countContentionFactor;
  const minWorktreeAddTimeoutMs = hasRepoSizeMetric ? MIN_WORKTREE_ADD_TIMEOUT_MS : FALLBACK_WORKTREE_ADD_TIMEOUT_MS;
  const perWorktreeAddTimeoutMs = clampTimeoutMs(roundUpToSecond(rawPerWorktreeMs), minWorktreeAddTimeoutMs, MAX_WORKTREE_ADD_TIMEOUT_MS);

  const waves = Math.max(1, Math.ceil(worktreeCount / maxParallel));
  const rawTaskTimeoutMs = perWorktreeAddTimeoutMs * waves + worktreeCount * 30_000 + 5 * 60_000;
  const taskTimeoutMs = clampTimeoutMs(roundUpToSecond(rawTaskTimeoutMs), perWorktreeAddTimeoutMs + 60_000, MAX_WORKTREE_TASK_TIMEOUT_MS);

  return {
    worktreeCount,
    maxParallel,
    perWorktreeAddTimeoutMs,
    taskTimeoutMs,
    metrics: {
      trackedFileCount,
      checkoutFileCount,
      checkoutBytes,
      indexBytes,
      looseObjectBytes,
      packedObjectBytes,
      objectBytes,
    },
  };
}

/**
 * 读取仓库规模并生成 worktree 创建超时估算；探测失败时回退到保守默认值。
 *
 * 说明：这里刻意不枚举目标引用的整棵 tree。`git ls-tree -r -l` 在大仓库会产生
 * 大量 stdout，Electron 主进程需要拼接和解析整段文本，容易造成应用短时间卡死。
 * 因此默认只使用 index 条目数、index 体积和对象库规模作为低成本代理指标。
 */
export async function estimateWorktreeTimeoutAsync(args: {
  repoRoot: string;
  gitPath?: string;
  ref?: string;
  worktreeCount: number;
  maxParallel?: number;
  probeTimeoutMs?: number;
}): Promise<WorktreeTimeoutEstimate> {
  const repoRoot = toFsPathAbs(args.repoRoot);
  const probeTimeoutMs = Math.max(1000, Math.min(30_000, Math.floor(Number(args.probeTimeoutMs) || 8000)));
  const [objects, index] = await Promise.all([
    readObjectMetricsAsync({ repoRoot, gitPath: args.gitPath, timeoutMs: probeTimeoutMs }),
    readIndexMetricsAsync({ repoRoot, gitPath: args.gitPath, timeoutMs: probeTimeoutMs }),
  ]);
  return calculateWorktreeTimeoutEstimate({
    metrics: {
      ...objects,
      ...index,
      checkoutFileCount: index.trackedFileCount,
      checkoutBytes: 0,
    },
    worktreeCount: args.worktreeCount,
    maxParallel: args.maxParallel,
  });
}

/**
 * 格式化超时估算，供创建日志展示和问题诊断。
 */
export function formatWorktreeTimeoutEstimate(estimate: WorktreeTimeoutEstimate): string {
  const metrics = estimate.metrics;
  return [
    `超时估算：单个 git worktree add ${formatDuration(estimate.perWorktreeAddTimeoutMs)}`,
    `任务等待 ${formatDuration(estimate.taskTimeoutMs)}`,
    `数量 ${estimate.worktreeCount}`,
    `并发 ${estimate.maxParallel}`,
    `checkout ${metrics.checkoutFileCount || metrics.trackedFileCount}`,
    `content ${formatBytes(metrics.checkoutBytes)}`,
    `index ${formatBytes(metrics.indexBytes)}`,
    `objects ${formatBytes(metrics.objectBytes)}(fallback)`,
  ].join("，");
}

/**
 * 读取 Git 对象库规模。
 */
async function readObjectMetricsAsync(args: {
  repoRoot: string;
  gitPath?: string;
  timeoutMs: number;
}): Promise<Pick<WorktreeRepoSizeMetrics, "looseObjectBytes" | "packedObjectBytes" | "objectBytes">> {
  const res = await execGitAsync({
    gitPath: args.gitPath,
    argv: ["-C", args.repoRoot, "count-objects", "-v"],
    timeoutMs: args.timeoutMs,
  });
  if (!res.ok) return { looseObjectBytes: 0, packedObjectBytes: 0, objectBytes: 0 };
  return parseGitCountObjectsOutput(res.stdout);
}

/**
 * 读取 Git index 的条目数和文件大小，用作 checkout 工作量的低成本代理指标。
 */
async function readIndexMetricsAsync(args: {
  repoRoot: string;
  gitPath?: string;
  timeoutMs: number;
}): Promise<Pick<WorktreeRepoSizeMetrics, "trackedFileCount" | "indexBytes">> {
  const res = await execGitAsync({
    gitPath: args.gitPath,
    argv: ["-C", args.repoRoot, "rev-parse", "--git-path", "index"],
    timeoutMs: args.timeoutMs,
  });
  if (!res.ok) return { trackedFileCount: 0, indexBytes: 0 };
  const indexPath = resolveGitPath(args.repoRoot, String(res.stdout || "").trim());
  if (!indexPath) return { trackedFileCount: 0, indexBytes: 0 };

  try {
    const st = await fsp.stat(indexPath);
    const trackedFileCount = await readIndexEntryCountAsync(indexPath);
    return { trackedFileCount, indexBytes: st.size };
  } catch {
    return { trackedFileCount: 0, indexBytes: 0 };
  }
}

/**
 * 从 Git index 头部读取 tracked entry 数量。
 */
async function readIndexEntryCountAsync(indexPath: string): Promise<number> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(indexPath, "r");
    const buf = Buffer.alloc(12);
    const read = await handle.read(buf, 0, buf.length, 0);
    if (read.bytesRead < 12) return 0;
    if (buf.toString("ascii", 0, 4) !== "DIRC") return 0;
    return Math.max(0, buf.readUInt32BE(8));
  } catch {
    return 0;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

/**
 * 解析 `git rev-parse --git-path` 返回值为绝对路径。
 */
function resolveGitPath(repoRoot: string, rawPath: string): string {
  const p = String(rawPath || "").trim();
  if (!p) return "";
  if (path.isAbsolute(p)) return p;
  return path.resolve(repoRoot, p);
}

/**
 * 将超时取整到秒，避免日志中出现难读的小数。
 */
function roundUpToSecond(ms: number): number {
  return Math.ceil(Math.max(0, Number(ms) || 0) / 1000) * 1000;
}

/**
 * 将毫秒数限制在指定区间。
 */
function clampTimeoutMs(ms: number, minMs: number, maxMs: number): number {
  return Math.max(minMs, Math.min(maxMs, Math.floor(Number(ms) || 0)));
}

/**
 * 格式化持续时间。
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes <= 0) return `${restSeconds}s`;
  if (restSeconds === 0) return `${minutes}m`;
  return `${minutes}m${restSeconds}s`;
}

/**
 * 格式化字节数。
 */
function formatBytes(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= MIB) return `${(value / MIB).toFixed(1)}MiB`;
  if (value >= KIB) return `${(value / KIB).toFixed(1)}KiB`;
  return `${Math.floor(value)}B`;
}
