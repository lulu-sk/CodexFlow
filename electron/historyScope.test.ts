// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { historyItemBelongsToScope } from "./historyScope";

const TEST_PARENT_PROJECT = "/mnt/c/users/example-user";
const TEST_CODEX_CHILD_PROJECT = `${TEST_PARENT_PROJECT}/.codex/worktrees/135b/codexflow`;
const TEST_CLAUDE_CHILD_PROJECT = `${TEST_PARENT_PROJECT}/projects/monorepo/apps/claude-demo`;
const TEST_GEMINI_CHILD_PROJECT = `${TEST_PARENT_PROJECT}/projects/monorepo/packages/gemini-demo`;

/**
 * 中文说明：构造父项目与子项目并存时的历史筛选参数。
 */
function createNestedScopeOptions(childProjectPath: string) {
  return {
    scope: "current_project" as const,
    currentProjectNeedles: [TEST_PARENT_PROJECT],
    allProjectNeedles: [
      TEST_PARENT_PROJECT,
      childProjectPath,
    ],
  };
}

describe("electron/historyScope.historyItemBelongsToScope", () => {
  it("codex 嵌套项目历史不会再被父项目吞掉", () => {
    expect(historyItemBelongsToScope(
      {
        providerId: "codex",
        dirKey: TEST_CODEX_CHILD_PROJECT,
        filePath: "codex.jsonl",
      },
      createNestedScopeOptions(TEST_CODEX_CHILD_PROJECT),
    )).toBe(false);
  });

  it("claude 嵌套项目历史不会再被父项目吞掉", () => {
    expect(historyItemBelongsToScope(
      {
        providerId: "claude",
        dirKey: TEST_CLAUDE_CHILD_PROJECT,
        filePath: "claude.jsonl",
      },
      createNestedScopeOptions(TEST_CLAUDE_CHILD_PROJECT),
    )).toBe(false);
  });

  it("gemini 嵌套项目历史不会再被父项目吞掉", () => {
    expect(historyItemBelongsToScope(
      {
        providerId: "gemini",
        dirKey: TEST_GEMINI_CHILD_PROJECT,
        filePath: "gemini.json",
      },
      createNestedScopeOptions(TEST_GEMINI_CHILD_PROJECT),
    )).toBe(false);
  });

  it("最具体子项目作为当前项目时仍能命中对应历史", () => {
    expect(historyItemBelongsToScope(
      {
        providerId: "codex",
        dirKey: TEST_CODEX_CHILD_PROJECT,
        filePath: "codex.jsonl",
      },
      {
        scope: "current_project",
        currentProjectNeedles: [TEST_CODEX_CHILD_PROJECT],
        allProjectNeedles: [
          TEST_PARENT_PROJECT,
          TEST_CODEX_CHILD_PROJECT,
        ],
      },
    )).toBe(true);
  });

  it("gemini 缺失 dirKey 时仍可通过 projectHash 归属", () => {
    expect(historyItemBelongsToScope(
      {
        providerId: "gemini",
        filePath: "/tmp/session-gemini.json",
      },
      {
        scope: "current_project",
        currentProjectNeedles: [],
        allProjectNeedles: [],
        geminiHashNeedles: new Set(["hash-demo"]),
        extractGeminiProjectHashFromPath: () => "hash-demo",
      },
    )).toBe(true);
  });
});
