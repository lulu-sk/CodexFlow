// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";

export type HistoryFavoriteEntry = {
  filePath: string;
  providerId?: string;
  id?: string;
  addedAt: number;
};

type HistoryFavoriteTarget = {
  filePath?: string;
  providerId?: string;
  id?: string;
};

const FAVORITES_FILE_NAME = "history.favorites.json";

let cachedEntries: HistoryFavoriteEntry[] | null = null;
let cachedPath = "";

/**
 * 获取当前 profile 的 userData 目录；非 Electron 环境回退到工作目录。
 */
function getUserDataDir(): string {
  try { const { app } = require("electron"); return app.getPath("userData"); } catch { return process.cwd(); }
}

/**
 * 将历史文件路径归一化为大小写与分隔符无关的匹配键。
 */
export function normalizeHistoryFavoritePathKey(filePath?: string): string {
  return String(filePath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 生成 provider + 会话 ID 的匹配键，用于文件路径变化（如 Codex 新版本 rollout）后仍能识别收藏。
 */
export function normalizeHistoryFavoriteIdKey(providerId?: string, id?: string): string {
  const pid = String(providerId || "").trim().toLowerCase();
  const sid = String(id || "").trim().toLowerCase();
  return pid && sid ? `${pid}:${sid}` : "";
}

/**
 * 解析并清洗收藏列表，丢弃无效项并按文件路径去重。
 */
export function normalizeHistoryFavoriteEntries(raw: unknown): HistoryFavoriteEntry[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as any).items) ? (raw as any).items : []);
  const seen = new Set<string>();
  const result: HistoryFavoriteEntry[] = [];
  for (const item of list) {
    const filePath = typeof item?.filePath === "string" ? item.filePath.trim() : "";
    const key = normalizeHistoryFavoritePathKey(filePath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      filePath,
      providerId: typeof item?.providerId === "string" && item.providerId.trim() ? item.providerId.trim() : undefined,
      id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : undefined,
      addedAt: Number.isFinite(Number(item?.addedAt)) && Number(item?.addedAt) > 0 ? Number(item.addedAt) : 0,
    });
  }
  return result;
}

/**
 * 基于收藏列表创建匹配函数：文件路径或 provider + 会话 ID 任一命中即视为已收藏。
 */
export function createHistoryFavoriteMatcher(entries: readonly HistoryFavoriteEntry[]): (item: HistoryFavoriteTarget) => boolean {
  const pathKeys = new Set<string>();
  const idKeys = new Set<string>();
  for (const entry of entries) {
    const pathKey = normalizeHistoryFavoritePathKey(entry.filePath);
    const idKey = normalizeHistoryFavoriteIdKey(entry.providerId, entry.id);
    if (pathKey) pathKeys.add(pathKey);
    if (idKey) idKeys.add(idKey);
  }
  return (item) => {
    const pathKey = normalizeHistoryFavoritePathKey(item?.filePath);
    if (pathKey && pathKeys.has(pathKey)) return true;
    const idKey = normalizeHistoryFavoriteIdKey(item?.providerId, item?.id);
    return !!idKey && idKeys.has(idKey);
  };
}

/**
 * 在收藏列表上应用一次收藏/取消收藏，返回新的列表（不修改入参）。
 */
export function applyHistoryFavoriteChange(
  entries: readonly HistoryFavoriteEntry[],
  target: HistoryFavoriteTarget,
  favorite: boolean,
  now: number = Date.now(),
): HistoryFavoriteEntry[] {
  const pathKey = normalizeHistoryFavoritePathKey(target?.filePath);
  if (!pathKey) return entries.slice();
  const idKey = normalizeHistoryFavoriteIdKey(target?.providerId, target?.id);
  const rest = entries.filter((entry) => {
    if (normalizeHistoryFavoritePathKey(entry.filePath) === pathKey) return false;
    return !(idKey && normalizeHistoryFavoriteIdKey(entry.providerId, entry.id) === idKey);
  });
  if (!favorite) return rest;
  return [
    {
      filePath: String(target.filePath || "").trim(),
      providerId: String(target.providerId || "").trim() || undefined,
      id: String(target.id || "").trim() || undefined,
      addedAt: now,
    },
    ...rest,
  ];
}

/**
 * 解析收藏文件路径（随 profile 隔离）。
 */
function getFavoritesPath(): string {
  return path.join(getUserDataDir(), FAVORITES_FILE_NAME);
}

/**
 * 读取收藏列表（按 profile 路径缓存）；缺失时返回空列表，损坏或读取失败时保留原文件并报错。
 */
export function listHistoryFavorites(): HistoryFavoriteEntry[] {
  const p = getFavoritesPath();
  if (cachedEntries && cachedPath === p) return cachedEntries.slice();
  let entries: HistoryFavoriteEntry[];
  try {
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    entries = normalizeHistoryFavoriteEntries(JSON.parse(raw || "[]"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    entries = [];
  }
  cachedEntries = entries;
  cachedPath = p;
  return cachedEntries.slice();
}

/**
 * 收藏或取消收藏一条历史，原子写入磁盘并返回最新列表。
 */
export function setHistoryFavorite(target: HistoryFavoriteTarget, favorite: boolean): HistoryFavoriteEntry[] {
  const next = applyHistoryFavoriteChange(listHistoryFavorites(), target, favorite);
  const p = getFavoritesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: next }, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
  cachedEntries = next;
  cachedPath = p;
  return next.slice();
}
