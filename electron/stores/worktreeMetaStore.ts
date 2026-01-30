// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { toFsPathAbs, toFsPathKey } from "../git/pathKey";

export type WorktreeMeta = {
  /** 该 worktree 所属仓库的主 worktree 路径（用于回收/删除等操作的落点） */
  repoMainPath: string;
  /** 创建时选择的基分支 */
  baseBranch: string;
  /**
   * 创建时基分支的提交号（用于“按分叉点之后回收”的默认边界）。
   * - 可选：旧数据可能不存在；此时回收可回退为 merge-base 推断。
   */
  baseRefAtCreate?: string;
  /** 为该 worktree 生成的专用分支 */
  wtBranch: string;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
};

type StoreShape = {
  version: 1;
  items: Record<string, WorktreeMeta>;
};

/**
 * 中文说明：根据已有记录与最新分支选择，构建应写回的 worktree 元数据。
 *
 * 设计原则：
 * - 优先保留 createdAt（若已有），避免无意义抖动。
 * - 当 baseBranch/wtBranch 发生变化时，清空 baseRefAtCreate，避免错误把旧分叉点当作“创建记录”。
 * - 允许调用方显式提供 baseRefAtCreate（例如 reset 后更新为最新基线）。
 */
export function buildNextWorktreeMeta(args: {
  existing: WorktreeMeta | null;
  repoMainPath: string;
  baseBranch: string;
  wtBranch: string;
  baseRefAtCreate?: string;
  createdAt?: number;
}): WorktreeMeta {
  const existing = args.existing;
  const repoMainPath = String(args.repoMainPath || "").trim();
  const baseBranch = String(args.baseBranch || "").trim();
  const wtBranch = String(args.wtBranch || "").trim();
  const createdAt =
    Number.isFinite(Number(existing?.createdAt))
      ? Math.floor(Number(existing!.createdAt))
      : (Number.isFinite(Number(args.createdAt)) ? Math.floor(Number(args.createdAt)) : Date.now());

  const branchesChanged =
    !!existing &&
    (String(existing.baseBranch || "").trim() !== baseBranch || String(existing.wtBranch || "").trim() !== wtBranch);

  const baseRefAtCreate =
    typeof args.baseRefAtCreate === "string"
      ? String(args.baseRefAtCreate || "").trim() || undefined
      : (branchesChanged ? undefined : (existing?.baseRefAtCreate ? String(existing.baseRefAtCreate || "").trim() || undefined : undefined));

  return {
    repoMainPath,
    baseBranch,
    wtBranch,
    createdAt,
    baseRefAtCreate,
  };
}

/**
 * 获取 worktree 元数据存储文件路径（位于 userData，避免写入仓库）。
 */
function getStorePath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "worktree-meta.json");
}

/**
 * 从磁盘读取 worktree 元数据（失败则返回空对象）。
 */
function loadStore(): StoreShape {
  try {
    const fp = getStorePath();
    if (!fs.existsSync(fp)) return { version: 1, items: {} };
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw || "{}") as Partial<StoreShape>;
    const items = parsed && typeof parsed === "object" && (parsed as any).items && typeof (parsed as any).items === "object" ? (parsed as any).items : {};
    return { version: 1, items: items as any };
  } catch {
    return { version: 1, items: {} };
  }
}

/**
 * 将 worktree 元数据写回磁盘（写入失败忽略，避免阻塞主流程）。
 */
function saveStore(next: StoreShape): void {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {}
}

/**
 * 读取指定 worktree 的元数据（按路径 key 查找）。
 */
export function getWorktreeMeta(worktreePath: string): WorktreeMeta | null {
  const abs = toFsPathAbs(worktreePath);
  const key = toFsPathKey(abs);
  if (!key) return null;
  const store = loadStore();
  const hit = store.items[key];
  return hit && typeof hit === "object" ? (hit as WorktreeMeta) : null;
}

/**
 * 写入指定 worktree 的元数据（按路径 key 覆盖）。
 */
export function setWorktreeMeta(worktreePath: string, meta: WorktreeMeta): void {
  const abs = toFsPathAbs(worktreePath);
  const key = toFsPathKey(abs);
  if (!key) return;
  const store = loadStore();
  store.items[key] = meta;
  saveStore(store);
}

/**
 * 删除指定 worktree 的元数据（按路径 key）。
 */
export function deleteWorktreeMeta(worktreePath: string): void {
  const abs = toFsPathAbs(worktreePath);
  const key = toFsPathKey(abs);
  if (!key) return;
  const store = loadStore();
  if (!store.items[key]) return;
  delete store.items[key];
  saveStore(store);
}

