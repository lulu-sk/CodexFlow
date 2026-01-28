// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type DirTreeStore = {
  version: 1;
  /** 根级节点顺序（存 projectId）。 */
  rootOrder: string[];
  /** 子 -> 父（仅允许一层子级；父为空/缺失则视为根）。 */
  parentById: Record<string, string>;
  /** 父 -> 子顺序（父为 projectId）。 */
  childOrderByParent: Record<string, string[]>;
  /** 节点展开状态（父节点用；子节点也可存但可能无效）。 */
  expandedById: Record<string, boolean>;
  /** 节点备注名（仅 UI 展示，不改真实目录名）。 */
  labelById: Record<string, string>;
};

/**
 * 获取目录树存储文件路径（位于 userData，避免写入仓库）。
 */
function getStorePath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "dir-tree.json");
}

/**
 * 从磁盘读取目录树（失败则返回空结构）。
 */
export function loadDirTreeStore(): DirTreeStore {
  try {
    const fp = getStorePath();
    if (!fs.existsSync(fp)) {
      return { version: 1, rootOrder: [], parentById: {}, childOrderByParent: {}, expandedById: {}, labelById: {} };
    }
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw || "{}") as Partial<DirTreeStore>;
    return {
      version: 1,
      rootOrder: Array.isArray((parsed as any)?.rootOrder) ? ((parsed as any).rootOrder as any[]).map((x) => String(x || "")).filter(Boolean) : [],
      parentById: (parsed as any)?.parentById && typeof (parsed as any).parentById === "object" ? ((parsed as any).parentById as any) : {},
      childOrderByParent: (parsed as any)?.childOrderByParent && typeof (parsed as any).childOrderByParent === "object" ? ((parsed as any).childOrderByParent as any) : {},
      expandedById: (parsed as any)?.expandedById && typeof (parsed as any).expandedById === "object" ? ((parsed as any).expandedById as any) : {},
      labelById: (parsed as any)?.labelById && typeof (parsed as any).labelById === "object" ? ((parsed as any).labelById as any) : {},
    };
  } catch {
    return { version: 1, rootOrder: [], parentById: {}, childOrderByParent: {}, expandedById: {}, labelById: {} };
  }
}

/**
 * 写回目录树（写入失败忽略，避免阻塞主流程）。
 */
export function saveDirTreeStore(next: DirTreeStore): void {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {}
}

