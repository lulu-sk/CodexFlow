import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { execGitAsync, type GitExecResult } from "../exec";
import { getUpdateOptionsSnapshotAsync } from "./config";
import type { GitUpdateConfigRuntime } from "./types";

type ConfigTestContext = {
  repoRoot: string;
  userDataPath: string;
  cleanupPaths: string[];
};

const cleanupQueue = new Set<string>();

/**
 * 在指定仓库执行 Git 命令；失败时直接抛出断言，便于快速定位配置测试环境问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 15_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 创建最小 Update Options 测试仓库，固定使用 `main` 作为当前分支。
 */
async function createConfigTestContextAsync(prefix: string): Promise<ConfigTestContext> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-update-config-${prefix}-`));
  const repoRoot = path.join(tempRoot, "repo");
  const userDataPath = path.join(tempRoot, "user-data");
  await fsp.mkdir(repoRoot, { recursive: true });
  await fsp.mkdir(userDataPath, { recursive: true });
  await gitAsync(repoRoot, ["init"]);
  await gitAsync(repoRoot, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repoRoot, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repoRoot, ["checkout", "-b", "main"]);
  await fsp.writeFile(path.join(repoRoot, "README.md"), "# config\n", "utf8");
  await gitAsync(repoRoot, ["add", "README.md"]);
  await gitAsync(repoRoot, ["commit", "-m", "init"]);
  return {
    repoRoot,
    userDataPath,
    cleanupPaths: [tempRoot],
  };
}

/**
 * 构造 Update Config 运行时桩，仅保留本次单测需要的 Git 执行能力。
 */
function createRuntime(ctx: ConfigTestContext): GitUpdateConfigRuntime {
  return {
    repoRoot: ctx.repoRoot,
    userDataPath: ctx.userDataPath,
    async runGitExecAsync(repoRoot, argv, timeoutMs) {
      return await execGitAsync({ argv: ["-C", repoRoot, ...argv], timeoutMs });
    },
    async runGitSpawnAsync(repoRoot, argv, timeoutMs) {
      return await execGitAsync({ argv: ["-C", repoRoot, ...argv], timeoutMs });
    },
    toGitErrorMessage(res: GitExecResult, fallback: string): string {
      return String(res.stderr || res.error || res.stdout || fallback).trim() || fallback;
    },
  };
}

/**
 * 返回 Update Options 持久化文件路径，供断言迁移是否回写时复用。
 */
function getOptionsStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "update-options.json");
}

afterEach(async () => {
  const cleanupPaths = Array.from(cleanupQueue);
  cleanupQueue.clear();
  await Promise.all(cleanupPaths.map(async (target) => {
    await fsp.rm(target, { recursive: true, force: true });
  }));
});

describe("update config options", () => {
  it("首次读取时默认 Update Options 应与 IDEA 一致为 Merge + Shelve", async () => {
    const ctx = await createConfigTestContextAsync("default-merge");
    ctx.cleanupPaths.forEach((target) => cleanupQueue.add(target));

    const snapshot = await getUpdateOptionsSnapshotAsync(createRuntime(ctx));
    expect(snapshot.options.updateMethod).toBe("merge");
    expect(snapshot.options.saveChangesPolicy).toBe("shelve");
    expect(snapshot.options.scope.syncStrategy).toBe("current");
    expect(snapshot.options.scope.linkedRepoRoots).toEqual([]);
    expect(snapshot.options.scope.skippedRepoRoots).toEqual([]);
    expect(snapshot.options.scope.includeNestedRoots).toBe(false);
    expect(snapshot.options.scope.rootScanMaxDepth).toBe(8);
    expect(snapshot.options.pull).toEqual({
      mode: "merge",
      options: [],
    });
    expect(typeof snapshot.pullCapabilities.noVerify).toBe("boolean");
    expect(snapshot.methodResolution.selectedMethod).toBe("merge");
    expect(snapshot.methodResolution.resolvedMethod).toBe("merge");
    expect(snapshot.methodResolution.saveChangesPolicy).toBe("shelve");
    expect(snapshot.scopePreview.roots).toHaveLength(1);
    expect(snapshot.scopePreview.roots[0]?.source).toBe("current");
  });

  it("历史 reset 配置在读取时应降级并回写为 Merge", async () => {
    const ctx = await createConfigTestContextAsync("legacy-reset");
    ctx.cleanupPaths.forEach((target) => cleanupQueue.add(target));

    const storePath = getOptionsStorePath(ctx.userDataPath);
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, JSON.stringify({
      version: 1,
      options: {
        updateMethod: "reset",
        saveChangesPolicy: "shelve",
      },
    }, null, 2), "utf8");

    const snapshot = await getUpdateOptionsSnapshotAsync(createRuntime(ctx));
    expect(snapshot.options.updateMethod).toBe("merge");
    expect(snapshot.options.saveChangesPolicy).toBe("shelve");
    expect(snapshot.options.scope.syncStrategy).toBe("current");
    expect(snapshot.options.pull).toEqual({
      mode: "merge",
      options: [],
    });

    const migrated = JSON.parse(await fsp.readFile(storePath, "utf8"));
    expect(migrated.options.updateMethod).toBe("merge");
    expect(migrated.options.scope.syncStrategy).toBe("current");
    expect(migrated.options.pull).toEqual({
      mode: "merge",
      options: [],
    });
  });

  it("历史 branch-default 配置在读取时应降级并回写为 Merge", async () => {
    const ctx = await createConfigTestContextAsync("legacy-branch-default");
    ctx.cleanupPaths.forEach((target) => cleanupQueue.add(target));

    const storePath = getOptionsStorePath(ctx.userDataPath);
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, JSON.stringify({
      version: 1,
      options: {
        updateMethod: "branch-default",
        saveChangesPolicy: "stash",
      },
    }, null, 2), "utf8");

    const snapshot = await getUpdateOptionsSnapshotAsync(createRuntime(ctx));
    expect(snapshot.options.updateMethod).toBe("merge");
    expect(snapshot.options.scope.syncStrategy).toBe("current");

    const migrated = JSON.parse(await fsp.readFile(storePath, "utf8"));
    expect(migrated.options.updateMethod).toBe("merge");
    expect(migrated.options.scope.syncStrategy).toBe("current");
    expect(migrated.options.pull).toEqual({
      mode: "merge",
      options: [],
    });
  });

  it("多仓默认范围应返回关联仓、嵌套仓与默认跳过结果预览", async () => {
    const ctx = await createConfigTestContextAsync("scope-preview");
    ctx.cleanupPaths.forEach((target) => cleanupQueue.add(target));

    const linkedRepo = path.join(path.dirname(ctx.repoRoot), "linked");
    await fsp.mkdir(linkedRepo, { recursive: true });
    await gitAsync(linkedRepo, ["init"]);
    await gitAsync(linkedRepo, ["config", "user.name", "CodexFlow"]);
    await gitAsync(linkedRepo, ["config", "user.email", "codexflow@example.com"]);
    await gitAsync(linkedRepo, ["checkout", "-b", "main"]);
    await fsp.writeFile(path.join(linkedRepo, "linked.txt"), "linked\n", "utf8");
    await gitAsync(linkedRepo, ["add", "linked.txt"]);
    await gitAsync(linkedRepo, ["commit", "-m", "init linked"]);

    const nestedRepo = path.join(ctx.repoRoot, "packages", "nested");
    await fsp.mkdir(nestedRepo, { recursive: true });
    await gitAsync(nestedRepo, ["init"]);
    await gitAsync(nestedRepo, ["config", "user.name", "CodexFlow"]);
    await gitAsync(nestedRepo, ["config", "user.email", "codexflow@example.com"]);
    await gitAsync(nestedRepo, ["checkout", "-b", "main"]);
    await fsp.writeFile(path.join(nestedRepo, "nested.txt"), "nested\n", "utf8");
    await gitAsync(nestedRepo, ["add", "nested.txt"]);
    await gitAsync(nestedRepo, ["commit", "-m", "init nested"]);

    const storePath = getOptionsStorePath(ctx.userDataPath);
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, JSON.stringify({
      version: 1,
      options: {
        updateMethod: "rebase",
        saveChangesPolicy: "stash",
        scope: {
          syncStrategy: "linked",
          linkedRepoRoots: [linkedRepo],
          skippedRepoRoots: [linkedRepo],
          includeNestedRoots: true,
          rootScanMaxDepth: 4,
        },
        pull: {
          mode: "rebase",
          options: ["noVerify", "ffOnly"],
        },
      },
    }, null, 2), "utf8");

    const snapshot = await getUpdateOptionsSnapshotAsync(createRuntime(ctx));
    expect(snapshot.options.scope.syncStrategy).toBe("linked");
    expect(snapshot.options.scope.linkedRepoRoots).toEqual([linkedRepo]);
    expect(snapshot.options.scope.skippedRepoRoots).toEqual([linkedRepo]);
    expect(snapshot.options.pull).toEqual({
      mode: "rebase",
      options: ["noVerify"],
    });
    expect(snapshot.scopePreview.multiRoot).toBe(true);
    expect(snapshot.scopePreview.roots.some((root) => root.repoRoot === ctx.repoRoot && root.source === "current" && root.included)).toBe(true);
    expect(snapshot.scopePreview.roots.some((root) => root.repoRoot === linkedRepo && root.source === "linked" && !root.included)).toBe(true);
    expect(snapshot.scopePreview.roots.some((root) => root.repoRoot === nestedRepo && root.source === "nested" && root.included)).toBe(true);
    expect(snapshot.scopePreview.skippedRoots.some((root) => root.repoRoot === linkedRepo && root.reasonCode === "requested")).toBe(true);
  });
});
