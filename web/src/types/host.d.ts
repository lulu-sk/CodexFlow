// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TerminalThemeId } from "./terminal-theme";

export {}; // make this a module

// 与主进程约定的类型（仅做声明，不引入运行时依赖）
export type ThemeSetting = 'light' | 'dark' | 'system';

export type ProviderId = string;

export type TerminalMode = 'wsl' | 'windows' | 'pwsh' | 'cmd';

export type ProviderItem = {
  id: ProviderId;
  displayName?: string;
  iconDataUrl?: string;
  iconDataUrlDark?: string;
  startupCmd?: string;
};

export type ProviderEnv = {
  terminal?: TerminalMode;
  distro?: string;
};

export type BuiltinIdeId = "vscode" | "cursor" | "windsurf" | "rider";

export type ProjectIdePreference = {
  /** 项目绑定模式：builtin=内置 IDE；custom=自定义命令模板。 */
  mode?: "builtin" | "custom";
  /** 内置 IDE 标识（mode=builtin 时生效）。 */
  builtinId?: BuiltinIdeId;
  /** 自定义 IDE 展示名（可选）。 */
  customName?: string;
  /** 自定义 IDE 命令模板（mode=custom 时生效）。 */
  customCommand?: string;
};

export type IdeOpenSettings = {
  /** 默认 IDE 模式：auto=自动探测；builtin=固定内置 IDE；custom=自定义命令模板。 */
  mode?: "auto" | "builtin" | "custom";
  /** 内置 IDE 标识（mode=builtin 时生效）。 */
  builtinId?: BuiltinIdeId;
  /** 自定义 IDE 展示名（可选）。 */
  customName?: string;
  /** 自定义 IDE 命令模板（mode=custom 时生效）。 */
  customCommand?: string;
};

export type ClaudeCodeSettings = {
  readAgentHistory?: boolean;
};

export type CodexErrorHandlingSettings = {
  /** 是否识别 Codex TUI/CLI 输出中的错误文本。 */
  detectionEnabled?: boolean;
  /** 是否在 Codex 仍处于 Reconnecting 阶段时也发送通知。 */
  notifyReconnectErrors?: boolean;
  /** 是否在可恢复错误后自动发送 continue。 */
  autoContinueEnabled?: boolean;
  /** 自动 continue 适用的可恢复错误类型。 */
  autoContinueErrorKinds?: Array<"rateLimited" | "concurrency" | "networkStream" | "badGateway" | "serviceUnavailable" | "highDemand" | "modelCapacity" | "forbidden" | "badRequest" | "payloadTooLarge">;
  /** 自动 continue 错误类型列表版本，用于一次性默认项迁移。 */
  autoContinueErrorKindsVersion?: number;
  /** 自动发送 continue 前等待的秒数。 */
  autoContinueDelaySeconds?: number;
  /** 单个错误连续自动 continue 的最大次数。 */
  autoContinueMaxAttempts?: number;
};

export type OnboardingSettings = {
  /** 是否已经处理过启动时 YOLO 权限模式推荐提示。 */
  yoloPromptHandled?: boolean;
};

export type ProvidersSettings = {
  activeId: ProviderId;
  items: ProviderItem[];
  env: Record<ProviderId, ProviderEnv>;
};

export type AppSettings = {
  terminal?: TerminalMode;
  terminalTheme?: TerminalThemeId;
  distro: string;
  codexCmd: string;
  providers?: ProvidersSettings;
  claudeCode?: ClaudeCodeSettings;
  historyRoot: string;
  sendMode?: 'write_only' | 'write_and_enter';
  locale?: string;
  projectPathStyle?: 'absolute' | 'relative';
  theme?: ThemeSetting;
  /** 任务完成提醒偏好 */
  notifications?: {
    badge?: boolean;
    system?: boolean;
    sound?: boolean;
    subagent?: boolean;
  };
  /** 网络代理设置 */
  network?: {
    proxyEnabled?: boolean;
    proxyMode?: 'system' | 'custom';
    proxyUrl?: string;
    noProxy?: string;
  };
  /** 拖拽/粘贴等输入相关偏好 */
  dragDrop?: {
    /** 拖拽添加的资源不在当前项目目录时提醒（默认开启） */
    warnOutsideProject?: boolean;
  };
  /** 一次性引导提示状态。 */
  onboarding?: OnboardingSettings;
  /** ChatGPT/Codex 账号相关设置（记录账号、切换备份等） */
  codexAccount?: {
    recordEnabled?: boolean;
    lastSeenSignatureByRuntime?: Record<string, string>;
  };
  /** Codex TUI/CLI 错误识别与自动 continue 设置 */
  codexErrorHandling?: CodexErrorHandlingSettings;
  /** 终端字体栈 */
  terminalFontFamily?: string;
  /** 实验性功能开关（全局共享，不随 profile 隔离） */
  experimental?: {
    /** 是否启用多实例（Profile）（实验性） */
    multiInstanceEnabled?: boolean;
  };
  /** git worktree 相关设置（仅影响 worktree/Build-Run 等，不影响 Provider/PTY 既有策略） */
  gitWorktree?: {
    /** Git 可执行文件路径；为空表示自动使用 PATH 中的 git */
    gitPath?: string;
    /** 默认外部 Git 工具 */
    externalGitTool?: {
      id?: "rider" | "sourcetree" | "fork" | "gitkraken" | "custom";
      /** 自定义命令（仅当 id=custom 时使用；支持占位符 {path}） */
      customCommand?: string;
    };
    /** “在此目录打开终端/Git Bash”的自定义命令（支持占位符 {path}） */
    terminalCommand?: string;
    /** worktree 自动提交开关（仅对 worktree 生效） */
    autoCommitEnabled?: boolean;
    /** 创建 worktree 时自动拷贝 AI 规则文件 */
    copyRulesOnCreate?: boolean;
  };
  /** 默认 IDE 打开策略（用于“文件定位跳转”链路）。 */
  ideOpen?: IdeOpenSettings;
};

export type Project = {
  id: string;
  name: string;
  winPath: string;
  wslPath: string;
  hasDotCodex: boolean;
  /** worktree 创建/重置后的项目级保留项与命令设置。 */
  worktreePostSetup?: WorktreePostSetupConfig;
  /** 是否已确认存在内置三引擎（codex/claude/gemini）的会话记录。 */
  hasBuiltInSessions?: boolean;
  /** 自定义引擎无法从会话文件反推 cwd 时，用于“保留该目录”的显式记录。 */
  dirRecord?: { kind: "custom_provider"; providerId: string; recordedAt: number };
  createdAt: number;
  lastOpenedAt?: number;
};

export type WorktreePostSetupItem = {
  /** 源项目内的相对路径，使用 / 分隔。 */
  relativePath: string;
  /** 展示名称，通常等于 relativePath。 */
  label?: string;
};

export type WorktreePostSetupConfig = {
  /** 创建 worktree 后复制的项目内保留项。 */
  items?: WorktreePostSetupItem[];
  /** 创建 worktree 后在目标目录执行的命令，留空表示不执行。 */
  command?: string;
  /** 重置后是否重新复制保留项并执行命令；默认开启。 */
  applyAfterReset?: boolean;
};

export type WorktreePostSetupApplyRequest = {
  /** 提供保留项和命令的源项目目录。 */
  sourceDir: string;
  /** 要应用到的目标 worktree 目录。 */
  targetDir: string;
  /** 项目级后置设置。 */
  config?: WorktreePostSetupConfig;
  /** 兼容旧设置：创建时拷贝 AI 规则文件。 */
  copyRules?: boolean;
};

export type WorktreePostSetupApplyResult = {
  ok: boolean;
  copied?: string[];
  warnings?: string[];
  command?: {
    skipped?: boolean;
    command?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
  };
  error?: string;
};

export type AppWindowMode = "main" | "detached-tab";

export type AppWindowMeta = {
  id: string;
  mode: AppWindowMode;
};

export type AppWindowClosedPayload = {
  windowId: string;
  mode: AppWindowMode;
};

export type AppWindowStatePayload = {
  isMaximized?: boolean;
};

export type AppWindowControlAction = "minimize" | "toggleMaximize" | "close";

export type AppBrandAssets = {
  title?: string;
  iconDataUrl?: string;
};

export type DetachedTabWindowPlacement = {
  x?: number;
  y?: number;
};

export type CreateDetachedTabWindowOptions = DetachedTabWindowPlacement & {
  windowId?: string;
};

export type TabDragPreviewWindowState = {
  windowId?: string;
  tabId?: string;
  tabName?: string;
  providerIconSrc?: string;
  isGitTab?: boolean;
  detachCandidate?: boolean;
};

export type CreateTabDragPreviewWindowOptions = TabDragPreviewWindowState;
export type UpdateTabDragPreviewWindowOptions = TabDragPreviewWindowState & {
  windowId: string;
};
export type CloseTabDragPreviewWindowOptions = {
  windowId?: string;
};

export type GitUpdateExecutionPhase =
  | "repository-graph"
  | "preflight"
  | "tracked-branch-config"
  | "fetch"
  | "updater-selection"
  | "save-if-needed"
  | "root-update"
  | "result-aggregation";

export type GitUpdateRootResultCode =
  | "NOTHING_TO_UPDATE"
  | "SUCCESS"
  | "INCOMPLETE"
  | "CANCEL"
  | "ERROR"
  | "NOT_READY"
  | "SKIPPED";

export type GitUpdateFetchStrategy =
  | "tracked-remote"
  | "default-remote"
  | "all-remotes";

export type GitUpdateFetchStatus =
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export type GitUpdateLocalChangesRestorePolicy = "not-applicable" | "restore" | "keep-saved";

export type GitUpdatePreservingStatus =
  | "not-needed"
  | "saved"
  | "restored"
  | "kept-saved"
  | "restore-failed";

export type GitUpdateSkipReasonCode =
  | "requested"
  | "detached-head"
  | "no-tracked-branch"
  | "remote-missing"
  | "parent-failed"
  | "fetch-failed"
  | "updated-by-parent";

export type GitUpdateSubmoduleMode = "branch" | "detached";
export type GitUpdateSubmoduleUpdateStrategy = "root" | "detached-updater" | "updated-by-parent";

export type GitUpdateSessionProgressFetchResult = {
  status: GitUpdateFetchStatus;
  strategy: GitUpdateFetchStrategy;
  remotes: string[];
  fetchedRemotes: string[];
  failedRemotes: Array<{ remote: string; error: string }>;
  upstream?: string;
  trackedRemote?: string;
  skippedReason?: string;
  error?: string;
};

export type GitUpdateSessionProgressUnfinishedState = {
  code: "rebase-in-progress" | "merge-in-progress" | "unmerged-files";
  stage: "preflight" | "update";
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy;
  savedLocalChangesRef?: string;
  message: string;
};

export type GitUpdateSessionProgressPreservingState = {
  saveChangesPolicy: "stash" | "shelve";
  status: GitUpdatePreservingStatus;
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy;
  savedLocalChangesRef?: string;
  savedLocalChangesDisplayName?: string;
  message?: string;
  notRestoredReason?: "unfinished-state" | "restore-failed" | "manual-decision";
};

export type GitUpdateSessionProgressSubmoduleUpdate = {
  mode: GitUpdateSubmoduleMode;
  strategy: GitUpdateSubmoduleUpdateStrategy;
  parentRepoRoot?: string;
  relativePath?: string;
  recursive: boolean;
  detachedHead: boolean;
};

export type GitUpdateSessionProgressSnapshot = {
  requestedRepoRoot: string;
  currentPhase?: GitUpdateExecutionPhase;
  activeRepoRoot?: string;
  activeRootName?: string;
  activePhase?: GitUpdateExecutionPhase;
  cancelled: boolean;
  cancelReason?: string;
  totalRoots: number;
  completedRoots: number;
  runningRoots: number;
  remainingRoots: number;
  multiRoot: boolean;
  roots: Array<{
    repoRoot: string;
    rootName: string;
    kind: "repository" | "submodule";
    currentPhase?: GitUpdateExecutionPhase;
    resultCode?: GitUpdateRootResultCode;
    skippedReason?: string;
    skippedReasonCode?: GitUpdateSkipReasonCode;
    fetchResult?: GitUpdateSessionProgressFetchResult;
    unfinishedState?: GitUpdateSessionProgressUnfinishedState;
    preservingState?: GitUpdateSessionProgressPreservingState;
    submoduleUpdate?: GitUpdateSessionProgressSubmoduleUpdate;
  }>;
};

export type HistorySummary = {
  providerId: "codex" | "claude" | "gemini";
  id: string;
  title: string;
  date: number | string; // 主进程用 mtimeMs（number），前端常转成 ISO string
  filePath: string;
  rawDate?: string;
  preview?: string;
  dirKey?: string;
  projectHash?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: 'wsl' | 'windows' | 'unknown';
};

export type MessageContent = {
  type: string;
  text: string;
  tags?: string[];
  src?: string;
  fallbackSrc?: string;
  localPath?: string;
  mimeType?: string;
};
export type HistoryMessage = { role: string; content: MessageContent[] };

// ---- Host API 声明 ----
export interface PtyAPI {
  openWSLConsole(args: { terminal?: TerminalMode; distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string; env?: Record<string, string> }): Promise<{ id: string; terminal?: TerminalMode; distro?: string; fallbackReason?: string }>;
  /** 读取 PTY 的尾部输出缓存（用于渲染进程 reload/HMR 后恢复终端滚动区）。 */
  backlog?: (id: string, args?: { maxChars?: number }) => Promise<{ ok: boolean; data?: string; error?: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  onData(id: string, handler: (data: string) => void): () => void;
  onExit?: (handler: (payload: { id: string; exitCode?: number }) => void) => () => void;
  // 可选：为 ConPTY/xterm 重排期间做握手控制
  pause?: (id: string) => void;
  resume?: (id: string) => void;
  clear?: (id: string) => void;
}

export interface ProjectsAPI {
  /** 读取缓存项目列表（不触发扫描） */
  list(): Promise<{ ok: boolean; projects?: Project[]; error?: string }>;
  scan(args?: { roots?: string[] }): Promise<{ ok: boolean; projects?: Project[]; error?: string }>;
  add(args: { winPath: string; dirRecord?: { providerId: string; recordedAt?: number } }): Promise<{ ok: boolean; project?: Project | null; error?: string }>;
  /** 更新项目级 worktree 后置设置。 */
  updateWorktreePostSetup(args: { id: string; config?: WorktreePostSetupConfig | null }): Promise<{ ok: boolean; project?: Project | null; error?: string }>;
  /** 移除“自定义引擎目录记录”。若项目已确认存在内置会话，仅清空记录；否则从列表移除该项目。 */
  removeDirRecord(args: { id: string }): Promise<{ ok: boolean; removed: boolean; project?: Project | null; error?: string }>;
  touch(id: string): void;
}

export type DirTreeStore = {
  version: 1;
  rootOrder: string[];
  parentById: Record<string, string>;
  childOrderByParent: Record<string, string[]>;
  expandedById: Record<string, boolean>;
  labelById: Record<string, string>;
};

export interface DirTreeAPI {
  get(): Promise<{ ok: boolean; store?: DirTreeStore; error?: string }>;
  set(store: DirTreeStore): Promise<{ ok: boolean; error?: string }>;
}

export type BuildRunBackend =
  | { kind: "system" }
  | { kind: "pwsh" }
  | { kind: "git_bash" }
  | { kind: "wsl"; distro?: string }
  | { kind: "custom"; command: string };

export type EnvRow = { key: string; value: string };

export type BuildRunCommandConfig = {
  mode: "simple" | "advanced";
  commandText?: string;
  cmd?: string;
  args?: string[];
  cwd?: string;
  env?: EnvRow[];
  backend?: BuildRunBackend;
};

export type DirBuildRunConfig = {
  build?: BuildRunCommandConfig;
  run?: BuildRunCommandConfig;
};

export interface BuildRunAPI {
  get(dir: string): Promise<{ ok: boolean; cfg?: DirBuildRunConfig | null; error?: string }>;
  set(dir: string, cfg: DirBuildRunConfig): Promise<{ ok: boolean; error?: string }>;
  exec(args: any): Promise<{ ok: boolean; error?: string }>;
}

export type GitWorktreeListEntry = {
  worktree: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  prune?: boolean;
};

export type WorktreeMeta = {
  /** 默认操作落点 worktree 路径（通常为主 worktree；若基分支由其他 worktree 持有，则可能为该基 worktree）。 */
  repoMainPath: string;
  baseBranch: string;
  /** 创建时基分支的提交号（用于“按分叉点之后回收”的默认边界）。 */
  baseRefAtCreate?: string;
  wtBranch: string;
  createdAt: number;
};

/** 回收范围：默认仅回收分叉点之后的提交；可选完整回收。 */
export type RecycleWorktreeRange = "since_fork" | "full";

export type RecycleWorktreeErrorCode =
  | "INVALID_ARGS"
  | "META_MISSING"
  | "FORK_POINT_UNAVAILABLE"
  | "FORK_POINT_INVALID"
  | "BASE_WORKTREE_DIRTY"
  | "WORKTREE_DIRTY"
  | "BASE_WORKTREE_IN_PROGRESS"
  | "BASE_WORKTREE_LOCKED"
  | "BASE_WORKTREE_STASH_FAILED"
  | "BASE_WORKTREE_DIRTY_AFTER_STASH"
  | "RECYCLE_FAILED"
  | "UNKNOWN";

export type RecycleWorktreeWarningCode =
  | "BASE_WORKTREE_RESTORE_CONFLICT"
  | "BASE_WORKTREE_RESTORE_FAILED"
  | "BASE_WORKTREE_STASH_DROP_FAILED";

export type RecycleBaseWorktreeStashKind = "staged" | "unstaged";

export type RecycleBaseWorktreeStash = {
  kind: RecycleBaseWorktreeStashKind;
  sha: string;
  message: string;
};

export type RecycleWorktreeDetails = {
  /** 回收实际执行所在的目标 worktree 路径（字段名为兼容历史沿用）。 */
  repoMainPath?: string;
  baseBranch?: string;
  wtBranch?: string;
  originalRef?: { kind: "branch"; name: string } | { kind: "detached"; sha: string };
  stashes?: RecycleBaseWorktreeStash[];
  suggestedRestoreCommand?: string;
  stderr?: string;
  stdout?: string;
  error?: string;
};

export type RecycleWorktreeResult =
  | { ok: true; warningCode?: RecycleWorktreeWarningCode; details?: RecycleWorktreeDetails }
  | { ok: false; errorCode: RecycleWorktreeErrorCode; details?: RecycleWorktreeDetails };

export type ResetWorktreeResult =
  | { ok: true; alreadyAligned?: boolean }
  | { ok: false; needsForce?: boolean; error?: string };

export type IsWorktreeAlignedToMainResult =
  | { ok: true; aligned: boolean }
  | { ok: false; error?: string };

export type CreatedWorktree = {
  providerId: "codex" | "claude" | "gemini";
  /** 默认操作落点 worktree 路径（通常为主 worktree；若基分支由其他 worktree 持有，则可能为该基 worktree）。 */
  repoMainPath: string;
  worktreePath: string;
  baseBranch: string;
  wtBranch: string;
  index: number;
  warnings?: string[];
};

export type WorktreeCreateTaskStatus = "running" | "canceling" | "canceled" | "success" | "error";

export type WorktreeCreateTaskItemStatus = "creating" | "success" | "error" | "canceled";

export type WorktreeCreateTaskItemSnapshot = {
  key: string;
  providerId: "codex" | "claude" | "gemini";
  worktreePath: string;
  wtBranch: string;
  index: number;
  status: WorktreeCreateTaskItemStatus;
  updatedAt: number;
  error?: string;
  warnings?: string[];
};

export type WorktreeTimeoutEstimate = {
  worktreeCount: number;
  maxParallel: number;
  perWorktreeAddTimeoutMs: number;
  taskTimeoutMs: number;
  metrics: {
    trackedFileCount: number;
    checkoutFileCount: number;
    checkoutBytes: number;
    indexBytes: number;
    looseObjectBytes: number;
    packedObjectBytes: number;
    objectBytes: number;
  };
};

export type WorktreeCreateTaskSnapshot = {
  taskId: string;
  repoDir: string;
  baseBranch: string;
  instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>;
  copyRules: boolean;
  status: WorktreeCreateTaskStatus;
  createdAt: number;
  updatedAt: number;
  logSize: number;
  totalCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  allCompleted: boolean;
  worktreeStates: WorktreeCreateTaskItemSnapshot[];
  timeoutEstimate?: WorktreeTimeoutEstimate;
  error?: string;
  items?: CreatedWorktree[];
};

export type WorktreeRecycleTaskStatus = "running" | "success" | "error";

export type WorktreeRecycleTaskSnapshot = {
  taskId: string;
  worktreePath: string;
  repoMainPath: string;
  baseBranch: string;
  wtBranch: string;
  range: RecycleWorktreeRange;
  /** 可选：手动指定的分叉点引用（提交号/引用），仅在 range=since_fork 时生效。 */
  forkBaseRef?: string;
  mode: "squash" | "rebase";
  autoStashBaseWorktree: boolean;
  status: WorktreeRecycleTaskStatus;
  createdAt: number;
  updatedAt: number;
  logSize: number;
  error?: string;
  result?: RecycleWorktreeResult;
};

export type WorktreeForkPointSource = "recorded" | "merge-base";

export type GitCommitSummary = {
  /** 完整提交号。 */
  sha: string;
  /** 短提交号（用于 UI 辅助展示）。 */
  shortSha: string;
  /** 提交标题（subject，单行）。 */
  subject: string;
  /** 作者时间戳（Unix 秒）。 */
  authorDateUnix: number;
};

export type WorktreeForkPointSnapshot = {
  repoMainPath: string;
  recordedSha?: string;
  recordedCommit?: GitCommitSummary;
  recordedApplies?: boolean;
  sha: string;
  autoCommit?: GitCommitSummary;
  source: WorktreeForkPointSource;
};

export type ResolveWorktreeForkPointResult =
  | { ok: true; forkPoint: WorktreeForkPointSnapshot }
  | { ok: false; error: string; forkPoint?: Partial<WorktreeForkPointSnapshot> };

export type GitDirInfo = {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  isInsideWorkTree: boolean;
  repoRoot?: string;
  isRepoRoot: boolean;
  branch?: string;
  detached: boolean;
  /** detached 时返回 canonical HEAD hash；展示层按需自行缩写。 */
  headSha?: string;
  isWorktree: boolean;
  worktrees?: GitWorktreeListEntry[];
  mainWorktree?: string;
  error?: string;
};

export type InitGitRepositoryResult = {
  ok: boolean;
  dir: string;
  repoRoot?: string;
  branch?: string;
  alreadyRepo?: boolean;
  log?: string;
  error?: string;
};

export interface GitWorktreeAPI {
  statusBatch(dirs: string[]): Promise<{ ok: boolean; items?: GitDirInfo[]; error?: string }>;
  listBranches(repoDir: string): Promise<{ ok: boolean; repoRoot?: string; branches?: string[]; current?: string; detached?: boolean; headSha?: string; error?: string }>;
  initRepo(args: { dir: string }): Promise<InitGitRepositoryResult>;
  getMeta(worktreePath: string): Promise<{ ok: boolean; meta?: WorktreeMeta | null; error?: string }>;
  create(args: { repoDir: string; baseBranch: string; instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>; copyRules?: boolean; postSetup?: WorktreePostSetupConfig }): Promise<{ ok: boolean; items?: CreatedWorktree[]; error?: string }>;
  createTaskStart(args: { repoDir: string; baseBranch: string; instances: Array<{ providerId: "codex" | "claude" | "gemini"; count: number }>; copyRules?: boolean; postSetup?: WorktreePostSetupConfig }): Promise<{ ok: boolean; taskId?: string; reused?: boolean; error?: string }>;
  createTaskGet(args: { taskId: string; from?: number }): Promise<{ ok: boolean; task?: WorktreeCreateTaskSnapshot; append?: string; error?: string }>;
  createTaskCancel(args: { taskId: string }): Promise<{ ok: boolean; alreadyFinished?: boolean; error?: string }>;
  recycleTaskStart(args: { worktreePath: string; baseBranch: string; wtBranch: string; range?: RecycleWorktreeRange; forkBaseRef?: string; mode: "squash" | "rebase"; commitMessage?: string; autoStashBaseWorktree?: boolean }): Promise<{ ok: boolean; taskId?: string; reused?: boolean; error?: string }>;
  recycleTaskGet(args: { taskId: string; from?: number }): Promise<{ ok: boolean; task?: WorktreeRecycleTaskSnapshot; append?: string; error?: string }>;
  recycle(args: { worktreePath: string; baseBranch: string; wtBranch: string; range?: RecycleWorktreeRange; forkBaseRef?: string; mode: "squash" | "rebase"; commitMessage?: string; autoStashBaseWorktree?: boolean }): Promise<RecycleWorktreeResult>;
  resolveForkPoint(args: { worktreePath: string; baseBranch: string; wtBranch: string }): Promise<ResolveWorktreeForkPointResult>;
  searchForkPointCommits(args: { worktreePath: string; wtBranch: string; query?: string; limit?: number }): Promise<{ ok: boolean; items?: GitCommitSummary[]; error?: string }>;
  validateForkPointRef(args: { worktreePath: string; wtBranch: string; ref: string }): Promise<{ ok: boolean; commit?: GitCommitSummary; error?: string }>;
  remove(args: { worktreePath: string; deleteBranch?: boolean; forceDeleteBranch?: boolean; forceRemoveWorktree?: boolean }): Promise<any>;
  reset(args: { worktreePath: string; targetRef?: string; force?: boolean }): Promise<ResetWorktreeResult>;
  /** 在已存在 worktree 上应用项目级保留项和命令。 */
  applyPostSetup(args: WorktreePostSetupApplyRequest): Promise<WorktreePostSetupApplyResult>;
  isAlignedToMain(args: { worktreePath: string; targetRef?: string }): Promise<IsWorktreeAlignedToMainResult>;
  autoCommit(args: { worktreePath: string; message: string }): Promise<{ ok: boolean; committed: boolean; error?: string }>;
  openExternalTool(dir: string): Promise<{ ok: boolean; error?: string }>;
  openTerminal(dir: string): Promise<{ ok: boolean; error?: string }>;
}

export interface GitFeatureAPI {
  call(args: { action: string; payload?: any; requestId?: number }): Promise<{ ok: boolean; data?: any; error?: string }>;
  onProgress?(handler: (payload: { requestId: number; action: string; repoRoot?: string; message: string; detail?: string; updateSession?: GitUpdateSessionProgressSnapshot }) => void): () => void;
}

export interface GitWorkbenchAPI {
  snapshot?: {
    /** 读取同一主进程生命周期内的 Git 工作台热会话快照。 */
    get(args: { tabId: string; repoRoot?: string }): Promise<{ ok: boolean; snapshot?: any | null; repoRoot?: string; updatedAt?: number; error?: string }>;
    /** 写入 Git 工作台热会话快照；仅用于小型结构化状态，不持久化大 diff。 */
    put(args: { tabId: string; repoRoot: string; snapshot: any }): Promise<{ ok: boolean; updatedAt?: number; count?: number; error?: string }>;
    /** 删除指定 Git 工作台热会话快照。 */
    delete(args: { tabId: string; repoRoot: string }): Promise<{ ok: boolean; deleted?: boolean; error?: string }>;
  };
  /**
   * 请求宿主打开 GitWorkbench；可按公共 actionId 触发提交、提交并推送、拉取、获取、推送、更新项目、冲突解决、搁置等入口。
   */
  show(args: {
    actionId?: string;
    projectId?: string;
    projectPath?: string;
    prefillCommitMessage?: string;
    focusCommitMessage?: boolean;
    selectCommitMessage?: boolean;
    requestId?: number;
  }): Promise<{ ok: boolean; error?: string }>;
  /**
   * 监听主进程转发的 GitWorkbench 打开请求，供 App 宿主统一切 tab 并下发到具体工作台实例。
   */
  onShowRequest?(handler: (payload: {
    actionId?: string;
    projectId?: string;
    projectPath?: string;
    prefillCommitMessage?: string;
    focusCommitMessage?: boolean;
    selectCommitMessage?: boolean;
    requestId?: number;
    receivedAt?: number;
  }) => void): () => void;
}

export interface HistoryAPI {
  list(args: {
    scope?: "current_project" | "project_group" | "all_sessions";
    projectWslPath?: string;
    projectWinPath?: string;
    groupProjectWslPaths?: string[];
    groupProjectWinPaths?: string[];
    limit?: number;
    offset?: number;
    historyRoot?: string;
  }): Promise<{ ok: boolean; sessions?: HistorySummary[]; error?: string }>;
  read(args: { filePath: string; providerId?: "codex" | "claude" | "gemini"; forceParse?: boolean }): Promise<{ id: string; title: string; date: number; messages: HistoryMessage[]; skippedLines: number; providerId?: "codex" | "claude" | "gemini" }>;
  findEmptySessions(): Promise<{ ok: boolean; candidates?: Array<{ id: string; title: string; rawDate?: string; date: number; filePath: string; sizeKB?: number }>; error?: string }>;
  trash(args: { filePath: string }): Promise<{ ok: true; notFound?: boolean } | { ok: false; error: string }>;
  trashMany(args: { filePaths: string[] }): Promise<{ ok: boolean; results?: Array<{ filePath: string; ok: boolean; notFound?: boolean; error?: string }>; summary?: { ok: number; notFound: number; failed: number }; error?: string }>;
  onIndexAdd?(handler: (payload: { items: HistorySummary[] }) => void): () => void;
  onIndexUpdate?(handler: (payload: { item: HistorySummary }) => void): () => void;
  onIndexRemove?(handler: (payload: { filePath: string }) => void): () => void;
  onIndexInvalidate?(handler: (payload: { reason?: string }) => void): () => void;
}

export interface SettingsAPI {
  get(): Promise<AppSettings>;
  update(partial: Partial<AppSettings>): Promise<AppSettings>;
  resolveRuntimeEnv?(args: { terminal?: TerminalMode; distro?: string }): Promise<{ ok: boolean; terminal?: TerminalMode; distro?: string; changed?: boolean; reason?: string; availableDistros?: string[]; error?: string }>;
  checkRuntimeCli?(args: { terminal?: TerminalMode; distro?: string; startupCmd?: string }): Promise<{ ok: boolean; cli?: string; terminal?: TerminalMode; distro?: string; reason?: string; error?: string }>;
  codexRoots(): Promise<string[]>;
  sessionRoots?(args: { providerId: "codex" | "claude" | "gemini" }): Promise<string[]>;
}

export interface OnboardingAPI {
  get(): Promise<{ ok: boolean; state?: { yoloPromptHandled?: boolean }; error?: string }>;
  update(partial: { yoloPromptHandled?: boolean }): Promise<{ ok: boolean; state?: { yoloPromptHandled?: boolean }; error?: string }>;
}

export interface StorageAPI {
  getAppDataInfo(): Promise<{
    ok: boolean;
    path: string;
    totalBytes: number;
    dirCount: number;
    fileCount: number;
    collectedAt: number;
    error?: string;
  }>;
  clearAppData(args?: { preserveSettings?: boolean }): Promise<{
    ok: boolean;
    path: string;
    bytesBefore: number;
    bytesAfter: number;
    bytesFreed: number;
    removedEntries: number;
    skippedEntries: number;
    errors?: Array<{ name: string; message: string }>;
    error?: string;
    scheduled?: boolean;
    note?: string;
  }>;
  purgeAppDataAndQuit(): Promise<{
    ok: boolean;
    path: string;
    bytesBefore: number;
    bytesAfter: number;
    bytesFreed: number;
    removedEntries: number;
    skippedEntries: number;
    errors?: Array<{ name: string; message: string }>;
    error?: string;
    scheduled?: boolean;
    note?: string;
  }>;
  listAutoProfiles(): Promise<{
    ok: boolean;
    baseUserData: string;
    currentUserData: string;
    count: number;
    totalBytes: number;
    items: Array<{
      profileId: string;
      dirName: string;
      path: string;
      totalBytes: number;
      dirCount: number;
      fileCount: number;
      collectedAt: number;
      isCurrent: boolean;
    }>;
    error?: string;
  }>;
  purgeAutoProfiles(args?: { includeCurrent?: boolean }): Promise<{
    ok: boolean;
    total: number;
    removed: number;
    skipped: number;
    busy: number;
    notFound: number;
    bytesFreed: number;
    errors?: Array<{ profileId: string; path: string; message: string }>;
    error?: string;
  }>;
  listWorktreeProfiles(): Promise<{
    ok: boolean;
    baseUserData: string;
    currentUserData: string;
    count: number;
    totalBytes: number;
    items: Array<{
      profileId: string;
      dirName: string;
      path: string;
      totalBytes: number;
      dirCount: number;
      fileCount: number;
      collectedAt: number;
      isCurrent: boolean;
    }>;
    error?: string;
  }>;
  purgeWorktreeProfiles(args?: { includeCurrent?: boolean }): Promise<{
    ok: boolean;
    total: number;
    removed: number;
    skipped: number;
    busy: number;
    notFound: number;
    bytesFreed: number;
    errors?: Array<{ profileId: string; path: string; message: string }>;
    error?: string;
  }>;
}

export type CodexAccountInfo = {
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
};

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;  // 原始字段（秒），UI 层转换为分钟/小时/天
  resetAfterSeconds: number | null;   // 原始字段，统一命名
};

export type CodexRateLimitSnapshot = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export type CodexAuthBackupItem = {
  id: string;
  createdAt: number;
  updatedAt: number;
  runtimeKey: string;
  signature: string;
  status: "signed_in" | "signed_out";
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  reason: string;
};

export type ClaudeUsageWindow = {
  remainingPercent: number | null;
  usedPercent: number | null;
  resetText?: string | null;
};

export type ClaudeUsageSnapshot = {
  providerId: "claude";
  source: "ccline-cache" | "tmux-capture";
  collectedAt: number;
  cachedAt?: number | null;
  resetAt?: number | null;
  windows: {
    fiveHour: ClaudeUsageWindow;
    sevenDay: ClaudeUsageWindow;
    weekOpus?: ClaudeUsageWindow | null;
  };
};

export type GeminiQuotaBucket = {
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  modelId?: string;
};

export type GeminiQuotaSnapshot = {
  providerId: "gemini";
  collectedAt: number;
  projectId?: string | null;
  tierId?: string | null;
  buckets: GeminiQuotaBucket[];
};

export interface CodexAPI {
  getAccountInfo(): Promise<{ ok: boolean; info?: CodexAccountInfo; error?: string }>;
  getRateLimit(): Promise<{ ok: boolean; snapshot?: CodexRateLimitSnapshot; error?: string }>;
  listAuthBackups(): Promise<{ ok: boolean; items?: CodexAuthBackupItem[]; error?: string }>;
  applyAuthBackup(args: { id: string }): Promise<{ ok: boolean; error?: string }>;
  deleteAuthBackup(args: { id: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface ClaudeAPI {
  getUsage(): Promise<{ ok: boolean; snapshot?: ClaudeUsageSnapshot; error?: string }>;
}

export interface GeminiAPI {
  getUsage(): Promise<{ ok: boolean; snapshot?: GeminiQuotaSnapshot; error?: string }>;
}

export type ProjectPreferredIde = BuiltinIdeId;

export interface NotificationsAPI {
  setBadgeCount(count: number): void;
  /** 同步任务栏角标状态；错误优先，其次完成数量，最后运行中提示。 */
  setTaskbarBadgeState?(state: { errorCount?: number; hasError?: boolean; completedCount?: number; runningCount?: number; hasRunningTask?: boolean }): void;
  showAgentCompletion(payload: { tabId: string; tabName?: string; projectName?: string; preview?: string; title: string; body: string; appTitle?: string }): void;
  /** 监听主进程转发的外部完成通知（如 Codex/Gemini/Claude hook -> JSONL 桥接）。 */
  onExternalAgentComplete?(handler: (payload: { providerId?: "codex" | "gemini" | "claude"; tabId?: string; envLabel?: string; preview?: string; previewEscapedWhitespace?: boolean; timestamp?: string; eventId?: string; hookEventName?: string; completionKind?: "agent" | "subagent"; agentType?: string; agentId?: string }) => void): () => void;
  onFocusTab?(handler: (payload: { tabId: string }) => void): () => void;
}

export interface UtilsAPI {
  /** 探测当前 Gemini CLI 版本对应的外部编辑器快捷键策略。 */
  resolveGeminiExternalEditorShortcut(args: {
    terminal?: TerminalMode;
    distro?: string;
    startupCmd?: string;
  }): Promise<{
    ok: boolean;
    shortcut?: "ctrlG" | "ctrlX" | "auto";
    version?: string;
    command?: string;
    error?: string;
  }>;
  /**
   * 中文说明：为当前 tab 预创建 Gemini Windows 外部编辑器所需 env 与会话文件。
   * - 仅影响 CodexFlow 打开的当前 PTY；
   * - 不修改系统全局 `EDITOR/VISUAL`。
   */
  prepareGeminiWindowsEditorEnv(args: {
    tabId: string;
  }): Promise<{ ok: boolean; env?: Record<string, string>; sourcePath?: string; statusPath?: string; error?: string }>;
  /** 写入本次 Gemini Windows 外部编辑器发送使用的 source/status 文件。 */
  writeGeminiWindowsEditorSource(args: {
    tabId: string;
    content: string;
  }): Promise<{ ok: boolean; requestId?: string; sourcePath?: string; statusPath?: string; error?: string }>;
  /** 读取指定 tab 的 Gemini Windows 外部编辑器执行状态。 */
  readGeminiWindowsEditorStatus(args: {
    tabId: string;
  }): Promise<{
    ok: boolean;
    status?: {
      state?: "idle" | "pending" | "done" | "error";
      requestId?: string;
      bufferPath?: string;
      message?: string;
      updatedAt?: string;
    } | null;
    error?: string;
  }>;
  /**
   * 中文说明：为当前 tab 预创建 Gemini WSL 外部编辑器所需 env 与会话文件。
   * - 仅影响 CodexFlow 打开的当前 PTY；
   * - 仅在超长文本命中阈值时由渲染层启用。
   */
  prepareGeminiWslEditorEnv(args: {
    tabId: string;
    distro: string;
  }): Promise<{ ok: boolean; env?: Record<string, string>; sourcePath?: string; statusPath?: string; error?: string }>;
  /** 写入本次 Gemini WSL 外部编辑器发送使用的 source/status 文件。 */
  writeGeminiWslEditorSource(args: {
    tabId: string;
    distro: string;
    content: string;
  }): Promise<{ ok: boolean; requestId?: string; sourcePath?: string; statusPath?: string; error?: string }>;
  /** 读取指定 tab 的 Gemini WSL 外部编辑器执行状态。 */
  readGeminiWslEditorStatus(args: {
    tabId: string;
    distro: string;
  }): Promise<{
    ok: boolean;
    status?: {
      state?: "idle" | "pending" | "done" | "error";
      requestId?: string;
      bufferPath?: string;
      message?: string;
      updatedAt?: string;
    } | null;
    error?: string;
  }>;
  /** 普通调试日志：受 `global.diagLog` 控制。 */
  perfLog(text: string): Promise<{ ok: boolean; error?: string }>;
  /** 白屏/强制刷新关键日志：受 `global.whiteScreenLog` 控制，默认开启。 */
  perfLogCritical(text: string): Promise<{ ok: boolean; error?: string }>;
  getWindowsInfo(): Promise<{ ok: boolean; platform?: string; buildNumber?: number; backend?: string; conptyAvailable?: boolean; error?: string }>;
  copyText(text: string): Promise<{ ok: boolean; error?: string }>;
  /** 将路径转换为当前系统可直接使用的剪贴板格式。 */
  normalizePathForClipboard(p: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  readText(): Promise<{ ok: boolean; text?: string; error?: string }>;
  saveText(content: string, defaultPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  fetchJson(args: { url: string; timeoutMs?: number; headers?: Record<string, string> }): Promise<{ ok: boolean; status?: number; data?: any; error?: string; raw?: string }>;
  showInFolder(p: string): Promise<{ ok: boolean; openedDir?: string; error?: string }>;
  openPath(p: string): Promise<{ ok: boolean; error?: string }>;
  /** 按“文件+行列”定位打开；若编辑器能力不可用则回退为普通打开。 */
  openPathAtPosition(p: string, pos?: { line?: number; column?: number; projectPath?: string }): Promise<{ ok: boolean; fallback?: boolean; error?: string }>;
  /** 读取指定项目根目录绑定的 IDE。 */
  getProjectPreferredIde(projectPath: string): Promise<{ ok: boolean; config?: ProjectIdePreference | null; ideId?: ProjectPreferredIde | null; error?: string }>;
  /** 设置或清除指定项目根目录的 IDE 绑定（清除时需显式传入 null）。 */
  setProjectPreferredIde(projectPath: string, config: ProjectIdePreference | ProjectPreferredIde | null): Promise<{ ok: boolean; error?: string }>;
  openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  openExternalConsole(args: { terminal?: TerminalMode; wslPath?: string; winPath?: string; distro?: string; startupCmd?: string; title?: string }): Promise<{ ok: boolean; error?: string }>;
  // 兼容旧名
  openExternalWSLConsole?(args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }): Promise<{ ok: boolean; error?: string }>;
  pathExists(p: string, dirOnly?: boolean): Promise<{ ok: boolean; exists?: boolean; isDirectory?: boolean; isFile?: boolean; error?: string }>;
  /** 获取当前用户主目录路径（轻量）。 */
  getHomeDir(): Promise<{ ok: boolean; homeDir?: string; error?: string }>;
  chooseFolder(args?: { title?: string; defaultPath?: string }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  chooseFiles(args?: {
    title?: string;
    defaultPath?: string;
    multiSelections?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean; error?: string }>;
  debugTermGet(): Promise<{ ok: boolean; enabled?: boolean; error?: string }>;
  debugTermSet(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 列出系统已安装字体名称（Windows）。其他平台返回空数组。 */
  listFonts(): Promise<string[]>;
  /** 列出系统字体详情：包含路径与是否等宽（基于字体表元数据判定）。 */
  listFontsDetailed(): Promise<Array<{ name: string; file?: string; monospace: boolean }>>;
  /** 检测系统是否安装 PowerShell 7（pwsh）。仅 Windows 返回可用性与路径。 */
  detectPwsh(): Promise<{ ok: boolean; available?: boolean; path?: string; error?: string }>;
}

// 仅声明渲染层使用到的最小 API（与 preload.ts 暴露保持一致）
export interface WslAPI {
  listDistros(): Promise<{ ok: boolean; distros: string[]; error?: string }>;
}

export interface FileIndexAPI {
  ensureIndex(args: { root: string; excludes?: string[] }): Promise<{ ok: boolean; total?: number; updatedAt?: number; error?: string }>;
  getAllCandidates(root: string): Promise<{ ok: boolean; items?: Array<{ rel: string; isDir: boolean }>; error?: string }>;
  /**
   * 主进程侧 @ 搜索（仅返回 topN）。
   * 目的：避免把全量候选列表跨进程传到渲染层/Worker，导致大仓库下的内存峰值与页面刷新。
   */
  searchAt(args: {
    root: string;
    query: string;
    scope?: "all" | "files" | "rule";
    limit?: number;
    excludes?: string[];
  }): Promise<{
    ok: boolean;
    items?: Array<{
      categoryId: "files" | "rule";
      rel: string;
      isDir: boolean;
      score: number;
      groupKey?: "pinned" | "legacy" | "dynamic";
    }>;
    total?: number;
    updatedAt?: number;
    error?: string;
  }>;
  setActiveRoots(roots: string[]): Promise<{ ok: boolean; closed?: number; remain?: number; trimmed?: number; error?: string }>;
  onChanged?: (handler: (payload: { root: string; reason?: string; adds?: { rel: string; isDir: boolean }[]; removes?: { rel: string; isDir: boolean }[] }) => void) => () => void;
}

export interface GitRepoWatchAPI {
  setActiveRoots(roots: string[]): Promise<{ ok: boolean; opened?: number; closed?: number; remain?: number; error?: string }>;
  onChanged?: (handler: (payload: { repoRoot: string; reason: string; paths: string[] }) => void) => () => void;
}

export interface ImagesAPI {
  saveDataURL(args: { dataURL: string; projectWinRoot?: string; projectWslRoot?: string; projectName?: string; ext?: string; prefix?: string; providerId?: string; runtimeEnv?: TerminalMode; distro?: string }): Promise<{ ok: boolean; winPath?: string; wslPath?: string; fileName?: string; error?: string }>;
  clipboardHasImage(): Promise<{ ok: boolean; has?: boolean; error?: string }>;
  saveFromClipboard(args: { projectWinRoot?: string; projectWslRoot?: string; projectName?: string; prefix?: string; providerId?: string; runtimeEnv?: TerminalMode; distro?: string }): Promise<{ ok: boolean; winPath?: string; wslPath?: string; fileName?: string; error?: string }>;
  copyToClipboard(args: { localPath?: string; src?: string; fallbackSrc?: string }): Promise<{ ok: boolean; error?: string }>;
  materializePreviewURL(args: { src?: string }): Promise<{ ok: boolean; src?: string; mimeType?: string; error?: string }>;
  trash(args: { winPath: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface AppAPI {
  /**
   * 本次主进程启动的唯一标识（跨 reload 稳定）。
   * 用途：渲染层区分“渲染 reload/HMR”与“应用重启”，避免重启后恢复失效的控制台绑定。
   */
  bootId: string;
  /** 当前渲染窗口的身份信息。 */
  window: AppWindowMeta;
  getVersion(): Promise<string>;
  getPaths(): Promise<{ licensePath?: string; noticePath?: string }>;
  /** 应用品牌资源，用于自绘标题栏。 */
  getBrandAssets?(): Promise<{ ok: boolean; error?: string } & AppBrandAssets>;
  /** 仅 Windows：设置原生标题栏主题（light/dark） */
  setTitleBarTheme?(theme: { mode: 'light' | 'dark'; source?: ThemeSetting } | 'light' | 'dark'): Promise<{ ok: boolean; error?: string }>;
  /** 控制当前窗口。 */
  controlWindow?(action: AppWindowControlAction): Promise<{ ok: boolean; isMaximized?: boolean; error?: string }>;
  /** 读取当前窗口状态。 */
  getWindowState?(): Promise<{ ok: boolean; isMaximized?: boolean; error?: string }>;
  /** 监听当前窗口状态变化。 */
  onWindowStateChanged?(handler: (payload: AppWindowStatePayload) => void): () => void;
  /** 主进程发起的“退出确认”请求（用于渲染进程自定义弹窗样式） */
  onQuitConfirm?(handler: (payload: { token: string; count: number }) => void): () => void;
  /** 回复主进程的“退出确认”结果 */
  respondQuitConfirm?(token: string, ok: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 创建一个用于承载独立标签页的新窗口。 */
  createDetachedTabWindow?(options?: CreateDetachedTabWindowOptions): Promise<{ ok: boolean; windowId?: string; error?: string }>;
  /** 创建桌面级标签拖拽预览浮层。 */
  createTabDragPreviewWindow?(options?: CreateTabDragPreviewWindowOptions): Promise<{ ok: boolean; windowId?: string; error?: string }>;
  /** 更新桌面级标签拖拽预览浮层。 */
  updateTabDragPreviewWindow?(options: UpdateTabDragPreviewWindowOptions): Promise<{ ok: boolean; error?: string }>;
  /** 关闭桌面级标签拖拽预览浮层。 */
  closeTabDragPreviewWindow?(options?: CloseTabDragPreviewWindowOptions): Promise<{ ok: boolean; closed?: boolean; error?: string }>;
  /** 监听应用窗口关闭事件。 */
  onWindowClosed?(handler: (payload: AppWindowClosedPayload) => void): () => void;
}

export interface TabDragPreviewAPI {
  /** 监听主进程推送的拖拽预览状态。 */
  onUpdate(handler: (payload: TabDragPreviewWindowState) => void): () => void;
}

export interface EnvAPI {
  getMeta(): Promise<{ ok: boolean; isDev?: boolean; devServerUrl?: string | null; protocol?: string; error?: string }>;
}

export interface I18nAPI {
  getLocale(): Promise<{ ok: boolean; locale?: string; error?: string }>;
  setLocale(locale: string): Promise<{ ok: boolean; locale?: string; error?: string }>;
  onLocaleChanged?(handler: (payload: { locale: string }) => void): () => void;
  userLocales?: {
    dir(): Promise<{ ok: boolean; dir?: string; error?: string }>;
    list(): Promise<{ ok: boolean; languages?: string[]; error?: string }>;
    read(lng: string, ns: string): Promise<{ ok: boolean; data?: any; error?: string }>;
  }
}

declare global {
  interface Window {
    host: {
      app: AppAPI;
      env: EnvAPI;
      pty: PtyAPI;
      projects: ProjectsAPI;
      dirTree?: DirTreeAPI;
      buildRun?: BuildRunAPI;
      gitWorktree?: GitWorktreeAPI;
      gitFeature?: GitFeatureAPI;
      gitWorkbench?: GitWorkbenchAPI;
      history: HistoryAPI;
      settings: SettingsAPI;
      onboarding: OnboardingAPI;
      storage: StorageAPI;
      utils: UtilsAPI;
      i18n: I18nAPI;
      codex: CodexAPI;
      claude: ClaudeAPI;
      gemini: GeminiAPI;
      notifications: NotificationsAPI;
      wsl?: WslAPI;
      fileIndex?: FileIndexAPI;
      gitRepoWatch?: GitRepoWatchAPI;
      images?: ImagesAPI;
      tabDragPreview?: TabDragPreviewAPI;
      debug?: {
        get(): Promise<any>;
        update(partial: any): Promise<any>;
        reset?(): Promise<any>;
        onChanged?(handler: () => void): () => void;
      };
    };
  }
}
