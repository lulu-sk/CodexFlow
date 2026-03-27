import { describe, expect, it } from "vitest";
import { normalizePathOpenCandidate } from "./pathOpen";

describe("normalizePathOpenCandidate", () => {
  it("在 Windows 下将 slash-prefixed 盘符路径还原为标准盘符路径", () => {
    expect(normalizePathOpenCandidate("/G:/Unity/Project/Client/Assets/file.cs", "win32"))
      .toBe("G:\\Unity\\Project\\Client\\Assets\\file.cs");
  });

  it("在 Windows 下保留普通盘符路径语义并统一分隔符", () => {
    expect(normalizePathOpenCandidate("G:/Unity/Project/file.cs", "win32"))
      .toBe("G:\\Unity\\Project\\file.cs");
  });

  it("非 Windows 平台保持原始 POSIX 形式，避免误改路径", () => {
    expect(normalizePathOpenCandidate("/G:/Unity/Project/file.cs", "linux"))
      .toBe("/G:/Unity/Project/file.cs");
  });
});
