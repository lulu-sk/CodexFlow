// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { deriveGeminiProjectHashInputCandidatesFromPath, tidyPathCandidate } from "./gemini-hash";

describe("tidyPathCandidate", () => {
  it("保留 Windows 盘符根目录的尾部语义", () => {
    expect(tidyPathCandidate("C:\\")).toBe("C:\\");
    expect(tidyPathCandidate("C:")).toBe("C:\\");
  });

  it("保留 /mnt 盘根目录", () => {
    expect(tidyPathCandidate("/mnt/c/")).toBe("/mnt/c");
  });
});

describe("deriveGeminiProjectHashInputCandidatesFromPath", () => {
  it("Windows 盘符根目录会保留 C:\\ 形态，和主进程候选保持一致", () => {
    const inputs = deriveGeminiProjectHashInputCandidatesFromPath("C:\\");
    expect(inputs).toContain("C:\\");
  });

  it("WSL 盘根目录会额外派生 Windows 盘符根目录候选", () => {
    const inputs = deriveGeminiProjectHashInputCandidatesFromPath("/mnt/c");
    expect(inputs).toContain("/mnt/c");
    expect(inputs).toContain("C:\\");
  });
});
