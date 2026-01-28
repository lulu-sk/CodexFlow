// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";

/**
 * 将任意路径字符串归一化为用于比较/去重的 key。
 *
 * 规则：
 * - 统一分隔符为 `/`
 * - 去除末尾 `/`
 * - Windows 下做小写化（路径比较大小写不敏感）
 */
export function toFsPathKey(p: string): string {
  const raw = String(p || "").trim();
  if (!raw) return "";
  try {
    const resolved = path.resolve(raw);
    const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
}

/**
 * 将任意路径字符串解析为“可用于显示/执行”的绝对路径。
 * - 主要用于在写入持久化 Key 前统一 `path.resolve`
 */
export function toFsPathAbs(p: string): string {
  const raw = String(p || "").trim();
  if (!raw) return "";
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

