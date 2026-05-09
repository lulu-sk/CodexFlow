import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { execGitAsync, spawnGitStdoutToFileAsync, type GitExecResult } from "../exec";
import { createWorkspaceChangesSaver } from "./preservingProcess";

const cleanupTargets = new Set<string>();

/**
 * 在指定仓库执行 Git 命令，并返回原始执行结果。
 */
async function gitExecAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<GitExecResult> {
  return await execGitAsync({
    argv: ["-C", repoRoot, ...argv],
    timeoutMs,
  });
}

/**
 * 要求 Git 命令成功，失败时直接附带 stderr 方便定位。
 */
async function gitMustAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await gitExecAsync(repoRoot, argv, timeoutMs);
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 初始化一个最小测试仓库，并写入首个提交。
 */
async function initRepoAsync(baseDir: string, name: string): Promise<string> {
  const repoRoot = path.join(baseDir, name);
  await fsp.mkdir(repoRoot, { recursive: true });
  await gitMustAsync(repoRoot, ["init"]);
  await gitMustAsync(repoRoot, ["config", "user.name", "CodexFlow"]);
  await gitMustAsync(repoRoot, ["config", "user.email", "codexflow@example.com"]);
  await gitMustAsync(repoRoot, ["checkout", "-b", "main"]);
  await fsp.writeFile(path.join(repoRoot, "tracked.txt"), `${name}: base\n`, "utf8");
  await gitMustAsync(repoRoot, ["add", "tracked.txt"]);
  await gitMustAsync(repoRoot, ["commit", "-m", `init ${name}`]);
  return repoRoot;
}

/**
 * 读取文本文件内容，供断言 stash 恢复后的工作区状态。
 */
async function readFileAsync(repoRoot: string, relativePath: string): Promise<string> {
  return await fsp.readFile(path.join(repoRoot, relativePath), "utf8");
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupTargets.values()).map(async (target) => {
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch {}
      cleanupTargets.delete(target);
    }),
  );
});

describe("git change saver", () => {
  it("stash saver 应维护 multi-root ref 映射，并能逐仓恢复本地改动", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-change-saver-"));
    cleanupTargets.add(tempRoot);
    const repoA = await initRepoAsync(tempRoot, "repo-a");
    const repoB = await initRepoAsync(tempRoot, "repo-b");
    const userDataPath = path.join(tempRoot, "user-data");
    await fsp.mkdir(userDataPath, { recursive: true });

    await fsp.writeFile(path.join(repoA, "tracked.txt"), "repo-a: changed\n", "utf8");
    await fsp.writeFile(path.join(repoB, "tracked.txt"), "repo-b: changed\n", "utf8");
    await fsp.writeFile(path.join(repoA, "untracked-a.txt"), "untracked a\n", "utf8");
    await fsp.writeFile(path.join(repoB, "untracked-b.txt"), "untracked b\n", "utf8");

    const saver = createWorkspaceChangesSaver({
      ctx: {
        gitPath: "git",
        userDataPath,
      },
      userDataPath,
      repoRoot: repoA,
      async runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
        return await gitExecAsync(targetRepoRoot, argv, timeoutMs);
      },
      async runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
        return await gitExecAsync(targetRepoRoot, argv, timeoutMs);
      },
      emitProgress() {},
      toGitErrorMessage(res: GitExecResult, fallback: string) {
        return String(res.stderr || res.error || res.stdout || fallback);
      },
    }, "stash", "multi-root stash");

    await saver.saveLocalChanges([repoA, repoB]);
    const savedItems = saver.getSavedLocalChangesList();
    expect(savedItems).toHaveLength(2);
    expect(new Set(savedItems.map((item) => item.repoRoot))).toEqual(new Set([repoA, repoB]));
    expect(saver.showSavedChanges()).toEqual(expect.objectContaining({
      kind: "open-saved-changes",
      label: "查看暂存列表",
      repoRoot: repoA,
      payload: expect.objectContaining({
        saveChangesPolicy: "stash",
        viewKind: "stash",
      }),
    }));
    expect(saver.notifyLocalChangesAreNotRestored("update project")).toEqual(expect.objectContaining({
      status: "kept-saved",
      saveChangesPolicy: "stash",
      savedChangesAction: expect.objectContaining({
        kind: "open-saved-changes",
        label: "查看暂存列表",
      }),
    }));
    expect((await gitMustAsync(repoA, ["stash", "list"])).trim()).toContain("stash@{0}");
    expect((await gitMustAsync(repoB, ["stash", "list"])).trim()).toContain("stash@{0}");

    const loadRes = await saver.load();
    expect(loadRes.ok).toBe(true);
    expect(loadRes.ok && new Set(loadRes.restoredRoots)).toEqual(new Set([repoA, repoB]));
    expect(await readFileAsync(repoA, "tracked.txt")).toContain("repo-a: changed");
    expect(await readFileAsync(repoB, "tracked.txt")).toContain("repo-b: changed");
    expect(await readFileAsync(repoA, "untracked-a.txt")).toContain("untracked a");
    expect(await readFileAsync(repoB, "untracked-b.txt")).toContain("untracked b");
    expect((await gitMustAsync(repoA, ["stash", "list"])).trim()).toBe("");
    expect((await gitMustAsync(repoB, ["stash", "list"])).trim()).toBe("");
  });

  it("shelve saver 应通过 shelf view manager 暴露查看动作，并保留 system shelf 语义", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-change-saver-shelve-"));
    cleanupTargets.add(tempRoot);
    const repoRoot = await initRepoAsync(tempRoot, "repo-shelve");
    const userDataPath = path.join(tempRoot, "user-data");
    await fsp.mkdir(userDataPath, { recursive: true });
    await fsp.writeFile(path.join(repoRoot, "tracked.txt"), "repo-shelve: changed\n", "utf8");

    const saver = createWorkspaceChangesSaver({
      ctx: {
        gitPath: "git",
        userDataPath,
      },
      userDataPath,
      repoRoot,
      async runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
        return await gitExecAsync(targetRepoRoot, argv, timeoutMs);
      },
      async runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
        return await gitExecAsync(targetRepoRoot, argv, timeoutMs);
      },
      async runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number) {
        return await spawnGitStdoutToFileAsync({
          cwd: targetRepoRoot,
          argv: ["-C", targetRepoRoot, ...argv],
          outFile: targetPath,
          timeoutMs,
        });
      },
      emitProgress() {},
      toGitErrorMessage(res: GitExecResult, fallback: string) {
        return String(res.stderr || res.error || res.stdout || fallback);
      },
    }, "shelve", "single-root shelf");

    await saver.saveLocalChanges([repoRoot]);

    expect(saver.showSavedChanges()).toEqual(expect.objectContaining({
      kind: "open-saved-changes",
      label: "查看搁置记录",
      repoRoot,
      payload: expect.objectContaining({
        saveChangesPolicy: "shelve",
        viewKind: "shelf",
        source: "system",
      }),
    }));
    expect(saver.notifyLocalChangesAreNotRestored("update project")).toEqual(expect.objectContaining({
      status: "kept-saved",
      saveChangesPolicy: "shelve",
      savedChangesAction: expect.objectContaining({
        kind: "open-saved-changes",
        label: "查看搁置记录",
      }),
    }));
  });
});
