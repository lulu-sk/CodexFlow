import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRepoChangeLists,
  loadChangeListsStore,
  saveChangeListsStore,
} from "../changelists";
import { execGitAsync, spawnGitStdoutToFileAsync, type GitExecResult } from "../exec";
import {
  deleteSystemShelveAsync,
  listSystemShelvesAsync,
  restoreSystemShelveAsync,
  saveSystemShelveAsync,
} from "../shelf/system";
import type { GitShelfManagerRuntime } from "../shelf/types";

const cleanupTargets = new Set<string>();

/**
 * 在指定目录执行 Git 命令，并在失败时抛出明确错误，便于快速定位测试问题。
 */
async function gitAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<GitExecResult> {
  return await execGitAsync({
    argv: ["-C", repoRoot, ...argv],
    timeoutMs,
  });
}

/**
 * 要求 Git 命令成功执行，并直接返回标准输出文本。
 */
async function gitMustAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await gitAsync(repoRoot, argv, timeoutMs);
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 初始化测试仓库，统一配置提交身份与默认分支，避免跨平台默认值差异。
 */
async function initRepoAsync(prefix: string): Promise<{ repoRoot: string; userDataPath: string }> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-shelf-${prefix}-`));
  cleanupTargets.add(tempRoot);
  const repoRoot = path.join(tempRoot, "repo");
  const userDataPath = path.join(tempRoot, "user-data");
  await fsp.mkdir(repoRoot, { recursive: true });
  await fsp.mkdir(userDataPath, { recursive: true });
  await gitMustAsync(repoRoot, ["init"]);
  await gitMustAsync(repoRoot, ["config", "user.name", "CodexFlow"]);
  await gitMustAsync(repoRoot, ["config", "user.email", "codexflow@example.com"]);
  await gitMustAsync(repoRoot, ["checkout", "-b", "main"]);
  await fsp.writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf8");
  await gitMustAsync(repoRoot, ["add", "tracked.txt"]);
  await gitMustAsync(repoRoot, ["commit", "-m", "init"]);
  return { repoRoot, userDataPath };
}

/**
 * 创建 shelf store 运行时，允许按命令关键字注入失败场景。
 */
function createShelfRuntime(
  repoRoot: string,
  userDataPath: string,
  options?: {
    failOnSpawn?: (argv: string[]) => string | null;
    failOnceOnSpawn?: (argv: string[]) => string | null;
  },
): GitShelfManagerRuntime {
  let hasFailed = false;
  return {
    repoRoot,
    userDataPath,
    async runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      return await execGitAsync({
        argv: ["-C", targetRepoRoot, ...argv],
        timeoutMs,
      });
    },
    async runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      const persistentFailMessage = options?.failOnSpawn?.(argv);
      if (persistentFailMessage) {
        return {
          ok: false,
          stdout: "",
          stderr: persistentFailMessage,
          exitCode: 1,
        };
      }
      const failMessage = !hasFailed ? options?.failOnceOnSpawn?.(argv) : null;
      if (failMessage) {
        hasFailed = true;
        return {
          ok: false,
          stdout: "",
          stderr: failMessage,
          exitCode: 1,
        };
      }
      return await execGitAsync({
        argv: ["-C", targetRepoRoot, ...argv],
        timeoutMs,
      });
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
    toGitErrorMessage(res, fallback) {
      return String(res.stderr || res.error || res.stdout || fallback);
    },
  };
}

/**
 * 构造稳定的大文本内容，用于验证大补丁场景不会再触发 maxBuffer 失败。
 */
function buildLargeText(label: string, lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `${label}-${String(index).padStart(6, "0")}-payload-payload-payload\n`).join("");
}

/**
 * 直接为测试仓库写入 changelist 映射，便于验证 shelve 保存/恢复是否保留原始归属关系。
 */
function assignTestChangeList(args: {
  userDataPath: string;
  repoRoot: string;
  listId: string;
  listName: string;
  filePath: string;
}): void {
  const store = loadChangeListsStore(args.userDataPath);
  const repo = ensureRepoChangeLists(store, args.userDataPath, args.repoRoot);
  const existing = repo.lists.find((item) => item.id === args.listId);
  if (!existing) {
    repo.lists.push({
      id: args.listId,
      name: args.listName,
      files: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  repo.activeListId = args.listId;
  repo.fileToList[args.filePath] = args.listId;
  saveChangeListsStore(args.userDataPath, store);
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

describe("system shelf 平台", () => {
  it("应只列出当前仓库的系统搁置记录，并支持恢复成功后自动清理", async () => {
    const firstRepo = await initRepoAsync("list-a");
    const secondRepo = await initRepoAsync("list-b");
    const sharedUserDataPath = firstRepo.userDataPath;

    const firstRuntime = createShelfRuntime(firstRepo.repoRoot, sharedUserDataPath);
    const secondRuntime = createShelfRuntime(secondRepo.repoRoot, sharedUserDataPath);

    await fsp.writeFile(path.join(firstRepo.repoRoot, "tracked.txt"), "base\nfirst\n", "utf8");
    await fsp.writeFile(path.join(secondRepo.repoRoot, "tracked.txt"), "base\nsecond\n", "utf8");

    const firstSave = await saveSystemShelveAsync(firstRuntime, "first");
    const secondSave = await saveSystemShelveAsync(secondRuntime, "second");
    expect(firstSave.ok && secondSave.ok).toBe(true);

    const firstItems = await listSystemShelvesAsync(firstRuntime);
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]?.repoRoot).toBe(firstRepo.repoRoot);
    expect(firstItems[0]?.source).toBe("system");

    const restoreRes = await restoreSystemShelveAsync(firstRuntime, firstItems[0]!.ref);
    expect(restoreRes.ok).toBe(true);
    expect(await fsp.readFile(path.join(firstRepo.repoRoot, "tracked.txt"), "utf8")).toContain("first");
    expect(await listSystemShelvesAsync(firstRuntime)).toHaveLength(0);
    expect(await listSystemShelvesAsync(secondRuntime)).toHaveLength(1);
  });

  it("删除记录时只应删除目标 ref 对应目录", async () => {
    const ctx = await initRepoAsync("delete-one");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nfirst\n", "utf8");
    const firstSave = await saveSystemShelveAsync(runtime, "first");
    expect(firstSave.ok).toBe(true);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nsecond\n", "utf8");
    const secondSave = await saveSystemShelveAsync(runtime, "second");
    expect(secondSave.ok).toBe(true);

    const items = await listSystemShelvesAsync(runtime);
    expect(items).toHaveLength(2);

    await deleteSystemShelveAsync(runtime, items[0]!.ref);
    const remaining = await listSystemShelvesAsync(runtime);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.ref).toBe(items[1]!.ref);
  });

  it("大补丁场景应通过流式写文件完成搁置，而不是触发 maxBuffer", async () => {
    const ctx = await initRepoAsync("large-patch");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);

    await fsp.writeFile(path.join(ctx.repoRoot, "secondary.txt"), "base\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "secondary.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "add secondary"]);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), buildLargeText("staged", 70_000), "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "tracked.txt"]);
    await fsp.writeFile(path.join(ctx.repoRoot, "secondary.txt"), buildLargeText("worktree", 70_000), "utf8");

    const saveRes = await saveSystemShelveAsync(runtime, "large-patch");
    expect(saveRes.ok).toBe(true);
    expect(saveRes.ok && saveRes.saved).toBeTruthy();

    const items = await listSystemShelvesAsync(runtime);
    expect(items).toHaveLength(1);
    expect(items[0]?.hasIndexPatch).toBe(true);
    expect(items[0]?.hasWorktreePatch).toBe(true);
  });

  it("不应再调用整仓 clean；即使注入 clean 失败，保存仍应按新平台语义成功", async () => {
    const ctx = await initRepoAsync("orphaned-clean");
    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nlocal\n", "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "temp.txt"), "temp\n", "utf8");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath, {
      failOnceOnSpawn(argv) {
        return argv[0] === "clean" ? "clean failed" : null;
      },
    });

    const saveRes = await saveSystemShelveAsync(runtime, "clean-fail");
    expect(saveRes.ok).toBe(true);
    expect(await listSystemShelvesAsync(runtime)).toHaveLength(1);
    const hiddenItems = await listSystemShelvesAsync(runtime, { includeHidden: true });
    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.state).toBe("saved");
  });

  it("恢复 index 成功但 worktree 失败时应标记 restore-failed，并允许后续重试", async () => {
    const ctx = await initRepoAsync("retry");
    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nstaged\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "tracked.txt"]);
    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nstaged\nunstaged\n", "utf8");

    const saveRuntime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const saveRes = await saveSystemShelveAsync(saveRuntime, "retry");
    expect(saveRes.ok).toBe(true);
    const items = await listSystemShelvesAsync(saveRuntime);
    expect(items).toHaveLength(1);

    const failedRestoreRuntime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath, {
      failOnSpawn(argv) {
        return argv[0] === "apply" && argv.some((item) => String(item || "").replace(/\\/g, "/").endsWith("/worktree.patch")) ? "worktree apply failed" : null;
      },
    });
    const restoreFailRes = await restoreSystemShelveAsync(failedRestoreRuntime, items[0]!.ref);
    expect(restoreFailRes.ok).toBe(false);

    const failedItems = await listSystemShelvesAsync(saveRuntime, { includeHidden: true });
    expect(failedItems).toHaveLength(1);
    expect(failedItems[0]?.state).toBe("restore-failed");

    const retryRes = await restoreSystemShelveAsync(saveRuntime, items[0]!.ref);
    expect(retryRes.ok).toBe(true);
    expect(await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).toContain("unstaged");
    expect(await listSystemShelvesAsync(saveRuntime)).toHaveLength(0);
  });

  it("恢复后应还原原始 changelist 映射", async () => {
    const ctx = await initRepoAsync("changelist-restore");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);

    assignTestChangeList({
      userDataPath: ctx.userDataPath,
      repoRoot: ctx.repoRoot,
      listId: "feature-list",
      listName: "功能列表",
      filePath: "tracked.txt",
    });

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nfeature\n", "utf8");
    const saveRes = await saveSystemShelveAsync(runtime, "restore-changelist");
    expect(saveRes.ok).toBe(true);

    const driftedStore = loadChangeListsStore(ctx.userDataPath);
    const driftedRepo = ensureRepoChangeLists(driftedStore, ctx.userDataPath, ctx.repoRoot);
    driftedRepo.lists = driftedRepo.lists.filter((item) => item.id !== "feature-list");
    driftedRepo.activeListId = "default";
    delete driftedRepo.fileToList["tracked.txt"];
    saveChangeListsStore(ctx.userDataPath, driftedStore);

    const items = await listSystemShelvesAsync(runtime);
    expect(items).toHaveLength(1);

    const restoreRes = await restoreSystemShelveAsync(runtime, items[0]!.ref);
    expect(restoreRes.ok).toBe(true);

    const restoredStore = loadChangeListsStore(ctx.userDataPath);
    const restoredRepo = ensureRepoChangeLists(restoredStore, ctx.userDataPath, ctx.repoRoot);
    expect(restoredRepo.activeListId).toBe("feature-list");
    expect(restoredRepo.fileToList["tracked.txt"]).toBe("feature-list");
    expect(restoredRepo.lists.some((item) => item.id === "feature-list" && item.name === "功能列表")).toBe(true);
  });

  it("恢复未跟踪文件时，若目标路径已存在且内容一致，应视为已恢复成功", async () => {
    const ctx = await initRepoAsync("untracked-same-content");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);

    await fsp.writeFile(path.join(ctx.repoRoot, "same.txt"), "same content\n", "utf8");
    const saveRes = await saveSystemShelveAsync(runtime, "same-content");
    expect(saveRes.ok).toBe(true);

    const items = await listSystemShelvesAsync(runtime);
    expect(items).toHaveLength(1);

    await fsp.writeFile(path.join(ctx.repoRoot, "same.txt"), "same content\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "same.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "track same content"]);

    const restoreRes = await restoreSystemShelveAsync(runtime, items[0]!.ref);
    expect(restoreRes.ok).toBe(true);
    expect(await fsp.readFile(path.join(ctx.repoRoot, "same.txt"), "utf8")).toBe("same content\n");
    expect(await listSystemShelvesAsync(runtime)).toHaveLength(0);
  });

  it("恢复未跟踪文件时，若目标路径已存在且内容不同，应继续保留 restore-failed", async () => {
    const ctx = await initRepoAsync("untracked-different-content");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);

    await fsp.writeFile(path.join(ctx.repoRoot, "same.txt"), "local untracked\n", "utf8");
    const saveRes = await saveSystemShelveAsync(runtime, "different-content");
    expect(saveRes.ok).toBe(true);

    const items = await listSystemShelvesAsync(runtime);
    expect(items).toHaveLength(1);

    await fsp.writeFile(path.join(ctx.repoRoot, "same.txt"), "tracked remote version\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "same.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "track different content"]);

    const restoreRes = await restoreSystemShelveAsync(runtime, items[0]!.ref);
    expect(restoreRes.ok).toBe(false);
    expect(restoreRes.ok ? "" : restoreRes.error).toContain("目标路径已存在同名文件，且内容不同");

    const hiddenItems = await listSystemShelvesAsync(runtime, { includeHidden: true });
    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.state).toBe("restore-failed");
  });
});
