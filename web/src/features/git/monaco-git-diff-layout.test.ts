// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { resolveCheckboxGutterOffset } from "./monaco-git-diff-layout";

describe("resolveCheckboxGutterOffset", () => {
  it("优先把复选框居中放进 glyph margin", () => {
    expect(resolveCheckboxGutterOffset({
      layoutInfo: {
        glyphMarginLeft: 0,
        glyphMarginWidth: 20,
        lineNumbersLeft: 20,
      },
      controlWidth: 16,
    })).toBe(2);
  });

  it("glyph margin 不足时退回到行号左侧", () => {
    expect(resolveCheckboxGutterOffset({
      layoutInfo: {
        glyphMarginLeft: 0,
        glyphMarginWidth: 8,
        lineNumbersLeft: 22,
      },
      controlWidth: 14,
    })).toBe(6);
  });

  it("左侧空间不足时不会返回负偏移", () => {
    expect(resolveCheckboxGutterOffset({
      layoutInfo: {
        glyphMarginLeft: 0,
        glyphMarginWidth: 0,
        lineNumbersLeft: 10,
      },
      controlWidth: 14,
    })).toBe(0);
  });
});
