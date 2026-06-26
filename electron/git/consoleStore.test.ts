import { describe, expect, it } from "vitest";

import { GitConsoleStore } from "./consoleStore";

describe("GitConsoleStore", () => {
  it("展示模式应裁剪长输出，而复制模式应保留更长原文", () => {
    const store = new GitConsoleStore();
    const repoRoot = "/repo";
    const longStdout = `header\n${"0123456789".repeat(8_500)}`;

    for (let index = 0; index < 25; index += 1) {
      store.appendCompletedEntry({
        cwd: repoRoot,
        gitPath: "git",
        argv: ["log", "--oneline", String(index)],
        result: {
          ok: true,
          stdout: longStdout,
          stderr: "",
          exitCode: 0,
        },
        durationMs: 12 + index,
      });
    }

    const viewEntry = store.listEntries(repoRoot, 20, "view")[0];
    const copyEntry = store.listEntries(repoRoot, 20, "copy")[0];
    const cappedEntries = store.listEntries(repoRoot, 20, "copy");
    const fullEntries = store.listEntries(repoRoot, 0, "copy");

    expect(viewEntry).toBeTruthy();
    expect(copyEntry).toBeTruthy();
    expect(viewEntry?.stdout.length).toBe(64_000);
    expect(viewEntry?.stdout.endsWith("…")).toBe(true);
    expect(copyEntry?.stdout).toBe(longStdout);
    expect(copyEntry?.stdout.length).toBeGreaterThan(viewEntry?.stdout.length || 0);
    expect(cappedEntries).toHaveLength(20);
    expect(fullEntries).toHaveLength(25);
  });

  it("按仓库读取日志时应包含仓库子目录里执行的记录", () => {
    const store = new GitConsoleStore();
    const repoRoot = "/repo";
    const subdir = "/repo/packages/app";
    const siblingRepo = "/repo-other";

    store.appendCompletedEntry({
      cwd: repoRoot,
      gitPath: "git",
      argv: ["status"],
      result: {
        ok: true,
        stdout: "root",
        stderr: "",
        exitCode: 0,
      },
      durationMs: 10,
    });
    store.appendCompletedEntry({
      cwd: subdir,
      gitPath: "git",
      argv: ["log"],
      result: {
        ok: true,
        stdout: "subdir",
        stderr: "",
        exitCode: 0,
      },
      durationMs: 11,
    });
    store.appendCompletedEntry({
      cwd: siblingRepo,
      gitPath: "git",
      argv: ["status"],
      result: {
        ok: true,
        stdout: "sibling",
        stderr: "",
        exitCode: 0,
      },
      durationMs: 12,
    });

    const entries = store.listEntries(repoRoot, 0, "copy");
    expect(entries.map((entry) => entry.stdout)).toEqual(["root", "subdir"]);

    const cleared = store.clearEntries(repoRoot);
    expect(cleared).toBe(2);
    expect(store.listEntries("", 0, "copy").map((entry) => entry.stdout)).toEqual(["sibling"]);
  });
});
