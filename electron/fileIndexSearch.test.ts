// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { searchFileIndexCandidates } from "./fileIndexSearch";

describe("electron/fileIndexSearch", () => {
  it("空查询：按 dirs -> files 返回种子结果", () => {
    const res = searchFileIndexCandidates({
      files: ["b.txt", "c.txt"],
      dirs: ["a", "z"],
      query: "",
      limit: 3,
    });
    expect(res.map((x) => `${x.isDir ? "D" : "F"}:${x.rel}`)).toEqual(["D:a", "D:z", "F:b.txt"]);
  });

  it("前缀命中应优先于仅包含命中", () => {
    const res = searchFileIndexCandidates({
      files: ["abc/def.txt", "abc/xxdefyy.txt"],
      dirs: [],
      query: "def",
      limit: 2,
    });
    expect(res[0]?.rel).toBe("abc/def.txt");
  });

  it("ASCII 大小写不敏感", () => {
    const res = searchFileIndexCandidates({
      files: ["docs/ReadMe.MD"],
      dirs: [],
      query: "readme",
      limit: 5,
    });
    expect(res[0]?.rel).toBe("docs/ReadMe.MD");
  });

  it("支持轻量子序列匹配（避免必须连续包含）", () => {
    const res = searchFileIndexCandidates({
      files: ["config.ts", "compile.ts"],
      dirs: [],
      query: "cfg",
      limit: 5,
    });
    // config: c...f...g
    expect(res.some((x) => x.rel === "config.ts")).toBe(true);
  });

  it("limit 生效且不会返回超过上限的结果", () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`);
    const res = searchFileIndexCandidates({ files, dirs: [], query: "file", limit: 7 });
    expect(res.length).toBe(7);
  });
});

