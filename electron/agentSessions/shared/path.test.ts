// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { dirKeyFromCwd, findBestMatchingDirKeyScope, pathMatchesDirKeyScope, tidyPathCandidate } from "./path";

const TEST_PARENT_SCOPE = "/mnt/c/users/example-user";
const TEST_CODEX_SCOPE = `${TEST_PARENT_SCOPE}/.codex/worktrees/135b/codexflow`;
const TEST_CLAUDE_SCOPE = `${TEST_PARENT_SCOPE}/projects/monorepo/apps/claude-demo`;
const TEST_GEMINI_SCOPE = `${TEST_PARENT_SCOPE}/projects/monorepo/packages/gemini-demo`;

describe("tidyPathCandidate", () => {
  it("保留 Windows 盘符根目录的尾部语义", () => {
    expect(tidyPathCandidate("C:\\")).toBe("C:\\");
    expect(tidyPathCandidate("C:")).toBe("C:\\");
  });

  it("保留 /mnt 盘根目录并去掉多余尾斜杠", () => {
    expect(tidyPathCandidate("/mnt/c/")).toBe("/mnt/c");
  });
});

describe("dirKeyFromCwd", () => {
  it("将 Windows 盘符根目录规范化为 /mnt/<drive>", () => {
    expect(dirKeyFromCwd("C:\\")).toBe("/mnt/c");
    expect(dirKeyFromCwd("C:")).toBe("/mnt/c");
  });
});

describe("pathMatchesDirKeyScope", () => {
  it("根目录 scope 仅允许精确匹配", () => {
    expect(pathMatchesDirKeyScope("/mnt/c", "/mnt/c")).toBe(true);
    expect(pathMatchesDirKeyScope("c:", "/mnt/c")).toBe(true);
    expect(pathMatchesDirKeyScope(TEST_PARENT_SCOPE, "/mnt/c")).toBe(false);
  });

  it("普通项目目录仍允许匹配子目录", () => {
    expect(pathMatchesDirKeyScope("/mnt/g/projects/demo/src", "/mnt/g/projects/demo")).toBe(true);
  });
});

describe("findBestMatchingDirKeyScope", () => {
  it("父子项目同时命中时优先返回更具体的子项目", () => {
    expect(findBestMatchingDirKeyScope(
      TEST_CODEX_SCOPE,
      [
        TEST_PARENT_SCOPE,
        TEST_CODEX_SCOPE,
      ],
    )).toBe(TEST_CODEX_SCOPE);
  });

  it("对 codex、claude、gemini 的嵌套项目路径都优先返回子项目", () => {
    const cases = [
      {
        providerId: "codex",
        candidate: TEST_CODEX_SCOPE,
        expected: TEST_CODEX_SCOPE,
      },
      {
        providerId: "claude",
        candidate: TEST_CLAUDE_SCOPE,
        expected: TEST_CLAUDE_SCOPE,
      },
      {
        providerId: "gemini",
        candidate: TEST_GEMINI_SCOPE,
        expected: TEST_GEMINI_SCOPE,
      },
    ] as const;

    for (const item of cases) {
      expect(findBestMatchingDirKeyScope(
        item.candidate,
        [
          TEST_PARENT_SCOPE,
          item.expected,
        ],
      ), `${item.providerId} should prefer nested project scope`).toBe(item.expected);
    }
  });
});
