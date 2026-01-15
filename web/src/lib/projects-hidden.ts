// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 项目隐藏相关的本地持久化（仅渲染层使用）。
 *
 * 说明：
 * - hiddenProjectIds：被隐藏的项目 id 列表（数组 JSON）
 * - showHiddenProjects：项目列表是否展示隐藏项目（"1"/"0"）
 */

const HIDDEN_PROJECT_IDS_STORAGE_KEY = "codexflow.hiddenProjectIds";
const SHOW_HIDDEN_PROJECTS_STORAGE_KEY = "codexflow.showHiddenProjects";

/**
 * 安全获取 localStorage（在某些环境/隐私模式下可能抛异常）。
 */
function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 将任意输入归一化为“去重后的 string[]”。
 */
function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of input) {
    const s = typeof it === "string" ? it.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 读取隐藏项目 id 列表（localStorage -> string[]）。
 */
export function loadHiddenProjectIds(): string[] {
  const ls = getLocalStorageSafe();
  if (!ls) return [];
  try {
    const raw = ls.getItem(HIDDEN_PROJECT_IDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeIdList(parsed);
  } catch {
    return [];
  }
}

/**
 * 写入隐藏项目 id 列表（string[] -> localStorage）。
 */
export function saveHiddenProjectIds(ids: readonly string[]): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    const normalized = normalizeIdList(Array.from(ids || []));
    ls.setItem(HIDDEN_PROJECT_IDS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {}
}

/**
 * 读取“是否展示隐藏项目”开关。
 */
export function loadShowHiddenProjects(): boolean {
  const ls = getLocalStorageSafe();
  if (!ls) return false;
  try {
    const raw = (ls.getItem(SHOW_HIDDEN_PROJECTS_STORAGE_KEY) || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  } catch {
    return false;
  }
}

/**
 * 写入“是否展示隐藏项目”开关。
 */
export function saveShowHiddenProjects(value: boolean): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    ls.setItem(SHOW_HIDDEN_PROJECTS_STORAGE_KEY, value ? "1" : "0");
  } catch {}
}

