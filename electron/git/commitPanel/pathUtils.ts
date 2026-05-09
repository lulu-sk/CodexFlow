// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { toFsPathAbs } from "../pathKey";

/**
 * 将任意路径归一化为仓库内相对路径，统一使用 `/` 分隔符。
 */
export function toRepoRelativePath(repoRoot: string, rawPath: string): string {
  const repoAbs = toFsPathAbs(repoRoot);
  const targetAbs = toFsPathAbs(rawPath);
  const rel = path.relative(repoAbs, targetAbs).replace(/\\/g, "/");
  if (!rel || rel === ".") return "";
  if (rel.startsWith("../") || rel === "..") return rawPath.replace(/\\/g, "/");
  return rel;
}

/**
 * 将输入路径数组统一转换为仓库相对路径，并去重过滤空值。
 */
export function normalizeRepoPaths(repoRoot: string, pathsInput: any): string[] {
  const arr = Array.isArray(pathsInput) ? pathsInput : [];
  const out: string[] = [];
  for (const raw of arr) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const rel = path.isAbsolute(value) ? toRepoRelativePath(repoRoot, value) : value.replace(/\\/g, "/");
    const clean = rel.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!clean || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}
