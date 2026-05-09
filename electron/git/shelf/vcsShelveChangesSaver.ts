// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Shelf 保存器参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  ChangeListManagerEx,
  createSystemShelvedChangeListName,
  type RepoChangeListSnapshot,
} from "../changelists";
import { scanWorkingTreeChangesAsync } from "./changeScanner";
import { ShelveChangesManager } from "./manager";
import type {
  GitShelfManagerRuntime,
  GitManualShelveSelection,
  GitShelfSource,
  GitShelveChangeListDescriptor,
  GitShelvedChangeListSavedEntry,
} from "./types";

type RootRollbackPlan = {
  repoRoot: string;
  trackedPaths: string[];
  untrackedPaths: string[];
};

/**
 * 对齐 IDEA `VcsShelveChangesSaver` 的平台级封装，负责“生成 shelf 记录 + 按变更回滚工作区 + 后续恢复”。
 */
export class VcsShelveChangesSaver {
  private readonly runtime: GitShelfManagerRuntime;

  private readonly stashMessage: string;

  private readonly source: GitShelfSource;

  private readonly shelveChangesManager: ShelveChangesManager;

  private readonly shelvedLists: GitShelvedChangeListSavedEntry[] = [];

  /**
   * 初始化平台级 shelf saver。
   */
  constructor(runtime: GitShelfManagerRuntime, stashMessage: string, source: GitShelfSource = "manual") {
    this.runtime = runtime;
    this.stashMessage = String(stashMessage || "").trim() || `Shelf changes @ ${new Date().toISOString()}`;
    this.source = source;
    this.shelveChangesManager = new ShelveChangesManager(runtime);
  }

  /**
   * 返回当前 saver 持有的 shelf 记录列表。
   */
  getShelvedLists(): GitShelvedChangeListSavedEntry[] {
    return [...this.shelvedLists];
  }

  /**
   * 归一化 roots 输入，统一去重并清理空值，避免同一 root 被重复保存。
   */
  private normalizeRoots(rootsToSave: string[]): string[] {
    return Array.from(new Set(
      (Array.isArray(rootsToSave) ? rootsToSave : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
  }

  /**
   * 归一化路径集合，统一转成仓库相对路径并去重。
   */
  private normalizePaths(paths: string[]): string[] {
    return Array.from(new Set(
      (Array.isArray(paths) ? paths : [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
  }

  /**
   * 收集目标 roots 下的本地改动，并按 changelist 语义分组成平台级 shelf 描述。
   */
  private async collectShelveDescriptorsAsync(rootsToSave: string[]): Promise<{
    descriptors: GitShelveChangeListDescriptor[];
    rollbackPlans: RootRollbackPlan[];
  }> {
    const normalizedRoots = this.normalizeRoots(rootsToSave);
    const groups = new Map<string, {
      changeListId?: string;
      changeListName?: string;
      roots: Map<string, { paths: Set<string>; untrackedPaths: Set<string> }>;
      snapshots: Map<string, RepoChangeListSnapshot>;
    }>();
    const rollbackPlans = new Map<string, { tracked: Set<string>; untracked: Set<string> }>();

    for (const repoRoot of normalizedRoots) {
      const scanRes = await scanWorkingTreeChangesAsync(this.runtime, repoRoot);
      if (!scanRes.ok) throw new Error(scanRes.error);
      const changes = scanRes.changes.filter((item) => !item.ignored);
      if (changes.length <= 0) continue;

      const changeListManager = new ChangeListManagerEx({
        userDataPath: this.runtime.userDataPath,
        repoRoot,
      });
      changeListManager.assignChangedPaths(changes.map((item) => item.path));
      const changeListsEnabled = changeListManager.areChangeListsEnabled();
      const defaultList = changeListManager.getDefaultChangeList();
      const listIdByPath = new Map<string, string>();
      for (const list of changeListManager.getChangeLists()) {
        for (const filePath of list.getFiles())
          listIdByPath.set(filePath, list.getId());
      }

      const rollbackPlan = rollbackPlans.get(repoRoot) || { tracked: new Set<string>(), untracked: new Set<string>() };
      for (const change of changes) {
        const listId = changeListManager.areChangeListsEnabled()
          ? (listIdByPath.get(change.path) || defaultList.getId())
          : "__all__";
        const groupKey = changeListsEnabled ? listId : "__all__";
        const currentGroup = groups.get(groupKey) || {
          changeListId: changeListsEnabled ? listId : undefined,
          changeListName: changeListsEnabled
            ? (changeListManager.getChangeList(listId)?.getName() || defaultList.getName())
            : undefined,
          roots: new Map<string, { paths: Set<string>; untrackedPaths: Set<string> }>(),
          snapshots: new Map<string, RepoChangeListSnapshot>(),
        };
        const rootGroup = currentGroup.roots.get(repoRoot) || { paths: new Set<string>(), untrackedPaths: new Set<string>() };
        rootGroup.paths.add(change.path);
        if (change.untracked)
          rootGroup.untrackedPaths.add(change.path);
        else
          rollbackPlan.tracked.add(change.path);
        if (change.untracked)
          rollbackPlan.untracked.add(change.path);
        currentGroup.roots.set(repoRoot, rootGroup);
        groups.set(groupKey, currentGroup);
      }

      for (const [groupKey, group] of groups.entries()) {
        const rootGroup = group.roots.get(repoRoot);
        if (!rootGroup) continue;
        const snapshot = changeListManager.createSnapshot([...rootGroup.paths]);
        if (snapshot)
          group.snapshots.set(repoRoot, snapshot);
        groups.set(groupKey, group);
      }
      rollbackPlans.set(repoRoot, rollbackPlan);
    }

    const descriptors = Array.from(groups.values())
      .map((group) => ({
        message: group.changeListName
          ? createSystemShelvedChangeListName(this.stashMessage, group.changeListName)
          : this.stashMessage,
        source: this.source,
        changeListId: group.changeListId,
        changeListName: group.changeListName,
        roots: Array.from(group.roots.entries()).map(([repoRoot, value]) => ({
          repoRoot,
          paths: [...value.paths],
          untrackedPaths: [...value.untrackedPaths],
        })),
        changeListSnapshots: Array.from(group.snapshots.values()),
      }))
      .filter((descriptor) => descriptor.roots.length > 0);

    return {
      descriptors,
      rollbackPlans: Array.from(rollbackPlans.entries()).map(([repoRoot, value]) => ({
        repoRoot,
        trackedPaths: [...value.tracked],
        untrackedPaths: [...value.untracked],
      })),
    };
  }

  /**
   * 按手动搁置的“当前选择 / 当前更改列表 / 当前受影响变更”语义收集单条 shelf 描述。
   */
  private async collectManualShelveDescriptorsAsync(
    repoRoot: string,
    selection: GitManualShelveSelection,
  ): Promise<{
    descriptors: GitShelveChangeListDescriptor[];
    rollbackPlans: RootRollbackPlan[];
  }> {
    const scanRes = await scanWorkingTreeChangesAsync(this.runtime, repoRoot);
    if (!scanRes.ok) throw new Error(scanRes.error);
    const changes = scanRes.changes.filter((item) => !item.ignored);
    if (changes.length <= 0) {
      return {
        descriptors: [],
        rollbackPlans: [],
      };
    }

    const selectedPaths = this.normalizePaths(selection.selectedPaths);
    const availablePaths = this.normalizePaths(selection.availablePaths || []);
    const availablePathSet = new Set(availablePaths);
    const changeByPath = new Map(
      changes.map((item) => [String(item.path || "").trim().replace(/\\/g, "/"), item] as const),
    );
    const changeListManager = new ChangeListManagerEx({
      userDataPath: this.runtime.userDataPath,
      repoRoot,
    });
    changeListManager.assignChangedPaths(changes.map((item) => item.path));

    const changeListContextEnabled = selection.changeListsEnabled === true;
    const targetChangeListId = String(selection.targetChangeListId || "").trim();
    const targetChangeListName = String(selection.targetChangeListName || "").trim();
    const targetChangeList = targetChangeListId ? changeListManager.getChangeList(targetChangeListId) : null;

    /**
     * 按前端传入的优先级解析手动搁置范围：显式选择 > 当前更改列表 > 当前可见受影响变更。
     */
    const resolveTargetPaths = (): string[] => {
      if (selectedPaths.length > 0)
        return selectedPaths.filter((item) => changeByPath.has(item));
      if (changeListContextEnabled && targetChangeListId) {
        const listPaths = targetChangeList?.getFiles() || [];
        return this.normalizePaths(listPaths).filter((item) => {
          if (!changeByPath.has(item)) return false;
          if (availablePathSet.size <= 0) return true;
          return availablePathSet.has(item);
        });
      }
      const fallbackPaths = availablePaths.length > 0 ? availablePaths : changes.map((item) => item.path);
      return this.normalizePaths(fallbackPaths).filter((item) => changeByPath.has(item));
    };

    const targetPaths = resolveTargetPaths();
    if (targetPaths.length <= 0) {
      return {
        descriptors: [],
        rollbackPlans: [],
      };
    }

    const snapshot = changeListManager.createSnapshot(targetPaths);
    const untrackedPaths = targetPaths.filter((item) => changeByPath.get(item)?.untracked === true);
    const untrackedPathSet = new Set(untrackedPaths);
    const useChangeListContext = selectedPaths.length <= 0 && changeListContextEnabled && !!targetChangeListId;
    return {
      descriptors: [{
        message: this.stashMessage,
        source: this.source,
        changeListId: useChangeListContext ? targetChangeListId : undefined,
        changeListName: useChangeListContext
          ? (targetChangeListName || targetChangeList?.getName() || undefined)
          : undefined,
        roots: [{
          repoRoot,
          paths: targetPaths,
          untrackedPaths,
        }],
        changeListSnapshots: snapshot ? [snapshot] : undefined,
      }],
      rollbackPlans: [{
        repoRoot,
        trackedPaths: targetPaths.filter((item) => !untrackedPathSet.has(item)),
        untrackedPaths,
      }],
    };
  }

  /**
   * 持久化 descriptor 并在回滚成功后把记录切到 `saved`，供手动与 update 两条入口共用。
   */
  private async persistShelvedDescriptorsAsync(
    descriptors: GitShelveChangeListDescriptor[],
    rollbackPlans: RootRollbackPlan[],
  ): Promise<void> {
    if (descriptors.length <= 0) return;

    for (const descriptor of descriptors) {
      const saveRes = await this.shelveChangesManager.createShelvedChangeListAsync(descriptor);
      if (!saveRes.ok) throw new Error(saveRes.error);
      if (saveRes.saved)
        this.shelvedLists.push(saveRes.saved);
    }
    if (this.shelvedLists.length <= 0) return;

    const rollbackRes = await this.doRollbackAsync(rollbackPlans);
    if (!rollbackRes.ok) {
      await Promise.all(
        this.shelvedLists.map(async (item) => {
          await this.shelveChangesManager.markChangeListAsOrphanedAsync(item.ref, rollbackRes.error);
        }),
      );
      throw new Error(rollbackRes.error);
    }

    await Promise.all(
      this.shelvedLists.map(async (item) => {
        await this.shelveChangesManager.markChangeListSavedAsync(item.ref);
      }),
    );
  }

  /**
   * 创建 shelf 记录并按文件级回滚工作区；任一步骤失败都会把记录转为 orphaned。
   */
  async save(rootsToSave: string[]): Promise<void> {
    const normalizedRoots = this.normalizeRoots(rootsToSave);
    this.shelvedLists.splice(0, this.shelvedLists.length);
    if (normalizedRoots.length <= 0) return;

    const { descriptors, rollbackPlans } = await this.collectShelveDescriptorsAsync(normalizedRoots);
    await this.persistShelvedDescriptorsAsync(descriptors, rollbackPlans);
  }

  /**
   * 按手动搁置上下文创建单条 shelf 记录，只处理当前选择或当前更改列表对应的 changes。
   */
  async saveSelection(repoRoot: string, selection: GitManualShelveSelection): Promise<void> {
    const normalizedRepoRoot = String(repoRoot || "").trim();
    this.shelvedLists.splice(0, this.shelvedLists.length);
    if (!normalizedRepoRoot) return;
    const { descriptors, rollbackPlans } = await this.collectManualShelveDescriptorsAsync(normalizedRepoRoot, selection);
    await this.persistShelvedDescriptorsAsync(descriptors, rollbackPlans);
  }

  /**
   * 恢复当前 saver 保存的所有 shelf 记录；任一记录失败时立即中断。
   */
  async load(): Promise<void> {
    for (const item of this.shelvedLists) {
      const restoreRes = await this.shelveChangesManager.unshelveChangeListAsync(item.ref);
      if (!restoreRes.ok)
        throw new Error(restoreRes.error);
    }
  }

  /**
   * 判断当前 saver 是否真的保存过本地改动。
   */
  wereChangesSaved(): boolean {
    return this.shelvedLists.length > 0;
  }

  /**
   * 执行 change/changelist 级回滚，对齐 IDEA `VcsShelveChangesSaver#doRollback` 的职责边界。
   */
  protected async doRollbackAsync(rollbackPlans: RootRollbackPlan[]): Promise<{ ok: true } | { ok: false; error: string }> {
    for (const plan of rollbackPlans) {
      if (plan.trackedPaths.length > 0) {
        const restoreRes = await this.runtime.runGitSpawnAsync(
          plan.repoRoot,
          ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...plan.trackedPaths],
          180_000,
        );
        if (!restoreRes.ok) {
          return {
            ok: false,
            error: this.runtime.toGitErrorMessage(restoreRes, "保存搁置后回滚本地改动失败"),
          };
        }
      }

      for (const untrackedPath of plan.untrackedPaths) {
        try {
          await fsp.rm(path.join(plan.repoRoot, untrackedPath), { recursive: true, force: true });
        } catch (error) {
          return {
            ok: false,
            error: String((error as Error)?.message || `删除未跟踪文件 ${untrackedPath} 失败`),
          };
        }
      }
    }
    return { ok: true };
  }
}
