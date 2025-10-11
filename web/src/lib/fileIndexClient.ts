// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 渲染进程侧的文件索引 API 封装（通过 preload 暴露的最小桥接）

export type FileCandidate = { rel: string; isDir: boolean };

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

