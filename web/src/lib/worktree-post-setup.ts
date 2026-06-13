// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { WorktreePostSetupConfig, WorktreePostSetupItem } from "@/types/host";

export const WORKTREE_POST_SETUP_BLOCKED_PATHS = new Set([
  ".git",
  "node_modules",
  "dist",
  "web/dist",
]);

/**
 * 归一化项目内相对路径，仅接受不越界的相对路径。
 */
export function normalizeWorktreePostSetupRelativePath(input: unknown): string {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("//") || raw.startsWith("/")) return "";
  const parts: string[] = [];
  for (const partRaw of raw.split("/")) {
    const part = partRaw.trim();
    if (!part || part === ".") continue;
    if (part === "..") return "";
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * 判断路径是否属于不应复制的目录。
 */
export function isBlockedWorktreePostSetupRelativePath(relativePath: string): boolean {
  const normalized = normalizeWorktreePostSetupRelativePath(relativePath).toLowerCase();
  if (!normalized) return true;
  for (const blocked of WORKTREE_POST_SETUP_BLOCKED_PATHS) {
    if (normalized === blocked || normalized.startsWith(`${blocked}/`)) return true;
  }
  return false;
}

/**
 * 把绝对路径转换为项目内相对路径；不在项目内时返回空串。
 */
export function toProjectRelativeWorktreePostSetupPath(projectPath: string, targetPath: string): string {
  const root = String(projectPath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = String(targetPath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !target) return "";
  const targetLower = target.toLowerCase();
  if (targetLower === root) return "";
  if (!targetLower.startsWith(`${root}/`)) return "";
  return normalizeWorktreePostSetupRelativePath(target.slice(root.length + 1));
}

/**
 * 归一化项目级 worktree 后置设置。
 */
export function normalizeWorktreePostSetupConfig(input: unknown): WorktreePostSetupConfig {
  const obj = input && typeof input === "object" ? (input as any) : {};
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  const items: WorktreePostSetupItem[] = [];
  const seen = new Set<string>();
  for (const item of itemsRaw) {
    const relativePath = normalizeWorktreePostSetupRelativePath((item as any)?.relativePath ?? item);
    if (!relativePath) continue;
    const key = relativePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String((item as any)?.label || relativePath).trim();
    items.push({ relativePath, label: label || relativePath });
  }
  return {
    items,
    command: String(obj.command ?? "").trim(),
    applyAfterReset: typeof obj.applyAfterReset === "boolean" ? obj.applyAfterReset : true,
  };
}

/**
 * 判断配置是否包含需要执行的后置动作。
 */
export function hasWorktreePostSetupActions(config: WorktreePostSetupConfig | null | undefined): boolean {
  const normalized = normalizeWorktreePostSetupConfig(config);
  return (normalized.items?.length || 0) > 0 || !!String(normalized.command || "").trim();
}
