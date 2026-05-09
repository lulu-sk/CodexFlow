// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Git/VCS 变更列表模型参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import fs from "node:fs";
import path from "node:path";
import { toFsPathKey } from "../pathKey";
import type {
  ChangeListItem,
  ChangeListsStore,
  GitCommitPanelLocalChangesConfig,
  GitCommitPanelViewOptions,
  LocalChangesConfigStore,
  RepoChangeLists,
  RepoLocalChangesConfig,
  RepoViewSettings,
  ViewSettingsStore,
} from "./types";

export const DEFAULT_CHANGE_LIST_ID = "default";
export const DEFAULT_CHANGE_LIST_NAME = "默认";

const DEFAULT_VIEW_OPTIONS: GitCommitPanelViewOptions = {
  groupByDirectory: true,
  groupingKeys: ["directory", "module", "repository"],
  showIgnored: false,
  detailsPreviewShown: true,
  diffPreviewOnDoubleClickOrEnter: true,
  manyFilesThreshold: 1000,
};

const DEFAULT_LOCAL_CHANGES_CONFIG: GitCommitPanelLocalChangesConfig = {
  stagingAreaEnabled: false,
  changeListsEnabled: true,
  commitAllEnabled: true,
};

type LegacyRepoChangeLists = {
  repoRoot?: string;
  viewOptions?: Partial<GitCommitPanelViewOptions>;
  localChanges?: Partial<GitCommitPanelLocalChangesConfig>;
  viewMode?: string;
  activeListId?: string;
  lists?: ChangeListItem[];
  fileToList?: Record<string, string>;
};

type LegacyChangeListsStore = {
  version?: number;
  repos?: Record<string, LegacyRepoChangeLists>;
};

/**
 * 归一化 grouping key 集合；保留唯一顺序，并兼容旧版仅保存 `groupByDirectory` 的结构。
 */
function normalizeGroupingKeys(
  groupingKeys: unknown,
  legacyGroupByDirectory?: boolean,
): Array<"directory" | "module" | "repository"> {
  const out: Array<"directory" | "module" | "repository"> = [];
  const push = (value: unknown): void => {
    if (value !== "directory" && value !== "module" && value !== "repository") return;
    if (!out.includes(value)) out.push(value);
  };
  if (Array.isArray(groupingKeys)) {
    for (const item of groupingKeys) push(item);
    return out;
  }
  if (legacyGroupByDirectory === true) return ["directory"];
  if (legacyGroupByDirectory === false) return [];
  return [...(DEFAULT_VIEW_OPTIONS.groupingKeys || ["directory"])];
}

/**
 * 把视图设置规整为平台认可的工作区级配置，统一收敛缺省值、旧字段与 grouping key。
 */
function normalizeViewOptions(options?: Partial<GitCommitPanelViewOptions> | null): GitCommitPanelViewOptions {
  const groupingKeys = normalizeGroupingKeys(options?.groupingKeys, options?.groupByDirectory);
  return {
    groupByDirectory: groupingKeys.includes("directory"),
    groupingKeys,
    showIgnored: !!options?.showIgnored,
    detailsPreviewShown: options?.detailsPreviewShown !== false,
    diffPreviewOnDoubleClickOrEnter: options?.diffPreviewOnDoubleClickOrEnter !== false,
    manyFilesThreshold: Number.isFinite(Number(options?.manyFilesThreshold))
      ? Math.max(1, Math.floor(Number(options?.manyFilesThreshold)))
      : DEFAULT_VIEW_OPTIONS.manyFilesThreshold,
  };
}

/**
 * 归一化提交面板 capability 配置；`stagingAreaEnabled` 与 `changeListsEnabled`
 * 在当前实现中对齐 source commit-mode 语义，统一收敛为 application scope 的二选一模式。
 */
function normalizeLocalChangesConfig(config: unknown): GitCommitPanelLocalChangesConfig {
  const raw = config && typeof config === "object"
    ? config as Partial<GitCommitPanelLocalChangesConfig>
    : {};
  const stagingAreaEnabled = raw.stagingAreaEnabled === true;
  return {
    stagingAreaEnabled,
    changeListsEnabled: !stagingAreaEnabled,
    commitAllEnabled: raw.commitAllEnabled !== false,
  };
}

/**
 * 读取 JSON 存储文件；若文件不存在或损坏，则返回兜底值。
 */
function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}") as T;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 安全写入 JSON 存储文件，写入失败时静默忽略，避免影响主流程。
 */
function saveJsonFile<T>(filePath: string, data: T): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // 忽略持久化错误，避免阻塞主流程
  }
}

/**
 * 返回 commit panel changelist 存储路径。
 */
function getChangeListsStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "commit-panel", "changelists.json");
}

/**
 * 返回 commit panel 视图设置存储路径。
 */
function getViewSettingsStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "commit-panel", "view-settings.json");
}

/**
 * 返回 commit panel 本地更改能力配置存储路径。
 */
function getLocalChangesStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "commit-panel", "local-changes.json");
}

/**
 * 返回旧版耦合存储路径，用于向新结构做一次性迁移。
 */
function getLegacyChangeListsStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "changelists.json");
}

/**
 * 读取旧版耦合存储，为新结构提供迁移种子。
 */
function loadLegacyStore(userDataPath: string): LegacyChangeListsStore {
  return loadJsonFile<LegacyChangeListsStore>(getLegacyChangeListsStorePath(userDataPath), { version: 1, repos: {} });
}

/**
 * 为指定仓库读取旧版迁移数据；若不存在则返回空对象。
 */
function loadLegacyRepoState(userDataPath: string, repoRoot: string): LegacyRepoChangeLists {
  const repoKey = toFsPathKey(repoRoot);
  if (!repoKey) return {};
  const legacy = loadLegacyStore(userDataPath);
  return legacy.repos?.[repoKey] || {};
}

/**
 * 创建默认 changelist 仓库结构。
 */
function createDefaultRepoChangeLists(repoRoot: string): RepoChangeLists {
  const now = Date.now();
  return {
    repoRoot,
    activeListId: DEFAULT_CHANGE_LIST_ID,
    lists: [{
      id: DEFAULT_CHANGE_LIST_ID,
      name: DEFAULT_CHANGE_LIST_NAME,
      comment: "",
      data: null,
      readOnly: false,
      files: [],
      createdAt: now,
      updatedAt: now,
    }],
    fileToList: {},
  };
}

/**
 * 创建默认视图设置仓库结构。
 */
function createDefaultRepoViewSettings(repoRoot: string): RepoViewSettings {
  return {
    repoRoot,
    options: { ...DEFAULT_VIEW_OPTIONS },
  };
}

/**
 * 创建默认本地更改配置仓库结构。
 */
function createDefaultRepoLocalChanges(repoRoot: string): RepoLocalChangesConfig {
  return {
    repoRoot,
    config: { ...DEFAULT_LOCAL_CHANGES_CONFIG },
  };
}

/**
 * 为提交面板视图设置解析 project scope；若未显式提供 projectPath，则回退到 repoRoot。
 */
function resolveCommitPanelProjectPath(projectPath: string | undefined, repoRoot: string): string {
  return String(projectPath || "").trim() || String(repoRoot || "").trim();
}

/**
 * 读取 changelist 存储。
 */
export function loadChangeListsStore(userDataPath: string): ChangeListsStore {
  const store = loadJsonFile<ChangeListsStore>(getChangeListsStorePath(userDataPath), { version: 1, repos: {} });
  return {
    version: 1,
    repos: store.repos && typeof store.repos === "object" ? store.repos : {},
  };
}

/**
 * 写入 changelist 存储。
 */
export function saveChangeListsStore(userDataPath: string, store: ChangeListsStore): void {
  saveJsonFile(getChangeListsStorePath(userDataPath), store);
}

/**
 * 读取视图设置存储。
 */
export function loadViewSettingsStore(userDataPath: string): ViewSettingsStore {
  const store = loadJsonFile<ViewSettingsStore>(getViewSettingsStorePath(userDataPath), { version: 1, repos: {} });
  return {
    version: 1,
    applicationOptions: store.applicationOptions && typeof store.applicationOptions === "object"
      ? normalizeViewOptions(store.applicationOptions)
      : undefined,
    repos: store.repos && typeof store.repos === "object" ? store.repos : {},
  };
}

/**
 * 写入视图设置存储。
 */
export function saveViewSettingsStore(userDataPath: string, store: ViewSettingsStore): void {
  saveJsonFile(getViewSettingsStorePath(userDataPath), store);
}

/**
 * 读取本地更改配置存储。
 */
export function loadLocalChangesStore(userDataPath: string): LocalChangesConfigStore {
  const store = loadJsonFile<LocalChangesConfigStore>(getLocalChangesStorePath(userDataPath), { version: 1, repos: {} });
  return {
    version: 1,
    applicationConfig: store.applicationConfig && typeof store.applicationConfig === "object"
      ? normalizeLocalChangesConfig(store.applicationConfig)
      : undefined,
    repos: store.repos && typeof store.repos === "object" ? store.repos : {},
  };
}

/**
 * 写入本地更改配置存储。
 */
export function saveLocalChangesStore(userDataPath: string, store: LocalChangesConfigStore): void {
  saveJsonFile(getLocalChangesStorePath(userDataPath), store);
}

/**
 * 确保指定仓库拥有可用的 changelist 状态，并在首次访问时从旧版结构迁移。
 */
export function ensureRepoChangeLists(store: ChangeListsStore, userDataPath: string, repoRoot: string): RepoChangeLists {
  const repoKey = toFsPathKey(repoRoot);
  if (!repoKey) return createDefaultRepoChangeLists(repoRoot);
  let repo = store.repos[repoKey];
  if (!repo || typeof repo !== "object") {
    const legacy = loadLegacyRepoState(userDataPath, repoRoot);
    repo = {
      ...createDefaultRepoChangeLists(repoRoot),
      activeListId: String(legacy.activeListId || "").trim() || DEFAULT_CHANGE_LIST_ID,
      lists: Array.isArray(legacy.lists) && legacy.lists.length > 0
        ? legacy.lists.map((item) => ({
          id: String(item?.id || "").trim(),
          name: String(item?.name || "").trim(),
          comment: String((item as any)?.comment || "").trim() || "",
          data: normalizeChangeListData((item as any)?.data),
          readOnly: (item as any)?.readOnly === true,
          files: Array.isArray(item?.files) ? item.files.map((one) => String(one || "").replace(/\\/g, "/")).filter(Boolean) : [],
          createdAt: Number(item?.createdAt) || Date.now(),
          updatedAt: Number(item?.updatedAt) || Date.now(),
        })).filter((item) => item.id && item.name)
        : createDefaultRepoChangeLists(repoRoot).lists,
      fileToList: legacy.fileToList && typeof legacy.fileToList === "object" ? legacy.fileToList : {},
    };
    store.repos[repoKey] = repo;
  }
  if (!Array.isArray(repo.lists) || repo.lists.length === 0) {
    repo.lists = createDefaultRepoChangeLists(repoRoot).lists;
  }
  repo.lists = repo.lists.map((item) => cloneChangeListItem(item));
  const hasDefault = repo.lists.some((item) => String(item.id || "").trim() === DEFAULT_CHANGE_LIST_ID);
  if (!hasDefault) {
    const now = Date.now();
    repo.lists.unshift({
      id: DEFAULT_CHANGE_LIST_ID,
      name: DEFAULT_CHANGE_LIST_NAME,
      comment: "",
      data: null,
      readOnly: false,
      files: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  repo.fileToList = repo.fileToList && typeof repo.fileToList === "object" ? repo.fileToList : {};
  const listIdSet = new Set(repo.lists.map((item) => String(item.id || "").trim()).filter(Boolean));
  const activeListId = String(repo.activeListId || "").trim();
  repo.activeListId = listIdSet.has(activeListId)
    ? activeListId
    : (listIdSet.has(DEFAULT_CHANGE_LIST_ID) ? DEFAULT_CHANGE_LIST_ID : (repo.lists[0]?.id || DEFAULT_CHANGE_LIST_ID));
  return repo;
}

/**
 * 确保指定项目拥有独立视图设置，并支持从旧版耦合结构迁移。
 * `showIgnored` 走 project scope，其余视图选项继续走 application scope。
 */
export function ensureRepoViewSettings(
  store: ViewSettingsStore,
  userDataPath: string,
  repoRoot: string,
  projectPath?: string,
): RepoViewSettings {
  const projectScopePath = resolveCommitPanelProjectPath(projectPath, repoRoot);
  const repoKey = toFsPathKey(projectScopePath);
  if (!repoKey) return createDefaultRepoViewSettings(projectScopePath);
  let repo = store.repos[repoKey];
  const applicationOptionsSeed = normalizeViewOptions(store.applicationOptions || DEFAULT_VIEW_OPTIONS);
  if (!repo || typeof repo !== "object") {
    const legacy = loadLegacyRepoState(userDataPath, repoRoot);
    const legacyOptions = legacy.viewOptions ? normalizeViewOptions(legacy.viewOptions) : null;
    repo = createDefaultRepoViewSettings(projectScopePath);
    repo.options = {
      ...(legacyOptions || applicationOptionsSeed),
      showIgnored: legacyOptions ? legacyOptions.showIgnored : applicationOptionsSeed.showIgnored,
    };
    store.repos[repoKey] = repo;
  }
  const applicationOptions = normalizeViewOptions(store.applicationOptions || repo.options || DEFAULT_VIEW_OPTIONS);
  store.applicationOptions = {
    ...applicationOptions,
    showIgnored: DEFAULT_VIEW_OPTIONS.showIgnored,
  };
  repo.repoRoot = projectScopePath;
  repo.options = {
    ...store.applicationOptions,
    showIgnored: repo.options?.showIgnored === true,
  };
  return repo;
}

/**
 * 确保指定仓库拥有独立本地更改能力配置，并支持从旧版耦合结构迁移。
 */
export function ensureRepoLocalChangesConfig(
  store: LocalChangesConfigStore,
  userDataPath: string,
  repoRoot: string,
): RepoLocalChangesConfig {
  const repoKey = toFsPathKey(repoRoot);
  if (!repoKey) return createDefaultRepoLocalChanges(repoRoot);
  let repo = store.repos[repoKey];
  if (!repo || typeof repo !== "object") {
    const legacy = loadLegacyRepoState(userDataPath, repoRoot);
    const legacyViewMode = legacy.viewMode === "staging" ? "staging" : "changelist";
    repo = createDefaultRepoLocalChanges(repoRoot);
    repo.config = {
      stagingAreaEnabled: !!legacy.localChanges?.stagingAreaEnabled || legacyViewMode === "staging",
      changeListsEnabled: legacy.localChanges?.changeListsEnabled !== false && legacyViewMode !== "staging",
      commitAllEnabled: legacy.localChanges?.commitAllEnabled !== false,
    };
    store.repos[repoKey] = repo;
  }
  const applicationConfig = normalizeLocalChangesConfig(store.applicationConfig || repo.config);
  store.applicationConfig = applicationConfig;
  repo.config = applicationConfig;
  return repo;
}

/**
 * 按当前变更文件重建每个 changelist 的文件列表。
 */
export function rebuildChangeListFiles(repo: RepoChangeLists, changedPaths: string[]): void {
  const changedSet = new Set(changedPaths);
  const listById = new Map<string, ChangeListItem>();
  for (const item of repo.lists) {
    item.files = [];
    listById.set(item.id, item);
  }
  const fallbackListId = listById.has(repo.activeListId)
    ? repo.activeListId
    : (listById.has(DEFAULT_CHANGE_LIST_ID) ? DEFAULT_CHANGE_LIST_ID : (repo.lists[0]?.id || DEFAULT_CHANGE_LIST_ID));

  for (const relPath of changedSet) {
    const mappedListId = repo.fileToList[relPath];
    const targetListId = listById.has(mappedListId) ? mappedListId : fallbackListId;
    const target = listById.get(targetListId);
    if (!target) continue;
    target.files.push(relPath);
    repo.fileToList[relPath] = targetListId;
  }

  for (const item of repo.lists) {
    item.files.sort((a, b) => a.localeCompare(b));
  }
}

/**
 * 判断 changelist 名称是否已存在，比较时忽略首尾空格并按不区分大小写处理。
 */
export function hasDuplicateChangeListName(repo: RepoChangeLists, name: string, excludeId?: string): boolean {
  const expected = String(name || "").trim().toLocaleLowerCase();
  const ignoredId = String(excludeId || "").trim();
  if (!expected) return false;
  return repo.lists.some((item) => {
    if (ignoredId && item.id === ignoredId) return false;
    return String(item.name || "").trim().toLocaleLowerCase() === expected;
  });
}

export type LocalChangeListSnapshotItem = {
  id: string;
  name: string;
  comment?: string;
  data?: Record<string, any> | null;
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type RepoChangeListSnapshot = {
  repoRoot: string;
  activeListId: string;
  lists: LocalChangeListSnapshotItem[];
  fileToList: Record<string, string>;
};

export type ChangeListManagerContext = {
  userDataPath: string;
  repoRoot: string;
  projectPath?: string;
};

export type ChangeListDataValue = Record<string, any> | null;

type ChangeLike =
  | string
  | {
      path?: string;
      relativePath?: string;
      afterPath?: string;
      beforePath?: string;
      filePath?: string;
      file?: string;
    };

type ChangeListHostListener = {
  onFreeze?(): void;
  onUnfreeze?(): void;
};

type ChangeListHostState = {
  updateDepth: number;
  freezeDepth: number;
  blockedModalNotifications: number;
  freezeReason?: string;
  queue: Promise<void>;
  listeners: Set<ChangeListHostListener>;
  updateWaiters: Array<() => void>;
  readyWaiters: Array<() => void>;
};

const changeListHostStates = new Map<string, ChangeListHostState>();

/**
 * 深拷贝 changelist 附加数据，仅保留可 JSON 序列化的稳定结构。
 */
function normalizeChangeListData(data: unknown): ChangeListDataValue {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(data)) as ChangeListDataValue;
  } catch {
    return null;
  }
}

/**
 * 为内部业务对象补齐 comment/data/readOnly 字段，避免新旧存储结构混用时丢失语义。
 */
function cloneChangeListItem(item: ChangeListItem): ChangeListItem {
  return {
    id: String(item.id || "").trim(),
    name: String(item.name || "").trim(),
    comment: String((item as any).comment || "").trim() || undefined,
    data: normalizeChangeListData((item as any).data),
    readOnly: item.readOnly === true || undefined,
    files: Array.isArray(item.files) ? [...item.files] : [],
    createdAt: Number(item.createdAt) || Date.now(),
    updatedAt: Number(item.updatedAt) || Date.now(),
  };
}

/**
 * 创建一个只用于“禁用 changelist 模式”读取场景的空白默认列表。
 */
function createBlankDefaultChangeList(): ChangeListItem {
  const now = Date.now();
  return {
    id: DEFAULT_CHANGE_LIST_ID,
    name: DEFAULT_CHANGE_LIST_NAME,
    comment: "",
    data: null,
    readOnly: false,
    files: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把变更对象或路径文本提取为仓库相对路径，供受影响列表与未跟踪文件归属统一复用。
 */
function extractChangeLikePath(repoRoot: string, value: ChangeLike | null | undefined): string {
  const raw = typeof value === "string"
    ? value
    : String(
      value?.path
      || value?.relativePath
      || value?.afterPath
      || value?.beforePath
      || value?.filePath
      || value?.file
      || "",
    ).trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const relativePath = path.isAbsolute(normalized)
    ? path.relative(repoRoot, normalized).replace(/\\/g, "/")
    : normalized;
  if (!relativePath || relativePath === "." || relativePath.startsWith("../")) return "";
  return relativePath;
}

/**
 * 为 changelist 平台层解析工作区级 host id；优先按 `userDataPath` 聚合，缺失时退化到仓库路径。
 */
export function resolveChangeListHostId(userDataPath: string, repoRoot?: string): string {
  return String(userDataPath || repoRoot || "").trim() || "__default__";
}

/**
 * 按 host id 读取或创建 changelist 平台共享状态。
 */
function getChangeListHostState(hostId: string): ChangeListHostState {
  const normalizedHostId = String(hostId || "").trim() || "__default__";
  const existing = changeListHostStates.get(normalizedHostId);
  if (existing) return existing;
  const created: ChangeListHostState = {
    updateDepth: 0,
    freezeDepth: 0,
    blockedModalNotifications: 0,
    queue: Promise.resolve(),
    listeners: new Set<ChangeListHostListener>(),
    updateWaiters: [],
    readyWaiters: [],
  };
  changeListHostStates.set(normalizedHostId, created);
  return created;
}

/**
 * 在 update 深度归零时唤醒等待 `waitForUpdate/promiseWaitForUpdate` 的调用方。
 */
function resolveHostUpdateWaitersIfNeeded(state: ChangeListHostState): void {
  if (state.updateDepth > 0) return;
  const waiters = [...state.updateWaiters];
  state.updateWaiters.length = 0;
  for (const resolve of waiters)
    resolve();
}

/**
 * 在宿主完全空闲后唤醒等待 freeze/block 全部结束的观察者。
 */
function resolveHostReadyWaitersIfNeeded(state: ChangeListHostState): void {
  if (state.updateDepth > 0 || state.freezeDepth > 0 || state.blockedModalNotifications > 0) return;
  const waiters = [...state.readyWaiters];
  state.readyWaiters.length = 0;
  for (const resolve of waiters)
    resolve();
}

/**
 * 把一次冻结流程串入 host 级串行队列，确保同一工作区不会并发进入多段 freezing 区间。
 */
export async function acquireChangeListHostQueueSlotAsync(hostId: string): Promise<() => void> {
  const state = getChangeListHostState(hostId);
  const previous = state.queue;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  state.queue = previous
    .catch(() => undefined)
    .then(() => current);
  await previous.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
  };
}

/**
 * 订阅 changelist host 的 freeze/unfreeze 生命周期，供 freezing 流程和测试共用。
 */
export function subscribeChangeListHost(hostId: string, listener: ChangeListHostListener): () => void {
  const state = getChangeListHostState(hostId);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * 等待 host 退出 update/freeze/block 全部平台状态，供外部后台任务显式避让。
 */
export async function waitForChangeListHostReadyAsync(hostId: string): Promise<void> {
  const state = getChangeListHostState(hostId);
  if (state.updateDepth <= 0 && state.freezeDepth <= 0 && state.blockedModalNotifications <= 0) return;
  await new Promise<void>((resolve) => {
    state.readyWaiters.push(resolve);
  });
}

/**
 * 开始一次 changelist 平台更新区间，并在结束时统一回收等待者。
 */
function beginChangeListHostUpdate(hostId: string): () => void {
  const state = getChangeListHostState(hostId);
  state.updateDepth += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state.updateDepth = Math.max(0, state.updateDepth - 1);
    resolveHostUpdateWaitersIfNeeded(state);
    resolveHostReadyWaitersIfNeeded(state);
  };
}

/**
 * 在 changelist host 上执行一次异步更新区间，供测试和异步平台流程复用。
 */
export async function runChangeListHostUpdateAsync<T>(hostId: string, action: () => Promise<T> | T): Promise<T> {
  const finish = beginChangeListHostUpdate(hostId);
  try {
    return await action();
  } finally {
    finish();
  }
}

/**
 * 等待 host 上所有更新任务完成，供 `waitForUpdate` 与 `promiseWaitForUpdate` 统一复用。
 */
function waitForChangeListHostUpdateAsync(hostId: string): Promise<void> {
  const state = getChangeListHostState(hostId);
  if (state.updateDepth <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.updateWaiters.push(resolve);
  });
}

/**
 * 冻结 changelist host，并在首次进入时广播平台层 freeze 事件。
 */
function freezeChangeListHost(hostId: string, reason: string): void {
  const state = getChangeListHostState(hostId);
  state.freezeDepth += 1;
  state.freezeReason = String(reason || "").trim() || state.freezeReason;
  if (state.freezeDepth !== 1) return;
  for (const listener of state.listeners)
    listener.onFreeze?.();
}

/**
 * 解除 changelist host 冻结；最后一层解除时广播 unfreeze 并尝试唤醒等待者。
 */
function unfreezeChangeListHost(hostId: string): void {
  const state = getChangeListHostState(hostId);
  state.freezeDepth = Math.max(0, state.freezeDepth - 1);
  if (state.freezeDepth > 0) return;
  state.freezeReason = undefined;
  for (const listener of state.listeners)
    listener.onUnfreeze?.();
  resolveHostReadyWaitersIfNeeded(state);
}

/**
 * 阻断 changelist host 的模态通知弹出，和 IDEA `blockModalNotifications` 语义保持一致。
 */
function blockChangeListHostModalNotifications(hostId: string): void {
  const state = getChangeListHostState(hostId);
  state.blockedModalNotifications += 1;
}

/**
 * 解除 changelist host 的模态通知阻断；计数归零时若其余状态也已空闲则唤醒等待者。
 */
function unblockChangeListHostModalNotifications(hostId: string): void {
  const state = getChangeListHostState(hostId);
  state.blockedModalNotifications = Math.max(0, state.blockedModalNotifications - 1);
  resolveHostReadyWaitersIfNeeded(state);
}

/**
 * 读取指定 host 的平台状态快照，供测试验证 freeze/update/wait 语义。
 */
function getChangeListHostSnapshot(hostId: string): {
  updateDepth: number;
  freezeDepth: number;
  blockedModalNotifications: number;
  freezeReason?: string;
} {
  const state = getChangeListHostState(hostId);
  return {
    updateDepth: state.updateDepth,
    freezeDepth: state.freezeDepth,
    blockedModalNotifications: state.blockedModalNotifications,
    freezeReason: state.freezeReason,
  };
}

/**
 * 提取系统生成的搁置描述里包裹的原始 changelist 名称。
 */
function extractOriginalChangeListName(description: string): string {
  const normalized = String(description || "").trim();
  const matched = normalized.match(/\s\[(.+)]$/);
  return matched?.[1] ? matched[1].trim() : normalized;
}

/**
 * 将原始 `ChangeListItem` 投影成 `LocalChangeList` 等价对象，隔离持久化结构与业务语义。
 */
export class LocalChangeList {
  private readonly item: ChangeListItem;

  private readonly defaultListId: string;

  /**
   * 初始化 changelist 等价对象。
   */
  constructor(item: ChangeListItem, defaultListId: string = DEFAULT_CHANGE_LIST_ID) {
    this.item = cloneChangeListItem(item);
    this.defaultListId = String(defaultListId || "").trim() || DEFAULT_CHANGE_LIST_ID;
  }

  /**
   * 返回逻辑稳定的 changelist id。
   */
  getId(): string {
    return this.item.id;
  }

  /**
   * 返回 changelist 名称。
   */
  getName(): string {
    return this.item.name;
  }

  /**
   * 返回 changelist 注释。
   */
  getComment(): string {
    return String(this.item.comment || "").trim();
  }

  /**
   * 判断当前是否为默认 changelist；对齐 IDEA，这里的 default 指当前活动列表。
   */
  isDefault(): boolean {
    return this.item.id === this.defaultListId;
  }

  /**
   * 判断当前 changelist 是否只读。
   */
  isReadOnly(): boolean {
    return this.item.readOnly === true;
  }

  /**
   * 返回附加数据。
   */
  getData(): ChangeListDataValue {
    return normalizeChangeListData(this.item.data);
  }

  /**
   * 返回当前 changelist 关联的文件集合副本。
   */
  getFiles(): string[] {
    return [...this.item.files];
  }

  /**
   * 返回当前对象的浅拷贝，避免调用方直接改写内部状态。
   */
  copy(): LocalChangeList {
    return new LocalChangeList(this.item, this.defaultListId);
  }

  /**
   * 返回底层持久化结构副本，供状态保存与快照生成复用。
   */
  toJSON(): ChangeListItem {
    return cloneChangeListItem(this.item);
  }
}

/**
 * 对齐 IDEA `ChangeListManagerEx` 的平台层封装，统一承接 changelist 状态、冻结状态与快照恢复。
 */
export class ChangeListManagerEx {
  private readonly context: ChangeListManagerContext;

  /**
   * 初始化 changelist 平台管理器。
   */
  constructor(context: ChangeListManagerContext) {
    this.context = {
      userDataPath: String(context.userDataPath || "").trim(),
      repoRoot: String(context.repoRoot || "").trim(),
    };
  }

  /**
   * 返回当前 manager 所属工作区 host id，保证多仓共享同一套平台状态。
   */
  private getHostId(): string {
    return resolveChangeListHostId(this.context.userDataPath, this.context.repoRoot);
  }

  /**
   * 读取并确保当前仓库拥有完整的 changelist 状态。
   */
  private loadRepoState(): { store: ChangeListsStore; repo: RepoChangeLists } {
    const store = loadChangeListsStore(this.context.userDataPath);
    const repo = ensureRepoChangeLists(store, this.context.userDataPath, this.context.repoRoot);
    return { store, repo };
  }

  /**
   * 把当前仓库的 changelist 状态写回持久化存储。
   */
  private saveRepoState(store: ChangeListsStore): void {
    saveChangeListsStore(this.context.userDataPath, store);
  }

  /**
   * 在 changelist host 上执行一次同步写操作，并自动维护 update/wait 状态。
   */
  private runWithHostUpdate<T>(action: () => T): T {
    const finish = beginChangeListHostUpdate(this.getHostId());
    try {
      return action();
    } finally {
      finish();
    }
  }

  /**
   * 创建“禁用 changelist 模式”下用于只读访问的空白默认列表。
   */
  private createDisabledModeDefaultList(): LocalChangeList {
    return new LocalChangeList(createBlankDefaultChangeList(), DEFAULT_CHANGE_LIST_ID);
  }

  /**
   * 在执行写操作前校验当前仓库是否允许修改 changelist。
   */
  private ensureChangeListsEnabled(): void {
    if (!this.areChangeListsEnabled())
      throw new Error("当前仓库已禁用更改列表");
  }

  /**
   * 把持久化列表包装成 `LocalChangeList` 等价对象，并按当前活动列表标记 default。
   */
  private wrapChangeLists(lists: ChangeListItem[], activeListId: string): LocalChangeList[] {
    const effectiveDefaultListId = String(activeListId || "").trim() || DEFAULT_CHANGE_LIST_ID;
    return lists.map((item) => new LocalChangeList(item, effectiveDefaultListId));
  }

  /**
   * 返回当前仓库是否启用了 changelist 能力。
   */
  areChangeListsEnabled(): boolean {
    const store = loadLocalChangesStore(this.context.userDataPath);
    const repo = ensureRepoLocalChangesConfig(store, this.context.userDataPath, this.context.repoRoot);
    saveLocalChangesStore(this.context.userDataPath, store);
    return repo.config.stagingAreaEnabled !== true && repo.config.changeListsEnabled !== false;
  }

  /**
   * 返回当前平台层是否处于 update 区间，供 freeze/wait 语义观察。
   */
  isInUpdate(): boolean {
    return getChangeListHostState(this.getHostId()).updateDepth > 0;
  }

  /**
   * 返回当前仓库的全部本地 changelist。
   */
  getChangeLists(): LocalChangeList[] {
    if (!this.areChangeListsEnabled())
      return [this.createDisabledModeDefaultList()];
    const { repo } = this.loadRepoState();
    return this.wrapChangeLists(repo.lists, repo.activeListId);
  }

  /**
   * 根据给定变更集合返回其受影响的 changelist 列表。
   */
  getAffectedLists(changes: ChangeLike[]): LocalChangeList[] {
    const normalizedPaths = Array.from(new Set(
      (Array.isArray(changes) ? changes : [])
        .map((item) => extractChangeLikePath(this.context.repoRoot, item))
        .filter(Boolean),
    ));
    if (normalizedPaths.length <= 0) return [];
    if (!this.areChangeListsEnabled())
      return [this.createDisabledModeDefaultList()];
    const { repo } = this.loadRepoState();
    const defaultListId = String(repo.activeListId || DEFAULT_CHANGE_LIST_ID).trim() || DEFAULT_CHANGE_LIST_ID;
    const listMap = new Map(repo.lists.map((item) => [String(item.id || "").trim(), item] as const));
    const affectedIds = new Set<string>();
    for (const relativePath of normalizedPaths) {
      const listId = String(repo.fileToList[relativePath] || defaultListId).trim() || defaultListId;
      affectedIds.add(listMap.has(listId) ? listId : defaultListId);
    }
    return this.wrapChangeLists(
      repo.lists.filter((item) => affectedIds.has(String(item.id || "").trim())),
      repo.activeListId,
    );
  }

  /**
   * 按 id 读取指定 changelist；缺失时返回 null。
   */
  getChangeList(id?: string | null): LocalChangeList | null {
    const targetId = String(id || "").trim();
    if (!targetId) return null;
    if (!this.areChangeListsEnabled())
      return targetId === DEFAULT_CHANGE_LIST_ID ? this.createDisabledModeDefaultList() : null;
    const { repo } = this.loadRepoState();
    const matched = repo.lists.find((item) => item.id === targetId);
    return matched ? new LocalChangeList(matched, repo.activeListId) : null;
  }

  /**
   * 按名称查找 changelist，比较时忽略首尾空格并按不区分大小写处理。
   */
  findChangeList(name: string): LocalChangeList | null {
    const expected = String(name || "").trim().toLocaleLowerCase();
    if (!expected) return null;
    if (!this.areChangeListsEnabled()) {
      const blank = this.createDisabledModeDefaultList();
      return blank.getName().toLocaleLowerCase() === expected ? blank : null;
    }
    const { repo } = this.loadRepoState();
    const matched = repo.lists.find((item) => String(item.name || "").trim().toLocaleLowerCase() === expected);
    return matched ? new LocalChangeList(matched, repo.activeListId) : null;
  }

  /**
   * 返回当前默认 changelist；若持久化状态损坏则回退到预设默认列表。
   */
  getDefaultChangeList(): LocalChangeList {
    if (!this.areChangeListsEnabled())
      return this.createDisabledModeDefaultList();
    const { repo } = this.loadRepoState();
    const matched = repo.lists.find((item) => item.id === repo.activeListId) || repo.lists[0];
    return new LocalChangeList(matched || {
      id: DEFAULT_CHANGE_LIST_ID,
      name: DEFAULT_CHANGE_LIST_NAME,
      comment: "",
      data: null,
      readOnly: false,
      files: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, repo.activeListId);
  }

  /**
   * 创建新的 changelist，支持同时写入 comment 与附加 data。
   */
  addChangeList(name: string, comment?: string | null, data?: ChangeListDataValue): LocalChangeList {
    const title = String(name || "").trim();
    if (!title) throw new Error("变更列表名称不能为空");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      if (hasDuplicateChangeListName(repo, title))
        throw new Error(`已存在同名更改列表：${title}`);
      const now = Date.now();
      const id = `cl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const created: ChangeListItem = {
        id,
        name: title,
        comment: String(comment || "").trim() || "",
        data: normalizeChangeListData(data),
        readOnly: false,
        files: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.lists.push(created);
      this.saveRepoState(store);
      return new LocalChangeList(created, repo.activeListId);
    });
  }

  /**
   * 重命名指定 changelist，并保留其稳定 id。
   */
  editChangeList(id: string, name: string): LocalChangeList {
    const targetId = String(id || "").trim();
    const title = String(name || "").trim();
    if (!targetId) throw new Error("缺少变更列表 ID");
    if (!title) throw new Error("变更列表名称不能为空");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const matched = repo.lists.find((item) => item.id === targetId);
      if (!matched) throw new Error("未找到目标变更列表");
      if (matched.readOnly === true) throw new Error("目标更改列表为只读");
      if (hasDuplicateChangeListName(repo, title, targetId))
        throw new Error(`已存在同名更改列表：${title}`);
      matched.name = title;
      matched.updatedAt = Date.now();
      this.saveRepoState(store);
      return new LocalChangeList(matched, repo.activeListId);
    });
  }

  /**
   * 按 changelist 名称更新附加数据，对齐 IDEA `editChangeListData` 的平台接口。
   */
  editChangeListData(name: string, newData: ChangeListDataValue): boolean {
    const targetName = String(name || "").trim();
    if (!targetName) return false;
    if (!this.areChangeListsEnabled()) return false;
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const matched = repo.lists.find((item) => String(item.name || "").trim() === targetName);
      if (!matched || matched.readOnly === true) return false;
      matched.data = normalizeChangeListData(newData);
      matched.updatedAt = Date.now();
      this.saveRepoState(store);
      return true;
    });
  }

  /**
   * 按 changelist id 同步更新 comment 与附加 data，供提交面板保存按列表草稿与作者元数据复用。
   */
  updateChangeListMetadata(
    id: string,
    patch: { comment?: string | null; data?: ChangeListDataValue },
  ): LocalChangeList {
    const targetId = String(id || "").trim();
    if (!targetId) throw new Error("缺少变更列表 ID");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const matched = repo.lists.find((item) => item.id === targetId);
      if (!matched) throw new Error("未找到目标变更列表");
      if (matched.readOnly === true) throw new Error("目标更改列表为只读");
      if (Object.prototype.hasOwnProperty.call(patch || {}, "comment"))
        matched.comment = String(patch?.comment || "").trim();
      if (Object.prototype.hasOwnProperty.call(patch || {}, "data"))
        matched.data = normalizeChangeListData(patch?.data);
      matched.updatedAt = Date.now();
      this.saveRepoState(store);
      return new LocalChangeList(matched, repo.activeListId);
    });
  }

  /**
   * 设置默认 changelist；当前 `automatic` 仅保留参数语义，不额外触发删除策略。
   */
  setDefaultChangeList(target: string | LocalChangeList, _automatic: boolean = false): LocalChangeList {
    const targetId = typeof target === "string"
      ? String(target || "").trim()
      : String(target?.getId() || "").trim();
    if (!targetId) throw new Error("缺少目标变更列表 ID");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const matched = repo.lists.find((item) => item.id === targetId);
      if (!matched) throw new Error("目标变更列表不存在");
      repo.activeListId = targetId;
      this.saveRepoState(store);
      return new LocalChangeList(matched, repo.activeListId);
    });
  }

  /**
   * 把未跟踪文件纳入指定 changelist；实际 add-to-vcs 由调用方完成，这里只维护归属映射。
   */
  addUnversionedFiles(list: LocalChangeList | null, unversionedFiles: ChangeLike[]): void {
    if (!this.areChangeListsEnabled()) return;
    const targetListId = String(list?.getId() || this.getDefaultChangeList().getId() || "").trim();
    if (!targetListId) return;
    const paths = Array.from(new Set(
      (Array.isArray(unversionedFiles) ? unversionedFiles : [])
        .map((item) => extractChangeLikePath(this.context.repoRoot, item))
        .filter(Boolean),
    ));
    if (paths.length <= 0) return;
    this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const targetList = repo.lists.find((item) => item.id === targetListId);
      if (!targetList) return;
      for (const relativePath of paths)
        repo.fileToList[relativePath] = targetList.id;
      this.saveRepoState(store);
    });
  }

  /**
   * 阻断当前 host 的模态通知，供冻结流程等敏感区间暂时抑制弹窗。
   */
  blockModalNotifications(): void {
    blockChangeListHostModalNotifications(this.getHostId());
  }

  /**
   * 解除当前 host 的模态通知阻断。
   */
  unblockModalNotifications(): void {
    unblockChangeListHostModalNotifications(this.getHostId());
  }

  /**
   * 冻结当前 host 的 changelist 平台状态，对齐 IDEA `freeze` 语义。
   */
  freeze(reason: string): void {
    freezeChangeListHost(this.getHostId(), reason);
  }

  /**
   * 解除当前 host 的 changelist 冻结状态。
   */
  unfreeze(): void {
    unfreezeChangeListHost(this.getHostId());
  }

  /**
   * 等待当前 host 上的 changelist 更新任务完成。
   */
  async waitForUpdate(): Promise<void> {
    await waitForChangeListHostUpdateAsync(this.getHostId());
  }

  /**
   * 返回一个会在当前 host 更新完成后 resolve 的 Promise。
   */
  promiseWaitForUpdate(): Promise<void> {
    return waitForChangeListHostUpdateAsync(this.getHostId());
  }

  /**
   * 删除指定 changelist，并把文件映射迁移到目标列表。
   */
  removeChangeList(id: string, targetListIdInput?: string): {
    removedListId: string;
    movedToListId: string;
    activeListId: string;
  } {
    const listId = String(id || "").trim();
    const targetListId = String(targetListIdInput || "").trim();
    if (!listId) throw new Error("缺少变更列表 ID");
    if (targetListId && targetListId === listId) throw new Error("目标更改列表不能与待删除列表相同");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const current = repo.lists.find((item) => item.id === listId);
      if (!current) throw new Error("未找到目标变更列表");
      if (current.readOnly === true) throw new Error("目标更改列表为只读");

      const remainingLists = repo.lists.filter((item) => item.id !== listId);
      if (remainingLists.length <= 0) {
        repo.lists = [createBlankDefaultChangeList()];
        repo.activeListId = DEFAULT_CHANGE_LIST_ID;
        for (const filePath of Object.keys(repo.fileToList))
          repo.fileToList[filePath] = DEFAULT_CHANGE_LIST_ID;
        this.saveRepoState(store);
        return {
          removedListId: listId,
          movedToListId: DEFAULT_CHANGE_LIST_ID,
          activeListId: DEFAULT_CHANGE_LIST_ID,
        };
      }

      const targetList = targetListId
        ? remainingLists.find((item) => item.id === targetListId)
        : remainingLists[0];
      if (!targetList) throw new Error("目标更改列表不存在");
      for (const [filePath, mappedListId] of Object.entries(repo.fileToList)) {
        if (mappedListId === listId)
          repo.fileToList[filePath] = targetList.id;
      }
      repo.lists = remainingLists;
      if (repo.activeListId === listId)
        repo.activeListId = targetList.id;
      this.saveRepoState(store);
      return {
        removedListId: listId,
        movedToListId: targetList.id,
        activeListId: repo.activeListId,
      };
    });
  }

  /**
   * 将一批文件移动到指定 changelist。
   */
  moveFilesToChangeList(pathsInput: string[], targetListIdInput: string): {
    moved: number;
    targetListId: string;
  } {
    const targetListId = String(targetListIdInput || "").trim();
    if (!targetListId) throw new Error("缺少目标变更列表");
    this.ensureChangeListsEnabled();
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const targetList = repo.lists.find((item) => item.id === targetListId);
      if (!targetList) throw new Error("目标变更列表不存在");
      const paths = Array.from(new Set(
        (Array.isArray(pathsInput) ? pathsInput : [])
          .map((item) => String(item || "").trim().replace(/\\/g, "/"))
          .filter(Boolean),
      ));
      for (const filePath of paths)
        repo.fileToList[filePath] = targetListId;
      this.saveRepoState(store);
      return {
        moved: paths.length,
        targetListId,
      };
    });
  }

  /**
   * 把未知映射的新变更文件归入当前默认 changelist，并重建文件列表。
   */
  assignChangedPaths(changedPaths: string[]): boolean {
    const normalizedPaths = Array.from(new Set(
      (Array.isArray(changedPaths) ? changedPaths : [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    return this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const existingIds = new Set(repo.lists.map((item) => item.id));
      let changed = false;
      for (const filePath of normalizedPaths) {
        const mappedListId = String(repo.fileToList[filePath] || "").trim();
        if (mappedListId && existingIds.has(mappedListId)) continue;
        repo.fileToList[filePath] = repo.activeListId || DEFAULT_CHANGE_LIST_ID;
        changed = true;
      }
      rebuildChangeListFiles(repo, normalizedPaths);
      this.saveRepoState(store);
      return changed;
    });
  }

  /**
   * 根据指定路径集合生成 changelist 快照，供 system shelf 保存与后续 unshelve 恢复复用。
   */
  createSnapshot(savedPaths: string[]): RepoChangeListSnapshot | undefined {
    const normalizedPaths = Array.from(new Set(
      (Array.isArray(savedPaths) ? savedPaths : [])
        .map((item) => String(item || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ));
    if (normalizedPaths.length <= 0) return undefined;
    const { repo } = this.loadRepoState();
    const listIds = new Set<string>();
    const fileToList: Record<string, string> = {};
    const fallbackListId = String(repo.activeListId || DEFAULT_CHANGE_LIST_ID).trim() || DEFAULT_CHANGE_LIST_ID;
    for (const relativePath of normalizedPaths) {
      const mappedListId = String(repo.fileToList[relativePath] || fallbackListId).trim() || fallbackListId;
      fileToList[relativePath] = mappedListId;
      listIds.add(mappedListId);
    }
    listIds.add(fallbackListId);
    return {
      repoRoot: this.context.repoRoot,
      activeListId: fallbackListId,
      lists: repo.lists
        .filter((item) => listIds.has(String(item.id || "").trim()))
        .map((item) => ({
          id: item.id,
          name: item.name,
          comment: String(item.comment || "").trim() || undefined,
          data: normalizeChangeListData(item.data),
          readOnly: item.readOnly === true || undefined,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      fileToList,
    };
  }

  /**
   * 把外部快照回写到当前仓库的 changelist 状态，用于 unshelve 后恢复文件归属与默认列表。
   */
  restoreSnapshot(snapshot: RepoChangeListSnapshot | null | undefined): void {
    if (!snapshot) return;
    this.runWithHostUpdate(() => {
      const { store, repo } = this.loadRepoState();
      const existingById = new Map(repo.lists.map((item) => [String(item.id || "").trim(), item] as const));
      for (const item of snapshot.lists || []) {
        const listId = String(item.id || "").trim();
        if (!listId) continue;
        const existing = existingById.get(listId);
        if (existing) {
          existing.name = String(item.name || "").trim() || existing.name;
          existing.comment = String(item.comment || "").trim() || "";
          existing.data = normalizeChangeListData(item.data);
          existing.readOnly = item.readOnly === true;
          existing.updatedAt = Number(item.updatedAt) || existing.updatedAt;
          continue;
        }
        const created: ChangeListItem = {
          id: listId,
          name: String(item.name || "").trim() || listId,
          comment: String(item.comment || "").trim() || "",
          data: normalizeChangeListData(item.data),
          readOnly: item.readOnly === true,
          files: [],
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
        };
        repo.lists.push(created);
        existingById.set(listId, created);
      }
      const activeListId = String(snapshot.activeListId || "").trim();
      if (activeListId && existingById.has(activeListId))
        repo.activeListId = activeListId;
      for (const [relativePath, rawListId] of Object.entries(snapshot.fileToList || {})) {
        const normalizedPath = String(relativePath || "").trim().replace(/\\/g, "/");
        const listId = String(rawListId || "").trim();
        if (!normalizedPath || !listId || !existingById.has(listId)) continue;
        repo.fileToList[normalizedPath] = listId;
      }
      this.saveRepoState(store);
    });
  }
}

/**
 * 创建 system shelf 描述时复用 IDEA 的命名规则，保留原始 changelist 名称后缀。
 */
export function createSystemShelvedChangeListName(systemPrefix: string, changelistName: string): string {
  const prefix = String(systemPrefix || "").trim();
  const listName = String(changelistName || "").trim();
  if (!listName) return prefix;
  return `${prefix} [${listName}]`;
}

/**
 * 从 system shelf 描述中推导 unshelve 后默认应恢复到的 changelist 名称。
 */
export function getChangeListNameForUnshelve(description: string, markedToDelete: boolean = false): string {
  const normalized = String(description || "").trim();
  if (!normalized) return DEFAULT_CHANGE_LIST_NAME;
  return markedToDelete ? extractOriginalChangeListName(normalized) : normalized;
}

/**
 * 导出 changelist 平台层测试辅助对象，便于验证 host 级 freeze/update/wait 状态。
 */
export const __testing = {
  /**
   * 读取指定上下文对应的 host id。
   */
  getHostId(userDataPath: string, repoRoot?: string): string {
    return resolveChangeListHostId(userDataPath, repoRoot);
  },

  /**
   * 读取指定 host 的平台状态快照。
   */
  getHostState(hostId: string): ReturnType<typeof getChangeListHostSnapshot> {
    return getChangeListHostSnapshot(hostId);
  },

  /**
   * 在指定 host 上人工制造一个异步 update 区间，供单测验证 wait 语义。
   */
  async runHostUpdateAsync<T>(hostId: string, action: () => Promise<T> | T): Promise<T> {
    return await runChangeListHostUpdateAsync(hostId, action);
  },

  /**
   * 等待指定 host 完全退出 update/freeze/block 平台状态。
   */
  async waitForHostReadyAsync(hostId: string): Promise<void> {
    await waitForChangeListHostReadyAsync(hostId);
  },

  /**
   * 重置全部 host 平台状态，供测试隔离环境。
   */
  resetAllHosts(): void {
    changeListHostStates.clear();
  },
};
