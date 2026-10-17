// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { HistoryAPI, HistoryFavoriteEntry } from "@/types/host";

type HistoryFavoriteTarget = {
  filePath?: string;
  providerId?: string;
  id?: string;
};

/**
 * 将历史文件路径归一化为大小写与分隔符无关的匹配键（与主进程规则保持一致）。
 */
function toPathKey(filePath?: string): string {
  return String(filePath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 生成 provider + 会话 ID 的匹配键（与主进程规则保持一致）。
 */
function toIdKey(providerId?: string, id?: string): string {
  const pid = String(providerId || "").trim().toLowerCase();
  const sid = String(id || "").trim().toLowerCase();
  return pid && sid ? `${pid}:${sid}` : "";
}

/**
 * 基于收藏列表创建匹配函数：文件路径或 provider + 会话 ID 任一命中即视为已收藏。
 */
export function createHistoryFavoriteMatcher(entries: readonly HistoryFavoriteEntry[]): (item: HistoryFavoriteTarget | null | undefined) => boolean {
  const pathKeys = new Set<string>();
  const idKeys = new Set<string>();
  for (const entry of entries) {
    const pathKey = toPathKey(entry.filePath);
    const idKey = toIdKey(entry.providerId, entry.id);
    if (pathKey) pathKeys.add(pathKey);
    if (idKey) idKeys.add(idKey);
  }
  return (item) => {
    if (!item) return false;
    const pathKey = toPathKey(item.filePath);
    if (pathKey && pathKeys.has(pathKey)) return true;
    const idKey = toIdKey(item.providerId, item.id);
    return !!idKey && idKeys.has(idKey);
  };
}

/**
 * 在本地收藏列表上乐观应用一次收藏/取消收藏，供 IPC 返回前即时刷新界面。
 */
export function applyHistoryFavoriteChange(
  entries: readonly HistoryFavoriteEntry[],
  target: HistoryFavoriteTarget,
  favorite: boolean,
): HistoryFavoriteEntry[] {
  const pathKey = toPathKey(target.filePath);
  if (!pathKey) return entries.slice();
  const idKey = toIdKey(target.providerId, target.id);
  const rest = entries.filter((entry) => {
    if (toPathKey(entry.filePath) === pathKey) return false;
    return !(idKey && toIdKey(entry.providerId, entry.id) === idKey);
  });
  if (!favorite) return rest;
  return [{ filePath: String(target.filePath || "").trim(), providerId: target.providerId, id: target.id, addedAt: Date.now() }, ...rest];
}

/**
 * 串行保存收藏操作，并把尚未落盘的操作叠加到已确认状态，避免旧响应或失败回滚覆盖后续点击。
 */
export function createHistoryFavoritesController(
  api: Pick<HistoryAPI, "listFavorites" | "setFavorite">,
  onChange: (entries: HistoryFavoriteEntry[], revision: number) => void,
  onError: (error: unknown) => void,
) {
  let confirmed: HistoryFavoriteEntry[] = [];
  let visible: HistoryFavoriteEntry[] = [];
  let revision = 0;
  const pending: { target: HistoryFavoriteTarget & { filePath: string }; favorite: boolean }[] = [];

  /** 将未完成的操作重新叠加到最近一次确认的列表上。 */
  function publish(): void {
    visible = pending.reduce((entries, change) => applyHistoryFavoriteChange(entries, change.target, change.favorite), confirmed);
    onChange(visible, revision);
  }

  const ready = Promise.resolve().then(async () => {
    const result = await api.listFavorites();
    if (!result.ok || !Array.isArray(result.items)) throw new Error(result.error || "history.listFavorites failed");
    confirmed = result.items;
    publish();
  });
  // 初始化失败时禁止写入未知的收藏快照，交给调用方显示错误。
  void ready.catch(onError);
  let queue: Promise<void> = ready.catch(() => {});

  /** 依据最新可见状态切换收藏，立即反馈，并按点击顺序写入主进程。 */
  async function toggle(target: HistoryFavoriteTarget | null | undefined): Promise<void> {
    const filePath = String(target?.filePath || "").trim();
    if (!target || !filePath) return;
    try {
      await ready;
    } catch {
      return;
    }
    const change = { target: { ...target, filePath }, favorite: !createHistoryFavoriteMatcher(visible)(target) };
    pending.push(change);
    publish();
    queue = queue.then(async () => {
      try {
        const result = await api.setFavorite({ ...change.target, favorite: change.favorite });
        if (!result.ok || !Array.isArray(result.items)) throw new Error(result.error || "history.setFavorite failed");
        confirmed = result.items;
        revision += 1;
      } catch (error) {
        onError(error);
      } finally {
        pending.shift();
        publish();
      }
    });
    await queue;
  }

  return { ready, toggle };
}
