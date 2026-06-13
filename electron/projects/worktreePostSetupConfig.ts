// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type WorktreePostSetupItem = {
  relativePath: string;
  label?: string;
};

export type WorktreePostSetupConfig = {
  items?: WorktreePostSetupItem[];
  command?: string;
  applyAfterReset?: boolean;
};

export type ProjectWorktreePostSetupCarrier = {
  worktreePostSetup?: WorktreePostSetupConfig;
};

/**
 * 归一化项目级 worktree 后置设置，避免无效数据写入 projects.json。
 */
export function normalizeProjectWorktreePostSetup(raw: unknown): WorktreePostSetupConfig | undefined {
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  const items: WorktreePostSetupItem[] = [];
  const seen = new Set<string>();
  for (const item of itemsRaw) {
    const relativePath = String((item as any)?.relativePath ?? item ?? "").trim().replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) continue;
    if (relativePath.split("/").some((part) => part === "..")) continue;
    const key = relativePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String((item as any)?.label || relativePath).trim();
    items.push({ relativePath, label: label || relativePath });
  }
  const command = String(obj.command ?? "").trim();
  const applyAfterReset = typeof obj.applyAfterReset === "boolean" ? obj.applyAfterReset : true;
  if (items.length === 0 && !command && applyAfterReset === true) return undefined;
  return { items, command, applyAfterReset };
}

/**
 * 从项目对象中读取并归一化 worktree 后置设置。
 */
function readProjectWorktreePostSetup(candidate: unknown): WorktreePostSetupConfig | undefined {
  const raw = candidate && typeof candidate === "object" ? (candidate as any).worktreePostSetup : undefined;
  return normalizeProjectWorktreePostSetup(raw);
}

/**
 * 将缓存项目上的 worktree 后置设置合并到扫描出的项目对象。
 */
export function mergeProjectWorktreePostSetup<T extends object>(project: T, ...fallbacks: unknown[]): T & ProjectWorktreePostSetupCarrier {
  const next = { ...(project as any) } as T & ProjectWorktreePostSetupCarrier;
  const normalized = readProjectWorktreePostSetup(project) || fallbacks.map(readProjectWorktreePostSetup).find(Boolean);
  if (normalized) next.worktreePostSetup = normalized;
  else delete (next as any).worktreePostSetup;
  return next;
}
