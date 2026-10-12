// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { perfLogger } from "./log";
import { isHistoryDeleteStagingName } from "./historyFastDelete";
import { isNetworkPath } from "./wsl";
import {
  deriveRefreshRootFromSource,
  commitIndexedHistoryFilesRemovedAfterSweep,
  getHistoryReconcileSnapshot,
  listIndexedHistoryFilesForRemovalAfterSweep,
  normalizeHistoryFileAnchor,
  reconcileIndexedHistoryFile,
  resolveAccessibleHistoryFilePath,
  registerHistoryReconcilerRuntimePort,
  shouldIndexHistoryFile,
  type HistoryReconcileResult,
  type ProviderId,
} from "./indexer";

export type HistoryRefreshRequest = {
  providerId?: ProviderId | string;
  filePath?: string;
  sourcePath?: string;
  threadId?: string;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  reason?: string;
};

type HistorySnapshot = ReturnType<typeof getHistoryReconcileSnapshot>;

type HistoryIndexPort = {
  deriveRefreshRootFromSource: typeof deriveRefreshRootFromSource;
  commitSweepRemovals: typeof commitIndexedHistoryFilesRemovedAfterSweep;
  getSnapshot: typeof getHistoryReconcileSnapshot;
  listSweepRemovalCandidates: typeof listIndexedHistoryFilesForRemovalAfterSweep;
  normalizeFileAnchor: typeof normalizeHistoryFileAnchor;
  reconcileFile: typeof reconcileIndexedHistoryFile;
  resolveAccessibleFilePath: typeof resolveAccessibleHistoryFilePath;
  shouldIndexFile: typeof shouldIndexHistoryFile;
};

type DirectoryReader = {
  read(): Promise<fs.Dirent | null>;
  close(): Promise<void>;
};

type FileSystemPort = {
  opendir(directoryPath: string): Promise<DirectoryReader>;
  stat(filePath: string): Promise<fs.Stats>;
};

type ReconcilerTiming = {
  notificationDebounceMs: number;
  fileRetryBaseMs: number;
  localDirectoryEntriesPerSlice: number;
  uncDirectoryEntriesPerSlice: number;
  localDirectorySliceIntervalMs: number;
  uncDirectorySliceIntervalMs: number;
  localDirectoryWallClockMs: number;
  uncDirectoryWallClockMs: number;
  localIoTimeoutMs: number;
  uncIoTimeoutMs: number;
  sweepFileStartIntervalMs: number;
  activePeriodicMs: number;
  idlePeriodicMs: number;
};

type PendingFile = {
  providerId: ProviderId;
  filePath: string;
  retryMissing: boolean;
  attempts: number;
  priority: "notification" | "sweep";
};

type DelayedRequest = {
  request: HistoryRefreshRequest;
  dueAt: number;
};

type DirectorySignature = {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

type PendingDirectory = {
  directoryPath: string;
  depth: number;
};

type DirectoryCursor = PendingDirectory & {
  reader: DirectoryReader;
  before: DirectorySignature;
  observedFiles: Set<string>;
  deferredDirectories: PendingDirectory[];
  sawClaudeProjects: boolean;
  incomplete: boolean;
};

type SweepLane = "local" | "unc";

type RootSweepState = {
  key: string;
  providerId: ProviderId;
  rootPath: string;
  lane: SweepLane;
  pendingDirectories: PendingDirectory[];
  queuedDirectories: Set<string>;
  cursor: DirectoryCursor | null;
  removalReview: SweepRemovalReview | null;
  processing: boolean;
  closeWhenIdle: boolean;
  failureCount: number;
  backoffUntil: number;
};

type SweepRemovalReview = {
  directoryPath: string;
  candidates: string[];
  nextIndex: number;
  missingFiles: string[];
};

type ActiveFileTask = {
  id: number;
  generation: number;
  lane: SweepLane;
  providerId: ProviderId;
  filePath: string;
  rootKey: string;
  promise: Promise<HistoryReconcileResult>;
};

type ReconcilerState = {
  generation: number;
  ready: boolean;
  activeTaskCount: number;
  runningDrain: boolean;
  rerunDrain: boolean;
  pendingRequests: Map<string, HistoryRefreshRequest>;
  delayedRequests: Map<string, DelayedRequest>;
  pendingFiles: Map<string, PendingFile>;
  roots: Map<string, RootSweepState>;
  activeFileTasks: Map<number, ActiveFileTask>;
  unresolvedRootIo: Map<string, Promise<unknown>>;
  nextTaskId: number;
  laneCursor: Record<SweepLane, number>;
  laneRunning: Record<SweepLane, boolean>;
  laneNextAt: Record<SweepLane, number>;
  nextSweepFileStartAt: number;
  drainTimer: NodeJS.Timeout | null;
  delayedTimer: NodeJS.Timeout | null;
  periodicTimer: NodeJS.Timeout | null;
  laneTimers: Record<SweepLane, NodeJS.Timeout | null>;
};

type IoResult<T> =
  | { status: "ok"; value: T }
  | { status: "error"; error: unknown }
  | { status: "timeout" };

const PROVIDERS: readonly ProviderId[] = ["codex", "claude", "gemini", "antigravity", "grok"];
const MAX_PENDING_FILES = 256;
const MAX_FILE_RETRIES = 5;
const MAX_LOCAL_FILE_TASKS = 2;
const MAX_CURRENT_FILE_TASKS = 8;
const MAX_UNSETTLED_UNC_FILE_TASKS = 6;
const MAX_OPEN_LOCAL_DIRECTORIES = 4;
const MAX_OPEN_UNC_DIRECTORIES = 2;
const MAX_CLAUDE_DEPTH = 12;

const DEFAULT_TIMING: ReconcilerTiming = {
  notificationDebounceMs: 120,
  fileRetryBaseMs: 1_000,
  localDirectoryEntriesPerSlice: 64,
  uncDirectoryEntriesPerSlice: 32,
  localDirectorySliceIntervalMs: 50,
  uncDirectorySliceIntervalMs: 250,
  localDirectoryWallClockMs: 40,
  uncDirectoryWallClockMs: 100,
  localIoTimeoutMs: 5_000,
  uncIoTimeoutMs: 3_000,
  sweepFileStartIntervalMs: 5,
  activePeriodicMs: 10_000,
  idlePeriodicMs: 60_000,
};

const defaultIndexPort: HistoryIndexPort = {
  deriveRefreshRootFromSource,
  commitSweepRemovals: commitIndexedHistoryFilesRemovedAfterSweep,
  getSnapshot: getHistoryReconcileSnapshot,
  listSweepRemovalCandidates: listIndexedHistoryFilesForRemovalAfterSweep,
  normalizeFileAnchor: normalizeHistoryFileAnchor,
  reconcileFile: reconcileIndexedHistoryFile,
  resolveAccessibleFilePath: resolveAccessibleHistoryFilePath,
  shouldIndexFile: shouldIndexHistoryFile,
};

const defaultFileSystemPort: FileSystemPort = {
  opendir: async (directoryPath) => await fsp.opendir(directoryPath),
  stat: async (filePath) => await fsp.stat(filePath),
};

let indexPort: HistoryIndexPort = defaultIndexPort;
let fileSystemPort: FileSystemPort = defaultFileSystemPort;
let timing: ReconcilerTiming = { ...DEFAULT_TIMING };

/**
 * 创建一份无运行任务的协调器状态。
 */
function createReconcilerState(): ReconcilerState {
  return {
    generation: 0,
    ready: false,
    activeTaskCount: 0,
    runningDrain: false,
    rerunDrain: false,
    pendingRequests: new Map(),
    delayedRequests: new Map(),
    pendingFiles: new Map(),
    roots: new Map(),
    activeFileTasks: new Map(),
    unresolvedRootIo: new Map(),
    nextTaskId: 1,
    laneCursor: { local: 0, unc: 0 },
    laneRunning: { local: false, unc: false },
    laneNextAt: { local: 0, unc: 0 },
    nextSweepFileStartAt: 0,
    drainTimer: null,
    delayedTimer: null,
    periodicTimer: null,
    laneTimers: { local: null, unc: null },
  };
}

let state = createReconcilerState();

/**
 * 记录低频协调器诊断信息。
 */
function logReconciler(message: string): void {
  try { perfLogger.log(`[history.reconciler] ${message}`); } catch {}
}

/**
 * 将外部 Provider 值收敛为受支持的标识。
 */
function normalizeProviderId(value?: ProviderId | string): ProviderId | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  return PROVIDERS.includes(normalized as ProviderId) ? normalized as ProviderId : undefined;
}

/**
 * 生成大小写不敏感且分隔符稳定的路径键。
 */
function canonicalPathKey(filePath: string): string {
  try { return path.normalize(filePath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); } catch { return String(filePath || "").toLowerCase(); }
}

/**
 * 判断全量请求是否需要优先补扫 Codex 最近日期目录。
 */
function shouldPrioritizeRecentCodexDirectories(request: HistoryRefreshRequest): boolean {
  return request.reason === "indexer-ready" || request.reason === "roots-discovered:codex";
}

/**
 * 生成刷新请求的合并键，避免同一通知被重复处理。
 */
function requestKey(request: HistoryRefreshRequest): string {
  const providerId = normalizeProviderId(request.providerId) || "all";
  const filePath = canonicalPathKey(String(request.filePath || ""));
  const identity = String(request.threadId || request.sessionId || "").trim().toLowerCase();
  const sourcePath = canonicalPathKey(String(request.sourcePath || ""));
  const startedAt = Number.isFinite(Number(request.startedAt)) && Number(request.startedAt) > 0
    ? Number(request.startedAt)
    : 0;
  const prioritizeRecentCodex = shouldPrioritizeRecentCodexDirectories(request) ? 1 : 0;
  return `${providerId}|${filePath}|${identity}|${sourcePath}|${startedAt}|${prioritizeRecentCodex}`;
}

/**
 * 生成 Provider 根目录的稳定键。
 */
function rootKey(providerId: ProviderId, rootPath: string): string {
  return `${providerId}|${canonicalPathKey(rootPath)}`;
}

/**
 * 判断错误是否明确表示目标不存在。
 */
function isMissingError(error: unknown): boolean {
  return String((error as NodeJS.ErrnoException | undefined)?.code || "").toUpperCase() === "ENOENT";
}

/**
 * 从文件路径推导 UNC 文件任务的隔离根键。
 */
function fileTaskRootKey(providerId: ProviderId, filePath: string): string {
  if (!isNetworkPath(filePath)) return `${providerId}|local`;
  const normalized = String(filePath || "").replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  const share = parts.length >= 2 ? `\\\\${parts[0]}\\${parts[1]}` : normalized;
  return `${providerId}|${canonicalPathKey(share)}`;
}

/**
 * 判断目录签名在遍历前后是否保持稳定。
 */
function isSameDirectorySignature(left: DirectorySignature, right: DirectorySignature): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size;
}

/**
 * 将文件元数据缩减为目录稳定性签名。
 */
function toDirectorySignature(stat: fs.Stats): DirectorySignature {
  return {
    mtimeMs: Number(stat.mtimeMs || 0),
    ctimeMs: Number(stat.ctimeMs || 0),
    size: Number(stat.size || 0),
  };
}

/**
 * 清理单个定时器引用。
 */
function clearTimer(timer: NodeJS.Timeout | null): void {
  if (!timer) return;
  try { clearTimeout(timer); } catch {}
}

/**
 * 清理所有会触发新工作的运行时定时器。
 */
function clearRuntimeTimers(): void {
  clearTimer(state.drainTimer);
  clearTimer(state.periodicTimer);
  clearTimer(state.laneTimers.local);
  clearTimer(state.laneTimers.unc);
  state.drainTimer = null;
  state.periodicTimer = null;
  state.laneTimers.local = null;
  state.laneTimers.unc = null;
}

/**
 * 安全关闭目录句柄，不让关闭失败影响后续调度。
 */
async function closeDirectoryReader(reader: DirectoryReader | null): Promise<void> {
  if (!reader) return;
  try { await reader.close(); } catch {}
}

/**
 * 废弃当前所有目录遍历证据，并在未结束 I/O 返回后关闭句柄。
 */
async function discardSweepStates(): Promise<void> {
  const closeTasks: Promise<void>[] = [];
  for (const root of state.roots.values()) {
    root.closeWhenIdle = true;
    if (!state.unresolvedRootIo.has(root.key) && root.cursor?.reader)
      closeTasks.push(closeDirectoryReader(root.cursor.reader));
  }
  state.roots.clear();
  if (closeTasks.length === 0) return;
  await Promise.race([
    Promise.allSettled(closeTasks).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

/**
 * 进入新的协调代次，保留尚未处理的通知和延迟请求。
 */
async function invalidateGeneration(): Promise<number> {
  state.generation++;
  state.ready = false;
  state.rerunDrain = false;
  clearRuntimeTimers();
  await discardSweepStates();
  return state.generation;
}

/**
 * 安排一次待办队列处理。
 */
function scheduleDrain(delayMs = timing.notificationDebounceMs): void {
  if (!state.ready) return;
  if (state.runningDrain) {
    state.rerunDrain = true;
    return;
  }
  if (state.drainTimer) return;
  state.drainTimer = setTimeout(() => {
    state.drainTimer = null;
    void drainRequests();
  }, Math.max(0, delayMs));
}

/**
 * 按当前任务活跃度安排下一次周期校对。
 */
function schedulePeriodicReconcile(): void {
  clearTimer(state.periodicTimer);
  state.periodicTimer = null;
  if (!state.ready) return;
  const delay = state.activeTaskCount > 0 ? timing.activePeriodicMs : timing.idlePeriodicMs;
  state.periodicTimer = setTimeout(() => {
    state.periodicTimer = null;
    requestHistoryReconcileNow("periodic");
    schedulePeriodicReconcile();
  }, delay);
}

/**
 * 将到期的延迟请求移入普通待办队列。
 */
function materializeDueRequests(): void {
  const now = Date.now();
  for (const [key, entry] of state.delayedRequests) {
    if (entry.dueAt > now) continue;
    state.delayedRequests.delete(key);
    state.pendingRequests.set(key, entry.request);
  }
  scheduleDelayedRequestTimer();
}

/**
 * 安排最早一条延迟请求的唤醒定时器。
 */
function scheduleDelayedRequestTimer(): void {
  clearTimer(state.delayedTimer);
  state.delayedTimer = null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of state.delayedRequests.values()) earliest = Math.min(earliest, entry.dueAt);
  if (!Number.isFinite(earliest)) return;
  state.delayedTimer = setTimeout(() => {
    state.delayedTimer = null;
    materializeDueRequests();
    scheduleDrain(0);
  }, Math.max(0, earliest - Date.now()));
}

/**
 * 判断目录项是否是当前 Provider 的解析依赖文件。
 */
function isProviderRelatedFile(providerId: ProviderId, filePath: string): boolean {
  const lower = path.basename(String(filePath || "")).toLowerCase();
  if (providerId === "antigravity") return lower.endsWith(".db") || lower.endsWith(".db-wal") || lower.endsWith(".db-shm");
  if (providerId === "grok") return lower === "summary.json" || lower === "updates.jsonl";
  return indexPort.shouldIndexFile(providerId, filePath);
}

/**
 * 判断目录名是否应从历史扫描中排除。
 */
function shouldSkipDirectory(name: string): boolean {
  const lower = String(name || "").toLowerCase();
  return !lower || lower === ".git" || lower === "node_modules" || isHistoryDeleteStagingName(name);
}

/**
 * 按 Provider 的真实目录结构判断是否继续下钻。
 */
function shouldDescend(providerId: ProviderId, depth: number, name: string): boolean {
  if (shouldSkipDirectory(name)) return false;
  if (providerId === "codex") return depth < 3;
  if (providerId === "claude") return depth < MAX_CLAUDE_DEPTH;
  if (providerId === "gemini") return depth === 0 || (depth === 1 && name.toLowerCase() === "chats");
  if (providerId === "antigravity") return false;
  if (providerId === "grok") return depth < 2;
  return false;
}

/**
 * 将目录加入指定根的待扫描队列，并在同一轮内去重。
 */
function enqueueDirectory(root: RootSweepState, directory: PendingDirectory, prioritize = false): void {
  const key = canonicalPathKey(directory.directoryPath);
  if (!key || root.queuedDirectories.has(key)) return;
  root.queuedDirectories.add(key);
  if (prioritize) root.pendingDirectories.unshift(directory);
  else root.pendingDirectories.push(directory);
}

/**
 * 将定向刷新的目录移动到队首；目录已处理或正在处理时，只补一个后续重扫任务。
 */
function prioritizeDirectoryRefresh(root: RootSweepState, directory: PendingDirectory): void {
  const key = canonicalPathKey(directory.directoryPath);
  if (!key) return;
  const pendingIndex = root.pendingDirectories.findIndex(
    (pending) => canonicalPathKey(pending.directoryPath) === key,
  );
  if (pendingIndex >= 0) {
    const [pending] = root.pendingDirectories.splice(pendingIndex, 1);
    root.pendingDirectories.unshift(pending);
    return;
  }
  root.queuedDirectories.delete(key);
  enqueueDirectory(root, directory, true);
}

/**
 * 创建或取得一个 Provider 根目录的遍历状态。
 */
function ensureRootState(providerId: ProviderId, rootPath: string): RootSweepState | null {
  const normalizedRoot = String(rootPath || "").trim();
  if (!normalizedRoot) return null;
  const key = rootKey(providerId, normalizedRoot);
  const existing = state.roots.get(key);
  if (existing) return existing;
  const root: RootSweepState = {
    key,
    providerId,
    rootPath: normalizedRoot,
    lane: isNetworkPath(normalizedRoot) ? "unc" : "local",
    pendingDirectories: [],
    queuedDirectories: new Set(),
    cursor: null,
    removalReview: null,
    processing: false,
    closeWhenIdle: false,
    failureCount: 0,
    backoffUntil: 0,
  };
  state.roots.set(key, root);
  return root;
}

/**
 * 启动一轮完整根目录扫描；已有扫描进行中时不重复排队。
 */
function enqueueRootSweep(providerId: ProviderId, rootPath: string): void {
  const root = ensureRootState(providerId, rootPath);
  if (!root) return;
  if (root.cursor || root.pendingDirectories.length > 0) return;
  root.queuedDirectories.clear();
  enqueueDirectory(root, { directoryPath: root.rootPath, depth: 0 });
  scheduleSweepLane(root.lane, 0);
}

/**
 * 将 Codex 最近三天目录提到扫描队列前部，缩短无精确路径通知的可见延迟。
 */
function prioritizeRecentCodexDirectories(rootPath: string, anchorTimeMs: number = Date.now()): void {
  const root = ensureRootState("codex", rootPath);
  if (!root) return;
  const safeAnchorTimeMs = Number.isFinite(anchorTimeMs) && anchorTimeMs > 0 ? anchorTimeMs : Date.now();
  for (let offset = 2; offset >= 0; offset--) {
    const date = new Date(safeAnchorTimeMs - offset * 24 * 60 * 60 * 1_000);
    const directoryPath = path.join(
      root.rootPath,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    );
    prioritizeDirectoryRefresh(root, { directoryPath, depth: 3 });
  }
  scheduleSweepLane(root.lane, 0);
}

/**
 * 将单文件任务放入有上限的去重队列。
 */
function enqueueFile(
  providerId: ProviderId,
  filePath: string,
  retryMissing: boolean,
  attempts = 0,
  priority: "notification" | "sweep" = "notification",
): void {
  const anchor = indexPort.normalizeFileAnchor(providerId, filePath);
  const key = `${providerId}|${canonicalPathKey(anchor)}`;
  if (!anchor || !canonicalPathKey(anchor)) return;
  const previous = state.pendingFiles.get(key);
  if (previous) {
    previous.retryMissing ||= retryMissing;
    previous.attempts = Math.min(previous.attempts, attempts);
    if (priority === "notification") previous.priority = "notification";
    return;
  }
  if (state.pendingFiles.size >= MAX_PENDING_FILES) {
    const first = state.pendingFiles.keys().next().value as string | undefined;
    if (first) state.pendingFiles.delete(first);
  }
  state.pendingFiles.set(key, { providerId, filePath: anchor, retryMissing, attempts, priority });
}

/**
 * 从已索引快照中按会话标识查找精确文件。
 */
function findIndexedFileByIdentity(snapshot: HistorySnapshot, providerId: ProviderId, identity: string): string {
  const wanted = String(identity || "").trim().toLowerCase();
  if (!wanted) return "";
  for (const entry of snapshot.files) {
    if (entry.providerId !== providerId) continue;
    const id = String(entry.id || "").trim().toLowerCase();
    const filePath = String(entry.filePath || "");
    const base = path.basename(filePath).toLowerCase();
    const parent = path.basename(path.dirname(filePath)).toLowerCase();
    if (id === wanted || base.includes(wanted) || parent === wanted) return filePath;
  }
  return "";
}

/**
 * 同步指定 Provider 的所有候选根，包含启动时尚不存在的根。
 */
function enqueueProviderRoots(snapshot: HistorySnapshot, providerId: ProviderId, prioritizeRecent: boolean): void {
  for (const rootPath of snapshot.rootsByProvider[providerId] || []) {
    enqueueRootSweep(providerId, rootPath);
    if (providerId === "codex" && prioritizeRecent) prioritizeRecentCodexDirectories(rootPath);
  }
}

/**
 * 将一条外部请求转换为精确文件或受限根扫描任务。
 */
function materializeRequest(request: HistoryRefreshRequest, snapshot: HistorySnapshot): void {
  const providerId = normalizeProviderId(request.providerId);
  if (!providerId) {
    // 启动恢复先补最近会话；普通周期校对保持原有任务量，避免反复读取日期目录。
    const prioritizeRecentCodex = shouldPrioritizeRecentCodexDirectories(request);
    for (const id of PROVIDERS)
      enqueueProviderRoots(snapshot, id, id === "codex" && prioritizeRecentCodex);
    return;
  }

  const accessiblePath = indexPort.resolveAccessibleFilePath(String(request.filePath || ""), request.sourcePath);
  let matchedFile = false;
  if (accessiblePath) {
    enqueueFile(providerId, accessiblePath, true);
    matchedFile = true;
  }

  const identity = String(request.threadId || request.sessionId || "").trim();
  if (!accessiblePath && identity) {
    const indexedPath = findIndexedFileByIdentity(snapshot, providerId, identity);
    if (indexedPath) {
      enqueueFile(providerId, indexedPath, true);
      matchedFile = true;
    }
  }

  const derivedRoot = indexPort.deriveRefreshRootFromSource(providerId, request.sourcePath);
  if (derivedRoot) {
    enqueueRootSweep(providerId, derivedRoot);
    if (providerId === "codex") prioritizeRecentCodexDirectories(derivedRoot);
  }

  const startedAt = Number(request.startedAt);
  if (!matchedFile && providerId === "codex" && Number.isFinite(startedAt) && startedAt > 0) {
    for (const rootPath of snapshot.rootsByProvider.codex || [])
      prioritizeRecentCodexDirectories(rootPath, startedAt);
    return;
  }

  if (!matchedFile)
    enqueueProviderRoots(snapshot, providerId, providerId === "codex");
}

/**
 * 判断一个异步结果是否仍属于当前可写代次。
 */
function isGenerationCurrent(generation: number): boolean {
  return state.ready && state.generation === generation;
}

/**
 * 安排一次单文件重试，并使用指数退避限制持续失败成本。
 */
function scheduleFileRetry(file: PendingFile): void {
  const attempts = file.attempts + 1;
  if (attempts > MAX_FILE_RETRIES) return;
  const delay = Math.min(30_000, timing.fileRetryBaseMs * 2 ** (attempts - 1));
  requestHistoryRefreshAfter({
    providerId: file.providerId,
    filePath: file.filePath,
    reason: `file-retry-${attempts}`,
  }, delay);
}

/**
 * 统计当前代次的本地文件任务数。
 */
function currentLocalFileTaskCount(): number {
  let count = 0;
  for (const task of state.activeFileTasks.values())
    if (task.generation === state.generation && task.lane === "local") count++;
  return count;
}

/**
 * 统计当前代次仍在执行的全部文件任务。
 */
function currentGenerationFileTaskCount(): number {
  let count = 0;
  for (const task of state.activeFileTasks.values())
    if (task.generation === state.generation) count++;
  return count;
}

/**
 * 统计所有代次尚未结束的 UNC 文件任务，限制不可取消 I/O 的累积数量。
 */
function unsettledUncFileTaskCount(): number {
  let count = 0;
  for (const task of state.activeFileTasks.values())
    if (task.lane === "unc") count++;
  return count;
}

/**
 * 判断指定 UNC Provider 是否已有尚未结束的解析任务。
 */
function hasCurrentUncProviderTask(providerId: ProviderId): boolean {
  for (const task of state.activeFileTasks.values()) {
    if (task.generation === state.generation && task.lane === "unc" && task.providerId === providerId) return true;
  }
  return false;
}

/**
 * 判断同一代次是否已有相同文件在解析，防止通知与周期扫描重复工作。
 */
function hasCurrentFileTask(providerId: ProviderId, filePath: string): boolean {
  const key = canonicalPathKey(filePath);
  for (const task of state.activeFileTasks.values()) {
    if (task.generation === state.generation && task.providerId === providerId && canonicalPathKey(task.filePath) === key) return true;
  }
  return false;
}

/**
 * 判断同一 UNC 根是否仍有跨代次未结束的解析任务。
 */
function hasUnsettledFileRoot(root: string): boolean {
  for (const task of state.activeFileTasks.values())
    if (task.rootKey === root) return true;
  return false;
}

/**
 * 启动一个文件校对任务，并在结束后继续排空队列。
 */
function startFileTask(file: PendingFile): void {
  const generation = state.generation;
  const lane: SweepLane = isNetworkPath(file.filePath) ? "unc" : "local";
  const taskRootKey = fileTaskRootKey(file.providerId, file.filePath);
  const id = state.nextTaskId++;
  const promise = indexPort.reconcileFile(file.filePath, file.providerId, () => isGenerationCurrent(generation));
  state.activeFileTasks.set(id, {
    id,
    generation,
    lane,
    providerId: file.providerId,
    filePath: file.filePath,
    rootKey: taskRootKey,
    promise,
  });
  void promise.then((result) => {
    if (generation !== state.generation) return;
    if (result === "retry" || result === "not-ready" || (result === "missing" && file.retryMissing))
      scheduleFileRetry(file);
  }).catch(() => {
    if (generation === state.generation) scheduleFileRetry(file);
  }).finally(() => {
    state.activeFileTasks.delete(id);
    scheduleDrain(0);
  });
}

/**
 * 在本地与 UNC 各自的并发上限内启动待处理文件。
 */
function startEligibleFileTasks(): number {
  if (!state.ready || currentGenerationFileTaskCount() >= MAX_CURRENT_FILE_TASKS) return 0;
  let started = 0;
  let currentAvailable = Math.max(0, MAX_CURRENT_FILE_TASKS - currentGenerationFileTaskCount());
  let localAvailable = Math.max(0, MAX_LOCAL_FILE_TASKS - currentLocalFileTaskCount());
  let uncAvailable = Math.max(0, MAX_UNSETTLED_UNC_FILE_TASKS - unsettledUncFileTaskCount());
  for (const [key, file] of Array.from(state.pendingFiles.entries())) {
    if (currentAvailable <= 0) break;
    if (hasCurrentFileTask(file.providerId, file.filePath)) continue;
    if (file.priority === "sweep" && Date.now() < state.nextSweepFileStartAt) continue;
    const unc = isNetworkPath(file.filePath);
    const taskRootKey = fileTaskRootKey(file.providerId, file.filePath);
    if (unc) {
      if (uncAvailable <= 0) continue;
      if (hasCurrentUncProviderTask(file.providerId) || hasUnsettledFileRoot(taskRootKey)) continue;
      uncAvailable--;
    } else {
      if (localAvailable <= 0) continue;
      localAvailable--;
    }
    state.pendingFiles.delete(key);
    if (file.priority === "sweep") state.nextSweepFileStartAt = Date.now() + timing.sweepFileStartIntervalMs;
    startFileTask(file);
    started++;
    currentAvailable--;
  }
  return started;
}

/**
 * 判断待处理通知中是否存在不受当前并发与 UNC 隔离限制的可启动任务。
 */
function hasRunnableNotificationFile(): boolean {
  if (currentGenerationFileTaskCount() >= MAX_CURRENT_FILE_TASKS) return false;
  let localAvailable = Math.max(0, MAX_LOCAL_FILE_TASKS - currentLocalFileTaskCount());
  let uncAvailable = Math.max(0, MAX_UNSETTLED_UNC_FILE_TASKS - unsettledUncFileTaskCount());
  for (const file of state.pendingFiles.values()) {
    if (file.priority !== "notification" || hasCurrentFileTask(file.providerId, file.filePath)) continue;
    if (!isNetworkPath(file.filePath)) {
      if (localAvailable > 0) return true;
      continue;
    }
    if (uncAvailable <= 0) continue;
    if (hasCurrentUncProviderTask(file.providerId)) continue;
    if (hasUnsettledFileRoot(fileTaskRootKey(file.providerId, file.filePath))) continue;
    uncAvailable--;
    return true;
  }
  return false;
}

/**
 * 为尚未启动的文件安排下一次排队检查，避免限速等待期间空转。
 */
function schedulePendingFileDrain(): void {
  if (!state.ready || state.pendingFiles.size === 0) return;
  let hasNotification = false;
  for (const file of state.pendingFiles.values()) {
    if (file.priority === "notification") {
      hasNotification = true;
      break;
    }
  }
  if (hasNotification) {
    if (currentGenerationFileTaskCount() === 0 && hasRunnableNotificationFile()) scheduleDrain(0);
    return;
  }
  scheduleDrain(Math.max(0, state.nextSweepFileStartAt - Date.now()));
}

/**
 * 处理通知与周期请求，并启动对应文件和目录任务。
 */
async function drainRequests(): Promise<void> {
  if (!state.ready) return;
  if (state.runningDrain) {
    state.rerunDrain = true;
    return;
  }
  state.runningDrain = true;
  const generation = state.generation;
  try {
    materializeDueRequests();
    const snapshot = indexPort.getSnapshot();
    if (!snapshot.ready || !isGenerationCurrent(generation)) return;
    const requests = Array.from(state.pendingRequests.values());
    state.pendingRequests.clear();
    for (const request of requests) materializeRequest(request, snapshot);
    startEligibleFileTasks();
    scheduleSweepLane("local", 0);
    scheduleSweepLane("unc", 0);
  } catch (error) {
    logReconciler(`drain failed error=${String(error)}`);
  } finally {
    state.runningDrain = false;
    const rerun = state.rerunDrain;
    state.rerunDrain = false;
    if (state.ready && (rerun || state.pendingRequests.size > 0)) scheduleDrain(0);
    else schedulePendingFileDrain();
  }
}

/**
 * 计算指定根发生 I/O 失败后的退避截止时间。
 */
function applyRootBackoff(root: RootSweepState, timeout: boolean): void {
  root.failureCount = Math.min(root.failureCount + 1, 6);
  const base = root.lane === "unc" ? (timeout ? 30_000 : 10_000) : 2_000;
  root.backoffUntil = Date.now() + Math.min(5 * 60_000, base * 2 ** (root.failureCount - 1));
}

/**
 * 执行单根单次 I/O；超时后保留未结束标记，禁止同根并发叠加。
 */
async function runRootIo<T>(
  root: RootSweepState,
  operation: () => Promise<T>,
  disposeLate?: (value: T) => Promise<void>,
): Promise<IoResult<T>> {
  if (state.unresolvedRootIo.has(root.key)) return { status: "timeout" };
  let timedOut = false;
  const timeoutMs = root.lane === "unc" ? timing.uncIoTimeoutMs : timing.localIoTimeoutMs;
  const operationPromise = Promise.resolve().then(operation);
  let tracked: Promise<unknown>;
  tracked = operationPromise.then(async (value) => {
    if (timedOut && disposeLate) await disposeLate(value);
    return value;
  }).catch(() => undefined).finally(() => {
    if (state.unresolvedRootIo.get(root.key) === tracked) state.unresolvedRootIo.delete(root.key);
    if (root.closeWhenIdle && root.cursor?.reader) void closeDirectoryReader(root.cursor.reader);
    if (state.ready) scheduleSweepLane(root.lane, Math.max(0, root.backoffUntil - Date.now()));
  });
  state.unresolvedRootIo.set(root.key, tracked);

  let timeoutTimer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<IoResult<T>>((resolve) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      resolve({ status: "timeout" });
    }, timeoutMs);
  });
  const result = await Promise.race<IoResult<T>>([
    operationPromise.then((value) => ({ status: "ok", value }) as IoResult<T>)
      .catch((error) => ({ status: "error", error }) as IoResult<T>),
    timeoutPromise,
  ]);
  clearTimer(timeoutTimer);
  if (!timedOut && state.unresolvedRootIo.get(root.key) === tracked) state.unresolvedRootIo.delete(root.key);
  return result;
}

/**
 * 统计指定调度通道当前保留的目录句柄数。
 */
function openDirectoryCount(lane: SweepLane): number {
  let count = 0;
  for (const root of state.roots.values())
    if (root.lane === lane && root.cursor?.reader) count++;
  return count;
}

/**
 * 判断根目录当前是否具备继续执行一个分片的条件。
 */
function isRootEligible(root: RootSweepState, lane: SweepLane, now: number): boolean {
  if (root.lane !== lane || root.processing || root.closeWhenIdle || root.backoffUntil > now) return false;
  if (state.unresolvedRootIo.has(root.key)) return false;
  return !!root.removalReview || !!root.cursor || root.pendingDirectories.length > 0;
}

/**
 * 以轮转方式选择下一个根，防止单一 Provider 长期占用扫描机会。
 */
function pickRootForLane(lane: SweepLane): RootSweepState | null {
  const now = Date.now();
  const roots = Array.from(state.roots.values()).filter((root) => isRootEligible(root, lane, now));
  if (roots.length === 0) return null;
  const openLimit = lane === "unc" ? MAX_OPEN_UNC_DIRECTORIES : MAX_OPEN_LOCAL_DIRECTORIES;
  const canOpen = openDirectoryCount(lane) < openLimit;
  const eligible = canOpen ? roots : roots.filter((root) => !!root.cursor);
  if (eligible.length === 0) return null;
  const index = state.laneCursor[lane] % eligible.length;
  state.laneCursor[lane] = (index + 1) % eligible.length;
  return eligible[index];
}

/**
 * 安排指定通道的下一个真实限速目录分片。
 */
function scheduleSweepLane(lane: SweepLane, requestedDelayMs: number): void {
  if (!state.ready || state.laneRunning[lane] || state.laneTimers[lane]) return;
  const delay = Math.max(0, requestedDelayMs, state.laneNextAt[lane] - Date.now());
  state.laneTimers[lane] = setTimeout(() => {
    state.laneTimers[lane] = null;
    void runSweepLane(lane);
  }, delay);
}

/**
 * 关闭并丢弃一个未完成的目录游标，禁止其产生删除证据。
 */
async function abandonCursor(root: RootSweepState): Promise<void> {
  const cursor = root.cursor;
  root.cursor = null;
  if (cursor) await closeDirectoryReader(cursor.reader);
}

/**
 * 打开根队列中的下一个目录，并记录遍历前签名。
 */
async function openNextDirectory(root: RootSweepState): Promise<boolean> {
  const next = root.pendingDirectories.shift();
  if (!next) return false;
  const statResult = await runRootIo(root, () => fileSystemPort.stat(next.directoryPath));
  if (statResult.status === "timeout") {
    applyRootBackoff(root, true);
    return false;
  }
  if (statResult.status === "error" || !statResult.value.isDirectory()) {
    if (statResult.status === "error" && !isMissingError(statResult.error)) applyRootBackoff(root, false);
    return false;
  }
  const openResult = await runRootIo(
    root,
    () => fileSystemPort.opendir(next.directoryPath),
    async (reader) => await closeDirectoryReader(reader),
  );
  if (openResult.status === "timeout") {
    applyRootBackoff(root, true);
    return false;
  }
  if (openResult.status === "error") {
    if (!isMissingError(openResult.error)) applyRootBackoff(root, false);
    return false;
  }
  root.failureCount = 0;
  root.backoffUntil = 0;
  root.cursor = {
    ...next,
    reader: openResult.value,
    before: toDirectorySignature(statResult.value),
    observedFiles: new Set(),
    deferredDirectories: [],
    sawClaudeProjects: false,
    incomplete: false,
  };
  return true;
}

/**
 * 处理一个文件目录项，归一组合文件锚点并加入解析队列。
 */
function processFileEntry(root: RootSweepState, cursor: DirectoryCursor, entry: fs.Dirent): void {
  const rawPath = path.join(cursor.directoryPath, entry.name);
  if (!isProviderRelatedFile(root.providerId, rawPath)) return;
  const anchor = indexPort.normalizeFileAnchor(root.providerId, rawPath);
  if (!anchor) return;
  if (indexPort.shouldIndexFile(root.providerId, rawPath)
    && canonicalPathKey(rawPath) === canonicalPathKey(anchor))
    cursor.observedFiles.add(canonicalPathKey(anchor));
  enqueueFile(root.providerId, anchor, false, 0, "sweep");
}

/**
 * 处理一个子目录项，并应用 Claude projects 优先和结构深度约束。
 */
function processDirectoryEntry(root: RootSweepState, cursor: DirectoryCursor, entry: fs.Dirent): void {
  if (!shouldDescend(root.providerId, cursor.depth, entry.name)) return;
  const child = { directoryPath: path.join(cursor.directoryPath, entry.name), depth: cursor.depth + 1 };
  if (root.providerId === "claude" && cursor.depth === 0) {
    if (entry.name.toLowerCase() === "projects") {
      cursor.sawClaudeProjects = true;
      enqueueDirectory(root, child);
    } else {
      cursor.deferredDirectories.push(child);
    }
    return;
  }
  enqueueDirectory(root, child);
}

/**
 * 完成一个到达 EOF 的目录，复核稳定性后才提交删除证据。
 */
async function finishDirectory(root: RootSweepState, generation: number): Promise<void> {
  const cursor = root.cursor;
  root.cursor = null;
  if (!cursor) return;
  await closeDirectoryReader(cursor.reader);
  if (root.providerId === "claude" && cursor.depth === 0 && !cursor.sawClaudeProjects)
    for (const directory of cursor.deferredDirectories) enqueueDirectory(root, directory);
  if (cursor.incomplete || !isGenerationCurrent(generation)) return;
  const afterResult = await runRootIo(root, () => fileSystemPort.stat(cursor.directoryPath));
  if (afterResult.status !== "ok" || !afterResult.value.isDirectory()) {
    if (afterResult.status === "timeout") applyRootBackoff(root, true);
    else if (afterResult.status === "error" && !isMissingError(afterResult.error)) applyRootBackoff(root, false);
    return;
  }
  const after = toDirectorySignature(afterResult.value);
  if (!isSameDirectorySignature(cursor.before, after) || !isGenerationCurrent(generation)) return;
  const candidates = indexPort.listSweepRemovalCandidates(
    root.providerId,
    cursor.directoryPath,
    cursor.observedFiles,
  );
  if (candidates.length > 0) {
    root.removalReview = {
      directoryPath: cursor.directoryPath,
      candidates,
      nextIndex: 0,
      missingFiles: [],
    };
  }
}

/**
 * 在协调器预算内复核目录遍历未观察到的索引文件，只把明确 ENOENT 作为删除证据。
 */
async function processRemovalReviewSlice(
  root: RootSweepState,
  generation: number,
  entryBudget: number,
  wallClockBudget: number,
): Promise<void> {
  const review = root.removalReview;
  if (!review) return;
  const startedAt = Date.now();
  let processed = 0;
  while (
    review.nextIndex < review.candidates.length
    && processed < entryBudget
    && Date.now() - startedAt < wallClockBudget
    && isGenerationCurrent(generation)
  ) {
    const filePath = review.candidates[review.nextIndex];
    const statResult = await runRootIo(root, () => fileSystemPort.stat(filePath));
    if (statResult.status === "timeout") {
      applyRootBackoff(root, true);
      return;
    }
    review.nextIndex++;
    processed++;
    if (statResult.status === "error") {
      if (isMissingError(statResult.error)) review.missingFiles.push(filePath);
      else applyRootBackoff(root, false);
    }
  }
  if (review.nextIndex < review.candidates.length || !isGenerationCurrent(generation)) return;
  root.removalReview = null;
  indexPort.commitSweepRemovals(
    root.providerId,
    review.missingFiles,
    () => isGenerationCurrent(generation),
  );
}

/**
 * 在固定条目预算内推进一个根目录，避免单个超大目录长期占用主进程。
 */
async function processRootSlice(root: RootSweepState, generation: number): Promise<void> {
  root.processing = true;
  const entryBudget = root.lane === "unc"
    ? timing.uncDirectoryEntriesPerSlice
    : timing.localDirectoryEntriesPerSlice;
  const wallClockBudget = root.lane === "unc"
    ? timing.uncDirectoryWallClockMs
    : timing.localDirectoryWallClockMs;
  const startedAt = Date.now();
  let processedEntries = 0;
  try {
    if (root.removalReview) {
      await processRemovalReviewSlice(root, generation, entryBudget, wallClockBudget);
      return;
    }
    if (!root.cursor) {
      const opened = await openNextDirectory(root);
      if (!opened) return;
    }
    while (
      root.cursor
      && processedEntries < entryBudget
      // 预留通知容量，队列忙时暂停读取，避免吞掉尚未索引的历史文件。
      && state.pendingFiles.size < MAX_PENDING_FILES - 64
      && Date.now() - startedAt < wallClockBudget
      && isGenerationCurrent(generation)
    ) {
      const cursor = root.cursor;
      const readResult = await runRootIo(root, () => cursor.reader.read());
      if (readResult.status === "timeout") {
        cursor.incomplete = true;
        applyRootBackoff(root, true);
        return;
      }
      if (readResult.status === "error") {
        cursor.incomplete = true;
        if (!isMissingError(readResult.error)) applyRootBackoff(root, false);
        await abandonCursor(root);
        return;
      }
      const entry = readResult.value;
      if (!entry) {
        await finishDirectory(root, generation);
        break;
      }
      processedEntries++;
      if (entry.isFile()) processFileEntry(root, cursor, entry);
      else if (entry.isDirectory()) processDirectoryEntry(root, cursor, entry);
    }
  } finally {
    root.processing = false;
    if (!root.removalReview && !root.cursor && root.pendingDirectories.length === 0)
      root.queuedDirectories.clear();
    startEligibleFileTasks();
    schedulePendingFileDrain();
  }
}

/**
 * 执行一个本地或 UNC 目录分片，并为下一分片设置实际时间间隔。
 */
async function runSweepLane(lane: SweepLane): Promise<void> {
  if (!state.ready || state.laneRunning[lane]) return;
  const root = pickRootForLane(lane);
  if (!root) return;
  state.laneRunning[lane] = true;
  const generation = state.generation;
  try {
    await processRootSlice(root, generation);
  } catch (error) {
    applyRootBackoff(root, false);
    logReconciler(`sweep failed provider=${root.providerId} lane=${lane} error=${String(error)}`);
  } finally {
    state.laneRunning[lane] = false;
    const interval = lane === "unc" ? timing.uncDirectorySliceIntervalMs : timing.localDirectorySliceIntervalMs;
    state.laneNextAt[lane] = Date.now() + interval;
    if (state.ready && generation === state.generation) scheduleSweepLane(lane, interval);
  }
}

/**
 * 在索引器开始初始化前切换代次，保留初始化期间到达的通知。
 */
export async function beginHistoryReconcilerInitialization(): Promise<number> {
  return await invalidateGeneration();
}

/**
 * 判断初始化代次是否仍为当前代次，不要求协调器已经 ready。
 */
export function isHistoryReconcilerGenerationCurrent(generation: number): boolean {
  return Number.isFinite(generation) && state.generation === generation;
}

/**
 * 仅允许当前初始化代次标记 ready，并立即排空初始化期间的待办。
 */
export function markHistoryReconcilerReady(generation: number): boolean {
  if (!isHistoryReconcilerGenerationCurrent(generation)) return false;
  state.ready = true;
  requestHistoryReconcileNow("indexer-ready");
  schedulePeriodicReconcile();
  return true;
}

/**
 * 暂停协调器并废弃当前扫描证据；待办通知继续保留给下次启动。
 */
export async function pauseHistoryReconciler(): Promise<number> {
  return await invalidateGeneration();
}

/**
 * 完全停止协调器并清空待办，主要供进程退出和测试清理使用。
 */
export async function stopHistoryReconciler(): Promise<void> {
  await invalidateGeneration();
  clearTimer(state.delayedTimer);
  state.delayedTimer = null;
  state.pendingRequests.clear();
  state.delayedRequests.clear();
  state.pendingFiles.clear();
}

/**
 * 入队一条完成通知触发的快速刷新，不在通知调用栈执行文件 I/O。
 */
export function requestHistoryFastRefresh(request: HistoryRefreshRequest): void {
  const normalized = { ...request, providerId: normalizeProviderId(request.providerId) };
  state.pendingRequests.set(requestKey(normalized), normalized);
  scheduleDrain();
}

/**
 * 延迟入队一条刷新请求，用于文件仍在补写时的稳定重试。
 */
export function requestHistoryRefreshAfter(request: HistoryRefreshRequest, delayMs: number): void {
  const normalized = { ...request, providerId: normalizeProviderId(request.providerId) };
  const key = requestKey(normalized);
  const dueAt = Date.now() + Math.max(0, Number(delayMs) || 0);
  const previous = state.delayedRequests.get(key);
  if (!previous || dueAt < previous.dueAt) state.delayedRequests.set(key, { request: normalized, dueAt });
  scheduleDelayedRequestTimer();
}

/**
 * 请求一次覆盖全部 Provider 的受限周期校对。
 */
export function requestHistoryReconcileNow(reason = "manual"): void {
  const request: HistoryRefreshRequest = { reason };
  state.pendingRequests.set(requestKey(request), request);
  scheduleDrain(0);
}

/**
 * 更新活跃任务数，以便在工作期间提高校对频率、空闲时降低成本。
 */
export function setHistoryReconcilerActiveTaskCount(count: number): void {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  if (state.activeTaskCount === normalized) return;
  state.activeTaskCount = normalized;
  schedulePeriodicReconcile();
}

/**
 * 返回是否仍有外部 Codex 校对工作，供关系删除逻辑阻止读取旧快照。
 */
export function hasPendingCodexReconcileWork(): boolean {
  for (const request of state.pendingRequests.values())
    if (normalizeProviderId(request.providerId) === "codex") return true;
  for (const request of state.delayedRequests.values())
    if (normalizeProviderId(request.request.providerId) === "codex") return true;
  for (const file of state.pendingFiles.values())
    if (file.providerId === "codex") return true;
  for (const task of state.activeFileTasks.values())
    if (task.providerId === "codex" && task.generation === state.generation) return true;
  return false;
}

/**
 * 暴露仅供针对性单元测试使用的可控端口与状态快照。
 */
export const __testing = {
  /** 重置协调器测试状态与依赖端口。 */
  async reset(): Promise<void> {
    await stopHistoryReconciler();
    state = createReconcilerState();
    indexPort = defaultIndexPort;
    fileSystemPort = defaultFileSystemPort;
    timing = { ...DEFAULT_TIMING };
  },
  /** 替换测试所需的索引器窄端口。 */
  setIndexPort(port: Partial<HistoryIndexPort>): void {
    indexPort = { ...defaultIndexPort, ...port };
  },
  /** 替换测试所需的文件系统窄端口。 */
  setFileSystemPort(port: Partial<FileSystemPort>): void {
    fileSystemPort = { ...defaultFileSystemPort, ...port };
  },
  /** 覆盖测试所需的调度时间参数。 */
  setTiming(overrides: Partial<ReconcilerTiming>): void {
    timing = { ...timing, ...overrides };
  },
  /** 读取不包含用户数据的协调器状态计数。 */
  snapshot(): {
    generation: number;
    ready: boolean;
    pendingRequests: number;
    delayedRequests: number;
    pendingFiles: number;
    roots: number;
    activeFileTasks: number;
    unresolvedRootIo: number;
  } {
    return {
      generation: state.generation,
      ready: state.ready,
      pendingRequests: state.pendingRequests.size,
      delayedRequests: state.delayedRequests.size,
      pendingFiles: state.pendingFiles.size,
      roots: state.roots.size,
      activeFileTasks: state.activeFileTasks.size,
      unresolvedRootIo: state.unresolvedRootIo.size,
    };
  },
};

registerHistoryReconcilerRuntimePort({
  hasPendingCodexWork: hasPendingCodexReconcileWork,
  requestFastRefresh: (request) => requestHistoryFastRefresh(request),
});
