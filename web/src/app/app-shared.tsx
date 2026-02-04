// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import PathChipsInput, { type PathChip } from "@/components/ui/path-chips-input";
import { retainPreviewUrl, releasePreviewUrl } from "@/lib/previewUrlRegistry";
import { retainPastedImage, releasePastedImage, requestTrashWinPath } from "@/lib/imageResourceRegistry";
import { setActiveFileIndexRoot } from "@/lib/atSearch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  FolderOpen,
  Plus,
  TerminalSquare,
  Settings as SettingsIcon,
  History as HistoryIcon,
  Send,
  PlugZap,
  CheckCircle2,
  MoreVertical,
  FileClock,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Trash2,
  X,
  Copy as CopyIcon,
  Info as InfoIcon,
  Maximize2,
  Minimize2,
  ArrowDownAZ,
  Check,
  Search,
  TriangleAlert,
  Hammer,
  Play,
  GitMerge,
  Loader2,
} from "lucide-react";
import AboutSupport from "@/components/about-support";
import { ProviderSwitcher } from "@/components/topbar/provider-switcher";
import { emitCodexRateRefresh } from "@/lib/codex-status";
import { emitClaudeUsageRefresh } from "@/lib/claude-status";
import { emitGeminiUsageRefresh } from "@/lib/gemini-status";
import { checkForUpdate, type UpdateCheckErrorType } from "@/lib/about";
import TerminalManager from "@/lib/TerminalManager";
import { isGeminiProvider, writeBracketedPaste, writeBracketedPasteAndEnter } from "@/lib/terminal-send";
import { oscBufferDefaults, trimOscBuffer } from "@/lib/oscNotificationBuffer";
import { resolveDirRowDropPosition } from "@/lib/dir-tree-dnd";
import HistoryCopyButton from "@/components/history/history-copy-button";
import HistoryPanelToggleButton from "@/components/history/history-panel-toggle-button";
import { HistoryMarkdown } from "@/features/history/renderers/history-markdown";
import { applyHistoryFindHighlights, clearHistoryFindHighlights, setActiveHistoryFindMatch } from "@/features/history/find/history-find";
import { toWSLForInsert } from "@/lib/wsl";
import { extractGeminiProjectHashFromPath, deriveGeminiProjectHashCandidatesFromPath } from "@/lib/gemini-hash";
import { normalizeProvidersSettings } from "@/lib/providers/normalize";
import { isBuiltInSessionProviderId, openaiIconUrl, openaiDarkIconUrl, claudeIconUrl, geminiIconUrl } from "@/lib/providers/builtins";
import { resolveProvider } from "@/lib/providers/resolve";
import { injectCodexTraceEnv } from "@/providers/codex/commands";
import { buildClaudeResumeStartupCmd } from "@/providers/claude/commands";
import { buildGeminiResumeStartupCmd } from "@/providers/gemini/commands";
import { bashSingleQuote, buildPowerShellCall, powerShellArgToken, splitCommandLineToArgv } from "@/lib/shell";
import SettingsDialog from "@/features/settings/settings-dialog";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_THEME_ID,
  getTerminalTheme,
  buildTerminalChromeColors,
  normalizeTerminalFontFamily,
  normalizeTerminalTheme,
  type TerminalThemeDefinition,
} from "@/lib/terminal-appearance";
import { getCachedThemeSetting, useThemeController, writeThemeSettingCache, type ThemeMode, type ThemeSetting } from "@/lib/theme";
import { loadHiddenProjectIds, loadShowHiddenProjects, saveHiddenProjectIds, saveShowHiddenProjects } from "@/lib/projects-hidden";
import { loadConsoleSession, saveConsoleSession, type PersistedConsoleTab } from "@/lib/console-session";
import type {
  AppSettings,
  BuildRunCommandConfig,
  CreatedWorktree,
  DirBuildRunConfig,
  DirTreeStore,
  GitDirInfo,
  Project,
  ProviderItem,
  ProviderEnv,
  WorktreeCreateTaskSnapshot,
  WorktreeCreateTaskStatus,
  WorktreeRecycleTaskSnapshot,
  WorktreeRecycleTaskStatus,
} from "@/types/host";
import type { TerminalThemeId } from "@/types/terminal-theme";

// 发送命令后延迟清理粘贴图片 3 分钟，避免命令执行期间文件提前被删除
const CHIP_COMMIT_RELEASE_DELAY_MS = 180_000;

// ---------- Types ----------

type TerminalMode = NonNullable<AppSettings["terminal"]>;
type ConsoleTab = {
  id: string;
  name: string;
  /** 创建该标签页时使用的引擎（Provider）id，用于标签图标等展示。 */
  providerId: string;
  logs: string[]; // kept for visual compatibility; no longer used once terminal mounts
  createdAt: number;
};

type BuildRunAction = "build" | "run";

type BuildRunDialogState = {
  open: boolean;
  action: BuildRunAction;
  /** 触发该对话框的节点（用于继承/覆盖判断） */
  projectId: string;
  /** 配置保存目标：self=保存到该节点目录；parent=保存到父节点目录（worktree 默认继承） */
  saveScope: "self" | "parent";
  /** 若 saveScope=parent，记录父节点 id */
  parentProjectId?: string;
  /** 当前编辑草稿 */
  draft: BuildRunCommandConfig;
  /** 是否显示高级模式 */
  advanced: boolean;
};

type DirLabelDialogState = {
  open: boolean;
  projectId: string;
  draft: string;
};

type GitWorktreeProviderId = "codex" | "claude" | "gemini";
type ExternalGitToolId = "rider" | "sourcetree" | "fork" | "gitkraken" | "custom";

type WorktreeProviderCounts = Record<GitWorktreeProviderId, number>;

type WorktreeCreateDialogState = {
  open: boolean;
  /** 触发创建的仓库节点（父节点）的 projectId */
  repoProjectId: string;
  /** baseBranch 下拉可选项 */
  branches: string[];
  /** 当前选择的基分支（不得为空） */
  baseBranch: string;
  /** 是否正在加载分支列表 */
  loadingBranches: boolean;
  /** 复用的子 worktree（projectId，多选；默认不选） */
  selectedChildWorktreeIds: string[];
  /** 初始提示词：chips */
  promptChips: PathChip[];
  /** 初始提示词：草稿 */
  promptDraft: string;
  /** 是否在本次创建/启动中临时启用 YOLO（不影响全局设置）。 */
  useYolo: boolean;
  /** 是否开启并行混合模式（Use Multiple Models） */
  useMultipleModels: boolean;
  /** 单选模式下选择的唯一引擎 */
  singleProviderId: GitWorktreeProviderId;
  /** 多选模式下各引擎次数 */
  multiCounts: WorktreeProviderCounts;
  /** 是否正在创建（防止重复提交） */
  creating: boolean;
  /** 错误摘要（用于 UI 提示） */
  error?: string;
};

type ForkPointOption = {
  /** 作为提交参数传给后端的值（通常为完整 commit sha）。 */
  value: string;
  /** 主展示文本（优先展示提交 subject）。 */
  title: string;
  /** 辅助展示文本（通常为 short sha）。 */
  subtitle: string;
  /** UI 标签（例如：创建记录 / 自动 / 手动）。 */
  tag?: string;
};

type WorktreeRecycleDialogState = {
  open: boolean;
  projectId: string;
  /** 主 worktree 路径（用于“主 worktree 脏”场景提供外部工具入口）。 */
  repoMainPath: string;
  branches: string[];
  baseBranch: string;
  wtBranch: string;
  /** 回收范围：默认仅回收分叉点之后；可选完整回收。 */
  range: "since_fork" | "full";
  /** 分叉点选择值（提交号/引用；通常为 commit sha）。 */
  forkPointValue: string;
  /** 用户是否手动改过分叉点选择（用于避免自动推断覆盖）。 */
  forkPointTouched: boolean;
  /** 分叉点置顶候选（创建记录/自动推断/手动）。 */
  forkPointPinned: ForkPointOption[];
  /** 分叉点搜索候选（从 git log 获取的提交列表）。 */
  forkPointSearchItems: ForkPointOption[];
  /** 分叉点搜索词（用于下拉框搜索输入）。 */
  forkPointSearchQuery: string;
  /** 是否正在加载置顶候选（resolveForkPoint）。 */
  forkPointPinnedLoading: boolean;
  /** 是否正在加载搜索候选（git log）。 */
  forkPointSearchLoading: boolean;
  /** 分叉点相关错误（校验失败/搜索失败等）。 */
  forkPointError?: string;
  mode: "squash" | "rebase";
  commitMessage: string;
  loading: boolean;
  running: boolean;
  error?: string;
};

type BaseWorktreeDirtyDialogState = {
  open: boolean;
  /** 主 worktree 路径（用于打开外部 Git 工具/终端）。 */
  repoMainPath: string;
  /** 回收前自动提交提示（可选）。 */
  preCommitHint?: string;
};

type WorktreeDeleteDialogState = {
  open: boolean;
  projectId: string;
  /** 操作类型：delete=删除 worktree；reset=对齐到主工作区当前基线（保持目录，不删除）。 */
  action: "delete" | "reset";
  /** 是否为“回收成功后”的推荐删除（仅用于 UI 文案） */
  afterRecycle?: boolean;
  /** 回收流程的额外提示（例如：回收前的自动提交提醒）。 */
  afterRecycleHint?: string;
  running: boolean;
  /** 当需要强确认时，进入二次确认步骤 */
  needsForceRemoveWorktree?: boolean;
  needsForceDeleteBranch?: boolean;
  needsForceResetWorktree?: boolean;
  error?: string;
};

type WorktreePostRecycleDialogState = {
  open: boolean;
  projectId: string;
  hint?: string;
};

type GitActionErrorDialogState = {
  open: boolean;
  title: string;
  /** 中文说明：可选说明文案；为空则回退到默认“Git 失败兜底提示”。 */
  hint?: string;
  message: string;
  dir: string;
};

type WorktreeCreateProgressState = {
  open: boolean;
  repoProjectId: string;
  taskId: string;
  status: WorktreeCreateTaskStatus;
  log: string;
  logOffset: number;
  updatedAt: number;
  error?: string;
};

type WorktreeRecycleProgressState = {
  open: boolean;
  projectId: string;
  taskId: string;
  status: WorktreeRecycleTaskStatus;
  log: string;
  logOffset: number;
  updatedAt: number;
  error?: string;
};

type NoticeDialogState = {
  open: boolean;
  title: string;
  message: string;
};

const GEMINI_NOTIFY_ENV_KEYS = {
  tabId: "GEMINI_CLI_CODEXFLOW_TAB_ID",
  envLabel: "GEMINI_CLI_CODEXFLOW_ENV_LABEL",
  providerId: "GEMINI_CLI_CODEXFLOW_PROVIDER_ID",
} as const;

const CLAUDE_NOTIFY_ENV_KEYS = {
  tabId: "CLAUDE_CODEXFLOW_TAB_ID",
  envLabel: "CLAUDE_CODEXFLOW_ENV_LABEL",
  providerId: "CLAUDE_CODEXFLOW_PROVIDER_ID",
} as const;

/**
 * 构建 ProviderItem 的 id -> item 索引，避免在标签渲染时重复线性扫描。
 */
function buildProviderItemIndex(items: ProviderItem[]): Record<string, ProviderItem> {
  const map: Record<string, ProviderItem> = {};
  for (const it of items || []) {
    const id = String(it?.id || "").trim();
    if (!id) continue;
    if (map[id]) continue;
    map[id] = it;
  }
  return map;
}

/**
 * 中文说明：构造 Gemini hook 所需的通知环境变量（仅 Gemini 标签页注入）。
 */
function buildGeminiNotifyEnv(tabId: string, providerId: string, envLabel: string): Record<string, string> {
  const pid = String(providerId || "").trim().toLowerCase();
  if (pid !== "gemini") return {};
  const tid = String(tabId || "").trim();
  if (!tid) return {};
  const label = String(envLabel || "").trim();
  return {
    [GEMINI_NOTIFY_ENV_KEYS.tabId]: tid,
    [GEMINI_NOTIFY_ENV_KEYS.envLabel]: label,
    [GEMINI_NOTIFY_ENV_KEYS.providerId]: pid,
  };
}

/**
 * 中文说明：构造 Claude Code hook 所需的通知环境变量（仅 claude 标签页注入）。
 */
function buildClaudeNotifyEnv(tabId: string, providerId: string, envLabel: string): Record<string, string> {
  const pid = String(providerId || "").trim().toLowerCase();
  if (pid !== "claude") return {};
  const tid = String(tabId || "").trim();
  if (!tid) return {};
  const label = String(envLabel || "").trim();
  return {
    [CLAUDE_NOTIFY_ENV_KEYS.tabId]: tid,
    [CLAUDE_NOTIFY_ENV_KEYS.envLabel]: label,
    [CLAUDE_NOTIFY_ENV_KEYS.providerId]: pid,
  };
}

/**
 * 中文说明：构造 Provider 完成通知链路所需的环境变量（按 providerId 注入）。
 * - Gemini：用于 AfterAgent hook（JSONL 桥接）
 * - Claude：用于 Stop hook（JSONL 桥接）
 */
function buildProviderNotifyEnv(tabId: string, providerId: string, envLabel: string): Record<string, string> {
  const pid = String(providerId || "").trim().toLowerCase();
  if (pid === "gemini") return buildGeminiNotifyEnv(tabId, pid, envLabel);
  if (pid === "claude") return buildClaudeNotifyEnv(tabId, pid, envLabel);
  return {};
}

/**
 * 获取某个 Provider 的图标 src（DataURL 或内置资源）。
 */
function getProviderIconSrc(providerId: string, providerItemById: Record<string, ProviderItem>, themeMode?: ThemeMode): string {
  const id = String(providerId || "").trim();
  if (!id) return "";
  const resolved = resolveProvider(providerItemById[id] ?? { id }, { themeMode });
  return resolved.iconSrc || "";
}

// 渲染端消息内容，支持可选 tags（用于嵌套类型筛选，如 message.input_text）
type MessageContent = { type: string; text: string; tags?: string[] };
type HistoryMessage = { role: string; content: MessageContent[] };
type HistorySession = {
  providerId: "codex" | "claude" | "gemini";
  id: string;
  title: string;
  date: string; // ISO
  rawDate?: string; // original string from log, if any
  preview?: string; // optional preview text extracted by indexer
  messages: HistoryMessage[];
  filePath?: string;
  resumeMode?: 'modern' | 'legacy' | 'unknown';
  resumeId?: string;
  runtimeShell?: 'wsl' | 'windows' | 'unknown';
};

type HistoryTimelineGroup = {
  key: string;
  label: string;
  bucket: HistoryTimelineBucket;
  anchor: Date | null;
  latest: number;
  latestTitle?: string;
  latestRaw?: string;
  sessions: HistorySession[];
};

type ResumeExecutionMode = 'internal' | 'external';
type LegacyResumePrompt = { filePath: string; mode: ResumeExecutionMode };
type ShellLabel = 'PowerShell' | 'PowerShell 7' | 'WSL';
type BlockingNotice =
  | { type: 'shell-mismatch'; expected: ShellLabel; current: ShellLabel }
  | { type: 'external-console'; env: ShellLabel };
type ResumeStrategy = 'legacy-only' | 'experimental_resume' | 'resume+fallback' | 'force-legacy-cli';
type ResumeStartup = {
  providerId: HistorySession["providerId"];
  startupCmd: string;
  session?: HistorySession;
  /** 用于日志/调试展示的“恢复目标”标识（路径 / sessionId / latest 等）。 */
  resumeLabel: string;
  /** 以下字段主要用于 Codex 的 resume 诊断与旧版兼容。 */
  sessionId?: string | null;
  strategy?: ResumeStrategy;
  resumeHint?: 'modern' | 'legacy';
  forceLegacyCli?: boolean;
};
type InputFullscreenCloseOptions = { immediate?: boolean };

// 项目排序设置在本地存储中的键（命名空间化）
const PROJECT_SORT_STORAGE_KEY = "codexflow.projectSort";
// 全屏输入层动画时长（毫秒），需与 CSS 关键帧保持一致
const INPUT_FULLSCREEN_TRANSITION_MS = 260;
type ProjectSortKey = "recent" | "name" | "manual";

function getDir(p?: string): string {
  if (!p) return '';
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : s;
}

// 从文件名中提取时间（例如 rollout-2025-09-12T01-47-57-xxxx.jsonl -> 2025-09-12 01:47:57）
function timeFromFilename(p?: string): string {
  if (!p) return "";
  try {
    const base = (p.replace(/\\\\/g, '/').split('/').pop() || '').replace(/\.jsonl$/i, '');
    let m = base.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m) {
      const d = m[1], hh = m[2], mm = m[3], ss = m[4];
      return `${d} ${hh}:${mm}:${ss}`;
    }
    m = base.match(/(\d{4}-\d{2}-\d{2})[T_ ](\d{2})[:\-](\d{2})[:\-](\d{2})/);
    if (m) {
      const d = m[1], hh = m[2], mm = m[3], ss = m[4];
      return `${d} ${hh}:${mm}:${ss}`;
    }
    return base;
  } catch {
    return "";
  }
}

// 解析文件名中的时间为本地 Date 对象
function parseDateFromFilename(p?: string): Date | null {
  if (!p) return null;
  try {
    const base = (p.replace(/\\\\/g, '/').split('/').pop() || '').replace(/\.jsonl$/i, '');
    let m = base.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]), hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6]);
      const dt = new Date(y, mo, d, hh, mm, ss);
      return isNaN(dt.getTime()) ? null : dt;
    }
    m = base.match(/(\d{4})-(\d{2})-(\d{2})[T_ ](\d{2})[:\-](\d{2})[:\-](\d{2})/);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]), hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6]);
      const dt = new Date(y, mo, d, hh, mm, ss);
      return isNaN(dt.getTime()) ? null : dt;
    }
    return null;
  } catch {
    return null;
  }
}

function formatAsLocal(dt: Date): string {
  try {
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const y = dt.getFullYear();
    const mo = pad(dt.getMonth() + 1);
    const d = pad(dt.getDate());
    const hh = pad(dt.getHours());
    const mm = pad(dt.getMinutes());
    const ss = pad(dt.getSeconds());
    return `${y}-${mo}-${d} ${hh}:${mm}:${ss}`;
  } catch { return ''; }
}

function parseRawDate(raw?: string): Date | null {
  try {
    if (!raw || typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) {
      const num = Number(t);
      const ms = t.length <= 10 ? num * 1000 : num; // 秒或毫秒
      const dt = new Date(ms);
      return isNaN(dt.getTime()) ? null : dt;
    }
    // 先尝试原生解析（支持 ISO）
    const dtIso = new Date(t);
    if (!isNaN(dtIso.getTime())) return dtIso;
    // 再尝试常见的 "YYYY-MM-DD HH:mm:ss" 格式（视为本地时间）
    const m = t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]), hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6]);
      const dt = new Date(y, mo, d, hh, mm, ss);
      return isNaN(dt.getTime()) ? null : dt;
    }
    return null;
  } catch { return null; }
}

function toLocalDisplayTime(s: HistorySession): string {
  try {
    const fromRaw = parseRawDate(s.rawDate);
    if (fromRaw) return formatAsLocal(fromRaw);
    if (s.date) {
      const dt = new Date(s.date);
      if (!isNaN(dt.getTime())) return formatAsLocal(dt);
    }
    const fromName = parseDateFromFilename(s.filePath);
    if (fromName) return formatAsLocal(fromName);
  } catch {}
  // 回退：尽量返回已有的原始时间/ISO，避免空白
  return String(s.rawDate || s.date || '');
}

// Canonicalize path to unify UNC/Windows to WSL-like for grouping
function canonicalizePath(p: string): string {
  if (!p) return '';
  const s = String(p);
  const lower = s.toLowerCase();
  // UNC: \\wsl.localhost\Distro\... -> /...
  const uncPrefix = '\\\\wsl.localhost\\';
  if (lower.startsWith(uncPrefix)) {
    // strip the prefix, leaving: Distro\path... => /path...
    const rest = s.slice(uncPrefix.length).replace(/^([^\\]+)\\/, '');
    return ('/' + rest).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  // Windows drive: C:\... -> /mnt/c/...
  const m = s.match(/^([a-zA-Z]):\\(.*)$/);
  if (m) {
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    return (`/mnt/${drive}/${rest}`).replace(/\/+$/, '').toLowerCase();
  }
  // Already POSIX-like or other
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 归一化目录树持久化结构：
 * - 移除不存在的节点引用
 * - 强制层级至多一级（子节点的父节点不能再有父节点）
 * - 去重并补齐 rootOrder/childOrder
 */
function normalizeDirTreeStore(store: DirTreeStore, projects: Project[]): { next: DirTreeStore; changed: boolean } {
  const ids = new Set(projects.map((p) => p.id));
  const next: DirTreeStore = {
    version: 1,
    rootOrder: Array.isArray(store?.rootOrder) ? store.rootOrder.map(String).filter((id) => ids.has(id)) : [],
    parentById: {},
    childOrderByParent: {},
    expandedById: {},
    labelById: {},
  };

  const changedRef = { value: false };
  const mark = () => { changedRef.value = true; };

  // parentById：仅保留合法的 child->parent；并强制父节点为根级
  const rawParent = store?.parentById && typeof store.parentById === "object" ? store.parentById : {};
  for (const [childIdRaw, parentIdRaw] of Object.entries(rawParent)) {
    const childId = String(childIdRaw || "").trim();
    const parentId = String(parentIdRaw || "").trim();
    if (!childId || !ids.has(childId)) { mark(); continue; }
    if (!parentId || !ids.has(parentId) || parentId === childId) { mark(); continue; }
    // 禁止二级：若 parent 自己也有 parent，则将 child 提升为根
    const parentsParent = String((rawParent as any)[parentId] || "").trim();
    if (parentsParent) { mark(); continue; }
    next.parentById[childId] = parentId;
  }

  // expanded / label：仅保留存在的 id
  const rawExpanded = store?.expandedById && typeof store.expandedById === "object" ? store.expandedById : {};
  for (const [id, v] of Object.entries(rawExpanded)) {
    const pid = String(id || "").trim();
    if (!pid || !ids.has(pid)) { mark(); continue; }
    next.expandedById[pid] = v === true;
  }
  const rawLabel = store?.labelById && typeof store.labelById === "object" ? store.labelById : {};
  for (const [id, v] of Object.entries(rawLabel)) {
    const pid = String(id || "").trim();
    if (!pid || !ids.has(pid)) { mark(); continue; }
    const label = String(v || "").trim();
    if (label) next.labelById[pid] = label;
  }

  // childOrder：过滤 + 去重 + 补齐
  const rawChildOrder = store?.childOrderByParent && typeof store.childOrderByParent === "object" ? store.childOrderByParent : {};
  for (const [parentIdRaw, listRaw] of Object.entries(rawChildOrder)) {
    const parentId = String(parentIdRaw || "").trim();
    if (!parentId || !ids.has(parentId)) { mark(); continue; }
    const list = Array.isArray(listRaw) ? (listRaw as any[]).map((x) => String(x || "").trim()).filter(Boolean) : [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const cid of list) {
      if (!ids.has(cid)) { mark(); continue; }
      if (next.parentById[cid] !== parentId) continue;
      if (seen.has(cid)) { mark(); continue; }
      seen.add(cid);
      cleaned.push(cid);
    }
    next.childOrderByParent[parentId] = cleaned;
  }
  // 补齐 childOrder：扫描 parentById 中的 child，若未在顺序中则追加
  for (const [childId, parentId] of Object.entries(next.parentById)) {
    const arr = next.childOrderByParent[parentId] || [];
    if (!arr.includes(childId)) {
      next.childOrderByParent[parentId] = [...arr, childId];
      mark();
    }
  }

  // rootOrder：去重并补齐所有根节点
  const rootSet = new Set<string>();
  const dedupRoot: string[] = [];
  for (const id of next.rootOrder) {
    if (rootSet.has(id)) { mark(); continue; }
    if (next.parentById[id]) { mark(); continue; } // 不能把子节点放到 rootOrder
    rootSet.add(id);
    dedupRoot.push(id);
  }
  for (const p of projects) {
    const id = p.id;
    if (!id || next.parentById[id]) continue;
    if (!rootSet.has(id)) {
      rootSet.add(id);
      dedupRoot.push(id);
      mark();
    }
  }
  next.rootOrder = dedupRoot;

  // 发生结构修正或字段丢弃时标记 changed；否则再做一次浅比较兜底
  let changed = changedRef.value;
  if (!changed) {
    try {
      const same =
        JSON.stringify(store?.rootOrder || []) === JSON.stringify(next.rootOrder) &&
        JSON.stringify(store?.parentById || {}) === JSON.stringify(next.parentById) &&
        JSON.stringify(store?.childOrderByParent || {}) === JSON.stringify(next.childOrderByParent) &&
        JSON.stringify(store?.expandedById || {}) === JSON.stringify(next.expandedById) &&
        JSON.stringify(store?.labelById || {}) === JSON.stringify(next.labelById);
      changed = !same;
    } catch {
      changed = true;
    }
  }

  return { next, changed };
}

/**
 * 将分支名压缩为用于列表展示的文本：最多 6 个字符。
 * - 优先展示最后一段（按 `/` 分隔），避免长前缀占满空间
 * - 超出则截断，并由 UI 通过 title 展示完整信息
 */
function formatBranchLabel(branch: string): { short: string; full: string; truncated: boolean } {
  const full = String(branch || "").trim();
  if (!full) return { short: "", full: "", truncated: false };
  const tail = full.split("/").filter(Boolean).pop() || full;
  const short = tail.length > 6 ? tail.slice(0, 6) : tail;
  return { short, full, truncated: short.length !== tail.length || full !== tail };
}

/**
 * 分支标签胶囊：用于项目列表右侧显示分支（如 master）。
 * - 固定尺寸与居中排版，避免不同目录显示不一致/溢出
 * - 支持可点击（创建 worktree）与静态展示两种模式
 */
function BranchChip(props: {
  mode: "button" | "static";
  text: string;
  title?: string;
  isDetached?: boolean;
  disabled?: boolean;
      onClick?: React.MouseEventHandler<HTMLButtonElement>;
    className?: string;
  }) {
    const base =
      "relative inline-flex h-[16px] w-[44px] items-center justify-center rounded-[5px] border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] text-[8px] font-mono font-medium leading-none text-[var(--cf-text-primary)] overflow-hidden whitespace-nowrap select-none";
    const interactive =
      props.mode === "button"
        ? "transition-colors duration-apple ease-apple hover:bg-[var(--cf-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-app-bg)] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
        : "";
    const showGitPrefix = !props.isDetached && String(props.text || "").trim().length > 0;
    const textClass = `${showGitPrefix ? "flex items-center justify-center gap-0.5" : "block text-center"} w-full ${props.isDetached ? "pr-3" : ""}`;
    const combined = `${base} ${interactive} ${props.className || ""}`;

    const content = (
      <>
        <span className={textClass}>
          {showGitPrefix ? (
            <span className="opacity-80 text-[9px] leading-none" aria-hidden="true">⎇</span>
          ) : null}
          <span>{props.text}</span>
        </span>
        {props.isDetached ? (
          <TriangleAlert className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 text-amber-500" />
        ) : null}
      </>
    );

    if (props.mode === "button") {
      return (
        <button type="button" className={combined} disabled={props.disabled} title={props.title} onClick={props.onClick}>
          {content}
        </button>
      );
    }
    return (
      <span className={combined} title={props.title}>
        {content}
      </span>
    );
  }

  /**
   * 统一的 worktree 操作面板：整合了分支展示、Build/Run、Recycle/Delete 等操作。
   * 旨在固定尺寸(46px宽)内提供高密度的交互，并保持视觉整洁。
   */
	  function WorktreeControlPad(props: {
	    mode: "secondary" | "root" | "normal";
	    branch?: { short: string; full: string; isDetached: boolean; headSha?: string; disabled?: boolean; title?: string };
	    onBranchClick?: (e: React.MouseEvent) => void;
	    onBuild: (isRightClick: boolean) => void;
	    onRun: (isRightClick: boolean) => void;
	    onRecycle?: () => void;
	    onDelete?: () => void;
	    /** 删除按钮禁用原因（用于区分“删除中/回收中”等不同状态提示）。 */
	    deleteDisabledReason?: "deleting" | "recycling";
	    t: (...args: any[]) => any;
	  }) {
	    const { mode, branch, onBranchClick, onBuild, onRun, onRecycle, onDelete, t } = props;
	    const deleteDisabled = props.deleteDisabledReason === "deleting" || props.deleteDisabledReason === "recycling";
		    const deleteTitle =
		      props.deleteDisabledReason === "deleting"
		        ? t("projects:worktreeDeleting", "删除中…")
		        : props.deleteDisabledReason === "recycling"
		          ? t("projects:worktreeDeleteDisabledRecycling", "合并中…")
		          : t("projects:worktreeDelete", "删除工作区");

	    // 基础容器样式
	    const containerBase = "w-[47px] flex flex-col items-center rounded-[3px] overflow-hidden select-none isolate transition-colors duration-300";
	    // 不同模式的容器修饰
    const containerStyle =
      mode === "secondary"
        ? "bg-transparent"
        : mode === "root"
        ? "bg-transparent"
        : "bg-transparent";

    // 按钮通用样式
    const btnBase =
      "flex items-center justify-center transition-colors hover:bg-slate-200/80 dark:hover:bg-slate-700/80 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none disabled:cursor-default";
    const iconClass = "h-3 w-3 text-slate-600 dark:text-slate-400";

    if (mode === "normal") {
      // Normal 模式：仅两个按钮并排，无容器背景
      return (
        <div className="flex items-center justify-end gap-1 w-[47px]">
          <button
            className="h-6 w-6 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
            title={t("projects:build", "Build")}
            onClick={(e) => { e.stopPropagation(); onBuild(false); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onBuild(true); }}
          >
            <Hammer className={iconClass} />
          </button>
          <button
            className="h-6 w-6 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
            title={t("projects:run", "Run")}
            onClick={(e) => { e.stopPropagation(); onRun(false); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRun(true); }}
          >
            <Play className={iconClass} />
          </button>
        </div>
      );
    }

    return (
      <div className={`${containerBase} ${containerStyle} py-0.5`}>
         {/* Branch Area */}
         <div className="h-3.5 mb-0.5 flex items-center justify-center px-[2px] w-full">
            {branch && (
               <BranchChip
                 mode={mode === "root" ? "button" : "static"}
                 text={branch.short}
                 isDetached={branch.isDetached}
                 disabled={branch.disabled}
                 title={branch.title}
                 onClick={onBranchClick}
                 className="h-full text-[9px] font-semibold"
               />
            )}
         </div>

         {/* Actions Grid */}
         <div className="grid grid-cols-2 gap-[1px] w-full px-[2px]">
            <button
               className={`${btnBase} h-[14px] rounded-[3px]`}
               title={t("projects:build", "Build")}
               onClick={(e) => { e.stopPropagation(); onBuild(false); }}
               onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onBuild(true); }}
            >
               <Hammer className={iconClass} />
            </button>
            <button
               className={`${btnBase} h-[14px] rounded-[3px]`}
               title={t("projects:run", "Run")}
               onClick={(e) => { e.stopPropagation(); onRun(false); }}
               onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRun(true); }}
            >
               <Play className={iconClass} />
            </button>

            {mode === "secondary" && (
               <>
		                 <button
		                    className={`${btnBase} h-[14px] rounded-[3px]`}
		                    title={t("projects:worktreeRecycle", "合并到目标分支")}
		                    onClick={(e) => { e.stopPropagation(); onRecycle?.(); }}
		                 >
	                    <GitMerge className={iconClass} />
	                 </button>
	                 <button
	                    className={`${btnBase} h-[14px] rounded-[3px]`}
	                    title={deleteTitle}
	                    disabled={deleteDisabled}
	                    onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
	                 >
	                    <Trash2
	                      className={
	                        deleteDisabled
	                          ? "h-3 w-3 text-slate-400 dark:text-slate-500"
	                          : "h-3 w-3 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 transition-colors"
	                      }
	                    />
                 </button>
               </>
            )}
         </div>
      </div>
    );
  }
  /**
   * 迷你图标按钮：用于目录树展开/收起等超小尺寸交互。 * 说明：不复用通用 `Button` 组件，避免 Tailwind 冲突类（例如 h/w）导致尺寸不稳定，从而挤压文本产生错误截断。
 */
function MiniIconButton(props: {
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-[12px] w-[12px] items-center justify-center rounded-apple-sm p-0 text-[var(--cf-text-secondary)] transition-all duration-apple ease-apple hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-app-bg)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
      title={props.title}
      aria-label={props.ariaLabel || props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/**
 * 计算多引擎并行模式下的总实例数（用于限制 ≤ 8）。
 */
function sumWorktreeProviderCounts(counts: Partial<WorktreeProviderCounts> | null | undefined): number {
  try {
    const c = counts && typeof counts === "object" ? counts : {};
    const n = (x: any) => Math.max(0, Math.floor(Number(x) || 0));
    return n((c as any).codex) + n((c as any).claude) + n((c as any).gemini);
  } catch {
    return 0;
  }
}

/**
 * 根据“worktree 创建”面板的引擎选择，生成实例队列（用于与复用子 worktree 做 1:1 分配）。
 * - 单选模式：始终返回 1 个实例（与现有面板行为保持一致）
 * - 并行混合模式：按 codex/claude/gemini 顺序展开计数
 */
function buildWorktreeProviderQueue(args: {
  useMultipleModels: boolean;
  singleProviderId: GitWorktreeProviderId;
  multiCounts: Partial<WorktreeProviderCounts> | null | undefined;
}): GitWorktreeProviderId[] {
  const order: GitWorktreeProviderId[] = ["codex", "claude", "gemini"];
  if (args.useMultipleModels) {
    const c = args.multiCounts && typeof args.multiCounts === "object" ? args.multiCounts : {};
    const out: GitWorktreeProviderId[] = [];
    for (const pid of order) {
      const n = Math.max(0, Math.floor(Number((c as any)[pid]) || 0));
      for (let i = 0; i < n; i++) out.push(pid);
    }
    return out;
  }
  const single = String(args.singleProviderId || "codex").trim().toLowerCase();
  if (single === "codex" || single === "claude" || single === "gemini") return [single as GitWorktreeProviderId];
  return ["codex"];
}

/**
 * 将实例队列（providerId 列表）聚合为主进程 worktree 创建 API 所需的 instances 结构。
 */
function collapseWorktreeProviderQueueToInstances(queue: GitWorktreeProviderId[]): Array<{ providerId: GitWorktreeProviderId; count: number }> {
  const counts: Record<GitWorktreeProviderId, number> = { codex: 0, claude: 0, gemini: 0 };
  for (const pid of Array.isArray(queue) ? queue : []) {
    if (pid === "codex" || pid === "claude" || pid === "gemini") counts[pid]++;
  }
  const out: Array<{ providerId: GitWorktreeProviderId; count: number }> = [];
  for (const pid of ["codex", "claude", "gemini"] as const) {
    if (counts[pid] > 0) out.push({ providerId: pid, count: counts[pid] });
  }
  return out;
}

/**
 * 按给定顺序与上限裁剪已选 id 列表，确保：去重、仅保留允许项、且不超过 limit。
 */
function trimSelectedIdsByOrder(args: { selectedIds: string[]; allowedOrder: string[]; limit: number }): string[] {
  const selected = Array.isArray(args.selectedIds) ? args.selectedIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const order = Array.isArray(args.allowedOrder) ? args.allowedOrder.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const limit = Math.max(0, Math.floor(Number(args.limit) || 0));
  if (selected.length === 0 || order.length === 0 || limit === 0) return [];
  const selectedSet = new Set(selected);
  const out: string[] = [];
  for (const id of order) {
    if (!selectedSet.has(id)) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 判断两个字符串数组是否完全相等（顺序与内容一致）。
 */
function areStringArraysEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

/**
 * 将 WSL/Windows 的绝对路径（若位于项目根内）转换为相对路径，用于 worktree 创建时的“可复用提示词”。
 * - 关键目标：避免把源项目的绝对路径直接分发到多个 worktree（不同 worktree 根目录不同，会导致路径失效）
 * - 若无法转换（不在项目内/无法识别），则返回原始路径文本
 */
function toWorktreePromptRelPath(args: { pathText: string; projectWinRoot?: string; projectWslRoot?: string }): string {
  const raw = String(args.pathText || "").trim();
  if (!raw) return "";

  // 1) 先尝试按 WSL/POSIX 绝对路径处理
  try {
    const p = raw.replace(/\\/g, "/");
    const root = String(args.projectWslRoot || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (p.startsWith("/") && root && root.startsWith("/")) {
      const normP = p.replace(/\/+$/, "");
      const normRoot = root;
      if (normP === normRoot) return ".";
      if (normP.startsWith(normRoot + "/")) {
        const rel = normP.slice(normRoot.length).replace(/^\/+/, "");
        return rel || ".";
      }
    }
  } catch {}

  // 2) 再尝试按 Windows 盘符/UNC 绝对路径处理（大小写不敏感）
  try {
    const p = raw.replace(/\//g, "\\").replace(/[\\]+$/, "");
    const rootRaw = String(args.projectWinRoot || "").trim();
    const root = rootRaw.replace(/\//g, "\\").replace(/[\\]+$/, "");
    if (root && (/^[a-zA-Z]:\\/.test(p) || p.startsWith("\\\\")) && (/^[a-zA-Z]:\\/.test(root) || root.startsWith("\\\\"))) {
      const pKey = p.toLowerCase();
      const rootKey = root.toLowerCase();
      if (pKey === rootKey) return ".";
      if (pKey.startsWith(rootKey + "\\")) {
        const rel = p.slice(root.length).replace(/^[\\]+/, "").replace(/\\/g, "/");
        return rel || ".";
      }
    }
  } catch {}

  // 3) 已是相对路径或无法转换：尽量统一分隔符为 /
  return raw.replace(/\\/g, "/");
}

/**
 * 将 worktree 创建面板中的 chips + 草稿合并为最终提示词：
 * - 每个 chip 独占一行，并用反引号包裹
 * - 项目内绝对路径会被转换为相对路径，保证对不同 worktree 可复用
 */
function compileWorktreePromptText(args: { chips: PathChip[]; draft: string; projectWinRoot?: string; projectWslRoot?: string }): string {
  const chips = Array.isArray(args.chips) ? args.chips : [];
  const draft = String(args.draft || "");
  const parts: string[] = [];
  if (chips.length > 0) {
    parts.push(
      chips
        .map((c) => {
          const raw = String((c as any)?.wslPath || (c as any)?.winPath || (c as any)?.fileName || "").trim();
          const p = toWorktreePromptRelPath({ pathText: raw, projectWinRoot: args.projectWinRoot, projectWslRoot: args.projectWslRoot });
          return p ? ("`" + p + "`") : "";
        })
        .filter(Boolean)
        .join("\n"),
    );
  }
  const trimmedDraft = draft.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (trimmedDraft) {
    if (parts.length > 0) parts.push("");
    parts.push(trimmedDraft);
  }
  return parts.join("\n");
}

/**
 * 基于 Provider + 终端模式，构造“带初始提示词注入”的启动命令。
 * - 仅用于 worktree 创建后的首次启动；不改动既有 Provider 的环境选择策略
 */
function buildProviderStartupCmdWithInitialPrompt(args: {
  providerId: GitWorktreeProviderId;
  terminalMode: TerminalMode;
  baseCmd: string;
  prompt: string;
}): string {
  const base = String(args.baseCmd || "").trim();
  const prompt = String(args.prompt || "");
  if (!base) return "";
  if (!prompt.trim()) return base;

  if (args.terminalMode !== "wsl") {
    if (args.providerId === "claude") {
      const baseArgv = splitCommandLineToArgv(base);
      const argv = baseArgv.length > 0 ? baseArgv : ["claude"];
      return buildPowerShellCall([...argv, prompt]);
    }
    if (args.providerId === "gemini") {
      const baseArgv = splitCommandLineToArgv(base);
      const argv = baseArgv.length > 0 ? baseArgv : ["gemini"];
      const hasI = argv.includes("-i") || argv.includes("--interactive");
      return buildPowerShellCall(hasI ? [...argv, prompt] : [...argv, "-i", prompt]);
    }
    // codex：可能包含 `$env:...;` 等脚本片段，避免强拆 argv，直接拼接参数
    return `${base} ${powerShellArgToken(prompt)}`.trim();
  }

  if (args.providerId === "gemini") {
    const hasI = base.includes(" -i ") || /\s-i\s/.test(base) || /\s--interactive\s/.test(base);
    return hasI ? `${base} ${bashSingleQuote(prompt)}`.trim() : `${base} -i ${bashSingleQuote(prompt)}`.trim();
  }
  if (args.providerId === "claude") {
    return `${base} ${bashSingleQuote(prompt)}`.trim();
  }
  return `${base} ${bashSingleQuote(prompt)}`.trim();
}

/**
 * 将输入/输出文本压缩为用于提交信息的短摘要（单行、限长）。
 */
function summarizeForCommitMessage(text: string, maxLen: number = 72): string {
  try {
    const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!raw) return "";
    const first = raw.split("\n").map((x) => x.trim()).find((x) => !!x) || "";
    const oneLine = first.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLen) return oneLine;
    const clipped = oneLine.slice(0, Math.max(0, maxLen - 3)).trim();
    return clipped ? `${clipped}...` : oneLine.slice(0, maxLen);
  } catch {
    return "";
  }
}

/**
 * 中文说明：解析回收接口返回的 stash 列表，并生成 UI 展示文本与建议恢复命令。
 * - 目标：尽量保持“已暂存/未暂存”的原始状态（先恢复 staged，再恢复 unstaged）。
 */
function parseRecycleStashes(details: any, t: any): {
  items: Array<{ kind: "staged" | "unstaged"; sha: string }>;
  stashLine: string;
  restoreCmd: string;
  stashMsgForWarning: string;
  stashShaForWarning: string;
} {
  const stashesRaw: any[] = Array.isArray(details?.stashes) ? details.stashes : [];
  const items = stashesRaw
    .map((s: any) => ({ kind: String(s?.kind || "").trim(), sha: String(s?.sha || "").trim() }))
    .filter((s: any): s is { kind: "staged" | "unstaged"; sha: string } => (s.kind === "staged" || s.kind === "unstaged") && Boolean(s.sha));

  const kindLabelOf = (kind: "staged" | "unstaged") =>
    kind === "staged"
      ? (t("projects:worktreeRecycleStashKindStaged", "已暂存") as string)
      : (t("projects:worktreeRecycleStashKindUnstaged", "未暂存/未跟踪") as string);

  const stashListText = items.map((s) => `- ${kindLabelOf(s.kind)}: ${s.sha}`).join("\n");
  const stashLine =
    items.length > 0
      ? (t("projects:worktreeRecycleStashInfo", "主 worktree 改动已保存到 stash：{msg} {sha}", { msg: `\n${stashListText}`, sha: "" }) as string).trim()
      : "";

  let restoreCmd = String(details?.suggestedRestoreCommand || "").trim();
  if (!restoreCmd) {
    const stagedSha = items.find((s) => s.kind === "staged")?.sha;
    const unstagedSha = items.find((s) => s.kind === "unstaged")?.sha;
    const cmds: string[] = [];
    if (stagedSha) cmds.push(`git stash apply --index ${stagedSha}`);
    if (unstagedSha) cmds.push(stagedSha ? `git stash apply ${unstagedSha}` : `git stash apply --index ${unstagedSha}`);
    restoreCmd = cmds.join("\n");
  }

  return {
    items,
    stashLine,
    restoreCmd,
    stashMsgForWarning: items.length > 0 ? `\n${stashListText}` : "",
    stashShaForWarning: items.map((s) => s.sha).join(" "),
  };
}

/**
 * 构造自动提交信息：包含来源（user/agent）+ 内容前缀摘要。
 */
function buildAutoCommitMessage(source: "user" | "agent", text: string): string {
  const head = summarizeForCommitMessage(text, 72);
  const label = source === "agent" ? "agent" : "user";
  const body = head || (source === "agent" ? "agent output" : "user input");
  return `auto(${label}): ${body}`.trim();
}

/**
 * 将 Windows/本地路径转为用于缓存/字典的 Key（Windows 下大小写不敏感）。
 */
	function toDirKeyForCache(absPath: string): string {
	  try {
    const raw = String(absPath || "").trim();
    if (!raw) return "";
    return raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(absPath || "");
	  }
	}

	/**
	 * 中文说明：将终端运行模式映射为 UI 展示标签。
	 */
	const toShellLabel = (mode: TerminalMode): ShellLabel => {
	  if (mode === "pwsh") return "PowerShell 7";
	  if (mode === "windows") return "PowerShell";
	  return "WSL";
	};

	/**
	 * 中文说明：将用户设置/旧存储中的 terminal 字段归一化为内部 TerminalMode。
	 */
	const normalizeTerminalMode = (raw: any): TerminalMode => {
	  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	  if (v === 'pwsh') return 'pwsh';
	  if (v === 'windows') return 'windows';
	  return 'wsl';
	};

	/**
	 * 中文说明：判断当前终端是否属于 Windows 家族（PowerShell / PowerShell 7）。
	 */
	const isWindowsLike = (mode: TerminalMode): boolean => mode !== 'wsl';

function normDir(p?: string): string { return canonicalizePath(getDir(p)); }

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HISTORY_UNKNOWN_GROUP_KEY = 'unknown-date';

type HistoryTimelineBucket = 'today' | 'yesterday' | 'last7' | 'month' | 'unknown';
type HistoryTimelineMeta = { key: string; bucket: HistoryTimelineBucket; anchor: Date | null };

function startOfLocalDay(dt: Date): Date {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function historySessionDate(session?: HistorySession): Date | null {
  if (!session) return null;
  const fromRaw = parseRawDate(session.rawDate);
  if (fromRaw) return fromRaw;
  if (session.date) {
    const dt = new Date(session.date);
    if (!isNaN(dt.getTime())) return dt;
  }
  return parseDateFromFilename(session.filePath);
}

function resolveHistoryTimelineMeta(session?: HistorySession, base: Date = new Date()): HistoryTimelineMeta {
  if (!session) return { key: HISTORY_UNKNOWN_GROUP_KEY, bucket: 'unknown', anchor: null };
  const anchor = historySessionDate(session);
  if (!anchor) return { key: HISTORY_UNKNOWN_GROUP_KEY, bucket: 'unknown', anchor: null };
  const todayStart = startOfLocalDay(base);
  const sessionStart = startOfLocalDay(anchor);
  const diffDays = Math.floor((todayStart.getTime() - sessionStart.getTime()) / DAY_IN_MS);
  if (diffDays <= 0) return { key: 'today', bucket: 'today', anchor };
  if (diffDays === 1) return { key: 'yesterday', bucket: 'yesterday', anchor };
  if (diffDays < 7) return { key: 'last7', bucket: 'last7', anchor };
  const month = (anchor.getMonth() + 1).toString().padStart(2, '0');
  return { key: `month-${anchor.getFullYear()}-${month}`, bucket: 'month', anchor };
}

function historyTimelineGroupKey(session?: HistorySession, base?: Date): string {
  return resolveHistoryTimelineMeta(session, base || new Date()).key;
}

// 统一计算相对时间标签，避免列表渲染时重复做差值
function describeRelativeAge(anchor: Date | null, base: Date): string {
  if (!anchor) return '';
  const safeBase = base.getTime();
  const diffMs = Math.max(0, safeBase - anchor.getTime());
  const HOUR_IN_MS = 60 * 60 * 1000;
  if (diffMs < DAY_IN_MS) {
    const hours = Math.max(1, Math.floor(diffMs / HOUR_IN_MS));
    return `${hours}h`;
  }
  const days = Math.max(1, Math.floor(diffMs / DAY_IN_MS));
  return `${days}d`;
}

// ---------- Helpers ----------

	const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	const UUID_REGEX_TEXT = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
	/**
	 * 中文说明：从通知/列表触发 tab 聚焦时的默认延迟（毫秒）。
	 * 用于避免与输入框编辑等状态切换产生竞争。
	 */
	const TAB_FOCUS_DELAY = 220;

function isUuidLike(value?: string | null): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return UUID_REGEX.test(trimmed);
}

function pickUuidFromString(text?: string | null): string | null {
  if (!text) return null;
  const match = String(text).match(UUID_REGEX);
  return match ? match[0] : null;
}

function inferSessionUuid(session?: HistorySession, filePath?: string): string | null {
  const fromId = pickUuidFromString(session?.id);
  if (fromId) return fromId;
  const base = typeof filePath === 'string' ? filePath.replace(/\\/g, '/').split('/').pop() : undefined;
  const fromPath = pickUuidFromString(base);
  return fromPath;
}

function toWindowsResumePath(raw: string): string {
  try {
    const s = String(raw || '');
    const m = s.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (m) {
      const drive = m[1].toUpperCase();
      const rest = m[2].replace(/\//g, '\\');
      return `${drive}:\\${rest}`;
    }
    return s;
  } catch {
    return String(raw || '');
  }
}

	/**
	 * 中文说明：历史标题在列表中的最大显示字符数（超出则截断）。
	 */
	const HISTORY_TITLE_MAX_CHARS = 48;

	/**
	 * 中文说明：将文本裁剪到指定长度并追加省略号。
	 */
	const clampText = (s: string, max: number) => {
	  const ss = String(s || "");
	  return ss.length > max ? ss.slice(0, max - 1) + "…" : ss;
	};

const fmtShort = (ts: number) => new Date(ts).toLocaleString();

function fmtIsoDateTime(iso?: string): string {
  try {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(iso || '');
  }
}

// 统一将多种时间表示（Date/ISO/数字秒或毫秒/常见格式）规范化为 ISO 字符串
function normalizeMsToIso(v: any): string {
  try {
    // Date 实例
    if (v instanceof Date) {
      const dt = v as Date;
      return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    // 数值：允许秒或毫秒
    if (typeof v === 'number' && !Number.isNaN(v)) {
      const ms = v < 1e12 ? v * 1000 : v;
      const dt = new Date(ms);
      return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    // 字符串：优先走健壮解析，其次再尝试原生解析
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return new Date().toISOString();
      // 纯数字字符串：按长度判断秒/毫秒
      if (/^\d+(\.\d+)?$/.test(t)) {
        const num = Number(t);
        const ms = t.length <= 10 ? num * 1000 : num;
        const dt = new Date(ms);
        return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
      }
      const parsed = parseRawDate(t);
      if (parsed) return parsed.toISOString();
      const dt = new Date(t);
      return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    // 其他类型：回退当前时间，避免空值
    return new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function normalizeResumeMode(mode: any): 'modern' | 'legacy' | 'unknown' {
  if (mode === 'modern') return 'modern';
  if (mode === 'legacy') return 'legacy';
  return 'unknown';
}

type CompletionPreferences = {
  badge: boolean;
  system: boolean;
  sound: boolean;
};

// 网络代理偏好（与设置对话框保持一致）
type NetworkPrefs = {
  proxyEnabled: boolean;
  proxyMode: "system" | "custom";
  proxyUrl: string;
  noProxy: string;
};

const DEFAULT_COMPLETION_PREFS: CompletionPreferences = {
  badge: true,
  system: true,
  sound: true,
};

const normalizeThemeSetting = (value: any): ThemeSetting => {
  if (value === "light" || value === "dark") return value;
  return "system";
};

// OSC 9; 是终端的 Operating System Command #9，用于终端/PTY 向宿主发送通知类信息
const OSC_NOTIFICATION_PREFIX = oscBufferDefaults.prefix;
const OSC_TERMINATOR_BEL = '\u0007';
const OSC_TERMINATOR_ST = '\u001b\\';
const MAX_OSC_BUFFER_LENGTH = oscBufferDefaults.maxLength;
const OSC_TAIL_WINDOW = oscBufferDefaults.tailWindow;
// 软限制：达到此大小时发出警告（但不裁剪），帮助提前发现问题
const OSC_BUFFER_SOFT_LIMIT = Math.floor(MAX_OSC_BUFFER_LENGTH * 0.75);

function normalizeCompletionPrefs(raw?: Partial<CompletionPreferences> | null): CompletionPreferences {
  return {
    badge: raw?.badge ?? DEFAULT_COMPLETION_PREFS.badge,
    system: raw?.system ?? DEFAULT_COMPLETION_PREFS.system,
    sound: raw?.sound ?? DEFAULT_COMPLETION_PREFS.sound,
  };
}

function isAgentCompletionMessage(message: string): boolean {
  const normalized = message.trim();
  // 中文说明：部分引擎会发出“空 payload”的 OSC 9; 通知（仅用于提示宿主“已完成”），这里也应视为完成事件。
  // 为空时后续会走默认文案（如“点击查看详情”），避免整条完成链路失效。
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (lower.includes('approval requested')) return false;
  if (lower.startsWith('codex wants to edit')) return false;
  return true;
}

/**
 * 中文说明：清理完成通知前缀，避免正文出现 agent-turn-complete。
 */
function normalizeCompletionPreview(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  return text.replace(/^agent-turn-complete\s*[:：]?\s*/i, "").trim();
}

// 筛选键规范化：将等价的 tags 与 type 统一到一个"规范键"，用于去重显示与匹配
function canonicalFilterKey(k?: string): string {
  try {
    const raw = String(k || "").toLowerCase().trim();
    if (!raw) return "";
    // 仅将"解释性子类型"做合并；不合并 message.input_text / message.output_text / message.text
    // 统一"说明"键：session_meta.instructions / session_instructions / instructions / user_instructions / message.user_instructions / user instructions -> instructions
    if (raw === 'session_meta.instructions' || raw === 'session_instructions' || raw === 'instructions' || raw === 'user_instructions' || raw === 'message.user_instructions' || raw === 'user instructions') return 'instructions';
    // 统一"摘要"键：reasoning.summary / summary -> summary
    if (raw === 'reasoning.summary' || raw === 'summary') return 'summary';
    if (raw === "message.user_instructions" || raw === "user_instructions") return "user_instructions";
    if (raw === "message.environment_context" || raw === "environment_context") return "environment_context";
    // 其余保持原样：reasoning.summary / function_call / function_output / session_meta.* / state / git 等
    return raw;
  } catch { return String(k || "").toLowerCase(); }
}

// 从一条内容项提取规范键集合（包含 type 与 tags 的规范化结果）
function keysOfItemCanonical(it: any): string[] {
  const out: string[] = [];
  try {
    const ty = canonicalFilterKey(String((it?.type || "")));
    if (ty) out.push(ty);
  } catch {}
  try {
    const tags: string[] = Array.isArray(it?.tags) ? (it.tags as string[]) : [];
    for (const t of tags) {
      const k = canonicalFilterKey(t);
      if (k) out.push(k);
    }
  } catch {}
  return Array.from(new Set(out));
}

// ---------- UI Components ----------

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
      aria-label={ok ? "Connected" : "Warning"}
    />
  );
}

function TerminalView({
  logs,
  tabId,
  ptyId,
  attachTerminal,
  onContextMenuDebug,
  theme,
}: {
  logs: string[];
  tabId: string;
  ptyId?: string | null;
  attachTerminal?: (tabId: string, el: HTMLDivElement) => void;
  onContextMenuDebug?: (event: React.MouseEvent) => void;
  theme: TerminalThemeDefinition;
}) {
  const { t } = useTranslation(['terminal']);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const scrollPulseRef = useRef<number | null>(null);
  const palette = theme?.palette;
  const backgroundColor = palette?.background || "var(--cf-surface-muted)";
  const placeholderColor = palette?.foreground || "var(--cf-text-primary)";
  const chrome = useMemo(() => buildTerminalChromeColors(theme), [theme]);
  const frameStyle = useMemo<React.CSSProperties>(
    () => ({
      backgroundColor,
      borderColor: chrome.frameBorder,
      boxShadow: chrome.frameShadow,
      ["--cf-scrollbar-thumb" as const]: chrome.scrollbarThumb,
      ["--cf-scrollbar-thumb-hover" as const]: chrome.scrollbarThumbHover,
      ["--cf-scrollbar-track" as const]: chrome.scrollbarTrack,
      ["--cf-terminal-bg" as const]: backgroundColor,
      ["--cf-terminal-scrollbar-thumb" as const]: chrome.scrollbarThumb,
      ["--cf-terminal-scrollbar-thumb-hover" as const]: chrome.scrollbarThumbHover,
      ["--cf-terminal-scrollbar-track" as const]: chrome.scrollbarTrack,
      ["--cf-terminal-scrollbar-border" as const]: chrome.scrollbarBorder,
      ["--cf-terminal-scrollbar-glow" as const]: chrome.scrollbarGlow,
    }),
    [backgroundColor, chrome]
  );
  const deactivateScrollChrome = useCallback(() => {
    const chromeNode = chromeRef.current;
    if (!chromeNode) return;
    if (chromeNode.matches(":hover")) return;
    chromeNode.removeAttribute("data-scroll-active");
  }, []);
  const triggerScrollChrome = useCallback(
    (holdMs = 900) => {
      const chromeNode = chromeRef.current;
      if (!chromeNode || typeof window === "undefined") return;
      chromeNode.setAttribute("data-scroll-active", "1");
      if (scrollPulseRef.current) {
        window.clearTimeout(scrollPulseRef.current);
      }
      scrollPulseRef.current = window.setTimeout(() => {
        deactivateScrollChrome();
        scrollPulseRef.current = null;
      }, holdMs);
    },
    [deactivateScrollChrome]
  );
  const bindViewportScroll = useCallback((): (() => void) | null => {
    const viewport = hostRef.current?.querySelector(".xterm-viewport") as HTMLDivElement | null;
    if (!viewport) return null;
    const handleScroll = () => triggerScrollChrome();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleScroll);
    };
  }, [triggerScrollChrome]);
  useEffect(() => {
    // 即使 PTY 已退出（无 ptyId），也把持久容器重新挂到宿主，避免"黑屏"
    if (hostRef.current && attachTerminal) {
      attachTerminal(tabId, hostRef.current);
      setMounted(true);
    }
  }, [attachTerminal, tabId, ptyId]);
  useEffect(() => {
    if (!hostRef.current) return;
    let cleanupViewport: (() => void) | null = bindViewportScroll();
    if (!cleanupViewport) {
      const observer = new MutationObserver(() => {
        if (cleanupViewport) return;
        cleanupViewport = bindViewportScroll();
        if (cleanupViewport) {
          observer.disconnect();
          triggerScrollChrome(1200);
        }
      });
      observer.observe(hostRef.current, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        cleanupViewport?.();
        if (typeof window !== "undefined" && scrollPulseRef.current) {
          window.clearTimeout(scrollPulseRef.current);
          scrollPulseRef.current = null;
        }
        chromeRef.current?.removeAttribute("data-scroll-active");
      };
    }
    triggerScrollChrome(1200);
    return () => {
      cleanupViewport?.();
      if (typeof window !== "undefined" && scrollPulseRef.current) {
        window.clearTimeout(scrollPulseRef.current);
        scrollPulseRef.current = null;
      }
      chromeRef.current?.removeAttribute("data-scroll-active");
    };
  }, [bindViewportScroll, triggerScrollChrome, theme]);
  useEffect(() => {
    if (mounted) {
      triggerScrollChrome(1000);
    }
  }, [mounted, triggerScrollChrome]);
  return (
    <div
      className="relative h-full min-h-0"
      onContextMenu={(event) => {
        if (onContextMenuDebug) {
          onContextMenuDebug(event);
        }
      }}
    >
      {/* 外层容器负责视觉（圆角/背景/阴影），并裁剪内部，保证四角对称 */}
      <div
        ref={chromeRef}
        className="cf-terminal-chrome h-full min-h-[320px] w-full rounded-lg overflow-hidden border [background-clip:padding-box]"
        style={frameStyle}
        onMouseEnter={() => triggerScrollChrome(1400)}
        onMouseLeave={deactivateScrollChrome}
      >
        {/* 纯净宿主：无 padding/滚动，避免 fit 计算偏差；xterm 内部自带滚动 */}
        <div ref={hostRef} className="h-full w-full overflow-hidden" />
        {/* 初始占位：终端挂载后隐藏，避免与 xterm 重叠 */}
        <pre className={`whitespace-pre-wrap font-mono text-sm leading-6 p-3 opacity-70 ${mounted ? 'hidden' : ''}`} style={{ color: placeholderColor }}>
          {logs.length === 0 ? (
            <span className="opacity-60">{t('terminal:readyPlaceholder')}</span>
          ) : (
            logs.map((l, i) => <div key={i}>{l}</div>)
          )}
        </pre>
      </div>
    </div>
  );
}

export {
  CHIP_COMMIT_RELEASE_DELAY_MS,
  GEMINI_NOTIFY_ENV_KEYS,
  CLAUDE_NOTIFY_ENV_KEYS,
  PROJECT_SORT_STORAGE_KEY,
  INPUT_FULLSCREEN_TRANSITION_MS,
  OSC_NOTIFICATION_PREFIX,
  OSC_TERMINATOR_BEL,
  OSC_TERMINATOR_ST,
  MAX_OSC_BUFFER_LENGTH,
  OSC_TAIL_WINDOW,
  OSC_BUFFER_SOFT_LIMIT,
  DEFAULT_COMPLETION_PREFS,
  normalizeThemeSetting,
  uid,
  buildProviderItemIndex,
  buildGeminiNotifyEnv,
  buildProviderNotifyEnv,
  getProviderIconSrc,
  getDir,
  timeFromFilename,
  parseDateFromFilename,
  formatAsLocal,
  parseRawDate,
  toLocalDisplayTime,
  canonicalizePath,
  normalizeDirTreeStore,
  formatBranchLabel,
  BranchChip,
  WorktreeControlPad,
  MiniIconButton,
  sumWorktreeProviderCounts,
  buildWorktreeProviderQueue,
  collapseWorktreeProviderQueueToInstances,
  trimSelectedIdsByOrder,
  areStringArraysEqual,
  toWorktreePromptRelPath,
  compileWorktreePromptText,
  buildProviderStartupCmdWithInitialPrompt,
  summarizeForCommitMessage,
  parseRecycleStashes,
  buildAutoCommitMessage,
  toDirKeyForCache,
  toShellLabel,
  normalizeTerminalMode,
  isWindowsLike,
  normDir,
  TAB_FOCUS_DELAY,
  HISTORY_TITLE_MAX_CHARS,
  clampText,
  HISTORY_UNKNOWN_GROUP_KEY,
  startOfLocalDay,
  historySessionDate,
  resolveHistoryTimelineMeta,
  historyTimelineGroupKey,
  describeRelativeAge,
  isUuidLike,
  pickUuidFromString,
  inferSessionUuid,
  toWindowsResumePath,
  fmtIsoDateTime,
  normalizeMsToIso,
  normalizeResumeMode,
  normalizeCompletionPrefs,
  isAgentCompletionMessage,
  normalizeCompletionPreview,
  canonicalFilterKey,
  keysOfItemCanonical,
  StatusDot,
  TerminalView,
};

export type {
  TerminalMode,
  ConsoleTab,
  BuildRunAction,
  BuildRunDialogState,
  DirLabelDialogState,
  GitWorktreeProviderId,
  ExternalGitToolId,
  WorktreeProviderCounts,
  WorktreeCreateDialogState,
  ForkPointOption,
  WorktreeRecycleDialogState,
  BaseWorktreeDirtyDialogState,
  WorktreeDeleteDialogState,
  WorktreePostRecycleDialogState,
  GitActionErrorDialogState,
  WorktreeCreateProgressState,
  WorktreeRecycleProgressState,
  NoticeDialogState,
  MessageContent,
  HistoryMessage,
  HistorySession,
  HistoryTimelineGroup,
  ResumeExecutionMode,
  LegacyResumePrompt,
  ShellLabel,
  BlockingNotice,
  ResumeStrategy,
  ResumeStartup,
  InputFullscreenCloseOptions,
  ProjectSortKey,
  HistoryTimelineBucket,
  HistoryTimelineMeta,
  CompletionPreferences,
  NetworkPrefs,
};
