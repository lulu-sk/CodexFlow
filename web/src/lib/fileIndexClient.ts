// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 渲染进程侧的文件索引 API 封装（通过 preload 暴露的最小桥接）

export type FileCandidate = { rel: string; isDir: boolean };
export type AtSearchWireItem = {
  categoryId: "files" | "rule";
  rel: string;
  isDir: boolean;
  score: number;
  groupKey?: "pinned" | "legacy" | "dynamic";
};

export async function ensureIndex(root: string, excludes?: string[]): Promise<{ total: number; updatedAt: number }> {
  const res: any = await (window as any).host?.fileIndex?.ensureIndex?.({ root, excludes });
  if (res && res.ok) return { total: Number(res.total || 0), updatedAt: Number(res.updatedAt || Date.now()) };
  throw new Error(String(res?.error || 'ensureIndex failed'));
}

export async function getAllCandidates(root: string): Promise<FileCandidate[]> {
  const res: any = await (window as any).host?.fileIndex?.getAllCandidates?.(root);
  if (res && res.ok && Array.isArray(res.items)) return res.items as FileCandidate[];
  return [];
}

/**
 * 中文说明：主进程侧 @ 搜索（仅返回 topN）。
 * @param args.root - 项目根（Windows/UNC）
 * @param args.query - 查询串（不含 '@'）
 * @param args.scope - all/files/rule
 * @param args.limit - 返回上限
 * @param args.excludes - 额外排除
 */
export async function searchAt(args: {
  root: string;
  query: string;
  scope?: "all" | "files" | "rule";
  limit?: number;
  excludes?: string[];
}): Promise<{ items: AtSearchWireItem[]; total: number; updatedAt: number }> {
  const res: any = await (window as any).host?.fileIndex?.searchAt?.(args);
  if (res && res.ok && Array.isArray(res.items)) {
    return {
      items: res.items as AtSearchWireItem[],
      total: Number(res.total || 0),
      updatedAt: Number(res.updatedAt || Date.now()),
    };
  }
  return { items: [], total: 0, updatedAt: Date.now() };
}

