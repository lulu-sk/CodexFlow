// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import {
  formatHistoryLocalPathPositionSuffix,
  resolveHistoryLocalPathLink,
  shouldAppendHistoryLocalPathPositionSuffix,
} from "./history-markdown";

describe("resolveHistoryLocalPathLink", () => {
  it("支持解析 WSL 绝对路径并移除行号", () => {
    const link = resolveHistoryLocalPathLink("/mnt/g/repo/src/App.tsx:81");
    expect(link).toEqual({
      rawPath: "/mnt/g/repo/src/App.tsx:81",
      openPath: "/mnt/g/repo/src/App.tsx",
      line: 81,
      column: undefined,
    });
  });

  it("支持解析 Windows 盘符路径并移除行列号", () => {
    const link = resolveHistoryLocalPathLink("C:\\work\\demo\\main.cs:120:8");
    expect(link).toEqual({
      rawPath: "C:\\work\\demo\\main.cs:120:8",
      openPath: "C:\\work\\demo\\main.cs",
      line: 120,
      column: 8,
    });
  });

  it("支持解析 file URI 并移除 #L 行号锚点", () => {
    const link = resolveHistoryLocalPathLink("file:///C:/work/demo/main.cs#L42");
    expect(link).toEqual({
      rawPath: "C:\\work\\demo\\main.cs#L42",
      openPath: "C:\\work\\demo\\main.cs",
      line: 42,
      column: undefined,
    });
  });

  it("支持解析带 query 的 file URI，且保留 #L 行号锚点", () => {
    const link = resolveHistoryLocalPathLink("file:///C:/work/demo/main.cs?download=1#L7");
    expect(link).toEqual({
      rawPath: "C:\\work\\demo\\main.cs#L7",
      openPath: "C:\\work\\demo\\main.cs",
      line: 7,
      column: undefined,
    });
  });

  it("本地路径存在非行号 hash 时仍可打开真实路径", () => {
    const link = resolveHistoryLocalPathLink("/mnt/g/repo/README.md#section");
    expect(link).toEqual({
      rawPath: "/mnt/g/repo/README.md#section",
      openPath: "/mnt/g/repo/README.md",
      line: undefined,
      column: undefined,
    });
  });

  it("非本地路径链接返回 null", () => {
    expect(resolveHistoryLocalPathLink("https://example.com/docs")).toBeNull();
  });
});

describe("formatHistoryLocalPathPositionSuffix", () => {
  it("line+column 时返回 :line:column", () => {
    expect(formatHistoryLocalPathPositionSuffix({ line: 205, column: 3 })).toBe(":205:3");
  });

  it("仅 line 时返回 :line", () => {
    expect(formatHistoryLocalPathPositionSuffix({ line: 205, column: undefined })).toBe(":205");
  });

  it("无效 line 时返回空字符串", () => {
    expect(formatHistoryLocalPathPositionSuffix({ line: undefined, column: 5 })).toBe("");
  });
});

describe("shouldAppendHistoryLocalPathPositionSuffix", () => {
  it("链接文本未包含行号时应追加后缀", () => {
    expect(shouldAppendHistoryLocalPathPositionSuffix("accountStorage.ts", { line: 205, column: undefined })).toBe(true);
  });

  it("链接文本已包含 :line 时不应重复追加", () => {
    expect(shouldAppendHistoryLocalPathPositionSuffix("accountStorage.ts:205", { line: 205, column: undefined })).toBe(false);
  });

  it("链接文本已包含 #Lline 时不应重复追加", () => {
    expect(shouldAppendHistoryLocalPathPositionSuffix("accountStorage.ts#L205", { line: 205, column: undefined })).toBe(false);
  });

  it("链接文本已包含相同行号（无列号）时，不应因链接含列号而重复追加", () => {
    expect(shouldAppendHistoryLocalPathPositionSuffix("accountStorage.ts:205", { line: 205, column: 3 })).toBe(false);
  });
});
