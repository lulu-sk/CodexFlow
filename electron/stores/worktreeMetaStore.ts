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

