// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, it, expect } from "vitest";
import { hasNonEmptyIOFromMessages } from "./empty";

describe("hasNonEmptyIOFromMessages", () => {
  it("空数组/空值返回 false", () => {
    expect(hasNonEmptyIOFromMessages(undefined)).toBe(false);
    expect(hasNonEmptyIOFromMessages(null)).toBe(false);
    expect(hasNonEmptyIOFromMessages([] as any)).toBe(false);
  });

  it("识别 input_text / output_text 为有效输入输出", () => {
    expect(hasNonEmptyIOFromMessages([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ] as any)).toBe(true);

    expect(hasNonEmptyIOFromMessages([
      { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ] as any)).toBe(true);
  });

  it("兼容旧格式：user/assistant 的 text 也视为有效", () => {
    expect(hasNonEmptyIOFromMessages([
      { role: "user", content: [{ type: "text", text: "legacy user" }] },
    ] as any)).toBe(true);

    expect(hasNonEmptyIOFromMessages([
      { role: "assistant", content: [{ type: "text", text: "legacy assistant" }] },
    ] as any)).toBe(true);
  });

  it("忽略仅包含空白文本的 content", () => {
    expect(hasNonEmptyIOFromMessages([
      { role: "user", content: [{ type: "input_text", text: "   \n\t" }] },
      { role: "assistant", content: [{ type: "output_text", text: "" }] },
    ] as any)).toBe(false);
  });

  it("忽略非 user/assistant 的 text（避免把 meta 当成输入输出）", () => {
    expect(hasNonEmptyIOFromMessages([
      { role: "meta", content: [{ type: "text", text: "meta text" }] },
      { role: "system", content: [{ type: "text", text: "system text" }] },
    ] as any)).toBe(false);
  });

  it("忽略 instructions/environment_context 等非输入输出类型", () => {
    expect(hasNonEmptyIOFromMessages([
      { role: "user", content: [{ type: "instructions", text: "rules" }] },
      { role: "user", content: [{ type: "environment_context", text: "<cwd>/x</cwd>" }] },
      { role: "assistant", content: [{ type: "meta", text: "thinking" }] },
    ] as any)).toBe(false);
  });
});

