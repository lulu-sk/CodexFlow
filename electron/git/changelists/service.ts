// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  ChangeListManagerEx,
  ensureRepoChangeLists,
  ensureRepoLocalChangesConfig,
  ensureRepoViewSettings,
  loadChangeListsStore,
  loadLocalChangesStore,
  loadViewSettingsStore,
  saveLocalChangesStore,
  saveViewSettingsStore,
  type ChangeListManagerContext,
} from "./platform";
import type {
  ChangeListItem,
  GitCommitPanelCapabilityState,
  GitCommitPanelLocalChangesConfig,
  GitCommitPanelViewOptions,
  RepoChangeLists,
} from "./types";

export type ChangeListGroupingKey = "directory" | "module" | "repository";

export type ChangeListViewOptionKey =
  | "groupByDirectory"
  | "showIgnored"
  | "detailsPreviewShown"
  | "diffPreviewOnDoubleClickOrEnter";

export type LocalChangesConfigKey = "stagingAreaEnabled" | "changeListsEnabled" | "commitAllEnabled";

export type ChangeListPlatformSnapshot = {
  repo: RepoChangeLists;
  viewOptions: GitCommitPanelViewOptions;
  localChanges: GitCommitPanelLocalChangesConfig;
};

export type ChangeListOperationAvailability = GitCommitPanelCapabilityState & {
  operationsAllowed: boolean;
  error?: string;
};

/**
 * 深拷贝单个 changelist 项，避免平台快照把底层持久化对象直接暴露给业务层。
 */
function cloneChangeListItem(item: ChangeListItem): ChangeListItem {
  return {
    id: String(item.id || "").trim(),
    name: String(item.name || "").trim(),
    comment: String(item.comment || "").trim() || "",
    data: item.data ? JSON.parse(JSON.stringify(item.data)) as Record<string, any> : null,
    readOnly: item.readOnly === true,
    files: Array.isArray(item.files) ? [...item.files] : [],
    createdAt: Number(item.createdAt) || Date.now(),
    updatedAt: Number(item.updatedAt) || Date.now(),
  };
}

/**
 * 深拷贝 changelist 仓库状态，隔离平台内部 JSON 结构与业务层快照。
 */
function cloneRepoChangeLists(repo: RepoChangeLists): RepoChangeLists {
  return {
    repoRoot: String(repo.repoRoot || "").trim(),
    activeListId: String(repo.activeListId || "").trim(),
    lists: Array.isArray(repo.lists) ? repo.lists.map((item) => cloneChangeListItem(item)) : [],
    fileToList: { ...(repo.fileToList || {}) },
  };
}

/**
 * 复制视图配置，并保留 grouping key 数组的稳定副本。
 */
function cloneViewOptions(options: GitCommitPanelViewOptions): GitCommitPanelViewOptions {
  return {
    groupByDirectory: options.groupByDirectory === true,
    groupingKeys: Array.isArray(options.groupingKeys) ? [...options.groupingKeys] : [],
    availableGroupingKeys: Array.isArray(options.availableGroupingKeys) ? [...options.availableGroupingKeys] : undefined,
    showIgnored: options.showIgnored === true,
    detailsPreviewShown: options.detailsPreviewShown !== false,
    diffPreviewOnDoubleClickOrEnter: options.diffPreviewOnDoubleClickOrEnter !== false,
    manyFilesThreshold: Number.isFinite(Number(options.manyFilesThreshold))
      ? Math.max(1, Math.floor(Number(options.manyFilesThreshold)))
      : 1000,
  };
}

/**
 * 复制本地更改能力配置，保证外层读取到的是不可共享的稳定快照。
 */
function cloneLocalChangesConfig(config: GitCommitPanelLocalChangesConfig): GitCommitPanelLocalChangesConfig {
  return {
    stagingAreaEnabled: config.stagingAreaEnabled === true,
    changeListsEnabled: config.changeListsEnabled !== false,
    commitAllEnabled: config.commitAllEnabled !== false,
  };
}

/**
 * 过滤并去重 grouping key 输入，统一对外暴露平台认可的 key 集。
 */
function normalizeGroupingKeysInput(groupingKeysInput: unknown): ChangeListGroupingKey[] {
  const input = Array.isArray(groupingKeysInput) ? groupingKeysInput : [];
  return Array.from(new Set(
    input.filter((key: unknown): key is ChangeListGroupingKey => key === "directory" || key === "module" || key === "repository"),
  ));
}

/**
 * 封装 changelist/view/localChanges 平台访问，统一隔离业务层与底层 JSON store。
 */
export class ChangeListPlatformService {
  private readonly context: ChangeListManagerContext;

  /**
   * 初始化平台服务上下文。
   */
  constructor(context: ChangeListManagerContext) {
    this.context = {
      userDataPath: String(context.userDataPath || "").trim(),
      repoRoot: String(context.repoRoot || "").trim(),
      projectPath: String(context.projectPath || "").trim() || undefined,
    };
  }

  /**
   * 按当前上下文创建 changelist 管理器，供真实 changelist 操作统一复用。
   */
  private getChangeListManager(): ChangeListManagerEx {
    return new ChangeListManagerEx(this.context);
  }

  /**
   * 读取 changelist 快照种子，仅向业务层暴露复制后的仓库态。
   */
  private loadRepoChangeLists(): RepoChangeLists {
    const store = loadChangeListsStore(this.context.userDataPath);
    const repo = ensureRepoChangeLists(store, this.context.userDataPath, this.context.repoRoot);
    return cloneRepoChangeLists(repo);
  }

  /**
   * 读取并持久化整理后的视图设置，确保旧结构迁移与缺省值修正都发生在平台层。
   */
  private loadViewOptions(): GitCommitPanelViewOptions {
    const store = loadViewSettingsStore(this.context.userDataPath);
    const repo = ensureRepoViewSettings(store, this.context.userDataPath, this.context.repoRoot, this.context.projectPath);
    saveViewSettingsStore(this.context.userDataPath, store);
    return cloneViewOptions(repo.options);
  }

  /**
   * 读取并持久化整理后的本地更改配置，确保 staging/changelist 互斥关系在平台层收口。
   */
  private loadLocalChangesConfig(): GitCommitPanelLocalChangesConfig {
    const store = loadLocalChangesStore(this.context.userDataPath);
    const repo = ensureRepoLocalChangesConfig(store, this.context.userDataPath, this.context.repoRoot);
    saveLocalChangesStore(this.context.userDataPath, store);
    return cloneLocalChangesConfig(repo.config);
  }

  /**
   * 在平台层内原子更新视图配置，并返回持久化后的最新副本。
   */
  private updateProjectViewOptions(mutator: (options: GitCommitPanelViewOptions) => void): GitCommitPanelViewOptions {
    const store = loadViewSettingsStore(this.context.userDataPath);
    const repo = ensureRepoViewSettings(store, this.context.userDataPath, this.context.repoRoot, this.context.projectPath);
    mutator(repo.options);
    saveViewSettingsStore(this.context.userDataPath, store);
    return cloneViewOptions(repo.options);
  }

  /**
   * 在平台层内原子更新 application-scope 视图配置，并保留当前项目自己的 `showIgnored` 选择。
   */
  private updateApplicationViewOptions(mutator: (options: GitCommitPanelViewOptions) => void): GitCommitPanelViewOptions {
    const store = loadViewSettingsStore(this.context.userDataPath);
    const repo = ensureRepoViewSettings(store, this.context.userDataPath, this.context.repoRoot, this.context.projectPath);
    const nextApplicationOptions = cloneViewOptions(store.applicationOptions || repo.options);
    mutator(nextApplicationOptions);
    store.applicationOptions = {
      ...nextApplicationOptions,
      showIgnored: false,
    };
    repo.options = {
      ...store.applicationOptions,
      showIgnored: repo.options.showIgnored === true,
    };
    saveViewSettingsStore(this.context.userDataPath, store);
    return cloneViewOptions(repo.options);
  }

  /**
   * 在平台层内原子更新本地更改配置，并返回持久化后的最新副本。
   */
  private updateCapabilityConfig(mutator: (config: GitCommitPanelLocalChangesConfig) => void): GitCommitPanelLocalChangesConfig {
    const store = loadLocalChangesStore(this.context.userDataPath);
    const repo = ensureRepoLocalChangesConfig(store, this.context.userDataPath, this.context.repoRoot);
    mutator(repo.config);
    saveLocalChangesStore(this.context.userDataPath, store);
    return cloneLocalChangesConfig(repo.config);
  }

  /**
   * 在执行 changelist 写操作前统一校验当前仓库的能力状态。
   */
  private ensureChangeListOperationsAllowed(): void {
    const availability = this.getOperationAvailability();
    if (!availability.operationsAllowed)
      throw new Error(availability.error || "当前仓库已禁用更改列表");
  }

  /**
   * 返回 status snapshot 所需的 changelist/view/localChanges 平台快照。
   */
  getSnapshotState(): ChangeListPlatformSnapshot {
    return {
      repo: this.loadRepoChangeLists(),
      viewOptions: this.loadViewOptions(),
      localChanges: this.loadLocalChangesConfig(),
    };
  }

  /**
   * 把 status 流程识别出的变更路径同步回 changelist 平台映射。
   */
  syncStatusChangedPaths(changedPaths: string[]): boolean {
    return this.getChangeListManager().assignChangedPaths(changedPaths);
  }

  /**
   * 返回当前仓库的本地更改能力配置。
   */
  getCapabilityState(): GitCommitPanelCapabilityState {
    return this.loadLocalChangesConfig();
  }

  /**
   * 返回当前是否启用了 staging area 模式。
   */
  isStagingAreaEnabled(): boolean {
    return this.getCapabilityState().stagingAreaEnabled === true;
  }

  /**
   * 返回当前是否允许 changelist 读写操作。
   */
  areChangeListsEnabled(): boolean {
    const capability = this.getCapabilityState();
    return capability.stagingAreaEnabled !== true && capability.changeListsEnabled !== false;
  }

  /**
   * 返回 changelist 操作可用性快照，供业务层统一判断是否允许执行。
   */
  getOperationAvailability(): ChangeListOperationAvailability {
    const capability = this.getCapabilityState();
    if (capability.stagingAreaEnabled) {
      return {
        ...capability,
        operationsAllowed: false,
        error: "暂存区域模式下不支持更改列表操作",
      };
    }
    if (!capability.changeListsEnabled) {
      return {
        ...capability,
        operationsAllowed: false,
        error: "当前仓库已禁用更改列表",
      };
    }
    return {
      ...capability,
      operationsAllowed: true,
    };
  }

  /**
   * 更新单个视图配置项，并返回最新持久化结果。
   */
  updateViewOption(key: ChangeListViewOptionKey, value: boolean): GitCommitPanelViewOptions {
    const nextValue = value === true;
    if (key === "showIgnored") {
      return this.updateProjectViewOptions((options) => {
        options.showIgnored = nextValue;
      });
    }
    return this.updateApplicationViewOptions((options) => {
      if (key === "groupByDirectory") {
        const currentKeys = Array.isArray(options.groupingKeys) ? [...options.groupingKeys] : [];
        options.groupingKeys = nextValue
          ? Array.from(new Set([...currentKeys, "directory"]))
          : currentKeys.filter((one) => one !== "directory");
        options.groupByDirectory = nextValue;
        return;
      }
      if (key === "detailsPreviewShown") {
        options.detailsPreviewShown = nextValue;
        return;
      }
      if (key === "diffPreviewOnDoubleClickOrEnter") {
        options.diffPreviewOnDoubleClickOrEnter = nextValue;
        return;
      }
      throw new Error("不支持的视图选项");
    });
  }

  /**
   * 更新 grouping key 集，并同步维护兼容字段 `groupByDirectory`。
   */
  updateGroupingKeys(groupingKeysInput: unknown): GitCommitPanelViewOptions {
    const nextKeys = normalizeGroupingKeysInput(groupingKeysInput);
    return this.updateApplicationViewOptions((options) => {
      options.groupingKeys = nextKeys;
      options.groupByDirectory = nextKeys.includes("directory");
    });
  }

  /**
   * 更新本地更改配置项，并保持 staging/changelist 两种模式互斥。
   */
  updateLocalChangesConfig(key: LocalChangesConfigKey, value: boolean): GitCommitPanelLocalChangesConfig {
    const nextValue = value === true;
    return this.updateCapabilityConfig((config) => {
      if (key === "stagingAreaEnabled") {
        config.stagingAreaEnabled = nextValue;
        config.changeListsEnabled = !nextValue;
        return;
      }
      if (key === "changeListsEnabled") {
        config.changeListsEnabled = nextValue;
        config.stagingAreaEnabled = !nextValue;
        return;
      }
      if (key === "commitAllEnabled") {
        config.commitAllEnabled = nextValue;
        return;
      }
      throw new Error("不支持的本地更改配置项");
    });
  }

  /**
   * 创建 changelist，并按显式参数决定是否切换为新的活动列表。
   */
  createChangeList(
    name: string,
    options?: { setActive?: boolean },
  ): { id: string; name: string; activeListId: string; created: true } {
    this.ensureChangeListOperationsAllowed();
    const manager = this.getChangeListManager();
    const created = manager.addChangeList(name);
    const shouldSetActive = options?.setActive === true;
    if (shouldSetActive)
      manager.setDefaultChangeList(created, false);
    return {
      id: created.getId(),
      name: created.getName(),
      activeListId: shouldSetActive ? created.getId() : manager.getDefaultChangeList().getId(),
      created: true,
    };
  }

  /**
   * 重命名指定 changelist，并返回最新名称。
   */
  renameChangeList(id: string, name: string): { id: string; name: string } {
    this.ensureChangeListOperationsAllowed();
    const renamed = this.getChangeListManager().editChangeList(id, name);
    return {
      id: renamed.getId(),
      name: renamed.getName(),
    };
  }

  /**
   * 切换当前活动 changelist，并返回新的活动列表 id。
   */
  setActiveChangeList(id: string): { activeListId: string } {
    this.ensureChangeListOperationsAllowed();
    const active = this.getChangeListManager().setDefaultChangeList(id);
    return {
      activeListId: active.getId(),
    };
  }

  /**
   * 删除 changelist，并返回迁移后的活动列表与目标列表信息。
   */
  deleteChangeList(id: string, targetListIdInput?: string): {
    activeListId: string;
    movedToListId: string;
    removedListId: string;
    recreatedDefault: boolean;
  } {
    this.ensureChangeListOperationsAllowed();
    const result = this.getChangeListManager().removeChangeList(id, targetListIdInput);
    return {
      activeListId: result.activeListId,
      movedToListId: result.movedToListId,
      removedListId: result.removedListId,
      recreatedDefault: result.movedToListId === "default",
    };
  }

  /**
   * 将文件归属移动到目标 changelist，并返回实际移动数量。
   */
  moveFilesToChangeList(paths: string[], targetListIdInput: string): { moved: number; targetListId: string } {
    this.ensureChangeListOperationsAllowed();
    return this.getChangeListManager().moveFilesToChangeList(paths, targetListIdInput);
  }

  /**
   * 更新指定 changelist 的 comment/data 元数据，并返回最新快照供前端立即回填。
   */
  updateChangeListMetadata(
    id: string,
    patch: { comment?: string | null; data?: Record<string, any> | null },
  ): { id: string; name: string; comment: string; data: Record<string, any> | null; readOnly: boolean } {
    this.ensureChangeListOperationsAllowed();
    const updated = this.getChangeListManager().updateChangeListMetadata(id, {
      comment: patch.comment,
      data: patch.data ?? null,
    });
    return {
      id: updated.getId(),
      name: updated.getName(),
      comment: updated.getComment(),
      data: updated.getData() ? JSON.parse(JSON.stringify(updated.getData())) as Record<string, any> : null,
      readOnly: updated.isReadOnly(),
    };
  }
}
