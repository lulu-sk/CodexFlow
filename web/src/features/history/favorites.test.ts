// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it, vi } from "vitest";
import type { HistoryFavoriteEntry } from "../../types/host";
import { applyHistoryFavoriteChange, createHistoryFavoriteMatcher, createHistoryFavoritesController } from "./favorites";

/** 创建可由用例控制完成时机的异步结果。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("历史收藏控制器", () => {
  it("连续切换同一条记录时立即反馈，并按顺序保存最新意图", async () => {
    const first = deferred<{ ok: boolean; items: HistoryFavoriteEntry[] }>();
    let visible: HistoryFavoriteEntry[] = [];
    let revision = 0;
    const target = { filePath: "/sessions/a.jsonl", providerId: "codex", id: "a" };
    const api = {
      listFavorites: vi.fn(async () => ({ ok: true, items: [] })),
      setFavorite: vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ok: true, items: [] }),
    };
    const controller = createHistoryFavoritesController(api, (entries, version) => { visible = entries; revision = version; }, vi.fn());
    await controller.ready;
    const added = controller.toggle(target);
    await Promise.resolve();
    expect(createHistoryFavoriteMatcher(visible)(target)).toBe(true);
    const removed = controller.toggle(target);
    await Promise.resolve();
    expect(visible).toEqual([]);
    first.resolve({ ok: true, items: applyHistoryFavoriteChange([], target, true) });
    await Promise.all([added, removed]);
    expect(api.setFavorite.mock.calls.map(([args]) => args.favorite)).toEqual([true, false]);
    expect(visible).toEqual([]);
    expect(revision).toBe(2);
  });

  it("前一次写入失败时只回滚该操作，保留后续不同记录的收藏", async () => {
    const first = deferred<{ ok: boolean; error: string }>();
    const a = { filePath: "/sessions/a.jsonl" };
    const b = { filePath: "/sessions/b.jsonl" };
    let visible: HistoryFavoriteEntry[] = [];
    const errors = vi.fn();
    const api = {
      listFavorites: vi.fn(async () => ({ ok: true, items: [] })),
      setFavorite: vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ok: true, items: applyHistoryFavoriteChange([], b, true) }),
    };
    const controller = createHistoryFavoritesController(api, (entries) => { visible = entries; }, errors);
    await controller.ready;
    const addedA = controller.toggle(a);
    const addedB = controller.toggle(b);
    await Promise.resolve();
    expect(visible).toHaveLength(2);
    first.resolve({ ok: false, error: "write failed" });
    await Promise.all([addedA, addedB]);
    expect(visible.map((entry) => entry.filePath)).toEqual([b.filePath]);
    expect(errors).toHaveBeenCalledOnce();
  });

  it("初始化完成前的点击不会覆盖磁盘上的既有收藏", async () => {
    const initial = deferred<{ ok: boolean; items: HistoryFavoriteEntry[] }>();
    const target = { filePath: "/sessions/a.jsonl" };
    const existing = applyHistoryFavoriteChange([], target, true);
    const api = {
      listFavorites: vi.fn(() => initial.promise),
      setFavorite: vi.fn(async () => ({ ok: true, items: [] })),
    };
    const controller = createHistoryFavoritesController(api, vi.fn(), vi.fn());
    const toggled = controller.toggle(target);
    expect(api.setFavorite).not.toHaveBeenCalled();
    initial.resolve({ ok: true, items: existing });
    await toggled;
    expect(api.setFavorite).toHaveBeenCalledWith({ ...target, favorite: false });
  });

  it("读取失败时禁止写入未知快照并报告错误", async () => {
    const errors = vi.fn();
    const api = { listFavorites: vi.fn(async () => ({ ok: false, error: "read failed" })), setFavorite: vi.fn() };
    const controller = createHistoryFavoritesController(api, vi.fn(), errors);
    await controller.toggle({ filePath: "/sessions/a.jsonl" });
    expect(api.setFavorite).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
  });
});
