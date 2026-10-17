// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyHistoryFavoriteChange,
  createHistoryFavoriteMatcher,
  normalizeHistoryFavoriteEntries,
} from "./historyFavorites";

describe("electron/historyFavorites", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("按文件路径匹配时忽略大小写与分隔符差异", () => {
    const match = createHistoryFavoriteMatcher([{ filePath: "C:\\sessions\\a.jsonl", addedAt: 1 }]);
    expect(match({ filePath: "c:/Sessions/A.jsonl" })).toBe(true);
    expect(match({ filePath: "c:/sessions/b.jsonl" })).toBe(false);
  });

  it("文件路径变化后仍可通过 provider + 会话 ID 匹配", () => {
    const match = createHistoryFavoriteMatcher([{ filePath: "/tmp/old.jsonl", providerId: "codex", id: "S-1", addedAt: 1 }]);
    expect(match({ filePath: "/tmp/new.jsonl", providerId: "codex", id: "s-1" })).toBe(true);
    expect(match({ filePath: "/tmp/new.jsonl", providerId: "claude", id: "s-1" })).toBe(false);
  });

  it("收藏置顶且去重，取消收藏同时移除同 ID 的旧路径", () => {
    const base = [{ filePath: "/tmp/a.jsonl", providerId: "codex", id: "a", addedAt: 1 }];
    const added = applyHistoryFavoriteChange(base, { filePath: "/tmp/b.jsonl", providerId: "codex", id: "b" }, true, 5);
    expect(added.map((item) => item.filePath)).toEqual(["/tmp/b.jsonl", "/tmp/a.jsonl"]);
    const again = applyHistoryFavoriteChange(added, { filePath: "/TMP/b.jsonl", providerId: "codex", id: "b" }, true, 6);
    expect(again).toHaveLength(2);
    const removed = applyHistoryFavoriteChange(again, { filePath: "/tmp/a-v2.jsonl", providerId: "codex", id: "a" }, false);
    expect(removed.map((item) => item.filePath)).toEqual(["/TMP/b.jsonl"]);
  });

  it("解析持久化数据时丢弃无效项并按路径去重", () => {
    const entries = normalizeHistoryFavoriteEntries({
      version: 1,
      items: [{ filePath: "/tmp/a.jsonl", addedAt: 2 }, { filePath: "/TMP/A.jsonl" }, { filePath: "" }, null],
    });
    expect(entries).toEqual([{ filePath: "/tmp/a.jsonl", providerId: undefined, id: undefined, addedAt: 2 }]);
  });

  it("读取 UTF-8 BOM 收藏文件后仍保留原记录", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFileSync").mockReturnValue('\uFEFF{"version":1,"items":[{"filePath":"/sessions/a.jsonl","addedAt":1}]}');
    const store = await import("./historyFavorites");
    expect(store.listHistoryFavorites().map((entry) => entry.filePath)).toEqual(["/sessions/a.jsonl"]);
  });

  it("替换文件失败时保留原文件和缓存，并清理临时文件", async () => {
    vi.resetModules();
    const original = { version: 1, items: [{ filePath: "/sessions/a.jsonl", addedAt: 1 }] };
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(original));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
    const remove = vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
    const store = await import("./historyFavorites");
    expect(() => store.setHistoryFavorite({ filePath: "/sessions/b.jsonl" }, true)).toThrow("rename failed");
    expect(store.listHistoryFavorites()).toEqual(original.items);
    expect(remove).toHaveBeenCalledOnce();
    expect(String(remove.mock.calls[0][0])).toContain("history.favorites.json.tmp-");
  });

  it("损坏的收藏文件报错且禁止覆盖原数据", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFileSync").mockReturnValue("{invalid json");
    const write = vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    const store = await import("./historyFavorites");
    expect(() => store.setHistoryFavorite({ filePath: "/sessions/a.jsonl" }, true)).toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
