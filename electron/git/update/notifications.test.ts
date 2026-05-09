// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { buildUpdateSessionNotificationAsync } from "./notifications";
import type { GitUpdateRepositoryGraphRuntime } from "./types";

/**
 * 构造用于通知测试的运行时桩，实现 revision -> 提交数 / 文件列表的稳定映射。
 */
function createNotificationRuntime(
  commitCountByRevision: Record<string, number>,
  filesByRevision: Record<string, string[]>,
): GitUpdateRepositoryGraphRuntime {
  return {
    repoRoot: "/repo",
    async runGitExecAsync(repoRoot: string, argv: string[]) {
      const revision = String(argv[argv.length - 1] || "");
      if (argv[0] === "rev-list" && argv[1] === "--count") {
        return {
          ok: true,
          stdout: `${commitCountByRevision[`${repoRoot}:${revision}`] ?? 0}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "diff" && argv[1] === "--name-only") {
        return {
          ok: true,
          stdout: `${(filesByRevision[`${repoRoot}:${revision}`] || []).join("\n")}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        ok: false,
        stdout: "",
        stderr: "unsupported",
        exitCode: 1,
      };
    },
  };
}

describe("update notifications", () => {
  it("应按多范围生成会话级 post actions，并透传统一 open-saved-changes 动作", async () => {
    const runtime = createNotificationRuntime(
      {
        "/repo:a1..a2": 2,
        "/repo/packages/lib:b1..b2": 3,
      },
      {
        "/repo:a1..a2": ["README.md", "src/app.ts"],
        "/repo/packages/lib:b1..b2": ["lib.txt", "lib.txt", "package.json"],
      },
    );

    const notification = await buildUpdateSessionNotificationAsync(runtime, "/repo", {
      resultCode: "SUCCESS",
      roots: [
        {
          repoRoot: "/repo",
          rootName: "root",
          kind: "repository",
          ok: true,
          resultCode: "SUCCESS",
          branch: "main",
          upstream: "origin/main",
          method: "merge",
          updatedRange: { start: "a1", end: "a2" },
        },
        {
          repoRoot: "/repo/packages/lib",
          rootName: "lib",
          kind: "repository",
          ok: true,
          resultCode: "SUCCESS",
          branch: "main",
          upstream: "origin/main",
          method: "rebase",
          updatedRange: { start: "b1", end: "b2" },
          preservingState: {
            saveChangesPolicy: "shelve",
            status: "restore-failed",
            localChangesRestorePolicy: "keep-saved",
            savedLocalChangesRef: "shelf@{demo}",
            savedChangesAction: {
              kind: "open-saved-changes",
              label: "查看搁置记录",
              repoRoot: "/repo/packages/lib",
              payload: {
                repoRoot: "/repo/packages/lib",
                ref: "shelf@{demo}",
                saveChangesPolicy: "shelve",
                viewKind: "shelf",
              },
            },
          },
        },
      ],
      successRoots: ["/repo", "/repo/packages/lib"],
      failedRoots: [],
      skippedRoots: [],
      fetchSuccessRoots: ["/repo", "/repo/packages/lib"],
      fetchFailedRoots: [],
      fetchSkippedRoots: [],
      nothingToUpdateRoots: [],
      updatedRoots: ["/repo", "/repo/packages/lib"],
      executedRoots: ["/repo", "/repo/packages/lib"],
      multiRoot: true,
    });

    expect(notification).toBeDefined();
    expect(notification?.receivedCommitsCount).toBe(5);
    expect(notification?.filteredCommitsCount).toBe(2);
    expect(notification?.postActions.map((action) => action.kind)).toEqual([
      "view-commits",
      "copy-revision-range",
      "open-saved-changes",
    ]);
    expect(notification?.postActions[1]?.revision).toBe("a1..a2");
    expect(Array.isArray(notification?.postActions[0]?.payload?.ranges)).toBe(true);
    expect(notification?.postActions[2]?.repoRoot).toBe("/repo/packages/lib");
    expect(notification?.postActions[2]?.payload?.repoRoot).toBe("/repo/packages/lib");
    expect(notification?.postActions[2]?.payload?.saveChangesPolicy).toBe("shelve");
    expect(notification?.description).toContain("可查看 2 个提交");
  });

  it("存在未完成冲突 root 时应在通知顶部补 resolve-conflicts 动作", async () => {
    const runtime = createNotificationRuntime(
      {
        "/repo:a1..a2": 1,
      },
      {
        "/repo:a1..a2": ["src/app.ts"],
      },
    );

    const notification = await buildUpdateSessionNotificationAsync(runtime, "/repo", {
      resultCode: "INCOMPLETE",
      roots: [
        {
          repoRoot: "/repo",
          rootName: "root",
          kind: "repository",
          ok: false,
          resultCode: "INCOMPLETE",
          branch: "main",
          upstream: "origin/main",
          method: "merge",
          updatedRange: { start: "a1", end: "a2" },
          data: {
            operationProblem: {
              kind: "merge-conflict",
            },
          },
        },
      ],
      successRoots: [],
      failedRoots: ["/repo"],
      skippedRoots: [],
      fetchSuccessRoots: ["/repo"],
      fetchFailedRoots: [],
      fetchSkippedRoots: [],
      nothingToUpdateRoots: [],
      updatedRoots: ["/repo"],
      executedRoots: ["/repo"],
      multiRoot: false,
    });

    expect(notification?.postActions.map((action) => action.kind)).toContain("resolve-conflicts");
    expect(notification?.postActions.find((action) => action.kind === "resolve-conflicts")).toEqual(
      expect.objectContaining({
        repoRoot: "/repo",
        label: "处理 root 冲突",
      }),
    );
  });
});
