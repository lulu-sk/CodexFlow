// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { findBestMatchingProjectScopeKey, normalizePathScopeKey, pathMatchesProjectScope } from "./path-scope";

const TEST_PARENT_SCOPE = "/mnt/c/users/example-user";
const TEST_CODEX_SCOPE = `${TEST_PARENT_SCOPE}/.codex/worktrees/135b/codexflow`;
const TEST_CLAUDE_SCOPE = `${TEST_PARENT_SCOPE}/projects/monorepo/apps/claude-demo`;
const TEST_GEMINI_SCOPE = `${TEST_PARENT_SCOPE}/projects/monorepo/packages/gemini-demo`;

describe("normalizePathScopeKey", () => {
  it("支持将 Windows 盘符根目录规范化为 /mnt/<drive>", () => {
    expect(normalizePathScopeKey("C:\\")).toBe("/mnt/c");
    expect(normalizePathScopeKey("C:")).toBe("/mnt/c");
  });
});

describe("pathMatchesProjectScope", () => {
  it("根目录 scope 不匹配子目录", () => {
    expect(pathMatchesProjectScope(TEST_PARENT_SCOPE, "/mnt/c")).toBe(false);
  });

  it("普通项目 scope 仍匹配子目录", () => {
    expect(pathMatchesProjectScope("/mnt/g/projects/demo/src", "/mnt/g/projects/demo")).toBe(true);
  });
});

describe("findBestMatchingProjectScopeKey", () => {
  it("父子项目同时命中时优先返回更具体的子项目", () => {
    expect(findBestMatchingProjectScopeKey(
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
      expect(findBestMatchingProjectScopeKey(
        item.candidate,
        [
          TEST_PARENT_SCOPE,
          item.expected,
        ],
      ), `${item.providerId} should prefer nested project scope`).toBe(item.expected);
    }
  });
});
