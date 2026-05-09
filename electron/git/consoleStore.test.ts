import { describe, expect, it } from "vitest";

import { GitConsoleStore } from "./consoleStore";

describe("GitConsoleStore", () => {
  it("展示模式应裁剪长输出，而复制模式应保留更长原文", () => {
    const store = new GitConsoleStore();
    const repoRoot = "/repo";
    const longStdout = `header\n${"0123456789".repeat(8_500)}`;

    store.appendCompletedEntry({
      cwd: repoRoot,
      gitPath: "git",
      argv: ["log", "--oneline"],
      result: {
        ok: true,
        stdout: longStdout,
        stderr: "",
        exitCode: 0,
      },
      durationMs: 12,
    });

    const viewEntry = store.listEntries(repoRoot, 20, "view")[0];
    const copyEntry = store.listEntries(repoRoot, 20, "copy")[0];

    expect(viewEntry).toBeTruthy();
    expect(copyEntry).toBeTruthy();
    expect(viewEntry?.stdout.length).toBe(64_000);
    expect(viewEntry?.stdout.endsWith("…")).toBe(true);
    expect(copyEntry?.stdout).toBe(longStdout);
    expect(copyEntry?.stdout.length).toBeGreaterThan(viewEntry?.stdout.length || 0);
  });
});
