import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeListManagerEx } from "../changelists";
import { execGitAsync, spawnGitStdoutToFileAsync, type GitExecResult } from "../exec";
import { ShelveChangesManager } from "./manager";
import type { GitShelfManagerRuntime } from "./types";
import { VcsShelveChangesSaver } from "./vcsShelveChangesSaver";

const cleanupTargets = new Set<string>();

/**
 * 在指定目录执行 Git 命令，并返回标准执行结果。
 */
async function gitAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<GitExecResult> {
  return await execGitAsync({
    argv: ["-C", repoRoot, ...argv],
    timeoutMs,
  });
}

/**
 * 要求 Git 命令成功执行，失败时直接给出可定位信息。
 */
async function gitMustAsync(repoRoot: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await gitAsync(repoRoot, argv, timeoutMs);
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 初始化一个最小测试仓库。
 */
async function initRepoAsync(prefix: string): Promise<{ repoRoot: string; userDataPath: string }> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-shelf-manager-${prefix}-`));
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
 * 构造统一 shelf manager runtime。
 */
function createShelfRuntime(
  repoRoot: string,
  userDataPath: string,
  options?: {
    onChange?: GitShelfManagerRuntime["onChange"];
  },
): GitShelfManagerRuntime {
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
    onChange: options?.onChange,
    toGitErrorMessage(res, fallback) {
      return String(res.stderr || res.error || res.stdout || fallback);
    },
  };
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

describe("统一搁置平台", () => {
  it("应统一保存 manual 来源的搁置记录，并支持按 source 过滤与恢复", async () => {
    const ctx = await initRepoAsync("manual-flow");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const saver = new VcsShelveChangesSaver(runtime, "manual shelf", "manual");

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nmanual\n", "utf8");
    await saver.save([ctx.repoRoot]);

    const allItems = await manager.listShelvedChangeListsAsync();
    expect(allItems).toHaveLength(1);
    expect(allItems[0]?.source).toBe("manual");

    const manualItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(manualItems).toHaveLength(1);

    const systemItems = await manager.listShelvedChangeListsAsync({ source: "system" });
    expect(systemItems).toHaveLength(0);

    const restoreRes = await manager.unshelveChangeListAsync(allItems[0]!.ref);
    expect(restoreRes.ok).toBe(true);
    expect(await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).toContain("manual");
    expect(await manager.listShelvedChangeListsAsync()).toHaveLength(0);
  });

  it("system shelf 应支持未跟踪目录的保存与恢复，避免把目录误当文件复制", async () => {
    const ctx = await initRepoAsync("untracked-directory");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const saver = new VcsShelveChangesSaver(runtime, "system shelf", "system");
    const untrackedFilePath = path.join(ctx.repoRoot, ".claude", "skills", "demo", "SKILL.md");

    await fsp.mkdir(path.dirname(untrackedFilePath), { recursive: true });
    await fsp.writeFile(untrackedFilePath, "demo\n", "utf8");

    await saver.save([ctx.repoRoot]);
    expect(await fsp.stat(untrackedFilePath).catch(() => null)).toBeNull();

    const items = await manager.listShelvedChangeListsAsync({ source: "system" });
    expect(items).toHaveLength(1);
    expect(items[0]?.hasUntrackedFiles).toBe(true);

    await saver.load();
    expect(await fsp.readFile(untrackedFilePath, "utf8")).toBe("demo\n");
  });

  it("手动搁置与系统搁置应共用同一平台层存储，并可按 source 区分读取", async () => {
    const ctx = await initRepoAsync("shared-platform");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const manualSaver = new VcsShelveChangesSaver(runtime, "manual shelf", "manual");
    const systemSaver = new VcsShelveChangesSaver(runtime, "system shelf", "system");

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nmanual\n", "utf8");
    await manualSaver.save([ctx.repoRoot]);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nupdate\n", "utf8");
    await systemSaver.save([ctx.repoRoot]);

    const allItems = await manager.listShelvedChangeListsAsync({ includeHidden: true, source: "all" });
    expect(allItems).toHaveLength(2);
    expect(new Set(allItems.map((item) => item.source))).toEqual(new Set(["manual", "system"]));
    expect(await manager.listShelvedChangeListsAsync({ source: "manual" })).toHaveLength(1);
    expect(await manager.listShelvedChangeListsAsync({ source: "system" })).toHaveLength(1);
    expect(manager.getShelfResourcesDirectory()).toContain(path.join("git", "shelves"));
  });

  it("手动搁置应只处理当前选择或当前更改列表，而不是整仓改动", async () => {
    const ctx = await initRepoAsync("manual-selection");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const changeListManager = new ChangeListManagerEx({
      userDataPath: ctx.userDataPath,
      repoRoot: ctx.repoRoot,
    });

    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature base\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "feature.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "add feature file"]);

    const featureList = changeListManager.addChangeList("功能改动", "功能线", { type: "feature" });
    const bugfixList = changeListManager.addChangeList("缺陷修复", "修复线", { type: "bugfix" });
    changeListManager.addUnversionedFiles(featureList, [{ path: "tracked.txt" }]);
    changeListManager.addUnversionedFiles(bugfixList, [{ path: "feature.txt" }]);
    changeListManager.assignChangedPaths(["tracked.txt", "feature.txt"]);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nfeature change\n", "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature bugfix\n", "utf8");

    const selectedSaver = new VcsShelveChangesSaver(runtime, "manual selected", "manual");
    await selectedSaver.saveSelection(ctx.repoRoot, {
      selectedPaths: ["tracked.txt"],
      availablePaths: ["tracked.txt", "feature.txt"],
      targetChangeListId: featureList.getId(),
      targetChangeListName: featureList.getName(),
      changeListsEnabled: true,
    });

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base\n");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature bugfix\n");

    let manualItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(manualItems).toHaveLength(1);
    expect(manualItems[0]?.originalChangeListName).toBeUndefined();

    await selectedSaver.load();
    expect(await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).toContain("feature change");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature bugfix\n");

    const changeListSaver = new VcsShelveChangesSaver(runtime, "manual changelist", "manual");
    await changeListSaver.saveSelection(ctx.repoRoot, {
      selectedPaths: [],
      availablePaths: ["tracked.txt", "feature.txt"],
      targetChangeListId: bugfixList.getId(),
      targetChangeListName: bugfixList.getName(),
      changeListsEnabled: true,
    });

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toContain("feature change");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature base\n");

    manualItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(manualItems).toHaveLength(1);
    expect(manualItems[0]?.originalChangeListName).toBe("缺陷修复");

    await changeListSaver.load();
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toContain("feature bugfix");
    expect(changeListManager.getAffectedLists([{ path: "tracked.txt" }])[0]?.getId()).toBe(featureList.getId());
    expect(changeListManager.getAffectedLists([{ path: "feature.txt" }])[0]?.getId()).toBe(bugfixList.getId());
  });

  it("应按 changelist 维度生成 system shelf，并在 rollback / unshelve 后恢复文件归属", async () => {
    const ctx = await initRepoAsync("changelist-flow");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const changeListManager = new ChangeListManagerEx({
      userDataPath: ctx.userDataPath,
      repoRoot: ctx.repoRoot,
    });
    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature base\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "feature.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "add feature file"]);

    const featureList = changeListManager.addChangeList("功能改动", "功能线", { type: "feature" });
    const bugfixList = changeListManager.addChangeList("缺陷修复", "修复线", { type: "bugfix" });
    changeListManager.addUnversionedFiles(featureList, [{ path: "tracked.txt" }]);
    changeListManager.addUnversionedFiles(bugfixList, [{ path: "feature.txt" }]);
    changeListManager.assignChangedPaths(["tracked.txt", "feature.txt"]);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nfeature change\n", "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature bugfix\n", "utf8");

    const saver = new VcsShelveChangesSaver(runtime, "system shelf", "system");
    await saver.save([ctx.repoRoot]);

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base\n");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature base\n");

    const items = await new ShelveChangesManager(runtime).listShelvedChangeListsAsync({ source: "system" });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.originalChangeListName))).toEqual(new Set(["功能改动", "缺陷修复"]));

    await saver.load();

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toContain("feature change");
    expect(await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).toContain("feature bugfix");
    expect(changeListManager.getAffectedLists([{ path: "tracked.txt" }])[0]?.getId()).toBe(featureList.getId());
    expect(changeListManager.getAffectedLists([{ path: "feature.txt" }])[0]?.getId()).toBe(bugfixList.getId());
  });

  it("partial unshelve 应只恢复选中文件，并在 remove-applied 策略下保留剩余 shelf 内容", async () => {
    const ctx = await initRepoAsync("partial-unshelve");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const changeListManager = new ChangeListManagerEx({
      userDataPath: ctx.userDataPath,
      repoRoot: ctx.repoRoot,
    });

    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature base\n", "utf8");
    await gitMustAsync(ctx.repoRoot, ["add", "feature.txt"]);
    await gitMustAsync(ctx.repoRoot, ["commit", "-m", "add feature file"]);

    const featureList = changeListManager.addChangeList("功能改动", "功能线", { type: "feature" });
    const bugfixList = changeListManager.addChangeList("缺陷修复", "修复线", { type: "bugfix" });
    changeListManager.addUnversionedFiles(featureList, [{ path: "tracked.txt" }]);
    changeListManager.addUnversionedFiles(featureList, [{ path: "feature.txt" }]);
    changeListManager.assignChangedPaths(["tracked.txt", "feature.txt"]);

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\ntracked partial\n", "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "feature.txt"), "feature partial\n", "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "new.txt"), "new partial\n", "utf8");

    const saver = new VcsShelveChangesSaver(runtime, "partial shelf", "manual");
    await saver.saveSelection(ctx.repoRoot, {
      selectedPaths: ["tracked.txt", "feature.txt", "new.txt"],
      availablePaths: ["tracked.txt", "feature.txt", "new.txt"],
      targetChangeListId: featureList.getId(),
      targetChangeListName: featureList.getName(),
      changeListsEnabled: true,
    });

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base\n");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature base\n");
    expect(await fsp.stat(path.join(ctx.repoRoot, "new.txt")).catch(() => null)).toBeNull();

    let items = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(items).toHaveLength(1);
    expect(new Set(items[0]?.paths || [])).toEqual(new Set(["tracked.txt", "feature.txt", "new.txt"]));

    const restoreRes = await manager.unshelveChangeListAsync(items[0]!.ref, {
      selectedPaths: ["tracked.txt", "new.txt"],
      targetChangeListId: bugfixList.getId(),
      removeAppliedFromShelf: true,
    });
    expect(restoreRes.ok).toBe(true);

    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toContain("tracked partial");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature base\n");
    expect((await fsp.readFile(path.join(ctx.repoRoot, "new.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("new partial\n");
    expect(changeListManager.getAffectedLists([{ path: "tracked.txt" }])[0]?.getId()).toBe(bugfixList.getId());

    items = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(items).toHaveLength(1);
    expect(items[0]?.paths).toEqual(["feature.txt"]);

    const restoreRemainingRes = await manager.unshelveChangeListAsync(items[0]!.ref, {
      selectedPaths: ["feature.txt"],
      removeAppliedFromShelf: true,
    });
    expect(restoreRemainingRes.ok).toBe(true);
    expect((await fsp.readFile(path.join(ctx.repoRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toContain("feature partial");
    expect(await manager.listShelvedChangeListsAsync({ source: "manual" })).toHaveLength(0);
  });

  it("应支持重命名、回收、恢复归档与彻底删除，并通过 includeHidden 暴露隐藏状态", async () => {
    const ctx = await initRepoAsync("archive-flow");
    const events: Array<{ type: string; ref: string; state?: string }> = [];
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath, {
      onChange(event) {
        events.push({ type: event.type, ref: event.ref, state: event.state });
      },
    });
    const manager = new ShelveChangesManager(runtime);
    const saver = new VcsShelveChangesSaver(runtime, "archive shelf", "manual");

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\narchive\n", "utf8");
    await saver.save([ctx.repoRoot]);

    const createdItem = (await manager.listShelvedChangeListsAsync({ source: "manual" }))[0];
    expect(createdItem).toBeDefined();
    const ref = createdItem!.ref;

    await manager.renameChangeListAsync(ref, "renamed shelf");
    let visibleItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(visibleItems[0]?.message).toBe("renamed shelf");

    await manager.recycleChangeListAsync(ref);
    visibleItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(visibleItems).toHaveLength(0);

    let hiddenItems = await manager.listShelvedChangeListsAsync({ source: "manual", includeHidden: true });
    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.state).toBe("recycled");

    await manager.restoreArchivedChangeListAsync(ref);
    visibleItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0]?.state).toBe("saved");
    expect(visibleItems[0]?.message).toBe("renamed shelf");

    await manager.deleteChangeListAsync(ref);
    visibleItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(visibleItems).toHaveLength(0);
    hiddenItems = await manager.listShelvedChangeListsAsync({ source: "manual", includeHidden: true });
    expect(hiddenItems).toHaveLength(1);
    expect(hiddenItems[0]?.state).toBe("deleted");

    await manager.restoreArchivedChangeListAsync(ref);
    visibleItems = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0]?.state).toBe("saved");

    await manager.deleteChangeListAsync(ref, { permanently: true });
    expect(await manager.listShelvedChangeListsAsync({ source: "manual", includeHidden: true })).toHaveLength(0);

    expect(events.map((item) => item.type)).toEqual([
      "created",
      "saved",
      "renamed",
      "recycled",
      "restored-to-list",
      "deleted",
      "restored-to-list",
      "removed",
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({ ref, type: "removed" }));
  });

  it("应支持导入外部 patch 文件，并在统一 shelf 平台中恢复", async () => {
    const ctx = await initRepoAsync("import-patch");
    const runtime = createShelfRuntime(ctx.repoRoot, ctx.userDataPath);
    const manager = new ShelveChangesManager(runtime);
    const patchPath = path.join(path.dirname(ctx.repoRoot), "imported-feature.patch");

    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\nimported line\n", "utf8");
    const patchText = await gitMustAsync(ctx.repoRoot, ["diff", "--binary"]);
    await fsp.writeFile(patchPath, patchText, "utf8");
    await fsp.writeFile(path.join(ctx.repoRoot, "tracked.txt"), "base\n", "utf8");

    const importRes = await manager.importPatchFilesAsync([patchPath]);
    expect(importRes.failed).toHaveLength(0);
    expect(importRes.imported).toHaveLength(1);

    const items = await manager.listShelvedChangeListsAsync({ source: "manual" });
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe("imported feature");
    expect(items[0]?.paths).toEqual(["tracked.txt"]);

    const restoreRes = await manager.unshelveChangeListAsync(items[0]!.ref);
    expect(restoreRes.ok).toBe(true);
    expect((await fsp.readFile(path.join(ctx.repoRoot, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base\nimported line\n");
    expect(await manager.listShelvedChangeListsAsync({ source: "manual" })).toHaveLength(0);
  });
});
