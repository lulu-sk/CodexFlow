import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ShelvedChangesViewManager } from "./viewManager";

const cleanupTargets = new Set<string>();

/**
 * 创建独立的用户数据目录，避免不同用例之间共享 shelf 视图持久化文件。
 */
async function createUserDataPathAsync(prefix: string): Promise<string> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-shelf-view-${prefix}-`));
  cleanupTargets.add(tempRoot);
  const userDataPath = path.join(tempRoot, "user-data");
  await fsp.mkdir(userDataPath, { recursive: true });
  return userDataPath;
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

describe("ShelvedChangesViewManager", () => {
  it("应按仓库维度持久化 shelf 视图状态，并在后续读取时保留之前的增量更新", async () => {
    const userDataPath = await createUserDataPathAsync("persist");
    const managerA = new ShelvedChangesViewManager("/repo-a", userDataPath);
    const managerB = new ShelvedChangesViewManager("/repo-b", userDataPath);

    expect(await managerA.getViewStateAsync()).toEqual({
      showRecycled: false,
      groupByDirectory: false,
    });

    expect(await managerA.updateViewStateAsync({ showRecycled: true })).toEqual({
      showRecycled: true,
      groupByDirectory: false,
    });
    expect(await managerA.updateViewStateAsync({ groupByDirectory: true })).toEqual({
      showRecycled: true,
      groupByDirectory: true,
    });

    expect(await managerB.getViewStateAsync()).toEqual({
      showRecycled: false,
      groupByDirectory: false,
    });
    expect(await managerB.updateViewStateAsync({ groupByDirectory: true })).toEqual({
      showRecycled: false,
      groupByDirectory: true,
    });

    const reloadedManagerA = new ShelvedChangesViewManager("/repo-a", userDataPath);
    expect(await reloadedManagerA.getViewStateAsync()).toEqual({
      showRecycled: true,
      groupByDirectory: true,
    });

    const persistedRaw = await fsp.readFile(path.join(userDataPath, "git", "shelf-view.json"), "utf8");
    expect(JSON.parse(persistedRaw)).toEqual({
      byRepoRoot: {
        "/repo-a": {
          showRecycled: true,
          groupByDirectory: true,
        },
        "/repo-b": {
          showRecycled: false,
          groupByDirectory: true,
        },
      },
    });
  });

  it("应兼容旧版 groupingMode 持久化结构，并回退为新的目录分组布尔值", async () => {
    const userDataPath = await createUserDataPathAsync("legacy");
    const storePath = path.join(userDataPath, "git", "shelf-view.json");
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, JSON.stringify({
      byRepoRoot: {
        "/repo-a": {
          showRecycled: true,
          groupingMode: "state",
        },
      },
    }, null, 2), "utf8");

    const manager = new ShelvedChangesViewManager("/repo-a", userDataPath);
    expect(await manager.getViewStateAsync()).toEqual({
      showRecycled: true,
      groupByDirectory: false,
    });
  });
});
