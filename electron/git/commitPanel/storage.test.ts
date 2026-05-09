import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { __testing, ChangeListManagerEx, ChangeListPlatformService, DEFAULT_CHANGE_LIST_ID, loadViewSettingsStore } from "../changelists";

const cleanupTargets = new Set<string>();

/**
 * 创建隔离的 commit panel 存储目录，避免用例间互相污染持久化状态。
 */
async function createStorageContextAsync(prefix: string): Promise<{ userDataPath: string; repoRoot: string }> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-changelist-${prefix}-`));
  cleanupTargets.add(tempRoot);
  const userDataPath = path.join(tempRoot, "user-data");
  const repoRoot = path.join(tempRoot, "repo");
  await fsp.mkdir(userDataPath, { recursive: true });
  await fsp.mkdir(repoRoot, { recursive: true });
  return { userDataPath, repoRoot };
}

/**
 * 提供一个稳定的异步等待器，便于验证 host update/wait 的先后顺序。
 */
async function delayAsync(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

afterEach(async () => {
  __testing.resetAllHosts();
  await Promise.all(
    Array.from(cleanupTargets.values()).map(async (target) => {
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch {}
      cleanupTargets.delete(target);
    }),
  );
});

describe("change list manager platform alignment", () => {
  it("新建更改列表默认不应自动切换活动列表，显式要求时才切换", async () => {
    const ctx = await createStorageContextAsync("create");
    const service = new ChangeListPlatformService(ctx);

    const first = service.createChangeList("功能开发");
    expect(first.activeListId).toBe(DEFAULT_CHANGE_LIST_ID);
    expect(service.getSnapshotState().repo.activeListId).toBe(DEFAULT_CHANGE_LIST_ID);

    const second = service.createChangeList("缺陷修复", { setActive: true });
    expect(second.activeListId).toBe(second.id);
    expect(service.getSnapshotState().repo.activeListId).toBe(second.id);
  });

  it("应支持 add/edit/default/unversioned/snapshot 语义，并把 default 绑定到当前活动列表", async () => {
    const ctx = await createStorageContextAsync("state");
    const manager = new ChangeListManagerEx(ctx);

    const featureList = manager.addChangeList("功能列表", "首轮开发", { ticket: "CF-1" });
    const bugfixList = manager.addChangeList("缺陷修复", "紧急修复", { ticket: "CF-2" });
    manager.editChangeListData("功能列表", { ticket: "CF-1A", scope: "ui" });
    manager.setDefaultChangeList(featureList, false);
    manager.addUnversionedFiles(featureList, [{ path: "src/app.ts" }]);
    manager.addUnversionedFiles(bugfixList, [{ path: "src/fix.ts" }]);
    manager.assignChangedPaths(["src/app.ts", "src/fix.ts"]);

    const affected = manager.getAffectedLists([{ path: "src/app.ts" }, { path: "src/fix.ts" }]);
    expect(new Set(affected.map((item) => item.getName()))).toEqual(new Set(["功能列表", "缺陷修复"]));
    expect(manager.getDefaultChangeList().getId()).toBe(featureList.getId());
    expect(manager.getDefaultChangeList().isDefault()).toBe(true);
    expect(manager.findChangeList("功能列表")?.getComment()).toBe("首轮开发");
    expect(manager.findChangeList("功能列表")?.getData()).toEqual({ ticket: "CF-1A", scope: "ui" });

    const snapshot = manager.createSnapshot(["src/app.ts", "src/fix.ts"]);
    expect(snapshot?.activeListId).toBe(featureList.getId());
    expect(snapshot?.lists.map((item) => item.id)).toEqual(expect.arrayContaining([featureList.getId(), bugfixList.getId()]));

    manager.removeChangeList(bugfixList.getId(), DEFAULT_CHANGE_LIST_ID);
    expect(manager.getChangeList(bugfixList.getId())).toBeNull();
    manager.restoreSnapshot(snapshot);
    expect(manager.getChangeList(bugfixList.getId())?.getName()).toBe("缺陷修复");
    expect(manager.getAffectedLists([{ path: "src/fix.ts" }])[0]?.getId()).toBe(bugfixList.getId());
  });

  it("application-scope 视图设置应在多项目之间共享，但 showIgnored 需按 project scope 隔离", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-changelist-view-scope-"));
    cleanupTargets.add(tempRoot);
    const userDataPath = path.join(tempRoot, "user-data");
    const repoRootA = path.join(tempRoot, "repo-a");
    const repoRootB = path.join(tempRoot, "repo-b");
    const projectPathA = path.join(tempRoot, "workspace-a");
    const projectPathB = path.join(tempRoot, "workspace-b");
    await fsp.mkdir(userDataPath, { recursive: true });
    await fsp.mkdir(repoRootA, { recursive: true });
    await fsp.mkdir(repoRootB, { recursive: true });
    await fsp.mkdir(projectPathA, { recursive: true });
    await fsp.mkdir(projectPathB, { recursive: true });

    const serviceA = new ChangeListPlatformService({ userDataPath, repoRoot: repoRootA, projectPath: projectPathA });
    const serviceASecondRoot = new ChangeListPlatformService({ userDataPath, repoRoot: repoRootB, projectPath: projectPathA });
    const serviceB = new ChangeListPlatformService({ userDataPath, repoRoot: repoRootB, projectPath: projectPathB });

    const updatedA = serviceA.updateViewOption("detailsPreviewShown", false);
    expect(updatedA.detailsPreviewShown).toBe(false);

    const storeAfterA = loadViewSettingsStore(userDataPath);
    expect(storeAfterA.applicationOptions?.detailsPreviewShown).toBe(false);

    const snapshotASecondRoot = serviceASecondRoot.getSnapshotState();
    expect(snapshotASecondRoot.viewOptions.detailsPreviewShown).toBe(false);

    const snapshotB = serviceB.getSnapshotState();
    expect(snapshotB.viewOptions.detailsPreviewShown).toBe(false);
    expect(snapshotB.viewOptions.showIgnored).toBe(false);

    const updatedSameProject = serviceASecondRoot.updateViewOption("showIgnored", true);
    expect(updatedSameProject.showIgnored).toBe(true);

    const snapshotA = serviceA.getSnapshotState();
    expect(snapshotA.viewOptions.showIgnored).toBe(true);
    expect(serviceB.getSnapshotState().viewOptions.showIgnored).toBe(false);

    const storeAfterB = loadViewSettingsStore(userDataPath);
    expect(storeAfterB.applicationOptions).toEqual(expect.objectContaining({
      detailsPreviewShown: false,
      showIgnored: false,
    }));
  });

  it("应把 freeze/unfreeze/wait/update 状态统一挂到 host 平台层", async () => {
    const ctx = await createStorageContextAsync("host");
    const manager = new ChangeListManagerEx(ctx);
    const hostId = __testing.getHostId(ctx.userDataPath, ctx.repoRoot);
    const order: string[] = [];

    const updateTask = __testing.runHostUpdateAsync(hostId, async () => {
      order.push("update:start");
      await delayAsync(30);
      order.push("update:end");
    });
    await delayAsync(5);
    expect(manager.isInUpdate()).toBe(true);
    order.push("wait:start");
    const waitTask = manager.promiseWaitForUpdate().then(() => {
      order.push("wait:end");
    });

    manager.blockModalNotifications();
    manager.freeze("单测冻结");
    expect(__testing.getHostState(hostId)).toEqual({
      updateDepth: 1,
      freezeDepth: 1,
      blockedModalNotifications: 1,
      freezeReason: "单测冻结",
    });

    await Promise.all([updateTask, waitTask]);
    manager.unfreeze();
    manager.unblockModalNotifications();
    await __testing.waitForHostReadyAsync(hostId);

    expect(order).toEqual([
      "update:start",
      "wait:start",
      "update:end",
      "wait:end",
    ]);
    expect(manager.isInUpdate()).toBe(false);
    expect(__testing.getHostState(hostId)).toEqual({
      updateDepth: 0,
      freezeDepth: 0,
      blockedModalNotifications: 0,
      freezeReason: undefined,
    });
  });
});
