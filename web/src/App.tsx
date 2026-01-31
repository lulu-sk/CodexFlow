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

// 发送命令后延迟清理粘贴图片 3 分钟，避免命令执行期间文件提前被删除
const CHIP_COMMIT_RELEASE_DELAY_MS = 180_000;
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

const toShellLabel = (mode: TerminalMode): ShellLabel => {
  if (mode === 'pwsh') return 'PowerShell 7';
  if (mode === 'windows') return 'PowerShell';
  return 'WSL';
};
const normalizeTerminalMode = (raw: any): TerminalMode => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'pwsh') return 'pwsh';
  if (v === 'windows') return 'windows';
  return 'wsl';
};
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

const HISTORY_TITLE_MAX_CHARS = 48;
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
  if (!normalized) return false;
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

export default function CodexFlowManagerUI() {
  const { t, i18n } = useTranslation(["projects", "history", "terminal", "settings", "common", "about"]);
  const localeForI18n = useMemo(() => {
    const raw = String(i18n.language || "").toLowerCase();
    const base = raw.split("-")[0] || raw;
    return { raw, base };
  }, [i18n.language]);
  const resolveLocalizedText = React.useCallback((locales?: Record<string, string>, fallback?: string) => {
    if (locales && typeof locales === "object") {
      if (localeForI18n.raw && locales[localeForI18n.raw]) return locales[localeForI18n.raw];
      if (localeForI18n.base && locales[localeForI18n.base]) return locales[localeForI18n.base];
      const first = Object.values(locales)[0];
      if (first) return first;
    }
    return fallback || "";
  }, [localeForI18n]);
  // UI 调试开关：改为读取统一调试配置
  const uiDebugEnabled = React.useCallback(() => {
    try { return !!(window as any)?.host?.debug && !!((window as any).__cf_ui_debug_cache__); } catch { return false; }
  }, []);
  // 统一日志（仅在开启时输出）：优先写入主进程 perf.log；回退到 console
  const uiLog = React.useCallback((msg: string) => {
    if (!uiDebugEnabled()) return;
    try { (window as any).host?.utils?.perfLog?.(`[ui] ${msg}`); } catch { try { console.log(`[ui] ${msg}`); } catch {} }
  }, [uiDebugEnabled]);
  const notificationsDebugEnabled = React.useCallback(() => {
    try { return !!(window as any).__cf_notif_debug_cache__; } catch { return true; }
  }, []);
  const notifyLog = React.useCallback((msg: string) => {
    if (!notificationsDebugEnabled()) return;
    try { (window as any).host?.utils?.perfLog?.(`[notifications.renderer] ${msg}`); } catch {}
  }, [notificationsDebugEnabled]);
  // 是否显示右键调试菜单：开发环境、UI 调试开关或显式开关
  // 用于触发 memo 重新计算的轻量状态（由 debug.onChanged 事件驱动）
  const [debugRefreshTick, setDebugRefreshTick] = React.useState(0);
  const showNotifDebugMenu = React.useMemo(() => {
    try { const mode = (window as any).__cf_notif_menu_mode__ as 'auto'|'forceOn'|'forceOff'|undefined; if (mode === 'forceOn') return true; if (mode === 'forceOff') return false; } catch {}
    try { if (uiDebugEnabled()) return true; } catch {}
    try { if (notificationsDebugEnabled()) return true; } catch {}
    try { if ((import.meta as any)?.env?.DEV) return true; } catch {}
    return false;
  }, [notificationsDebugEnabled, uiDebugEnabled, debugRefreshTick]);
  useEffect(() => {
    notifyLog(`ctx.menu.toggle enabled=${showNotifDebugMenu ? '1' : '0'}`);
  }, [notifyLog, showNotifDebugMenu]);

  // 统一调试配置变更时，更新本地缓存判断（通过 preload 注入的 onChanged 已刷新全局）
  useEffect(() => {
    const off = (window as any)?.host?.debug?.onChanged?.(() => {
      try { setDebugRefreshTick((prev: number) => prev + 1); } catch {}
    });
    return () => { try { off && off(); } catch {} };
  }, []);
  const [devMeta, setDevMeta] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res: any = await window.host?.env?.getMeta?.();
        if (!active) return;
        if (res && res.ok && typeof res.isDev === 'boolean') setDevMeta(res.isDev);
      } catch {}
    })();
    return () => { active = false; };
  }, []);

  const isDevEnvironment = React.useMemo(() => {
    if (devMeta !== null) return devMeta;
    try {
      if ((import.meta as any)?.env?.DEV) return true;
    } catch {}
    try {
      const loc = window.location;
      const protocol = String(loc?.protocol || '').toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') {
        const host = String(loc?.hostname || '').toLowerCase();
        if (!host || host === 'localhost' || host === '127.0.0.1') return true;
        if (host.endsWith('.localhost')) return true;
        if (protocol === 'http:') return true;
      }
    } catch {}
    try {
      if (uiDebugEnabled()) return true;
    } catch {}
    return false;
  }, [devMeta, uiDebugEnabled, debugRefreshTick]);

  // 诊断：打印当前页面上可能的"覆盖层/遮罩"信息以及活跃元素
  const dumpOverlayDiagnostics = React.useCallback((reason: string) => {
    if (!uiDebugEnabled()) return;
    try {
      const items: string[] = [];
      const all = Array.from(document.querySelectorAll<HTMLElement>('body *'));
      for (const el of all) {
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        const z = cs.zIndex || '';
        const pe = cs.pointerEvents || '';
        const vis = cs.visibility || '';
        const disp = cs.display || '';
        const op = cs.opacity || '';
        // 只输出可能拦截点击的元素（pointer-events 非 none，且有一定尺寸）
        const mayBlock = pe !== 'none' && rect.width >= 8 && rect.height >= 8;
        if (!mayBlock) continue;
        items.push(`fixed[${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}] z=${z} pe=${pe} vis=${vis} disp=${disp} op=${op} cls=${(el.className||'').toString().slice(0,80)}`);
      }
      const ae = document.activeElement as HTMLElement | null;
      const aeInfo = ae ? `${ae.tagName.toLowerCase()}#${ae.id||''}.${(ae.className||'').toString().split(' ').slice(0,3).join('.')} pe=${(window.getComputedStyle(ae).pointerEvents||'')}` : 'null';
      uiLog(`overlay.dump:${reason} count=${items.length} activeEl=${aeInfo}`);
      for (const line of items) uiLog(`overlay.item ${line}`);
    } catch {}
  }, [uiLog, uiDebugEnabled]);
  // ---------- App State ----------
  const appBootId = useMemo(() => {
    try { return String(window.host?.app?.bootId || "").trim(); } catch { return ""; }
  }, []);
  const restoredConsoleSession = useMemo(() => {
    // 若无法获取 bootId，则不做会话恢复，避免跨重启残留无效控制台
    if (!appBootId) return null;
    return loadConsoleSession({ currentBootId: appBootId });
  }, [appBootId]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsHydrated, setProjectsHydrated] = useState<boolean>(false);
  const [dirTreeStore, setDirTreeStore] = useState<DirTreeStore>(() => ({
    version: 1,
    rootOrder: [],
    parentById: {},
    childOrderByParent: {},
    expandedById: {},
    labelById: {},
  }));
  const dirTreeStoreRef = useRef<DirTreeStore | null>(null);
  const [gitInfoByProjectId, setGitInfoByProjectId] = useState<Record<string, GitDirInfo>>({});
  const [buildRunCfgByDirKey, setBuildRunCfgByDirKey] = useState<Record<string, DirBuildRunConfig | null>>({});
  const buildRunCfgByDirKeyRef = useRef<Record<string, DirBuildRunConfig | null>>({});
  const [dirDrag, setDirDrag] = useState<{ draggingId: string; overId?: string; position?: "before" | "after" | "asChild" | "root-end" } | null>(null);
  const [buildRunDialog, setBuildRunDialog] = useState<BuildRunDialogState>(() => ({
    open: false,
    action: "build",
    projectId: "",
    saveScope: "self",
    parentProjectId: undefined,
    draft: { mode: "simple", commandText: "", cwd: "", env: [], backend: { kind: "system" } } as any,
    advanced: false,
  }));
  const [dirLabelDialog, setDirLabelDialog] = useState<DirLabelDialogState>(() => ({ open: false, projectId: "", draft: "" }));
  const [gitWorktreeAutoCommitEnabled, setGitWorktreeAutoCommitEnabled] = useState<boolean>(true);
  const [gitWorktreeCopyRulesOnCreate, setGitWorktreeCopyRulesOnCreate] = useState<boolean>(true);
  const [gitWorktreeGitPath, setGitWorktreeGitPath] = useState<string>("");
	  const [gitWorktreeExternalGitToolId, setGitWorktreeExternalGitToolId] = useState<ExternalGitToolId>("rider");
	  const [gitWorktreeExternalGitToolCustomCommand, setGitWorktreeExternalGitToolCustomCommand] = useState<string>("");
	  const [gitWorktreeTerminalCommand, setGitWorktreeTerminalCommand] = useState<string>("");
	  const [worktreeCreateDialog, setWorktreeCreateDialog] = useState<WorktreeCreateDialogState>(() => ({
	    open: false,
    repoProjectId: "",
    branches: [],
    baseBranch: "",
    loadingBranches: false,
    selectedChildWorktreeIds: [],
    promptChips: [],
    promptDraft: "",
    useMultipleModels: false,
    singleProviderId: "codex",
    multiCounts: { codex: 1, claude: 0, gemini: 0 },
	    creating: false,
	    error: undefined,
	  }));
	  const worktreeCreateRunningTaskIdByRepoIdRef = useRef<Record<string, string>>({});
	  /** 回收任务运行中的 taskId（用于“可关闭/可重开”的进度面板）。 */
	  const worktreeRecycleRunningTaskIdByProjectIdRef = useRef<Record<string, string>>({});
	  /** 回收弹窗：分叉点解析的请求序号（用于避免竞态覆盖）。 */
	  const worktreeRecycleForkPointReqIdRef = useRef<number>(0);
	  /** 回收弹窗：分叉点搜索的请求序号（用于避免竞态覆盖）。 */
	  const worktreeRecycleForkPointSearchReqIdRef = useRef<number>(0);
		  const [worktreeCreateProgress, setWorktreeCreateProgress] = useState<WorktreeCreateProgressState>(() => ({
		    open: false,
		    repoProjectId: "",
		    taskId: "",
	    status: "running",
	    log: "",
	    logOffset: 0,
	    updatedAt: 0,
	    error: undefined,
	  }));
	  const [worktreeRecycleProgress, setWorktreeRecycleProgress] = useState<WorktreeRecycleProgressState>(() => ({
	    open: false,
	    projectId: "",
	    taskId: "",
	    status: "running",
	    log: "",
	    logOffset: 0,
	    updatedAt: 0,
	    error: undefined,
	  }));
	  const [noticeDialog, setNoticeDialog] = useState<NoticeDialogState>(() => ({ open: false, title: "", message: "" }));
	  const [worktreeRecycleDialog, setWorktreeRecycleDialog] = useState<WorktreeRecycleDialogState>(() => ({
	    open: false,
	    projectId: "",
    repoMainPath: "",
    branches: [],
    baseBranch: "",
    wtBranch: "",
    range: "since_fork",
    forkPointValue: "",
    forkPointTouched: false,
    forkPointPinned: [],
    forkPointSearchItems: [],
    forkPointSearchQuery: "",
    forkPointPinnedLoading: false,
    forkPointSearchLoading: false,
    forkPointError: undefined,
    mode: "squash",
    commitMessage: "",
    loading: false,
    running: false,
    error: undefined,
  }));
  const [worktreeDeleteDialog, setWorktreeDeleteDialog] = useState<WorktreeDeleteDialogState>(() => ({
    open: false,
    projectId: "",
    action: "delete",
    afterRecycle: false,
    afterRecycleHint: undefined,
    running: false,
    needsForceRemoveWorktree: false,
    needsForceDeleteBranch: false,
    needsForceResetWorktree: false,
    error: undefined,
  }));
  const [worktreePostRecycleDialog, setWorktreePostRecycleDialog] = useState<WorktreePostRecycleDialogState>(() => ({ open: false, projectId: "", hint: undefined }));
  const worktreeDeleteInFlightByProjectIdRef = useRef<Record<string, boolean>>({});
  const [worktreeDeleteInFlightByProjectId, setWorktreeDeleteInFlightByProjectId] = useState<Record<string, boolean>>({});
  const worktreeDeleteSubmitGuardRef = useRef<boolean>(false);
  const [worktreeBlockedDialog, setWorktreeBlockedDialog] = useState<{ open: boolean; count: number }>(() => ({ open: false, count: 0 }));
  const [baseWorktreeDirtyDialog, setBaseWorktreeDirtyDialog] = useState<BaseWorktreeDirtyDialogState>(() => ({ open: false, repoMainPath: "" }));
  const [gitActionErrorDialog, setGitActionErrorDialog] = useState<GitActionErrorDialogState>(() => ({
    open: false,
    title: "",
    message: "",
    dir: "",
  }));

  /**
   * 中文说明：设置某个 worktree 的“删除进行中”标记。
   * - 用于禁用侧栏按钮，避免重复触发删除（尤其是用户关闭弹窗后再次点击）。
   */
  const setWorktreeDeleteInFlight = useCallback((projectId: string, inFlight: boolean) => {
    const pid = String(projectId || "").trim();
    if (!pid) return;
    worktreeDeleteInFlightByProjectIdRef.current[pid] = inFlight;
    setWorktreeDeleteInFlightByProjectId((prev) => {
      const next = { ...(prev || {}) } as Record<string, boolean>;
      if (inFlight) next[pid] = true;
      else delete next[pid];
      return next;
    });
  }, []);
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => loadHiddenProjectIds());
  const [showHiddenProjects, setShowHiddenProjects] = useState<boolean>(() => loadShowHiddenProjects());
  const [query, setQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => restoredConsoleSession?.selectedProjectId || "");
  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);
  const visibleProjects = useMemo(() => {
    if (showHiddenProjects) return projects;
    return projects.filter((p) => !hiddenProjectIdSet.has(p.id));
  }, [projects, showHiddenProjects, hiddenProjectIdSet]);
  const selectedProject = useMemo(
    () => visibleProjects.find((p) => p.id === selectedProjectId) || null,
    [visibleProjects, selectedProjectId]
  );
  const [projectSort, setProjectSort] = useState<ProjectSortKey>(() => {
    if (typeof window === "undefined") return "recent";
    try {
      const saved = window.localStorage?.getItem(PROJECT_SORT_STORAGE_KEY);
      if (saved === "recent" || saved === "name" || saved === "manual") return saved;
    } catch {}
    return "recent";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage?.setItem(PROJECT_SORT_STORAGE_KEY, projectSort); } catch {}
  }, [projectSort]);
  const sortedProjects = useMemo(() => {
    const list = [...visibleProjects];
    const getRecentTimestamp = (project: Project): number => {
      if (typeof project.lastOpenedAt === "number" && !Number.isNaN(project.lastOpenedAt)) {
        return project.lastOpenedAt;
      }
      if (typeof project.createdAt === "number" && !Number.isNaN(project.createdAt)) {
        return project.createdAt;
      }
      return 0;
    };
    const compareByName = (a: Project, b: Project): number => {
      const nameDiff = (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base", numeric: true });
      if (nameDiff !== 0) return nameDiff;
      return (a.winPath || "").localeCompare(b.winPath || "", undefined, { sensitivity: "base", numeric: true });
    };
    if (projectSort === "manual") {
      const rank = new Map<string, number>();
      for (let i = 0; i < dirTreeStore.rootOrder.length; i++) {
        const id = dirTreeStore.rootOrder[i];
        if (id && !rank.has(id)) rank.set(id, i);
      }
      list.sort((a, b) => {
        const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return compareByName(a, b);
      });
      return list;
    }
    list.sort((a, b) => {
      if (projectSort === "name") return compareByName(a, b);
      const recentDiff = getRecentTimestamp(b) - getRecentTimestamp(a);
      if (recentDiff !== 0) return recentDiff;
      return compareByName(a, b);
    });
    return list;
  }, [dirTreeStore.rootOrder, visibleProjects, projectSort]);
  const handleProjectSortChange = useCallback((value: string) => {
    if (value === "recent" || value === "name" || value === "manual") {
      setProjectSort(value);
    }
  }, []);
  const projectSortLabel = useMemo(() => {
    if (projectSort === "manual") return t("projects:sortManual", "手动") as string;
    if (projectSort === "name") return t("projects:sortName") as string;
    return t("projects:sortRecent") as string;
  }, [projectSort, t]);

  useEffect(() => {
    saveHiddenProjectIds(hiddenProjectIds);
  }, [hiddenProjectIds]);

  useEffect(() => {
    saveShowHiddenProjects(showHiddenProjects);
  }, [showHiddenProjects]);

  useEffect(() => {
    // 清理已不存在的项目 id，避免隐藏列表长期积累脏数据
    if (!projectsHydrated) return;
    if (hiddenProjectIds.length === 0) return;
    const exists = new Set(projects.map((p) => p.id));
    setHiddenProjectIds((prev) => {
      const next = prev.filter((id) => exists.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [projectsHydrated, projects, hiddenProjectIds.length]);

  // 目录树：在 projects 变更后归一化一次，确保不会产生二级层级或引用脏数据
  useEffect(() => {
    if (!projectsHydrated) return;
    const { next, changed } = normalizeDirTreeStore(dirTreeStore, projects);
    if (changed) setDirTreeStore(next);
  }, [dirTreeStore, projects, projectsHydrated]);

  // 目录树：持久化（轻量防抖，避免拖拽过程中频繁写盘）
  useEffect(() => {
    if (!projectsHydrated) return;
    const timer = window.setTimeout(() => {
      try { (window as any).host?.dirTree?.set?.(dirTreeStore); } catch {}
    }, 200);
    return () => { try { window.clearTimeout(timer); } catch {} };
  }, [dirTreeStore, projectsHydrated]);

  // Git 状态：批量刷新（用于分支/工作树识别与“目录缺失”判定）
  useEffect(() => {
    if (!projectsHydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const dirs = projects.map((p) => p.winPath).filter(Boolean);
        const res: any = await (window as any).host?.gitWorktree?.statusBatch?.(dirs);
        if (cancelled) return;
        if (res && res.ok && Array.isArray(res.items)) {
          const next: Record<string, GitDirInfo> = {};
          for (let i = 0; i < projects.length; i++) {
            const p = projects[i];
            const info = (res.items[i] || null) as GitDirInfo | null;
            if (p?.id && info) next[p.id] = info;
          }
          setGitInfoByProjectId(next);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [projectsHydrated, projects]);

  // Worktree 创建面板：当实例数/子节点变化时，裁剪“复用子 worktree”的选择，避免超出上限或引用失效
  useEffect(() => {
    if (!worktreeCreateDialog.open) return;
    const repoId = String(worktreeCreateDialog.repoProjectId || "").trim();
    if (!repoId) return;

    const selectedRaw = Array.isArray(worktreeCreateDialog.selectedChildWorktreeIds) ? worktreeCreateDialog.selectedChildWorktreeIds : [];
    if (selectedRaw.length === 0) return;

    const total = worktreeCreateDialog.useMultipleModels ? sumWorktreeProviderCounts(worktreeCreateDialog.multiCounts) : 1;
    const childIds = dirTreeStore.childOrderByParent[repoId] || [];
    const allowedOrder = childIds.filter((id) => !!gitInfoByProjectId[id]?.isWorktree);
    const trimmed = trimSelectedIdsByOrder({ selectedIds: selectedRaw, allowedOrder, limit: total });

    if (areStringArraysEqual(selectedRaw, trimmed)) return;
    setWorktreeCreateDialog((prev) => {
      if (!prev.open || prev.repoProjectId !== repoId) return prev;
      return { ...prev, selectedChildWorktreeIds: trimmed };
    });
  }, [
    dirTreeStore.childOrderByParent,
    gitInfoByProjectId,
    worktreeCreateDialog.multiCounts,
    worktreeCreateDialog.open,
    worktreeCreateDialog.repoProjectId,
    worktreeCreateDialog.selectedChildWorktreeIds,
    worktreeCreateDialog.useMultipleModels,
  ]);

  useEffect(() => {
    // 如果没有可见项目，清空选择
    if (visibleProjects.length === 0) {
      if (selectedProjectId !== "") setSelectedProjectId("");
      return;
    }
    // 如果当前选中的项目已被隐藏或删除，清空选择（回到首页）
    if (selectedProjectId && !visibleProjects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId("");
    }
  }, [visibleProjects, selectedProjectId]);

  // 切换项目时：确保/加载文件索引并推送至前端 Worker
  useEffect(() => {
    (async () => {
      try {
        const root = selectedProject?.winPath || '';
        if (root) await setActiveFileIndexRoot(root);
      } catch {}
    })();
  }, [selectedProject?.winPath]);

  // Console tabs per project
  const [tabsByProject, setTabsByProject] = useState<Record<string, ConsoleTab[]>>(() => {
    const out: Record<string, ConsoleTab[]> = {};
    const from = restoredConsoleSession?.tabsByProject || {};
    for (const [projectId, list] of Object.entries(from)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      out[projectId] = list.map((tab) => ({
        id: tab.id,
        name: tab.name,
        providerId: tab.providerId,
        createdAt: tab.createdAt,
        logs: [],
      }));
    }
    return out;
  });
  const tabs = tabsByProject[selectedProjectId] || [];
  const [activeTabId, setActiveTabId] = useState<string | null>(() => restoredConsoleSession?.activeTabByProject?.[selectedProjectId] || null);
  const activeTabIdRef = useRef<string | null>(null);
  // 记录每个项目的活跃 tab，切换项目时恢复对应的活跃 tab，避免切换关闭控制台
  const [activeTabByProject, setActiveTabByProject] = useState<Record<string, string | null>>(() => restoredConsoleSession?.activeTabByProject || {});
  // 编辑标签名状态
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const [renameWidth, setRenameWidth] = useState<number | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const tabFocusTimerRef = useRef<number | null>(null);
  const tabFocusNextRef = useRef<{ immediate: boolean; allowDuringRename: boolean; delay?: number }>({ immediate: false, allowDuringRename: false });
  const editingTabIdRef = useRef<string | null>(null);
  // 调试：标签页右键测试菜单（仅开发或显式开启）
  const [tabCtxMenu, setTabCtxMenu] = useState<{ show: boolean; x: number; y: number; tabId?: string | null }>({ show: false, x: 0, y: 0, tabId: null });
  useEffect(() => {
    if (!showNotifDebugMenu && tabCtxMenu.show) {
      notifyLog("ctx.menu.forceClose reason=disabled");
      setTabCtxMenu({ show: false, x: 0, y: 0, tabId: null });
    }
  }, [notifyLog, showNotifDebugMenu, tabCtxMenu.show]);
  const closeTabContextMenu = React.useCallback((source: string, targetTabId?: string | null) => {
    const id = targetTabId ?? tabCtxMenu.tabId ?? activeTabId ?? null;
    notifyLog(`ctx.menu.close source=${source} tab=${id || 'none'}`);
    setTabCtxMenu({ show: false, x: 0, y: 0, tabId: null });
  }, [activeTabId, notifyLog, tabCtxMenu.tabId]);
  const openTabContextMenu = React.useCallback((event: React.MouseEvent, tabId: string | null, source: string) => {
    const id = tabId || "none";
    notifyLog(`ctx.menu.request source=${source} tab=${id} enabled=${showNotifDebugMenu ? '1' : '0'}`);
    event.preventDefault();
    event.stopPropagation();
    if (!showNotifDebugMenu) {
      notifyLog(`ctx.menu.blocked source=${source} tab=${id}`);
      return;
    }
    setTabCtxMenu({ show: true, x: event.clientX, y: event.clientY, tabId });
    notifyLog(`ctx.menu.open source=${source} tab=${id} x=${Math.round(event.clientX)} y=${Math.round(event.clientY)}`);
  }, [notifyLog, setTabCtxMenu, showNotifDebugMenu]);
  // Terminal adapters 与 PTY 状态
  const [terminalMode, setTerminalMode] = useState<TerminalMode>('wsl');
  const [terminalFontFamily, setTerminalFontFamily] = useState<string>(DEFAULT_TERMINAL_FONT_FAMILY);
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>(DEFAULT_TERMINAL_THEME_ID);
  const terminalThemeDef = useMemo(() => getTerminalTheme(terminalTheme), [terminalTheme]);
  const [codexTraceEnabled, setCodexTraceEnabled] = useState(false);
  const initialPtyByTab = useMemo<Record<string, string>>(() => restoredConsoleSession?.ptyByTab || {}, [restoredConsoleSession]);
  const initialPtyAlive = useMemo<Record<string, boolean>>(() => {
    const next: Record<string, boolean> = {};
    for (const tabId of Object.keys(initialPtyByTab)) next[tabId] = true;
    return next;
  }, [initialPtyByTab]);
  const ptyByTabRef = useRef<Record<string, string>>(initialPtyByTab);
  const [ptyByTab, setPtyByTab] = useState<Record<string, string>>(() => initialPtyByTab);
  const ptyAliveRef = useRef<Record<string, boolean>>(initialPtyAlive);
  const [ptyAlive, setPtyAlive] = useState<Record<string, boolean>>(() => initialPtyAlive);
  const terminalManagerRef = useRef<TerminalManager | null>(null);
  if (!terminalManagerRef.current) {
    terminalManagerRef.current = new TerminalManager(
      (tabId: string) => ptyByTabRef.current[tabId],
      undefined,
      { fontFamily: terminalFontFamily, theme: terminalTheme }
    );
  }
  const tm = terminalManagerRef.current;
  const [notificationPrefs, setNotificationPrefs] = useState<CompletionPreferences>(DEFAULT_COMPLETION_PREFS);
  const notificationPrefsRef = useRef<CompletionPreferences>(DEFAULT_COMPLETION_PREFS);
  const [pendingCompletions, setPendingCompletions] = useState<Record<string, number>>({});
  const pendingCompletionsRef = useRef<Record<string, number>>({});
  const completionSnapshotRef = useRef<Record<string, { preview: string; ts: number }>>({});
  const ptyNotificationBuffersRef = useRef<Record<string, string>>({});
  const ptyListenersRef = useRef<Record<string, () => void>>({});
  const ptyToTabRef = useRef<Record<string, string>>({});
  const tabProjectRef = useRef<Record<string, string>>({});
  const tabsByProjectRef = useRef<Record<string, ConsoleTab[]>>(tabsByProject);
  const projectsRef = useRef<Project[]>(projects);
  const audioContextRef = useRef<AudioContext | null>(null);
  const userInputCountByTabIdRef = useRef<Record<string, number>>({});
  const autoCommitQueueByProjectIdRef = useRef<Record<string, Promise<void>>>({});

  useEffect(() => { editingTabIdRef.current = editingTabId; }, [editingTabId]);
  useEffect(() => { notificationPrefsRef.current = notificationPrefs; }, [notificationPrefs]);
  useEffect(() => { tabsByProjectRef.current = tabsByProject; }, [tabsByProject]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => { dirTreeStoreRef.current = dirTreeStore; }, [dirTreeStore]);
  useEffect(() => { buildRunCfgByDirKeyRef.current = buildRunCfgByDirKey; }, [buildRunCfgByDirKey]);

  // 关键修复：渲染进程意外 reload/HMR 后，基于本地快照恢复 tab 与 PTY 绑定，避免“标签页/控制台丢失”。
  const restoredConsoleSessionAppliedRef = useRef(false);
  useEffect(() => {
    if (restoredConsoleSessionAppliedRef.current) return;
    restoredConsoleSessionAppliedRef.current = true;
    const snapshot = restoredConsoleSession;
    if (!snapshot) return;

    // 重建 tabId -> projectId 映射（用于通知聚焦、跨项目定位等）
    try {
      for (const [projectId, list] of Object.entries(snapshot.tabsByProject || {})) {
        for (const tab of list || []) {
          try { registerTabProject(tab.id, projectId); } catch {}
        }
      }
    } catch {}

    // 恢复 PTY 绑定：通知解析监听 + xterm 适配器桥接（含尾部缓冲回放）
    try {
      const knownTabs = new Set<string>();
      for (const list of Object.values(snapshot.tabsByProject || {})) {
        for (const tab of list || []) knownTabs.add(tab.id);
      }
      for (const [tabId, ptyId] of Object.entries(snapshot.ptyByTab || {})) {
        if (!knownTabs.has(tabId)) continue;
        try { registerPtyForTab(tabId, ptyId); } catch {}
        try { tm.setPty(tabId, ptyId, { hydrateBacklog: true }); } catch {}
      }
    } catch {}
  }, [restoredConsoleSession, tm]);

  // 将当前控制台会话写入本地，支持 reload/HMR 后恢复
  const consoleSessionSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (consoleSessionSaveTimerRef.current) {
      window.clearTimeout(consoleSessionSaveTimerRef.current);
      consoleSessionSaveTimerRef.current = null;
    }
    consoleSessionSaveTimerRef.current = window.setTimeout(() => {
      try {
        const compactTabsByProject: Record<string, PersistedConsoleTab[]> = {};
        for (const [projectId, list] of Object.entries(tabsByProject || {})) {
          if (!Array.isArray(list) || list.length === 0) continue;
          compactTabsByProject[projectId] = list.map((tab) => ({
            id: tab.id,
            name: tab.name,
            providerId: tab.providerId,
            createdAt: tab.createdAt,
          }));
        }
        saveConsoleSession({
          version: 1,
          savedAt: Date.now(),
          bootId: appBootId,
          selectedProjectId,
          tabsByProject: compactTabsByProject,
          activeTabByProject,
          ptyByTab,
        });
      } catch {}
    }, 250);
    return () => {
      if (consoleSessionSaveTimerRef.current) {
        window.clearTimeout(consoleSessionSaveTimerRef.current);
        consoleSessionSaveTimerRef.current = null;
      }
    };
  }, [selectedProjectId, tabsByProject, activeTabByProject, ptyByTab, appBootId]);
  useEffect(() => {
    if (!terminalManagerRef.current) return;
    try { terminalManagerRef.current.setAppearance({ fontFamily: terminalFontFamily, theme: terminalTheme }); } catch {}
  }, [terminalFontFamily, terminalTheme]);

  const injectTraceEnv = React.useCallback((cmd: string | null | undefined) => {
    return injectCodexTraceEnv({ cmd, traceEnabled: codexTraceEnabled, terminalMode });
  }, [terminalMode, codexTraceEnabled]);

  // 从统一调试配置读取 Codex TUI trace 开关，并监听热更新
  useEffect(() => {
    let dispose: (() => void) | null = null;
    (async () => {
      try {
        const cfg: any = await (window as any).host?.debug?.get?.();
        if (cfg && cfg.codex) setCodexTraceEnabled(!!cfg.codex.tuiTrace);
      } catch {}
      try {
        dispose = (window as any).host?.debug?.onChanged?.(() => {
          (async () => {
            try {
              const nextCfg: any = await (window as any).host?.debug?.get?.();
              setCodexTraceEnabled(!!(nextCfg && nextCfg.codex && nextCfg.codex.tuiTrace));
            } catch {}
          })();
        });
      } catch {}
    })();
    return () => { try { dispose && dispose(); } catch {} };
  }, []);

  const scheduleFocusForTab = React.useCallback((tabId: string | null | undefined, opts?: { immediate?: boolean; allowDuringRename?: boolean; delay?: number }) => {
    if (!tabId) return;
    if (tabFocusTimerRef.current) {
      window.clearTimeout(tabFocusTimerRef.current);
      tabFocusTimerRef.current = null;
    }
    const allowDuringRename = opts?.allowDuringRename ?? false;
    const delay = typeof opts?.delay === 'number' ? Math.max(0, opts.delay) : (opts?.immediate ? 0 : TAB_FOCUS_DELAY);
    const run = () => {
      if (!allowDuringRename && editingTabIdRef.current === tabId) {
        notifyLog(`tabFocus.skip tab=${tabId} reason=editing`);
        return;
      }
      try {
        notifyLog(`tabFocus.run tab=${tabId} delay=${delay}`);
        terminalManagerRef.current?.onTabActivated(tabId);
      } catch {}
    };
    if (delay === 0) run();
    else tabFocusTimerRef.current = window.setTimeout(run, delay);
  }, [terminalManagerRef, notifyLog]);

  type TabFocusOptions = { focusMode?: 'immediate' | 'defer'; allowDuringRename?: boolean; delay?: number; projectId?: string };

  function startEditTab(id: string, name: string) {
    // set a fixed width equal to current label width to avoid layout jump
    try {
      const el = document.getElementById(`tab-label-${id}`);
      const w = el ? Math.ceil((el.getBoundingClientRect().width || 80)) : 80;
      setRenameWidth(Math.max(60, w));
    } catch { setRenameWidth(null); }
    setEditingTabId(id);
    setRenameDraft(name);
  }

  // 当开始编辑某个 tab 时，选中文本（只执行一次）
  useEffect(() => {
    if (!editingTabId) return;
    try {
      const el = editInputRef.current;
      if (el) {
        el.focus();
        // defer selection to onFocus handler to ensure it happens only once
      }
    } catch {}
  }, [editingTabId]);

  // 设置活跃 tab 的封装：同时记录到 per-project map，供切换时恢复
  function setActiveTab(id: string | null, options?: TabFocusOptions) {
    const prevId = activeTabIdRef.current;
    if (prevId && prevId !== id) {
      try {
        terminalManagerRef.current?.onTabDeactivated(prevId);
        notifyLog(`tabFocus.deactivate tab=${prevId} next=${id || 'none'}`);
      } catch {}
    }
    activeTabIdRef.current = id ?? null;
    if (id && prevId !== id) {
      try { notifyLog(`tabFocus.activate tab=${id} prev=${prevId || 'none'}`); } catch {}
    } else if (!id && prevId) {
      try { notifyLog(`tabFocus.clear prev=${prevId}`); } catch {}
    }
    setActiveTabId((prev) => (prev === id ? prev : id));
    try {
      const targetProjectId = options?.projectId || selectedProject?.id;
      if (targetProjectId) {
        setActiveTabByProject((m) => {
          const current = m[targetProjectId];
          if (current === id) return m;
          return { ...m, [targetProjectId]: id };
        });
      }
    } catch {}
    tabFocusNextRef.current = {
      immediate: options?.focusMode === 'immediate',
      allowDuringRename: options?.allowDuringRename ?? false,
      delay: options?.delay,
    };
  }
  const tabsListRef = useRef<HTMLDivElement | null>(null);
  const [centerMode, setCenterMode] = useState<'console' | 'history'>('console');

  function computePendingTotal(map: Record<string, number>): number {
    let total = 0;
    for (const value of Object.values(map)) {
      if (typeof value === 'number' && value > 0) total += value;
    }
    return total;
  }

  function syncTaskbarBadge(map: Record<string, number>, prefs?: CompletionPreferences) {
    try {
      const effective = prefs ?? notificationPrefsRef.current;
      const rawTotal = computePendingTotal(map);
      const total = effective.badge ? rawTotal : 0;
      notifyLog(`syncTaskbarBadge raw=${rawTotal} effective=${total} enabled=${effective.badge}`);
      window.host.notifications?.setBadgeCount?.(total);
    } catch {}
  }

  function isAppForeground(): boolean {
    try {
      const visibility = typeof document.visibilityState === 'string' ? document.visibilityState : (document as any)?.visibilityState;
      const visible = typeof visibility === 'string' ? visibility === 'visible' : !(document as any)?.hidden;
      const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      return !!(visible && focused);
    } catch {
      return true;
    }
  }

  function applyPending(next: Record<string, number>) {
    pendingCompletionsRef.current = next;
    setPendingCompletions(next);
    const entries = Object.entries(next).filter(([_, count]) => typeof count === 'number' && count > 0);
    notifyLog(`applyPending entries=${entries.map(([id, count]) => `${id}:${count}`).join(',') || 'none'}`);
    syncTaskbarBadge(next);
  }

  function clearPendingForTab(tabId: string) {
    if (!tabId) return;
    const current = pendingCompletionsRef.current;
    if (!current[tabId]) return;
    const next = { ...current };
    delete next[tabId];
    applyPending(next);
  }

  function autoClearActiveTabIfForeground(source: string) {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const count = pendingCompletionsRef.current[tabId];
    if (!count || count <= 0) return;
    if (!isAppForeground()) return;
    notifyLog(`autoClearPending source=${source} tab=${tabId} count=${count}`);
    clearPendingForTab(tabId);
  }

  function registerTabProject(tabId: string, projectId: string | null | undefined) {
    if (!tabId || !projectId) return;
    tabProjectRef.current[tabId] = projectId;
  }

  function unregisterTabProject(tabId: string) {
    if (!tabId) return;
    delete tabProjectRef.current[tabId];
  }

  async function playCompletionChime() {
    if (!notificationPrefsRef.current.sound) return;
    try {
      const AudioCtor: typeof AudioContext | undefined =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtor) return;

      let ctx = audioContextRef.current;
      if (!ctx) {
        ctx = new AudioCtor({ latencyHint: "interactive" as any });
        audioContextRef.current = ctx;
      }
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }

      // 源 -> 高通 -> 低通 -> 压缩 -> 总线，用短包络塑造柔和的提示音。
      const now = ctx.currentTime;
      const start = now + 0.04;

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(120, start);
      hp.Q.setValueAtTime(0.7, start);

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(3800, start);
      lp.Q.setValueAtTime(0.9, start);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-24, start);
      comp.knee.setValueAtTime(24, start);
      comp.ratio.setValueAtTime(3, start);
      comp.attack.setValueAtTime(0.003, start);
      comp.release.setValueAtTime(0.12, start);

      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(0.16, start + 0.05);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);

      hp.connect(lp);
      lp.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.setValueAtTime(-0.18, start);
      panR.pan.setValueAtTime(0.18, start);
      panL.connect(hp);
      panR.connect(hp);

      const blip = (t: number, freq: number, pan: "L" | "R") => {
        const gainNode = ctx!.createGain();
        gainNode.gain.setValueAtTime(0.0001, t);
        gainNode.gain.exponentialRampToValueAtTime(0.9, t + 0.012);
        gainNode.gain.linearRampToValueAtTime(0.22, t + 0.14);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);

        const sine = ctx!.createOscillator();
        sine.type = "sine";
        sine.frequency.setValueAtTime(freq, t);

        const triangle = ctx!.createOscillator();
        triangle.type = "triangle";
        triangle.frequency.setValueAtTime(freq * 2, t);

        sine.connect(gainNode);
        triangle.connect(gainNode);
        gainNode.connect(pan === "L" ? panL : panR);

        sine.start(t);
        triangle.start(t);
        sine.stop(t + 0.45);
        triangle.stop(t + 0.45);
      };

      const FREQ_E5 = 659;
      const FREQ_GS5 = 831;
      const FREQ_B5 = 988;

      blip(start + 0, FREQ_E5, "L");
      blip(start + 0.08, FREQ_GS5, "R");
      blip(start + 0.16, FREQ_B5, "L");
    } catch {}
  }

  /**
   * 中文说明：记录最近一次完成通知，用于去重。
   */
  function recordCompletionSnapshot(tabId: string, preview: string) {
    const safeId = String(tabId || "").trim();
    if (!safeId) return;
    completionSnapshotRef.current[safeId] = { preview: String(preview || ""), ts: Date.now() };
  }

  /**
   * 中文说明：判断是否为短时间内重复通知。
   */
  function isDuplicateCompletion(tabId: string, preview: string, windowMs: number): boolean {
    const safeId = String(tabId || "").trim();
    if (!safeId) return false;
    const last = completionSnapshotRef.current[safeId];
    if (!last) return false;
    const delta = Date.now() - last.ts;
    return delta >= 0 && delta <= windowMs && String(last.preview || "") === String(preview || "");
  }

  /**
   * 中文说明：根据外部通知负载推断对应的 tabId。
   */
  function resolveExternalTabId(payload: { tabId?: string; providerId?: string; envLabel?: string }): string | null {
    const direct = String(payload?.tabId || "").trim();
    if (direct) return direct;
    const providerId = String(payload?.providerId || "gemini").trim().toLowerCase();
    const envLabel = String(payload?.envLabel || "").trim();
    const matched: ConsoleTab[] = [];
    for (const list of Object.values(tabsByProjectRef.current)) {
      for (const tab of list || []) {
        if (String(tab?.providerId || "").trim().toLowerCase() !== providerId) continue;
        if (envLabel && String(tab.name || "").trim() === envLabel) matched.push(tab);
        else if (!envLabel) matched.push(tab);
      }
    }
    if (envLabel) {
      if (matched.length === 1) return matched[0].id;
      return null;
    }
    return matched.length === 1 ? matched[0].id : null;
  }

  function showCompletionNotification(tabId: string, preview: string) {
    if (!notificationPrefsRef.current.system) {
      notifyLog(`showCompletionNotification skipped tab=${tabId} reason=systemDisabled`);
      return;
    }
    let tabName = '';
    let providerId = '';
    let projectName: string | undefined;
    const currentTabs = tabsByProjectRef.current;
    for (const [pid, list] of Object.entries(currentTabs)) {
      const found = (list || []).find((tab) => tab.id === tabId);
      if (found) {
        tabName = found.name;
        providerId = found.providerId;
        const project = projectsRef.current.find((p) => p.id === pid);
        if (project) projectName = project.name;
        break;
      }
    }
    if (!tabName) tabName = t('common:notifications.untitledTab', 'Agent');
    const appTitle = t('common:app.name', 'CodexFlow') as string;
    const providerLabel = providerId ? getProviderLabel(providerId) : "";
    const header = [providerLabel || appTitle, tabName].filter(Boolean).join(' · ') || appTitle;
    const normalizedPreview = preview.trim();
    const body = normalizedPreview || (t('common:notifications.openTabHint', '点击查看详情') as string);
    try {
      notifyLog(`showCompletionNotification tab=${tabId} project=${projectName || 'n/a'} title="${header}" bodyPreview="${body.slice(0, 60)}"`);
      window.host.notifications?.showAgentCompletion?.({
        tabId,
        tabName,
        projectName,
        preview: normalizedPreview,
        title: header,
        body,
        appTitle,
      });
    } catch {}
  }

  // 右键菜单：测试通知/徽标/铃声/整链路（仅开发/显式开关）
  function renderTabContextMenu() {
    if (!tabCtxMenu.show || !showNotifDebugMenu) return null;
    const tabId = tabCtxMenu.tabId || activeTabId || null;
    const close = (reason: string = "menu-close") => closeTabContextMenu(reason, tabId);
    const doTestSystemNotification = () => {
      if (!tabId) { close("system-notification-missing-tab"); return; }
      const preview = '这是一条模拟的完成内容片段（mock preview）';
      showCompletionNotification(tabId, preview);
      notifyLog(`ctx.testSystemNotification tab=${tabId}`);
      close("system-notification");
    };
    const doTestBadgePlus = () => {
      const current = { ...pendingCompletionsRef.current };
      const id = tabId || 'mock';
      current[id] = (current[id] ?? 0) + 1;
      applyPending(current);
      notifyLog(`ctx.badge.plus id=${id} val=${current[id]}`);
      close("badge-plus");
    };
    const doBadgeClear = () => {
      applyPending({});
      notifyLog('ctx.badge.clear');
      close("badge-clear");
    };
    const doTestChime = () => {
      const prev = { ...notificationPrefsRef.current };
      (notificationPrefsRef as any).current = { ...prev, sound: true };
      void playCompletionChime();
      (notificationPrefsRef as any).current = prev;
      notifyLog('ctx.chime');
      close("chime");
    };
    const doTestOSCChain = () => {
      const id = tabId || activeTabId || '';
      if (!id) { close("osc-chain-missing-tab"); return; }
      const ptyId = ptyByTabRef.current[id];
      const payload = 'agent-turn-complete: mock via OSC';
      const chunk = `${OSC_NOTIFICATION_PREFIX}${payload}${OSC_TERMINATOR_BEL}`;
      if (ptyId) {
        try { processPtyNotificationChunk(ptyId, chunk); notifyLog(`ctx.osc.inject pty=${ptyId}`); } catch {}
      } else {
        try { handleAgentCompletion(id, payload); notifyLog('ctx.osc.fallback.handle'); } catch {}
      }
      close("osc-chain");
    };
    return (
      <div
        style={{ position: 'fixed', left: tabCtxMenu.x, top: tabCtxMenu.y, zIndex: 10000 }}
          className="min-w-[220px] rounded-md border border-slate-200 bg-white/95 shadow-lg dark:border-slate-700 dark:bg-slate-900/95"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
      >
        <div className="px-3 py-2 text-xs text-slate-400">通知调试菜单（仅开发/显式开启）</div>
        <button className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={doTestSystemNotification}>测试系统通知</button>
        <button className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={doTestOSCChain}>测试整链路（OSC 9;）</button>
        <div className="h-px bg-slate-200" />
        <button className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={doTestBadgePlus}>徽标+1</button>
        <button className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={doBadgeClear}>清空徽标</button>
        <div className="h-px bg-slate-200" />
        <button className="w-full px-3 py-2 text-left hover:bg-slate-50" onClick={doTestChime}>测试完成铃声</button>
      </div>
    );
  }

  function handleAgentCompletion(tabId: string, preview: string) {
    if (!tabId) return;
    const cleanedPreview = normalizeCompletionPreview(preview);
    recordCompletionSnapshot(tabId, cleanedPreview);
    const foreground = isAppForeground();
    const activeMatch = activeTabIdRef.current === tabId;
    notifyLog(`handleAgentCompletion tab=${tabId} previewLength=${cleanedPreview.length} sound=${notificationPrefsRef.current.sound} foreground=${foreground ? '1' : '0'} activeMatch=${activeMatch ? '1' : '0'}`);
    const current = pendingCompletionsRef.current;
    if (foreground && activeMatch) {
      notifyLog(`handleAgentCompletion auto-clear tab=${tabId}`);
      autoClearActiveTabIfForeground('agent-complete');
    } else {
      const next = { ...current, [tabId]: (current[tabId] ?? 0) + 1 };
      applyPending(next);
    }
    showCompletionNotification(tabId, cleanedPreview);
    void playCompletionChime();
    // 无论通知开关如何，均请求刷新 Codex 用量（由顶部栏组件自行做 1 分钟冷却）
    try { emitCodexRateRefresh('agent-complete'); } catch {}
    try { emitClaudeUsageRefresh('agent-complete'); } catch {}
    try { emitGeminiUsageRefresh('agent-complete'); } catch {}

    // worktree 自动提交：每次 agent 完成输出后，若有变更则提交一次（仅对非主 worktree 生效）
    try {
      const projectId = tabProjectRef.current[tabId];
      if (projectId) enqueueAutoCommit(projectId, "agent", cleanedPreview);
    } catch {}
  }

  function processPtyNotificationChunk(ptyId: string, chunk: string) {
    if (!ptyId || typeof chunk !== 'string' || chunk.length === 0) return;
    const hasOsc = chunk.includes(OSC_NOTIFICATION_PREFIX);
    if (hasOsc || chunk.includes('\u001b')) {
      const snippet = chunk.replace(/\s+/g, ' ').slice(0, 120);
      notifyLog(`ptyChunk pty=${ptyId} len=${chunk.length} hasOSC=${hasOsc} snippet="${snippet}"`);
    }
    
    // 获取或初始化缓冲区，关键防护：确保总是有有效的字符串
    const existingBuffer = ptyNotificationBuffersRef.current[ptyId];
    if (typeof existingBuffer !== 'string' && existingBuffer !== undefined) {
      console.warn(`[Notification] Invalid buffer type for pty=${ptyId}, resetting`);
      notifyLog(`WARN: Invalid buffer type pty=${ptyId} type=${typeof existingBuffer}`);
      ptyNotificationBuffersRef.current[ptyId] = '';
    }
    let buffer = (ptyNotificationBuffersRef.current[ptyId] || '') + chunk;
    
    // 增强诊断：记录缓冲区状态，特别是在检测到 OSC 前缀时
    const hadOscBefore = existingBuffer && existingBuffer.includes(OSC_NOTIFICATION_PREFIX);
    if (hasOsc || hadOscBefore) {
      notifyLog(`buffer state pty=${ptyId} before=${existingBuffer?.length || 0} after=${buffer.length} hadOsc=${hadOscBefore} newOsc=${hasOsc}`);
    }
    
    // 防护：检测异常超长的缓冲区（在处理之前），可能表明 OSC 序列长时间未完成
    if (buffer.length > MAX_OSC_BUFFER_LENGTH * 2) {
      const oscIdx = buffer.lastIndexOf(OSC_NOTIFICATION_PREFIX);
      if (oscIdx >= 0) {
        const pendingLen = buffer.length - oscIdx;
        notifyLog(`WARN: Extremely long buffer pty=${ptyId} total=${buffer.length} pendingOSC=${pendingLen}`);
        console.warn(`[Notification] Potential stuck OSC sequence pty=${ptyId} bufferLen=${buffer.length} pendingLen=${pendingLen}`);
      }
    }
    
    let processedCount = 0;
    while (true) {
      const start = buffer.indexOf(OSC_NOTIFICATION_PREFIX);
      if (start < 0) break;
      if (start > 0) {
        notifyLog(`OSC prefix found at offset=${start}, trimming pty=${ptyId}`);
        buffer = buffer.slice(start);
      }
      const payload = buffer.slice(OSC_NOTIFICATION_PREFIX.length);
      const belIndex = payload.indexOf(OSC_TERMINATOR_BEL);
      const stIndex = payload.indexOf(OSC_TERMINATOR_ST);
      let terminatorIndex = -1;
      let terminatorLength = 1;
      if (belIndex >= 0 && (stIndex < 0 || belIndex < stIndex)) {
        terminatorIndex = belIndex;
        terminatorLength = 1;
      } else if (stIndex >= 0) {
        terminatorIndex = stIndex;
        terminatorLength = OSC_TERMINATOR_ST.length;
      }
      if (terminatorIndex < 0) {
        // OSC 前缀存在但终止符未到达，记录诊断信息（但只在缓冲区较大时记录，避免日志泛滥）
        if (buffer.length > 1024) {
          notifyLog(`OSC incomplete pty=${ptyId} bufferLen=${buffer.length} payloadLen=${payload.length}`);
        }
        break;
      }
      const message = payload.slice(0, terminatorIndex);
      buffer = payload.slice(terminatorIndex + terminatorLength);
      processedCount++;
      
      const tabId = ptyToTabRef.current[ptyId];
      const isCompletion = isAgentCompletionMessage(message);
      if (tabId && isCompletion) {
        const activeMatch = activeTabIdRef.current === tabId;
        notifyLog(`processPtyNotificationChunk hit tab=${tabId} active=${activeMatch ? '1' : '0'} message="${message.slice(0, 80)}"`);
        handleAgentCompletion(tabId, message);
      } else if (tabId) {
        notifyLog(`processPtyNotificationChunk ignore tab=${tabId} isCompletion=${isCompletion} message="${message.slice(0, 80)}"`);
      } else {
        // 增强日志：记录映射丢失的情况，便于诊断
        notifyLog(`processPtyNotificationChunk ignoreNoTab pty=${ptyId} isCompletion=${isCompletion} message="${message.slice(0, 80)}" hasMapping=${!!ptyToTabRef.current[ptyId]}`);
        if (!ptyToTabRef.current[ptyId]) {
          console.warn('[Notification] Lost pty-to-tab mapping for notification', { ptyId, messagePreview: message.slice(0, 80) });
        }
      }
    }
    
    if (processedCount > 0) {
      notifyLog(`processed ${processedCount} OSC sequence(s) pty=${ptyId} remainingBuffer=${buffer.length}`);
    }
    
    // 软限制警告：在达到硬限制之前提前发现潜在问题
    if (buffer.length > OSC_BUFFER_SOFT_LIMIT && buffer.length <= MAX_OSC_BUFFER_LENGTH) {
      const oscIdx = buffer.lastIndexOf(OSC_NOTIFICATION_PREFIX);
      if (oscIdx >= 0) {
        const pendingLen = buffer.length - oscIdx;
        notifyLog(`SOFT LIMIT: Buffer approaching max pty=${ptyId} len=${buffer.length} limit=${MAX_OSC_BUFFER_LENGTH} pendingOSC=${pendingLen}`);
      } else if (buffer.length > OSC_BUFFER_SOFT_LIMIT * 1.2) {
        // 如果缓冲区较大但没有 OSC 前缀，也记录（可能是异常情况）
        notifyLog(`SOFT LIMIT: Large buffer without OSC pty=${ptyId} len=${buffer.length}`);
      }
    }
    
    // 专用缓冲裁剪：限制内存占用，同时保留 OSC 起始片段，防止分片导致的通知丢失
    if (buffer.length > MAX_OSC_BUFFER_LENGTH) {
      // 在裁剪前记录完整状态，帮助诊断
      const preCheck = {
        hasPrefix: buffer.includes(OSC_NOTIFICATION_PREFIX),
        lastPrefixIdx: buffer.lastIndexOf(OSC_NOTIFICATION_PREFIX),
        length: buffer.length,
      };
      notifyLog(`buffer trim START pty=${ptyId} len=${preCheck.length} hasPrefix=${preCheck.hasPrefix} lastIdx=${preCheck.lastPrefixIdx}`);
      
      const { buffer: reducedBuffer, reason, trimmedBytes, partialPrefixLength } = trimOscBuffer(buffer, {
        prefix: OSC_NOTIFICATION_PREFIX,
        maxLength: MAX_OSC_BUFFER_LENGTH,
        tailWindow: OSC_TAIL_WINDOW,
      });
      
      if (trimmedBytes > 0) {
        const postCheck = {
          hasPrefix: reducedBuffer.includes(OSC_NOTIFICATION_PREFIX),
          lastPrefixIdx: reducedBuffer.lastIndexOf(OSC_NOTIFICATION_PREFIX),
          length: reducedBuffer.length,
        };
        if (reason === "from-prefix") {
          notifyLog(`buffer trimmed from OSC start, trimmed=${trimmedBytes} keep=${reducedBuffer.length} prefixPreserved=${postCheck.hasPrefix}`);
        } else if (reason === "partial-prefix") {
          notifyLog(`buffer trimmed, preserved partial OSC prefix length=${partialPrefixLength} trimmed=${trimmedBytes} keep=${reducedBuffer.length}`);
        } else if (reason === "tail") {
          notifyLog(`buffer trimmed to tail window, trimmed=${trimmedBytes} keep=${reducedBuffer.length}`);
          // 特别警告：如果裁剪前有前缀但裁剪后没有，说明可能丢失了 OSC 序列
          if (preCheck.hasPrefix && !postCheck.hasPrefix) {
            console.warn(`[Notification] OSC prefix lost during tail trimming pty=${ptyId} before=${preCheck.length} after=${postCheck.length}`);
            notifyLog(`CRITICAL: OSC prefix lost in tail trim pty=${ptyId} beforeLen=${preCheck.length} beforeIdx=${preCheck.lastPrefixIdx}`);
          }
        }
      }
      buffer = reducedBuffer;
    }
    ptyNotificationBuffersRef.current[ptyId] = buffer;
  }

  function unregisterPtyListener(ptyId: string | undefined | null) {
    if (!ptyId) return;
    const off = ptyListenersRef.current[ptyId];
    if (typeof off === 'function') {
      try { off(); } catch {}
    }
    delete ptyListenersRef.current[ptyId];
    delete ptyNotificationBuffersRef.current[ptyId];
    delete ptyToTabRef.current[ptyId];
    notifyLog(`unregisterPtyListener pty=${ptyId}`);
  }

  function registerPtyForTab(tabId: string, ptyId: string | undefined) {
    if (!ptyId) return;
    const previousTab = ptyToTabRef.current[ptyId];
    const previousListener = ptyListenersRef.current[ptyId];
    const existingBuffer = ptyNotificationBuffersRef.current[ptyId];
    
    if (previousTab === tabId && typeof previousListener === 'function') {
      notifyLog(`registerPtyForTab reuse tab=${tabId} pty=${ptyId} bufferLen=${existingBuffer?.length || 0}`);
      return;
    }

    notifyLog(`registerPtyForTab BEGIN tab=${tabId} pty=${ptyId} prevTab=${previousTab || 'none'} bufferLen=${existingBuffer?.length || 0}`);

    const shouldResetBuffer = !!previousTab && previousTab !== tabId;
    
    // 关键诊断：在重置缓冲区前，检查是否有未完成的 OSC 序列
    if (shouldResetBuffer && existingBuffer && existingBuffer.length > 0) {
      const hasOscPrefix = existingBuffer.includes(OSC_NOTIFICATION_PREFIX);
      if (hasOscPrefix) {
        const oscIdx = existingBuffer.lastIndexOf(OSC_NOTIFICATION_PREFIX);
        const pendingLen = existingBuffer.length - oscIdx;
        notifyLog(`WARN: Resetting buffer with pending OSC pty=${ptyId} prevTab=${previousTab} newTab=${tabId} bufferLen=${existingBuffer.length} pendingOSC=${pendingLen}`);
        console.warn(`[Notification] Discarding buffer with OSC sequence during tab reassignment pty=${ptyId} pendingLen=${pendingLen}`);
      } else {
        notifyLog(`Resetting buffer (no OSC) pty=${ptyId} prevTab=${previousTab} newTab=${tabId} bufferLen=${existingBuffer.length}`);
      }
    }

    // 关键：先更新映射，确保此后到达的流量具备正确归属
    ptyToTabRef.current[ptyId] = tabId;
    notifyLog(`registerPtyForTab mapping set tab=${tabId} pty=${ptyId}`);

    let off: (() => void) | undefined;
    try {
      off = window.host.pty.onData(ptyId, (data) => {
        try { processPtyNotificationChunk(ptyId, data); } catch (err) { console.warn('processPtyNotificationChunk failed', err); }
      });
    } catch (err) {
      console.warn('registerPtyForTab failed', err);
      notifyLog(`registerPtyForTab ERROR: ${String((err as any)?.message || err)} pty=${ptyId}`);
      // 回滚映射
      if (previousTab && previousTab !== tabId) {
        ptyToTabRef.current[ptyId] = previousTab;
      } else if (!previousTab) {
        delete ptyToTabRef.current[ptyId];
      }
      return;
    }

    if (typeof off === 'function') {
      ptyListenersRef.current[ptyId] = off;
      notifyLog(`registerPtyForTab SUCCESS tab=${tabId} pty=${ptyId} listener=${typeof off}`);
    } else {
      console.warn('registerPtyForTab: onData did not return a function', ptyId);
      notifyLog(`registerPtyForTab WARNING: onData returned non-function pty=${ptyId} type=${typeof off}`);
    }

    if (typeof previousListener === 'function') {
      try {
        previousListener();
        notifyLog(`registerPtyForTab unregistered old listener pty=${ptyId}`);
      } catch (err) {
        notifyLog(`registerPtyForTab failed to unregister old listener pty=${ptyId} error=${String(err)}`);
      }
    }

    // 只在确实需要重置时才删除缓冲区，并记录详细信息
    if (shouldResetBuffer) {
      delete ptyNotificationBuffersRef.current[ptyId];
      notifyLog(`registerPtyForTab buffer reset pty=${ptyId}`);
    } else if (existingBuffer && existingBuffer.length > 0) {
      // 不需要重置但有缓冲区内容，记录以便跟踪
      notifyLog(`registerPtyForTab keeping existing buffer pty=${ptyId} len=${existingBuffer.length}`);
    }
  }

  // History panel data (fixed sidebar)
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const historySessionsRef = useRef<HistorySession[]>(historySessions);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryDir, setSelectedHistoryDir] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  // 用于在点击项目时抑制自动选中历史的标志
  const suppressAutoSelectRef = useRef(false);
  useEffect(() => { historySessionsRef.current = historySessions; }, [historySessions]);

  const focusTabFromNotification = React.useCallback((tabId: string) => {
    if (!tabId) return;
    let projectId = tabProjectRef.current[tabId];
    if (!projectId) {
      const entries = tabsByProjectRef.current;
      for (const [pid, list] of Object.entries(entries)) {
        if ((list || []).some((tab) => tab.id === tabId)) {
          projectId = pid;
          tabProjectRef.current[tabId] = pid;
          break;
        }
      }
    }
    if (!projectId) return;
    if (projectId !== selectedProjectId) {
      suppressAutoSelectRef.current = true;
      setSelectedProjectId(projectId);
    }
    setCenterMode('console');
    setSelectedHistoryDir(null);
    setSelectedHistoryId(null);
    setActiveTab(tabId, { focusMode: 'immediate', allowDuringRename: true, delay: 0, projectId });
  }, [selectedProjectId, setActiveTab, setCenterMode, setSelectedHistoryDir, setSelectedHistoryId, setSelectedProjectId]);

  const [showHistoryPanel, setShowHistoryPanel] = useState(true);
  const [historyQuery, setHistoryQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [historyCtxMenu, setHistoryCtxMenu] = useState<{ show: boolean; x: number; y: number; item: HistorySession | null; groupKey: string | null }>({ show: false, x: 0, y: 0, item: null, groupKey: null });
  const historyCtxMenuRef = useRef<HTMLDivElement | null>(null);
  // 历史删除确认（应用内对话框，替代 window.confirm，避免同步阻塞导致的焦点/指针异常）
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; item: HistorySession | null; groupKey: string | null }>({ open: false, item: null, groupKey: null });
  // 退出确认（主进程发起，渲染层展示以保持 UI 风格一致）
  const [quitConfirm, setQuitConfirm] = useState<{ open: boolean; token: string | null; count: number }>(() => ({ open: false, token: null, count: 0 }));
  const quitConfirmTokenRef = useRef<string | null>(null);
  useEffect(() => { quitConfirmTokenRef.current = quitConfirm.token; }, [quitConfirm.token]);

  /**
   * 回复主进程的退出确认结果，并关闭对话框。
   */
  const respondQuitConfirm = useCallback(async (ok: boolean, tokenOverride?: string | null) => {
    const token = String(tokenOverride ?? quitConfirmTokenRef.current ?? "").trim();
    // 先清空 token，避免重复回包
    quitConfirmTokenRef.current = null;
    setQuitConfirm({ open: false, token: null, count: 0 });
    if (!token) return;
    try { await window.host.app.respondQuitConfirm?.(token, ok); } catch {}
  }, []);
  // 历史索引失效计数：用于在不切换项目的情况下触发强制刷新。
  const [historyInvalidateNonce, setHistoryInvalidateNonce] = useState<number>(0);
  const [projectCtxMenu, setProjectCtxMenu] = useState<{ show: boolean; x: number; y: number; project: Project | null }>({ show: false, x: 0, y: 0, project: null });
  const [hideProjectConfirm, setHideProjectConfirm] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const projectCtxMenuRef = useRef<HTMLDivElement | null>(null);
  type HoverProjectShortcutContext = {
    project: Project;
    isHidden: boolean;
    canRemoveDirRecord: boolean;
    canDeleteWorktree: boolean;
  };
  type HoverHistoryShortcutContext = { item: HistorySession; groupKey: string };
  const hoveredProjectShortcutRef = useRef<HoverProjectShortcutContext | null>(null);
  const hoveredHistoryShortcutRef = useRef<HoverHistoryShortcutContext | null>(null);
  // Simple in-memory cache to show previous results instantly when switching projects
  const historyCacheRef = useRef<Record<string, HistorySession[]>>({});
  // Gemini：基于项目路径计算 projectHash，用于在会话缺失 cwd 时仍能正确归属到项目。
  const geminiProjectHashNeedlesRef = useRef<Set<string>>(new Set());
  // UI 仅显示预览，预览由外部（后端/初始化流程）负责准备和缓存
  const [sessionPreviewMap, setSessionPreviewMap] = useState<Record<string, string>>({});

  const monthFormatter = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(i18n.language || undefined, { month: 'short' });
    } catch {
      return new Intl.DateTimeFormat(undefined, { month: 'short' });
    }
  }, [i18n.language]);
  const todayKey = new Date().toDateString();
  const historyNow = useMemo(() => new Date(), [historySessions, todayKey]);
  const sessionMatchesQuery = useCallback(
    (session: HistorySession, q: string) => {
      if (!q) return true;
      const previewSource = (session.preview || sessionPreviewMap[session.filePath || session.id] || '').toLowerCase();
      return (
        (session.title || '').toLowerCase().includes(q) ||
        (session.filePath || '').toLowerCase().includes(q) ||
        previewSource.includes(q)
      );
    },
    [sessionPreviewMap]
  );

  // Auto-adjust history context menu position to stay within viewport (pre-paint to avoid visible jump)
  useLayoutEffect(() => {
    if (!historyCtxMenu.show) return;
    const margin = 8;
    const adjust = () => {
      try {
        const el = historyCtxMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let left = historyCtxMenu.x;
        let top = historyCtxMenu.y;
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        if (left > maxLeft) left = maxLeft;
        if (top > maxTop) top = maxTop;
        if (left < margin) left = margin;
        if (top < margin) top = margin;
        if (left !== historyCtxMenu.x || top !== historyCtxMenu.y) {
          setHistoryCtxMenu((m) => ({ ...m, x: left, y: top }));
        }
      } catch {}
    };
    adjust();
    const onResize = () => adjust();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, [historyCtxMenu.show, historyCtxMenu.x, historyCtxMenu.y]);

  // Auto-adjust project context menu position to stay within viewport (pre-paint to avoid visible jump)
  useLayoutEffect(() => {
    if (!projectCtxMenu.show) return;
    const margin = 8;
    const adjust = () => {
      try {
        const el = projectCtxMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let left = projectCtxMenu.x;
        let top = projectCtxMenu.y;
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        if (left > maxLeft) left = maxLeft;
        if (top > maxTop) top = maxTop;
        if (left < margin) left = margin;
        if (top < margin) top = margin;
        if (left !== projectCtxMenu.x || top !== projectCtxMenu.y) {
          setProjectCtxMenu((m) => ({ ...m, x: left, y: top }));
        }
      } catch {}
    };
    adjust();
    const onResize = () => adjust();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, [projectCtxMenu.show, projectCtxMenu.x, projectCtxMenu.y]);

  // Settings
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Provider：决定后续“新建/启动”的命令与环境（与设置面板一致，且可扩展）
  const [activeProviderId, setActiveProviderId] = useState<string>("codex");
  const [providerItems, setProviderItems] = useState<ProviderItem[]>([
    { id: "codex" },
    { id: "claude" },
    { id: "gemini" },
  ]);
  const providerItemById = useMemo(() => buildProviderItemIndex(providerItems), [providerItems]);
  const [providerEnvById, setProviderEnvById] = useState<Record<string, Required<ProviderEnv>>>(() => ({
    codex: { terminal: "wsl", distro: "Ubuntu-24.04" },
    claude: { terminal: "wsl", distro: "Ubuntu-24.04" },
    gemini: { terminal: "wsl", distro: "Ubuntu-24.04" },
  }));
  const [wslDistro, setWslDistro] = useState("Ubuntu-24.04");
  // 基础命令（默认 'codex'），不做 tmux 包装，直接在 WSL 中执行。
  const [codexCmd, setCodexCmd] = useState("codex");
  // Claude Code：是否读取 agent-*.jsonl 等不推荐历史（仅影响历史索引/预览）。
  const [claudeCodeReadAgentHistory, setClaudeCodeReadAgentHistory] = useState<boolean>(false);
  // 网络代理设置（用于设置对话框初始值与回显）
  const [networkPrefs, setNetworkPrefs] = useState<NetworkPrefs>({ proxyEnabled: true, proxyMode: "system", proxyUrl: "", noProxy: "" });
  // ChatGPT/Codex：是否启用“记录账号”（用于自动备份与快速切换）
  const [codexAccountRecordEnabled, setCodexAccountRecordEnabled] = useState<boolean>(false);
  // 实验性：是否允许多实例（Profile）（需要重启后生效）
  const [multiInstanceEnabled, setMultiInstanceEnabled] = useState<boolean>(false);
  const [sendMode, setSendMode] = useState<'write_only' | 'write_and_enter'>("write_and_enter");
  // 项目内路径样式：absolute=全路径；relative=相对路径（默认全路径）
  const [projectPathStyle, setProjectPathStyle] = useState<'absolute' | 'relative'>('absolute');
  // 拖拽：目录外资源提醒（默认开启）
  const [dragDropWarnOutsideProject, setDragDropWarnOutsideProject] = useState<boolean>(true);
  // 界面语言：用于设置面板展示与切换
  const [locale, setLocale] = useState<string>("en");
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => normalizeThemeSetting(getCachedThemeSetting() ?? "system"));
  const [legacyResumePrompt, setLegacyResumePrompt] = useState<LegacyResumePrompt | null>(null);
  const [legacyResumeLoading, setLegacyResumeLoading] = useState(false);
  const [blockingNotice, setBlockingNotice] = useState<BlockingNotice | null>(null);

  const themeMode = useThemeController(themeSetting);

  useEffect(() => {
    writeThemeSettingCache(themeSetting);
  }, [themeSetting]);

  /**
   * 更新“目录外资源提醒”开关并持久化到主进程设置。
   */
  const updateWarnOutsideProjectDrop = useCallback(async (enabled: boolean) => {
    setDragDropWarnOutsideProject(!!enabled);
    try {
      await window.host.settings.update({ dragDrop: { warnOutsideProject: !!enabled } } as any);
    } catch {}
  }, []);

  /**
   * 统一写入 Provider 设置（同时对 codex 做 legacy 字段双写，保持旧逻辑兼容）。
   */
  const persistProviders = useCallback(async (next: { activeId: string; items: ProviderItem[]; env: Record<string, Required<ProviderEnv>> }) => {
    const codexItem = next.items.find((x) => x.id === "codex");
    const codexResolved = resolveProvider(codexItem ?? { id: "codex" });
    const codexEnv = next.env["codex"] || { terminal: "wsl", distro: wslDistro };
    try {
      await window.host.settings.update({
        providers: next as any,
        terminal: codexEnv.terminal,
        distro: codexEnv.distro,
        codexCmd: codexResolved.startupCmd || "codex",
      } as any);
    } catch (e) {
      console.warn("settings.update providers failed", e);
    }
  }, [wslDistro]);

  /**
   * 获取指定 Provider 的环境（缺失时回退到 codex 或当前状态）。
   */
  const getProviderEnv = useCallback((providerId: string): Required<ProviderEnv> => {
    const hit = providerEnvById[providerId];
    if (hit) return hit;
    const fallback = providerEnvById["codex"];
    if (fallback) return fallback;
    return { terminal: terminalMode, distro: wslDistro };
  }, [providerEnvById, terminalMode, wslDistro]);

  /**
   * 构造某个 Provider 的启动命令（Codex 会按调试开关注入 trace 环境变量）。
   */
  const buildProviderStartupCmd = useCallback((providerId: string, env: Required<ProviderEnv>): string => {
    const item = providerItems.find((x) => x.id === providerId) ?? { id: providerId };
    const resolved = resolveProvider(item);
    if (providerId === "codex") {
      return injectCodexTraceEnv({ cmd: resolved.startupCmd || codexCmd, traceEnabled: codexTraceEnabled, terminalMode: env.terminal as any });
    }
    return resolved.startupCmd;
  }, [providerItems, codexCmd, codexTraceEnabled]);

  /**
   * 获取 Provider 的展示名称（用于菜单文案与外部终端标题）。
   */
  const getProviderLabel = useCallback((providerId: string): string => {
    const id = String(providerId || "").trim();
    if (!id) return "";
    const resolved = resolveProvider(providerItemById[id] ?? { id });
    if (resolved.labelKey) {
      try { return String(t(resolved.labelKey as any)); } catch {}
    }
    const displayName = String(resolved.displayName || "").trim();
    return displayName || id;
  }, [providerItemById, t]);

  /**
   * 切换当前 Provider，并将其环境同步到“当前默认环境”状态（仅影响后续新建/启动）。
   */
  const changeActiveProvider = useCallback(async (nextId: string) => {
    const id = String(nextId || "").trim();
    if (!id || id === activeProviderId) return;
    const env = getProviderEnv(id);
    setActiveProviderId(id);
    setTerminalMode(env.terminal as any);
    setWslDistro(env.distro);
    await persistProviders({ activeId: id, items: providerItems, env: providerEnvById });
  }, [activeProviderId, getProviderEnv, persistProviders, providerEnvById, providerItems]);

  // WSL 发行版列表：供环境下拉与设置面板复用（缓存到内存，避免重复请求）
  const [availableDistros, setAvailableDistros] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const result: any = await (window.host as any).wsl?.listDistros?.();
        if (result && result.ok && Array.isArray(result.distros)) {
          const names = (result.distros as any[])
            .map((item) => (typeof item === "string" ? item : (item && typeof item.name === "string" ? item.name : null)))
            .filter((item): item is string => !!item);
          setAvailableDistros(names);
        }
      } catch {
        setAvailableDistros([]);
      }
    })();
  }, []);

  // 命令输入改为 Chips + 草稿：按 Tab 隔离
  useEffect(() => {
    try {
      (window as any).host?.app?.setTitleBarTheme?.({ mode: themeMode, source: themeSetting });
    } catch {}
  }, [themeMode, themeSetting]);
  const [chipsByTab, setChipsByTab] = useState<Record<string, PathChip[]>>({});
  const [draftByTab, setDraftByTab] = useState<Record<string, string>>({});
  const [inputFullscreenByTab, setInputFullscreenByTab] = useState<Record<string, boolean>>({});
  const [inputFullscreenClosingTabs, setInputFullscreenClosingTabs] = useState<Record<string, boolean>>({});
  const fullscreenCloseTimersRef = useRef<Record<string, number>>({});
  const chipPreviewUrlsRef = useRef<Set<string>>(new Set());
  const chipResourceRef = useRef<Map<string, PathChip>>(new Map());
  const committedChipSnapshotRef = useRef<Map<string, PathChip>>(new Map());
  const committedChipReleaseTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      try {
        const timers = fullscreenCloseTimersRef.current;
        Object.values(timers).forEach((timerId) => {
          if (typeof timerId === 'number') window.clearTimeout(timerId);
        });
      } catch {}
    };
  }, []);

  const scheduleCommittedChipRelease = useCallback((chip: PathChip) => {
    if (!chip || !chip.id || !chip.fromPaste || !chip.winPath) return;
    const chipId = chip.id;
    committedChipSnapshotRef.current.set(chipId, chip);
    retainPastedImage(chip);
    const prevTimer = committedChipReleaseTimersRef.current[chipId];
    if (typeof prevTimer === 'number') {
      window.clearTimeout(prevTimer);
      delete committedChipReleaseTimersRef.current[chipId];
    }
    const timerId = window.setTimeout(() => {
      delete committedChipReleaseTimersRef.current[chipId];
      const snapshot = committedChipSnapshotRef.current.get(chipId);
      committedChipSnapshotRef.current.delete(chipId);
      if (!snapshot) return;
      const result = releasePastedImage(snapshot);
      if (result.shouldTrash) requestTrashWinPath(result.winPath);
    }, CHIP_COMMIT_RELEASE_DELAY_MS);
    committedChipReleaseTimersRef.current[chipId] = timerId;
  }, []);

  useEffect(() => {
    const prev = chipPreviewUrlsRef.current;
    const next = new Set<string>();
    const lists = Object.values(chipsByTab);
    for (const list of lists) {
      for (const chip of list) {
        const url = String(chip?.previewUrl || "");
        if (url && url.startsWith("blob:")) next.add(url);
      }
    }
    for (const url of next) {
      if (!prev.has(url)) retainPreviewUrl(url);
    }
    for (const url of prev) {
      if (!next.has(url)) releasePreviewUrl(url);
    }
    chipPreviewUrlsRef.current = next;
  }, [chipsByTab]);

  useEffect(() => () => {
    for (const url of Array.from(chipPreviewUrlsRef.current)) {
      releasePreviewUrl(url);
    }
    chipPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    const prev = chipResourceRef.current;
    const next = new Map<string, PathChip>();
    const added: PathChip[] = [];
    const removed: PathChip[] = [];
    const lists = Object.values(chipsByTab);
    for (const list of lists) {
      for (const chip of list || []) {
        if (!chip || !chip.id) continue;
        next.set(chip.id, chip);
        if (!prev.has(chip.id)) added.push(chip);
      }
    }
    for (const [chipId, chip] of prev.entries()) {
      if (!next.has(chipId)) removed.push(chip);
    }
    if (added.length > 0) {
      for (const chip of added) {
        if (chip?.fromPaste && chip.winPath) retainPastedImage(chip);
      }
    }
    if (removed.length > 0) {
      for (const chip of removed) {
        if (!chip?.fromPaste || !chip.winPath) continue;
        const result = releasePastedImage(chip);
        if (result.shouldTrash) {
          requestTrashWinPath(result.winPath);
        }
      }
    }
    chipResourceRef.current = next;
  }, [chipsByTab]);

  useEffect(() => () => {
    const prev = chipResourceRef.current;
    chipResourceRef.current = new Map();
    for (const chip of prev.values()) {
      if (!chip?.fromPaste || !chip.winPath) continue;
      const result = releasePastedImage(chip);
      if (result.shouldTrash) {
        requestTrashWinPath(result.winPath);
      }
    }
  }, []);

  useEffect(() => () => {
    const timers = committedChipReleaseTimersRef.current;
    committedChipReleaseTimersRef.current = {};
    Object.values(timers).forEach((timerId) => { if (typeof timerId === 'number') window.clearTimeout(timerId); });
    const snapshots = committedChipSnapshotRef.current;
    committedChipSnapshotRef.current = new Map();
    for (const chip of snapshots.values()) {
      if (!chip?.fromPaste || !chip.winPath) continue;
      const result = releasePastedImage(chip);
      if (result.shouldTrash) {
        requestTrashWinPath(result.winPath);
      }
    }
  }, []);

  // 防御性清理：当视图中心从历史切回控制台、或窗口可见性发生变化时，强制关闭所有全屏遮罩
  useEffect(() => {
    if (centerMode === 'console') {
      dumpOverlayDiagnostics('before-clear-onCenterConsole');
      try { setHistoryCtxMenu((m) => ({ ...m, show: false })); } catch {}
      try { setProjectCtxMenu((m) => ({ ...m, show: false })); } catch {}
      // 释放可能残留的指针捕获（例如原生 confirm 期间的鼠标按下未正确收尾）
      try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
      try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
      // 小延迟后尝试恢复焦点（处理 confirm 等同步对话框造成的焦点丢失）
      try {
        const id = activeTabId;
        setTimeout(() => {
          try { scheduleFocusForTab(id, { immediate: true, allowDuringRename: true }); } catch {}
          try { (window as any).focus?.(); } catch {}
          dumpOverlayDiagnostics('after-clear-onCenterConsole');
        }, 0);
      } catch {}
    }
  }, [centerMode, scheduleFocusForTab, activeTabId]);

  useEffect(() => {
    const onVisibility = () => {
      try { setHistoryCtxMenu((m) => ({ ...m, show: false })); } catch {}
      try { setProjectCtxMenu((m) => ({ ...m, show: false })); } catch {}
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, []);

  // Ensure an active tab exists when tabs change
  useEffect(() => {
    // 当切换项目或 tabsByProject 变化时，恢复该项目的活跃 tab（若存在），否则选第一个
    const projectTabs = tabsByProject[selectedProjectId] || [];
    if (activeTabId && projectTabs.some((tab) => tab.id === activeTabId)) return;
    const stored = activeTabByProject[selectedProjectId];
    if (stored && projectTabs.some((tab) => tab.id === stored)) {
      setActiveTab(stored, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
      return;
    }
    if (projectTabs.length > 0) setActiveTab(projectTabs[0].id, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
    else setActiveTab(null, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
  }, [selectedProjectId, tabsByProject, activeTabByProject, activeTabId]);

  // 关键修复：当 activeTabId 通过"程序方式"变化（例如切换项目时恢复活跃 tab）时，
  // 需要显式通知 TerminalManager，触发暂停/恢复数据流、精确度量与聚焦。
  useEffect(() => {
    if (tabFocusTimerRef.current) {
      window.clearTimeout(tabFocusTimerRef.current);
      tabFocusTimerRef.current = null;
    }
    if (!activeTabId) return;
    const opts = tabFocusNextRef.current;
    scheduleFocusForTab(activeTabId, opts);
    tabFocusNextRef.current = { immediate: false, allowDuringRename: false };
    return () => {
      if (tabFocusTimerRef.current) {
        window.clearTimeout(tabFocusTimerRef.current);
        tabFocusTimerRef.current = null;
      }
    };
  }, [activeTabId, scheduleFocusForTab]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    if (!activeTabId) return;
    if (!pendingCompletionsRef.current[activeTabId]) return;
    const next = { ...pendingCompletionsRef.current };
    delete next[activeTabId];
    applyPending(next);
  }, [activeTabId]);

  useEffect(() => {
    const handleFocus = () => {
      try { autoClearActiveTabIfForeground('window-focus'); } catch {}
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, []);

  useEffect(() => {
    syncTaskbarBadge(pendingCompletionsRef.current, notificationPrefs);
  }, [notificationPrefs]);

  useEffect(() => {
    const aliveTabs = new Set<string>();
    for (const list of Object.values(tabsByProject)) {
      for (const tab of list || []) {
        aliveTabs.add(tab.id);
      }
    }
    const current = pendingCompletionsRef.current;
    let changed = false;
    const next: Record<string, number> = {};
    for (const [tabId, count] of Object.entries(current)) {
      if (aliveTabs.has(tabId) && count > 0) {
        next[tabId] = count;
      } else if (count) {
        changed = true;
      }
    }
    if (changed) {
      applyPending(next);
    }
    const currentMappings = { ...tabProjectRef.current };
    let mappingChanged = false;
    for (const tabId of Object.keys(currentMappings)) {
      if (!aliveTabs.has(tabId)) {
        delete tabProjectRef.current[tabId];
        mappingChanged = true;
      }
    }
    if (mappingChanged) {
      // no further action required; mappingRef 仅用于辅助焦点
    }
  }, [tabsByProject]);

  // Load settings and projects on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await window.host.settings.get();
        if (s) {
          const legacyTerminal = normalizeTerminalMode((s as any).terminal);
          const legacyDistro = String(s.distro || wslDistro);
          const legacyCodexCmd = String(s.codexCmd || codexCmd);
          const normalizedProviders = normalizeProvidersSettings((s as any).providers, {
            terminal: legacyTerminal,
            distro: legacyDistro,
            codexCmd: legacyCodexCmd,
          });
          setProviderItems(normalizedProviders.items);
          setProviderEnvById(normalizedProviders.env);
          setActiveProviderId(normalizedProviders.activeId);

          const activeEnv = normalizedProviders.env[normalizedProviders.activeId] || { terminal: legacyTerminal, distro: legacyDistro };
          setTerminalMode(activeEnv.terminal);
          setWslDistro(activeEnv.distro);

          const codexItem = normalizedProviders.items.find((x) => x.id === "codex");
          const codexResolved = resolveProvider(codexItem ?? { id: "codex" });
          setCodexCmd(codexResolved.startupCmd || legacyCodexCmd);
          setSendMode(s.sendMode || 'write_and_enter');
          setProjectPathStyle((s as any).projectPathStyle || 'absolute');
          setDragDropWarnOutsideProject(((s as any)?.dragDrop?.warnOutsideProject) !== false);
          const nextThemeSetting = normalizeThemeSetting((s as any).theme);
          setThemeSetting(nextThemeSetting);
          writeThemeSettingCache(nextThemeSetting);
          setNotificationPrefs(normalizeCompletionPrefs((s as any).notifications));
          setTerminalFontFamily(normalizeTerminalFontFamily((s as any).terminalFontFamily));
          setTerminalTheme(normalizeTerminalTheme((s as any).terminalTheme));
          setClaudeCodeReadAgentHistory(!!(s as any)?.claudeCode?.readAgentHistory);
          setMultiInstanceEnabled(!!(s as any)?.experimental?.multiInstanceEnabled);
          // git worktree：默认开启自动提交与规则文件复制
          try { setGitWorktreeAutoCommitEnabled(((s as any)?.gitWorktree?.autoCommitEnabled) !== false); } catch {}
          try { setGitWorktreeCopyRulesOnCreate(((s as any)?.gitWorktree?.copyRulesOnCreate) !== false); } catch {}
          try { setGitWorktreeGitPath(String((s as any)?.gitWorktree?.gitPath || "")); } catch {}
          try {
            const id = String((s as any)?.gitWorktree?.externalGitTool?.id || "rider").trim().toLowerCase();
            const normalized = (id === "rider" || id === "sourcetree" || id === "fork" || id === "gitkraken" || id === "custom") ? (id as ExternalGitToolId) : ("rider" as ExternalGitToolId);
            setGitWorktreeExternalGitToolId(normalized);
          } catch {}
          try { setGitWorktreeExternalGitToolCustomCommand(String((s as any)?.gitWorktree?.externalGitTool?.customCommand || "")); } catch {}
          try { setGitWorktreeTerminalCommand(String((s as any)?.gitWorktree?.terminalCommand || "")); } catch {}
          // 同步网络代理偏好
          try {
            const net = (s as any).network || {};
            setNetworkPrefs({
              proxyEnabled: net.proxyEnabled !== false,
              proxyMode: net.proxyMode === 'custom' ? 'custom' : 'system',
              proxyUrl: String(net.proxyUrl || ''),
              noProxy: String(net.noProxy || ''),
            });
          } catch {}
          // 同步“记录账号”偏好
          try {
            setCodexAccountRecordEnabled(!!(s as any)?.codexAccount?.recordEnabled);
          } catch {}
          // historyRoot 自动计算，无需显示设置
        }
      } catch (e) {
        console.warn('settings.get failed', e);
      }
      // 初始化语言：优先主进程（已考虑系统语言回退）
      try {
        const res = await (window as any).host?.i18n?.getLocale?.();
        if (res && res.ok && res.locale) setLocale(String(res.locale));
      } catch {}
      // 目录树：读取本地持久化结构（仅 UI 用，不触发扫描）
      try {
        const res: any = await (window as any).host?.dirTree?.get?.();
        if (res && res.ok && res.store) {
          setDirTreeStore(res.store as DirTreeStore);
        }
      } catch {}
      try {
        const res: any = await window.host.projects.list();
        if (res && res.ok && Array.isArray(res.projects)) {
          setProjects(res.projects);
          setSelectedProjectId((prev) => (res.projects.some((p: any) => p.id === prev) ? prev : ""));
        } else {
          console.warn('projects.list returned', res);
        }
      } catch (e) {
        console.warn('projects.list failed', e);
      }
      try {
        const res: any = await window.host.projects.scan();
        if (res && res.ok && Array.isArray(res.projects)) {
          setProjects(res.projects);
          setSelectedProjectId((prev) => (res.projects.some((p: any) => p.id === prev) ? prev : ""));
        } else {
          console.warn('projects.scan returned', res);
        }
      } catch (e) {
        console.warn('projects.scan failed', e);
      } finally {
        setProjectsHydrated(true);
      }
      // 启动静默检查更新（仅提示）
      try {
        const cur = await window.host.app.getVersion();
        setAppVersion(cur);
        const skip = String((globalThis as any).__cf_updates_skip__ || '').trim();
        const res = await checkForUpdate(cur, { force: false });
        if (res.status === "update" && res.latest && res.latest.version !== skip) {
          setUpdateDialog({
            show: true,
            current: cur,
            latest: {
              version: res.latest.version,
              notes: res.latest.notes,
              notesLocales: res.latest.notesLocales,
              url: res.latest.url
            }
          });
        } else if (res.status === "failed" || res.source !== "network") {
          console.warn("Silent update check fallback:", res.error || res.source);
        }
      } catch {}
    })();
  }, []);

  // 监听主进程语言变更事件，保持本地 locale 状态同步（用于设置面板默认值等）
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = (window as any)?.host?.i18n?.onLocaleChanged?.((payload: { locale: string }) => {
        const next = String(payload?.locale || 'en');
        setLocale(next);
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = window.host.notifications?.onFocusTab?.((payload: { tabId?: string }) => {
        const tabId = typeof payload?.tabId === 'string' ? payload.tabId : '';
        if (!tabId) return;
        focusTabFromNotification(tabId);
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [focusTabFromNotification]);

  // 监听主进程转发的 Gemini 完成通知（JSONL 桥接）
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = window.host.notifications?.onExternalAgentComplete?.((payload: { providerId?: string; tabId?: string; envLabel?: string; preview?: string; timestamp?: string; eventId?: string }) => {
        const providerId = String(payload?.providerId || "gemini").trim().toLowerCase();
        if (providerId && providerId !== "gemini") return;
        const preview = String(payload?.preview || "");
        const resolvedTabId = resolveExternalTabId({
          tabId: payload?.tabId,
          providerId,
          envLabel: payload?.envLabel,
        });
        if (!resolvedTabId) {
          notifyLog(`externalCompletion skip: no tab match provider=${providerId} env=${payload?.envLabel || ""}`);
          return;
        }
        const cleanedPreview = normalizeCompletionPreview(preview);
        if (isDuplicateCompletion(resolvedTabId, cleanedPreview, 1500)) {
          notifyLog(`externalCompletion dedupe tab=${resolvedTabId}`);
          return;
        }
        notifyLog(`externalCompletion ok tab=${resolvedTabId} previewLen=${cleanedPreview.length}`);
        handleAgentCompletion(resolvedTabId, preview);
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [handleAgentCompletion, isDuplicateCompletion, notifyLog, resolveExternalTabId]);

  // 监听主进程“退出确认”请求：用应用内 Dialog 替代原生对话框，保持 UI 风格一致
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = window.host.app?.onQuitConfirm?.((payload: { token: string; count: number }) => {
        const token = String(payload?.token || "").trim();
        const count = Math.max(0, Math.floor(Number(payload?.count) || 0));
        if (!token) return;
        const prev = quitConfirmTokenRef.current;
        if (prev && prev !== token) void respondQuitConfirm(false, prev);
        quitConfirmTokenRef.current = token;
        setQuitConfirm({ open: true, token, count });
      });
    } catch {}
    return () => { try { off && off(); } catch {} };
  }, [respondQuitConfirm]);

  // Filtered projects
  const pendingByProject = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [projectId, list] of Object.entries(tabsByProject)) {
      let sum = 0;
      for (const tab of list || []) {
        const pending = pendingCompletions[tab.id];
        if (typeof pending === 'number' && pending > 0) {
          sum += pending;
        }
      }
      if (sum > 0) map[projectId] = sum;
    }
    return map;
  }, [pendingCompletions, tabsByProject]);

  /**
   * 将项目列表映射为“最多一级”的目录树行：
   * - 根节点按当前排序（recent/name/manual）输出
   * - 子节点按 childOrderByParent 输出（仅在父节点展开时展示）
   */
  const dirTreeRows = useMemo(() => {
    const byId = new Map<string, Project>();
    for (const p of visibleProjects) {
      if (p?.id) byId.set(p.id, p);
    }
    const isChild = (id: string): boolean => !!dirTreeStore.parentById[id];
    const roots = sortedProjects.filter((p) => p?.id && !isChild(p.id));

    const rows: Array<{ project: Project; depth: 0 | 1; parentId?: string }> = [];
    for (const root of roots) {
      rows.push({ project: root, depth: 0 });
      const childIds = dirTreeStore.childOrderByParent[root.id] || [];
      const expanded = dirTreeStore.expandedById[root.id] !== false;
      if (!expanded) continue;
      for (const cid of childIds) {
        const child = byId.get(cid);
        if (!child) continue;
        rows.push({ project: child, depth: 1, parentId: root.id });
      }
    }
    return rows;
  }, [dirTreeStore.childOrderByParent, dirTreeStore.expandedById, dirTreeStore.parentById, sortedProjects, visibleProjects]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sortedProjects;
    const q = query.toLowerCase();
    return sortedProjects.filter((p) => `${p.name} ${p.winPath}`.toLowerCase().includes(q));
  }, [sortedProjects, query]);

  const tabsForProject = tabsByProject[selectedProjectId] || [];
  const activeTab = useMemo(() => tabsForProject.find((tab) => tab.id === activeTabId) || null, [tabsForProject, activeTabId]);

  // ---------- Actions ----------

  /**
   * 关闭并清理指定项目下的所有控制台/PTY 与关联内存状态。
   *
   * 说明：该方法不修改 projects 列表与隐藏列表，仅做运行态清理，供“隐藏项目/移除目录记录”等场景复用。
   */
  const cleanupProjectRuntime = useCallback((project: Project | null) => {
    if (!project) return;
    const projectTabs = tabsByProject[project.id] || [];
    const tabIds = projectTabs.map((tab) => tab.id);
    for (const tabId of tabIds) {
      const ptyId = ptyByTabRef.current[tabId];
      if (ptyId) {
        try { window.host.pty.close(ptyId); } catch {}
        unregisterPtyListener(ptyId);
        delete ptyByTabRef.current[tabId];
      }
      delete ptyAliveRef.current[tabId];
      clearPendingForTab(tabId);
      unregisterTabProject(tabId);
      try { tm.disposeTab(tabId, true); } catch (err) { console.warn('tm.disposeTab failed', err); }
    }
    if (tabIds.length > 0) {
      setPtyByTab((prev) => {
        const next = { ...prev };
        for (const tabId of tabIds) delete next[tabId];
        return next;
      });
      setPtyAlive((prev) => {
        const next = { ...prev };
        for (const tabId of tabIds) delete next[tabId];
        return next;
      });
      setChipsByTab((prev) => {
        const next = { ...prev };
        for (const tabId of tabIds) delete next[tabId];
        return next;
      });
      setDraftByTab((prev) => {
        const next = { ...prev };
        for (const tabId of tabIds) delete next[tabId];
        return next;
      });
    }
    setTabsByProject((prev) => {
      if (!(project.id in prev)) return prev;
      const next = { ...prev };
      delete next[project.id];
      return next;
    });
    setActiveTabByProject((prev) => {
      if (!(project.id in prev)) return prev;
      const next = { ...prev };
      delete next[project.id];
      return next;
    });
    if (tabIds.includes(activeTabId || "")) {
      setActiveTab(null, { projectId: project.id, focusMode: 'immediate', allowDuringRename: true });
    }
    try {
      const projectKey = canonicalizePath(project.wslPath || project.winPath || project.id);
      if (projectKey) delete historyCacheRef.current[projectKey];
    } catch {}
    setSelectedProjectId((prev) => (prev === project.id ? "" : prev));
    try { suppressAutoSelectRef.current = true; } catch {}
    setSelectedHistoryDir(null);
    setSelectedHistoryId(null);
    setCenterMode('console');
  }, [activeTabId, setActiveTab, tabsByProject, tm]);

  /**
   * 隐藏项目：关闭该项目下的所有控制台/PTY，并将其加入隐藏列表（会持久化）。
   */
  const hideProject = useCallback((project: Project | null) => {
    if (!project) return;
    cleanupProjectRuntime(project);
    setHiddenProjectIds((prev) => (prev.includes(project.id) ? prev : [...prev, project.id]));
    setHideProjectConfirm({ open: false, project: null });
    setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
  }, [cleanupProjectRuntime]);

  /**
   * 取消隐藏项目：从隐藏列表移除该项目 id。
   */
  const unhideProject = useCallback((project: Project | null) => {
    if (!project) return;
    setHiddenProjectIds((prev) => prev.filter((id) => id !== project.id));
  }, []);

  /**
   * 将项目从 UI 列表中移除（仅移除记录，不删除磁盘目录），并清理该项目下的运行态资源。
   */
  const removeProjectFromUIList = useCallback((project: Project | null) => {
    if (!project) return;
    cleanupProjectRuntime(project);
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    setHiddenProjectIds((prev) => prev.filter((id) => id !== project.id));
    setHideProjectConfirm({ open: false, project: null });
    setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
  }, [cleanupProjectRuntime]);

  function markProjectUsed(projectId: string | null | undefined) {
    try { suppressAutoSelectRef.current = true; } catch {}
    if (!projectId) return;
    try {
      const now = Date.now();
      setProjects((prev) => prev.map((x) => (x.id === projectId ? { ...x, lastOpenedAt: now } : x)));
    } catch {}
  }

  /**
   * 用最新项目对象回写到 projects 列表（优先按 id 匹配，winPath 兜底）。
   */
  const upsertProjectInList = useCallback((nextProject: Project) => {
    try {
      const next = nextProject as any;
      const nextId = String(next?.id || "").trim();
      const nextWin = String(next?.winPath || "").replace(/\\/g, "/").toLowerCase();
      if (!nextId && !nextWin) return;
      setProjects((prev) => {
        const byId = nextId ? prev.findIndex((p) => p.id === nextId) : -1;
        if (byId >= 0) {
          const copy = prev.slice();
          copy[byId] = { ...(prev[byId] as any), ...(nextProject as any) };
          return copy;
        }
        if (nextWin) {
          const byPath = prev.findIndex((p) => String(p.winPath || "").replace(/\\/g, "/").toLowerCase() === nextWin);
          if (byPath >= 0) {
            const copy = prev.slice();
            copy[byPath] = { ...(prev[byPath] as any), ...(nextProject as any), id: prev[byPath].id || nextId };
            return copy;
          }
        }
        return [nextProject, ...prev];
      });
    } catch {}
  }, []);

  /**
   * 标记某个项目已开始/存在内置三引擎会话（用于抑制“移除目录记录”误判）。
   */
  const markProjectHasBuiltInSessions = useCallback((projectId: string) => {
    const id = String(projectId || "").trim();
    if (!id) return;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, hasBuiltInSessions: true, dirRecord: undefined } : p)));
  }, []);

  /**
   * 自定义 Provider 新建会话时记录目录：避免自定义引擎无法被会话扫描反推 cwd，导致该项目在下次扫描时“消失”。
   */
  const recordCustomProviderDirIfNeeded = useCallback(async (project: Project, providerId: string) => {
    try {
      const pid = String(providerId || "").trim();
      if (!pid || isBuiltInSessionProviderId(pid)) return;
      if (project?.hasBuiltInSessions === true) return;
      const existing = (project as any)?.dirRecord;
      if (existing && String(existing.kind || "") === "custom_provider" && String(existing.providerId || "") === pid) return;
      const res: any = await window.host.projects.add({ winPath: project.winPath, dirRecord: { providerId: pid } });
      if (res && res.ok && res.project) {
        upsertProjectInList(res.project as Project);
      }
    } catch {}
  }, [upsertProjectInList]);

  // 新增项目并选中，随后自动为该项目打开一个控制台（无 tmux 包装）

  async function openConsoleForProject(project: Project) {
    if (!project) return;
    const tabName = isWindowsLike(terminalMode)
      ? toShellLabel(terminalMode)
      : (wslDistro || `Console ${((tabsByProject[project.id] || []).length + 1).toString()}`);
    const tab: ConsoleTab = {
      id: uid(),
      name: String(tabName),
      providerId: activeProviderId,
      logs: [],
      createdAt: Date.now(),
    };
    const notifyEnv = buildGeminiNotifyEnv(tab.id, tab.providerId, tab.name);
    let ptyId: string | undefined;
    try {
      const env = getProviderEnv(activeProviderId);
      const startupCmd = buildProviderStartupCmd(activeProviderId, env);
      const { id } = await window.host.pty.openWSLConsole({
        terminal: env.terminal,
        distro: env.distro,
        wslPath: project.wslPath,
        winPath: project.winPath,
        cols: 80,
        rows: 24,
        startupCmd,
        env: notifyEnv,
      });
      ptyId = id;
    } catch (e) {
      console.error('Failed to open PTY for project', e);
      alert(String(t('terminal:openFailed', { error: String((e as any)?.message || e) })));
      return;
    }

    // 内置三引擎：即便会话记录落盘存在延迟，也先在 UI 侧标记，避免“自定义目录记录可移除”误判。
    if (isBuiltInSessionProviderId(activeProviderId)) {
      markProjectHasBuiltInSessions(project.id);
    } else {
      void recordCustomProviderDirIfNeeded(project, activeProviderId);
    }

    registerTabProject(tab.id, project.id);
    setTabsByProject((m) => ({ ...m, [project.id]: [...(m[project.id] || []), tab] }));
    setActiveTab(tab.id, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
    if (ptyId) {
      ptyByTabRef.current[tab.id] = ptyId;
      setPtyByTab((m) => ({ ...m, [tab.id]: ptyId }));
      ptyAliveRef.current[tab.id] = true;
      setPtyAlive((m) => ({ ...m, [tab.id]: true }));
      registerPtyForTab(tab.id, ptyId);
      try { tm.setPty(tab.id, ptyId); } catch (err) { console.warn('tm.setPty failed', err); }
    }
    try { window.host.projects.touch(project.id); } catch {}
    // 打开控制台后，立即在内存中更新最近使用时间，保证"最近使用优先"实时生效
    markProjectUsed(project.id);
    // 确保视图停留在控制台
    try { setCenterMode('console'); } catch {}
  }
  // 点击"打开项目"：弹出系统选择目录并把选中目录加入项目，随后打开控制台
  async function openProjectPicker() {
    try {
      const res: any = await (window.host.utils as any).chooseFolder();
      if (!(res && res.ok && res.path)) return;
      const winPath = String(res.path || '').trim();
      if (!winPath) return;
      // 若该路径已在项目列表中，行为等同于点击对应项目
      const exists = projects.find((x) => String(x.winPath || '').replace(/\\/g, '/').toLowerCase() === winPath.replace(/\\/g, '/').toLowerCase());
      if (exists) {
        // 用户显式打开：若该项目处于隐藏状态，自动取消隐藏，避免“已选中但列表不可见”的矛盾状态
        if (hiddenProjectIdSet.has(exists.id)) {
          setHiddenProjectIds((prev) => prev.filter((id) => id !== exists.id));
        }
        try { suppressAutoSelectRef.current = true; } catch {}
        setSelectedProjectId(exists.id);
        try { await openConsoleForProject(exists); } catch {}
        return;
      }
      const added: any = await window.host.projects.add({ winPath });
      if (added && added.ok && added.project) {
        const p = added.project as Project;
        if (hiddenProjectIdSet.has(p.id)) {
          setHiddenProjectIds((prev) => prev.filter((id) => id !== p.id));
        }
        // 在选中项目前抑制自动选中历史详情
        try { suppressAutoSelectRef.current = true; } catch {}
        setProjects((s) => [p, ...s]);
        setSelectedProjectId(p.id);
        try { await openConsoleForProject(p); } catch {}
      }
    } catch (e) {
      console.warn('openProjectPicker failed', e);
    }
  }

  const attachTerminal = React.useCallback((tabId: string, el: HTMLDivElement) => {
    try { tm.attachToHost(tabId, el); } catch (err) { console.warn('attachTerminal via tm failed', err); }
  }, [tm]);

  async function openNewConsole() {
    if (!selectedProject) return;
    const tabName = isWindowsLike(terminalMode)
      ? toShellLabel(terminalMode)
      : (wslDistro || `Console ${((tabsByProject[selectedProject.id] || []).length + 1).toString()}`);
    const tab: ConsoleTab = {
      id: uid(),
      // 默认使用当前设置中的终端名称
      name: String(tabName),
      providerId: activeProviderId,
      logs: [],
      createdAt: Date.now(),
    };
    const notifyEnv = buildGeminiNotifyEnv(tab.id, tab.providerId, tab.name);
    let ptyId: string | undefined;
    // Open PTY in main (WSL)
    try {
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole start project=${selectedProject?.name}`); } catch {}
      const env = getProviderEnv(activeProviderId);
      const startupCmd = buildProviderStartupCmd(activeProviderId, env);
      const { id } = await window.host.pty.openWSLConsole({
        terminal: env.terminal,
        distro: env.distro,
        wslPath: selectedProject.wslPath,
        winPath: selectedProject.winPath,
        cols: 80,
        rows: 24,
        startupCmd,
        env: notifyEnv,
      });
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole pty=${id}`); } catch {}
      ptyId = id;
    } catch (e) {
      console.error('Failed to open PTY', e);
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole error ${String((e as any)?.stack || e)}`); } catch {}
      alert(String(t('terminal:openFailed', { error: String((e as any)?.message || e) })));
      return;
    }

    // 内置三引擎：即便会话记录落盘存在延迟，也先在 UI 侧标记，避免“自定义目录记录可移除”误判。
    if (isBuiltInSessionProviderId(activeProviderId)) {
      markProjectHasBuiltInSessions(selectedProject.id);
    } else {
      void recordCustomProviderDirIfNeeded(selectedProject, activeProviderId);
    }

    registerTabProject(tab.id, selectedProject.id);
    setTabsByProject((m) => ({ ...m, [selectedProject.id]: [...(m[selectedProject.id] || []), tab] }));
    setActiveTab(tab.id, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
    if (ptyId) {
      ptyByTabRef.current[tab.id] = ptyId;
      setPtyByTab((m) => ({ ...m, [tab.id]: ptyId }));
      ptyAliveRef.current[tab.id] = true;
      setPtyAlive((m) => ({ ...m, [tab.id]: true }));
      registerPtyForTab(tab.id, ptyId);
      // inform manager about PTY so it can wire bridges
      try { tm.setPty(tab.id, ptyId); } catch (err) { console.warn('tm.setPty failed', err); }
    }
    // touch project lastOpenedAt
    try { window.host.projects.touch(selectedProject.id); } catch {}
    // 同步更新内存，触发排序刷新；并抑制历史面板自动切换
    markProjectUsed(selectedProject.id);
  }

  // 计算当前项目的 Gemini projectHash 候选（用于索引事件归属判断）
  useEffect(() => {
    let cancelled = false;
    const next = new Set<string>();
    geminiProjectHashNeedlesRef.current = next;
    if (!selectedProject) return;

    (async () => {
      /**
       * 将项目路径加入 hash 候选集合（兼容 WSL/Windows 的路径字符串差异）。
       */
      const addCandidate = async (p?: string) => {
        const raw = typeof p === "string" ? p.trim() : "";
        if (!raw) return;
        try {
          const hashes = await deriveGeminiProjectHashCandidatesFromPath(raw);
          for (const h of hashes) {
            if (h) next.add(h);
          }
        } catch {}
      };
      await Promise.all([
        addCandidate(selectedProject.wslPath),
        addCandidate(selectedProject.winPath),
      ]);
      if (!cancelled) geminiProjectHashNeedlesRef.current = next;
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  // 当项目变更时，加载历史（项目范围）
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!selectedProject) {
        setHistorySessions([]);
        setSelectedHistoryDir(null);
        setSelectedHistoryId(null);
        setHistoryLoading(false);
        return;
      }
      // 如果是用户刚刚通过点击项目触发的切换，则抑制自动选中历史（保持控制台视图）
      const skipAuto = suppressAutoSelectRef.current;
      const projectKey = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
      const ensureIso = (d: any): string => normalizeMsToIso(d);
      // 先显示缓存
      const cached = historyCacheRef.current[projectKey];
      const hasCache = !!(cached && cached.length > 0);
      setHistoryLoading(!hasCache);
      if (hasCache) {
        setHistorySessions(cached);
        // 若当前选择无效或为空，重置为缓存中的第一组（除非是点击项目触发的切换）
        if (!skipAuto) {
          const nowRef = new Date();
          const keyOf = (item?: HistorySession) => historyTimelineGroupKey(item, nowRef);
          const dirs = new Set(cached.map((x) => keyOf(x)));
          const ids = new Set(cached.map((x) => x.id));
          const invalidSelection = (!selectedHistoryId || !ids.has(selectedHistoryId) || !selectedHistoryDir || !dirs.has(selectedHistoryDir));
          const firstKey = cached.length > 0 ? keyOf(cached[0]) : null;
          if (invalidSelection && firstKey) {
            // 仅优化默认 UI：展开最新分组，不自动选择会话，也不切换到详情
            setSelectedHistoryDir(null);
            setSelectedHistoryId(null);
            setExpandedGroups({ [firstKey]: true });
          }
        }
      } else {
        setHistorySessions([]);
        setSelectedHistoryDir(null);
        setSelectedHistoryId(null);
      }
      try {
        // 固定为项目范围历史
        const res: any = await window.host.history.list({ projectWslPath: selectedProject.wslPath, projectWinPath: selectedProject.winPath });
        if (cancelled) return;
        if (!(res && res.ok && Array.isArray(res.sessions))) throw new Error('history.list failed');
        // 映射时：优先将后端提供的 rawDate 作为 title（原始字符串），避免前端再做时区/格式化转换
        // 同时接收后端提供的 preview 字段，并把它同步到前端只读映射 sessionPreviewMap
        const mapped: HistorySession[] = res.sessions.map((h: any) => ({
          providerId: (h.providerId === "claude" || h.providerId === "gemini") ? h.providerId : "codex",
          id: h.id,
          title: (typeof h.rawDate === 'string' ? String(h.rawDate) : h.title),
          date: ensureIso(h.date),
          rawDate: (typeof h.rawDate === 'string' ? h.rawDate : undefined),
          preview: (typeof h.preview === 'string' ? String(h.preview) : undefined),
          messages: [],
          filePath: h.filePath,
          resumeMode: normalizeResumeMode(h.resumeMode),
          resumeId: typeof h.resumeId === 'string' ? h.resumeId : undefined,
          runtimeShell: h.runtimeShell === 'windows' ? 'windows' : (h.runtimeShell === 'wsl' ? 'wsl' : 'unknown'),
        }));
        setHistorySessions(mapped as any);
        setSessionPreviewMap((cur) => {
          const next = { ...cur } as Record<string, string>;
          for (const s of mapped) {
            const key = s.filePath || s.id;
            if (s.preview && key && !next[key]) next[key] = clampText(s.preview, 40);
          }
          return next;
        });
        historyCacheRef.current[projectKey] = mapped;
        // 校验并修正当前选择，避免缓存残留导致的空白详情
        if (!skipAuto) {
          const ids = new Set(mapped.map((x) => x.id));
          const nowRef = new Date();
          const keyOf = (item?: HistorySession) => historyTimelineGroupKey(item, nowRef);
          const dirs = new Set(mapped.map((x) => keyOf(x)));
          const needResetId = !selectedHistoryId || !ids.has(selectedHistoryId);
          const needResetDir = !selectedHistoryDir || !dirs.has(selectedHistoryDir);
          if ((needResetId || needResetDir) && mapped.length > 0) {
            const firstKey = keyOf(mapped[0]);
            // 仅优化默认 UI：展开最新分组，不自动选择会话，也不切换到详情
            setSelectedHistoryDir(null);
            setSelectedHistoryId(null);
            setExpandedGroups({ [firstKey]: true });
          }
        }
        // 如果抑制了自动选择，需要在处理完加载后重置抑制标志
        if (skipAuto) suppressAutoSelectRef.current = false;
      } catch (e) {
        if (!cancelled) console.warn('history.list failed', e);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedProject, historyInvalidateNonce]);

  // 订阅索引器事件：新增/更新/删除时，若属于当前选中项目则立即更新 UI
  useEffect(() => {
    if (!selectedProject) return;
    const projectNeedles: string[] = Array.from(new Set([
      canonicalizePath(selectedProject.wslPath || ''),
      canonicalizePath(selectedProject.winPath || ''),
    ].filter(Boolean)));
    const startsWithBoundary = (child: string, parent: string): boolean => {
      try {
        const c = String(child || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
        const p = String(parent || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
        if (!c || !p) return false;
        if (c === p) return true;
        return c.startsWith(p + '/');
      } catch { return false; }
    };
    const belongsToSelected = (item: any): boolean => {
      try {
        const dirKey: string = String((item && (item.dirKey || '')) || '').toLowerCase();
        if (dirKey) return projectNeedles.some((n) => startsWithBoundary(dirKey, n));
      } catch {}
      try {
        const pid = String(item?.providerId || '').toLowerCase();
        if (pid === 'gemini') {
          const h = extractGeminiProjectHashFromPath(String(item?.filePath || ''));
          if (h && geminiProjectHashNeedlesRef.current.has(h)) return true;
        }
      } catch {}
      try {
        const fp = String(item?.filePath || '');
        if (!fp) return false;
        const dir = normDir(fp);
        return projectNeedles.some((n) => startsWithBoundary(dir, n));
      } catch {}
      return false;
    };
    const toSession = (it: any): HistorySession => {
      const ensureIso = (d: any): string => normalizeMsToIso(d);
      return {
        providerId: (it.providerId === "claude" || it.providerId === "gemini") ? it.providerId : "codex",
        id: String(it.id || ''),
        title: typeof it.rawDate === 'string' ? String(it.rawDate) : String(it.title || ''),
        date: ensureIso(it.date),
        rawDate: (typeof it.rawDate === 'string' ? it.rawDate : undefined),
        preview: (typeof it.preview === 'string' ? it.preview : undefined),
        messages: [],
        filePath: String(it.filePath || ''),
        resumeMode: normalizeResumeMode(it.resumeMode),
        resumeId: typeof it.resumeId === 'string' ? it.resumeId : undefined,
        runtimeShell: it.runtimeShell === 'windows' ? 'windows' : (it.runtimeShell === 'wsl' ? 'wsl' : 'unknown'),
      };
    };
    const upsertSessions = (items: any[]) => {
      if (!Array.isArray(items) || items.length === 0) return;
      setHistorySessions((cur) => {
        const mp = new Map<string, HistorySession>();
        for (const s of cur) mp.set(String(s.filePath || s.id), s);
        let changed = false;
        for (const it of items) {
          if (!belongsToSelected(it)) continue;
          const s = toSession(it);
          const key = s.filePath || s.id;
          const prev = mp.get(key);
          if (
            !prev ||
            prev.providerId !== s.providerId ||
            prev.date !== s.date ||
            prev.title !== s.title ||
            prev.rawDate !== s.rawDate ||
            prev.preview !== s.preview ||
            prev.resumeMode !== s.resumeMode ||
            prev.resumeId !== s.resumeId ||
            prev.runtimeShell !== s.runtimeShell
          ) {
            mp.set(key, s);
            changed = true;
          }
        }
        if (!changed) return cur;
        const next = Array.from(mp.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        try {
          const projectKey = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
          historyCacheRef.current[projectKey] = next;
          setSessionPreviewMap((curMap) => {
            const mm = { ...curMap } as Record<string, string>;
            for (const s of next) {
              const key = s.filePath || s.id;
              if (s.preview && key && !mm[key]) mm[key] = clampText(s.preview, 40);
            }
            return mm;
          });
        } catch {}
        return next;
      });
    };
    const updateOne = (it: any) => upsertSessions([it]);
    const removeOne = (filePath: string) => {
      if (!filePath) return;
      setHistorySessions((cur) => {
        const next = cur.filter((x) => (x.filePath || x.id) !== filePath);
        if (next.length === cur.length) return cur;
        try {
          const projectKey = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
          historyCacheRef.current[projectKey] = next;
        } catch {}
        // 若当前选中项被移除，选择同组最新一条
        if (selectedHistoryId && !next.some((x) => x.id === selectedHistoryId)) {
          const nowRef = new Date();
          const keyOf = (item?: HistorySession) => historyTimelineGroupKey(item, nowRef);
          const removedSession = cur.find((x) => (x.filePath || x.id) === filePath);
          const key = removedSession ? keyOf(removedSession) : HISTORY_UNKNOWN_GROUP_KEY;
          const restInGroup = next
            .filter((x) => keyOf(x) === key)
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          if (restInGroup.length > 0) setSelectedHistoryId(restInGroup[0].id);
          else {
            const groups = Array.from(new Set(next.map((x) => keyOf(x))));
            const firstKey = groups[0] || null;
            setSelectedHistoryDir(firstKey);
            if (firstKey) {
              const firstInDir = next
                .filter((x) => keyOf(x) === firstKey)
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
              setSelectedHistoryId(firstInDir ? firstInDir.id : null);
            } else {
              setSelectedHistoryId(null);
            }
          }
          setCenterMode('history');
        }
        return next;
      });
    };
    const unsubAdd = window.host.history.onIndexAdd?.((payload: { items: any[] }) => {
      try { upsertSessions(payload?.items || []); } catch {}
    }) || (() => {});
    const unsubUpd = window.host.history.onIndexUpdate?.((payload: { item: any }) => {
      try { updateOne(payload?.item); } catch {}
    }) || (() => {});
    const unsubRem = window.host.history.onIndexRemove?.((payload: { filePath: string }) => {
      try { removeOne(String(payload?.filePath || '')); } catch {}
    }) || (() => {});
    const unsubInvalidate = window.host.history.onIndexInvalidate?.((_payload: { reason?: string }) => {
      try {
        const projectKey = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
        delete historyCacheRef.current[projectKey];
      } catch {}
      try { setHistoryInvalidateNonce((x) => x + 1); } catch {}
    }) || (() => {});
    return () => { try { unsubAdd(); } catch {}; try { unsubUpd(); } catch {}; try { unsubRem(); } catch {}; try { unsubInvalidate(); } catch {}; };
  }, [selectedProject, selectedHistoryId, selectedHistoryDir]);

  // Subscribe to PTY exit/error events：标记退出并更新计数（不修改标签名）
  useEffect(() => {
    const unsubExit = typeof window.host.pty.onExit === 'function'
      ? window.host.pty.onExit((payload) => {
          const { id } = payload;
          // find tabId
          const tabId = Object.keys(ptyByTabRef.current).find((k) => ptyByTabRef.current[k] === id);
          if (!tabId) return;
          // 标记存活状态为 false，并移除映射，避免后续写入
          try {
            ptyAliveRef.current[tabId] = false;
            setPtyAlive((m) => ({ ...m, [tabId]: false }));
            delete ptyByTabRef.current[tabId];
            setPtyByTab((m) => { const n = { ...m }; delete n[tabId]; return n; });
            unregisterPtyListener(id);
          } catch {}
        })
      : () => {};

    return () => { try { unsubExit(); } catch {} };
  }, [selectedProjectId]);

  function compileTextFromChipsAndDraft(tabId: string): string {
    const chips = chipsByTab[tabId] || [];
    const draft = draftByTab[tabId] || "";
    const parts: string[] = [];
    if (chips.length > 0) {
      parts.push(
        chips
          .map((c) => {
            if (isWindowsLike(terminalMode)) {
              // 优先 Windows 路径；若不存在，则从 WSL 路径推导
              let wp = String(c.winPath || '').trim();
              if (!wp) {
                const wsl = String(c.wslPath || '').trim();
                if (wsl) {
                  const m = wsl.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
                  if (m) {
                    wp = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
                  } else if (selectedProject && selectedProject.wslPath && selectedProject.winPath) {
                    // 若为绝对 WSL 且在项目内，映射为 Windows 绝对路径
                    const rootW = String(selectedProject.wslPath).replace(/\\/g, '/');
                    const w = wsl.replace(/\\/g, '/');
                    if (w === rootW || w.startsWith(rootW + '/')) {
                      const rel = w.slice(rootW.length).replace(/^\/+/, '').replace(/\//g, '\\');
                      wp = String(selectedProject.winPath).replace(/\/+$/, '') + (rel ? (String(selectedProject.winPath).endsWith('\\') ? '' : '\\') + rel : '');
                    }
                  }
                }
              }
              return wp ? ('`' + wp + '`') : (c.fileName || '');
            }
            // 默认 WSL 模式
            return c.wslPath ? ('`' + c.wslPath + '`') : (c.winPath || c.fileName || '');
          })
          .join("\n")
      );
    }
    if (draft && draft.trim()) {
      if (parts.length > 0) parts.push("");
      parts.push(draft.trim());
    }
    return parts.join("\n");
  }

  const requestInputFullscreenOpen = useCallback((tabId: string) => {
    if (!tabId) return;
    const isClosing = !!inputFullscreenClosingTabs[tabId];
    const stableOpen = !!inputFullscreenByTab[tabId] && !isClosing;
    if (stableOpen) return;
    const timers = fullscreenCloseTimersRef.current;
    if (typeof timers[tabId] === 'number') {
      window.clearTimeout(timers[tabId]);
      delete timers[tabId];
    }
    setInputFullscreenClosingTabs((m) => {
      if (!m[tabId]) return m;
      const next = { ...m };
      delete next[tabId];
      return next;
    });
    setInputFullscreenByTab((m) => {
      if (m[tabId]) return m;
      return { ...m, [tabId]: true };
    });
  }, [inputFullscreenByTab, inputFullscreenClosingTabs]);

  const requestInputFullscreenClose = useCallback((tabId: string, options?: InputFullscreenCloseOptions) => {
    if (!tabId) return;
    const isOpen = !!inputFullscreenByTab[tabId];
    const isClosing = !!inputFullscreenClosingTabs[tabId];
    if (!isOpen && !isClosing) return;
    const timers = fullscreenCloseTimersRef.current;
    if (typeof timers[tabId] === 'number') {
      window.clearTimeout(timers[tabId]);
      delete timers[tabId];
    }
    if (options?.immediate) {
      setInputFullscreenClosingTabs((m) => {
        if (!m[tabId]) return m;
        const next = { ...m };
        delete next[tabId];
        return next;
      });
      setInputFullscreenByTab((m) => {
        if (!m[tabId]) return m;
        const next = { ...m };
        delete next[tabId];
        return next;
      });
      return;
    }
    setInputFullscreenClosingTabs((m) => (m[tabId] ? m : { ...m, [tabId]: true }));
    const timer = window.setTimeout(() => {
      setInputFullscreenClosingTabs((m) => {
        if (!m[tabId]) return m;
        const next = { ...m };
        delete next[tabId];
        return next;
      });
      setInputFullscreenByTab((m) => {
        if (!m[tabId]) return m;
        const next = { ...m };
        delete next[tabId];
        return next;
      });
      delete fullscreenCloseTimersRef.current[tabId];
    }, INPUT_FULLSCREEN_TRANSITION_MS);
    fullscreenCloseTimersRef.current[tabId] = timer;
  }, [inputFullscreenByTab, inputFullscreenClosingTabs]);

  const setInputFullscreenState = useCallback((tabId: string, next: boolean) => {
    if (!tabId) return;
    if (next) requestInputFullscreenOpen(tabId);
    else requestInputFullscreenClose(tabId);
  }, [requestInputFullscreenClose, requestInputFullscreenOpen]);

  const toggleInputFullscreen = useCallback((tabId: string) => {
    if (!tabId) return;
    const isOpen = !!inputFullscreenByTab[tabId];
    const isClosing = !!inputFullscreenClosingTabs[tabId];
    if (isOpen && !isClosing) requestInputFullscreenClose(tabId);
    else requestInputFullscreenOpen(tabId);
  }, [inputFullscreenByTab, inputFullscreenClosingTabs, requestInputFullscreenClose, requestInputFullscreenOpen]);

  function sendCommand() {
    if (!activeTab) return;
    const chipsSnapshot = chipsByTab[activeTab.id] || [];
    const text = compileTextFromChipsAndDraft(activeTab.id);
    if (!text.trim()) return;
    const pid = ptyByTabRef.current[activeTab.id];
    if (!pid) return;
    // 统一改用 TerminalManager 的封装，保证行为一致且便于复用
    try {
      if (sendMode === 'write_and_enter') tm.sendTextAndEnter(activeTab.id, text, { providerId: activeTab.providerId });
      else tm.sendText(activeTab.id, text, { providerId: activeTab.providerId });
    } catch {
      // 兜底：避免 Gemini 直接写入 `\n` 被吞，统一使用 bracketed paste +（可选）延迟回车
      try {
        if (isGeminiProvider(activeTab.providerId)) {
          const write = (data: string) => { try { window.host.pty.write(pid, data); } catch {} };
          if (sendMode === "write_and_enter") writeBracketedPasteAndEnter(write, text, { providerId: activeTab.providerId });
          else writeBracketedPaste(write, text);
        } else {
          // 非 Gemini：直接写入 PTY，并在需要时单独补 CR
          try { window.host.pty.write(pid, text); } catch {}
          if (sendMode === 'write_and_enter') { try { window.host.pty.write(pid, '\r'); } catch {} }
        }
      } catch {}
    }
    if (chipsSnapshot.length > 0) {
      for (const chip of chipsSnapshot) {
        scheduleCommittedChipRelease(chip);
      }
    }
    setChipsByTab((m) => ({ ...m, [activeTab.id]: [] }));
    setDraftByTab((m) => ({ ...m, [activeTab.id]: "" }));
    setInputFullscreenState(activeTab.id, false);

    // worktree 自动提交：用户第 2 条输入开始，每次输入后若有变更则提交一次
    try {
      const projectId = selectedProject?.id;
      if (projectId) {
        const prevCount = userInputCountByTabIdRef.current[activeTab.id] || 0;
        const nextCount = prevCount + 1;
        userInputCountByTabIdRef.current[activeTab.id] = nextCount;
        if (nextCount >= 2) enqueueAutoCommit(projectId, "user", text);
      }
    } catch {}
  }

  function closeTab(id: string) {
    if (!selectedProject) return;
    const pid = ptyByTabRef.current[id];
    if (pid) {
      try { window.host.pty.close(pid); } catch {}
      delete ptyByTabRef.current[id];
      unregisterPtyListener(pid);
    }
    try { delete ptyAliveRef.current[id]; setPtyAlive((m) => { const n = { ...m }; delete n[id]; return n; }); } catch {}
    // let manager dispose the tab (adapter/container and optionally close PTY)
    try { tm.disposeTab(id, true); } catch (err) { console.warn('tm.disposeTab failed', err); }
    setTabsByProject((m) => {
      const next = (m[selectedProject.id] || []).filter((tab) => tab.id !== id);
      return { ...m, [selectedProject.id]: next };
    });
    clearPendingForTab(id);
    unregisterTabProject(id);
    try { delete userInputCountByTabIdRef.current[id]; } catch {}
    setInputFullscreenByTab((m) => {
      if (!m[id]) return m;
      const next = { ...m } as Record<string, boolean>;
      delete next[id];
      return next;
    });
    if (activeTabId === id) setActiveTab(null);
  }

  /**
   * 开始编辑“目录节点备注名”（仅改 UI 显示名，不改真实文件夹名）。
   * 说明：该能力仅通过左键双击触发，不提供右键菜单入口。
   */
  const openDirLabelDialog = useCallback((project: Project) => {
    const pid = String(project?.id || "").trim();
    if (!pid) return;
    const current = String(dirTreeStore.labelById[pid] || "").trim();
    setDirLabelDialog({ open: true, projectId: pid, draft: current });
  }, [dirTreeStore.labelById]);

  /**
   * 结束编辑“目录节点备注名”（不保存）。
   */
  const closeDirLabelDialog = useCallback(() => {
    setDirLabelDialog({ open: false, projectId: "", draft: "" });
  }, []);

  /**
   * 保存目录节点备注名：为空则清空备注并回退默认显示名。
   */
  const submitDirLabelDialog = useCallback((draftOverride?: string) => {
    const dlg = dirLabelDialog;
    if (!dlg.open) return;
    const pid = String(dlg.projectId || "").trim();
    if (!pid) { closeDirLabelDialog(); return; }
    const nextLabel = String(draftOverride ?? dlg.draft ?? "").trim();
    setDirTreeStore((prev) => {
      const next: DirTreeStore = { ...prev, labelById: { ...(prev.labelById || {}) } };
      if (nextLabel) next.labelById[pid] = nextLabel;
      else delete next.labelById[pid];
      return next;
    });
    closeDirLabelDialog();
  }, [closeDirLabelDialog, dirLabelDialog]);

  /**
   * 获取目录节点的展示名：优先使用备注名（仅 UI），否则回退项目名。
   */
  const getDirNodeLabel = useCallback((p: Project): string => {
    const id = String(p?.id || "").trim();
    if (!id) return String(p?.name || "");
    const label = String(dirTreeStore.labelById[id] || "").trim();
    return label || String(p?.name || "");
  }, [dirTreeStore.labelById]);

  /**
   * 判断目录节点是否为子级（仅 UI 结构，与文件系统无关）。
   */
  const isDirChild = useCallback((projectId: string): boolean => {
    const id = String(projectId || "").trim();
    if (!id) return false;
    return !!dirTreeStore.parentById[id];
  }, [dirTreeStore.parentById]);

  /**
   * 判断目录节点是否存在子级（用于展开/折叠与拖拽约束）。
   */
  const hasDirChildren = useCallback((projectId: string): boolean => {
    const id = String(projectId || "").trim();
    if (!id) return false;
    const list = dirTreeStore.childOrderByParent[id] || [];
    return Array.isArray(list) && list.length > 0;
  }, [dirTreeStore.childOrderByParent]);

  /**
   * 切换父节点展开/折叠状态（仅影响 UI，不改变磁盘结构）。
   */
  const toggleDirExpanded = useCallback((projectId: string) => {
    const id = String(projectId || "").trim();
    if (!id) return;
    setDirTreeStore((prev) => {
      const cur = prev.expandedById[id];
      const nextExpanded = { ...prev.expandedById, [id]: cur === false };
      return { ...prev, expandedById: nextExpanded };
    });
  }, []);

  /**
   * 开始拖拽目录节点（仅在非按钮区域触发）。
   */
  const onDirDragStart = useCallback((e: React.DragEvent, projectId: string) => {
    const id = String(projectId || "").trim();
    if (!id) return;
    if (query.trim()) {
      // 搜索模式下禁用拖拽，避免“树结构与筛选结果”冲突
      e.preventDefault();
      return;
    }
    try {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    } catch {}
    setDirDrag({ draggingId: id });
    setProjectSort("manual");
  }, [query]);

  /**
   * 结束拖拽：清理悬浮/落点状态。
   */
  const onDirDragEnd = useCallback(() => {
    setDirDrag(null);
  }, []);

  /**
   * 将一次 drop 应用到目录树：
   * - 根级排序：before/after/root-end（空白区域视为 root-end）
   * - 设为子级：asChild（仅允许拖拽“无子级节点”成为子级）
   */
  const applyDirDrop = useCallback((dragId: string, targetId: string | null, position: "before" | "after" | "asChild" | "root-end") => {
    const src = String(dragId || "").trim();
    const dst = String(targetId || "").trim();
    if (!src) return;
    if (src === dst) return;

    // 以当前“可见根节点顺序”作为基准，保证在 recent/name 排序视图下拖拽也稳定落地为 manual
    const currentRoots = sortedProjects
      .filter((p) => p?.id && !dirTreeStore.parentById[p.id])
      .map((p) => p.id);

    setDirTreeStore((prev) => {
      const next: DirTreeStore = {
        ...prev,
        rootOrder: currentRoots.length > 0 ? currentRoots : [...prev.rootOrder],
        parentById: { ...prev.parentById },
        childOrderByParent: { ...prev.childOrderByParent },
        expandedById: { ...prev.expandedById },
        labelById: { ...prev.labelById },
      };

      const removeFromArray = (arr: string[], id: string): string[] => arr.filter((x) => x !== id);

      // 先从原父节点移除
      const prevParent = next.parentById[src];
      if (prevParent) {
        const prevList = next.childOrderByParent[prevParent] || [];
        next.childOrderByParent[prevParent] = removeFromArray(prevList, src);
        delete next.parentById[src];
      }
      // 从根级移除（若本来就是根）
      next.rootOrder = removeFromArray(next.rootOrder || [], src);

      if (position === "asChild") {
        // 约束：已拥有子级的节点不能成为别人的子级（避免潜在二级层级）
        const srcHasChildren = (next.childOrderByParent[src] || []).length > 0;
        if (srcHasChildren) {
          // 回退：作为根级追加到末尾
          next.rootOrder = [...next.rootOrder, src];
          return next;
        }
        if (!dst) {
          next.rootOrder = [...next.rootOrder, src];
          return next;
        }
        // 目标必须是根节点；子节点不作为 drop target
        if (next.parentById[dst]) {
          next.rootOrder = [...next.rootOrder, src];
          return next;
        }
        next.parentById[src] = dst;
        const list = next.childOrderByParent[dst] || [];
        next.childOrderByParent[dst] = list.includes(src) ? list : [...list, src];
        next.expandedById[dst] = true;
        return next;
      }

      // 其它：根级放置（before/after/root-end）
      if (!dst || position === "root-end") {
        next.rootOrder = [...next.rootOrder, src];
        return next;
      }
      const idx = next.rootOrder.indexOf(dst);
      if (idx < 0) {
        next.rootOrder = [...next.rootOrder, src];
        return next;
      }
      const insertAt = position === "before" ? idx : idx + 1;
      next.rootOrder = [...next.rootOrder.slice(0, insertAt), src, ...next.rootOrder.slice(insertAt)];
      return next;
    });
  }, [dirTreeStore.parentById, dirTreeStore.childOrderByParent, sortedProjects]);

  /**
   * 读取并缓存某个目录的 Build/Run 配置（Key=目录绝对路径）。
   */
  const ensureBuildRunConfigLoaded = useCallback(async (winPath: string): Promise<DirBuildRunConfig | null> => {
    const dir = String(winPath || "").trim();
    if (!dir) return null;
    const key = toDirKeyForCache(dir);
    if (!key) return null;
    const cached = buildRunCfgByDirKeyRef.current[key];
    if (cached !== undefined) return cached;
    try {
      const res: any = await (window as any).host?.buildRun?.get?.(dir);
      const cfg = res && res.ok ? ((res.cfg as DirBuildRunConfig) || null) : null;
      setBuildRunCfgByDirKey((prev) => ({ ...prev, [key]: cfg }));
      return cfg;
    } catch {
      setBuildRunCfgByDirKey((prev) => ({ ...prev, [key]: null }));
      return null;
    }
  }, []);

  /**
   * 保存某个目录的 Build/Run 配置，并同步更新本地缓存。
   */
  const persistBuildRunConfig = useCallback(async (winPath: string, cfg: DirBuildRunConfig): Promise<boolean> => {
    const dir = String(winPath || "").trim();
    if (!dir) return false;
    const key = toDirKeyForCache(dir);
    if (!key) return false;
    try {
      const res: any = await (window as any).host?.buildRun?.set?.(dir, cfg);
      if (!(res && res.ok)) return false;
      setBuildRunCfgByDirKey((prev) => ({ ...prev, [key]: cfg }));
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * 解析某节点在当前动作（Build/Run）下的“生效配置”：
   * - 先读自身配置
   * - 若自身无配置且为子节点，则继承父节点配置
   */
  const resolveEffectiveBuildRunCommand = useCallback(async (project: Project, action: BuildRunAction): Promise<{
    effective: BuildRunCommandConfig | null;
    inherited: boolean;
    parentProjectId?: string;
    defaultSaveScope: "self" | "parent";
  }> => {
    const selfCfg = await ensureBuildRunConfigLoaded(project.winPath);
    const selfCmd = (selfCfg as any)?.[action] as BuildRunCommandConfig | undefined;
    if (selfCmd) return { effective: selfCmd, inherited: false, defaultSaveScope: "self" };

    const parentId = String(dirTreeStore.parentById[project.id] || "").trim();
    if (parentId) {
      const parent = projectsRef.current.find((x) => x.id === parentId) || null;
      if (parent) {
        const parentCfg = await ensureBuildRunConfigLoaded(parent.winPath);
        const parentCmd = (parentCfg as any)?.[action] as BuildRunCommandConfig | undefined;
        if (parentCmd) return { effective: parentCmd, inherited: true, parentProjectId: parentId, defaultSaveScope: "parent" };
        return { effective: null, inherited: false, parentProjectId: parentId, defaultSaveScope: "parent" };
      }
    }
    return { effective: null, inherited: false, defaultSaveScope: "self" };
  }, [dirTreeStore.parentById, ensureBuildRunConfigLoaded]);

  /**
   * 触发 Build/Run：
   * - 若无配置：打开配置对话框
   * - 否则：直接外部终端执行
   * - edit=true：强制进入“编辑命令”
   */
  const triggerBuildRun = useCallback(async (project: Project, action: BuildRunAction, edit = false) => {
    const p = project;
    if (!p?.id || !p?.winPath) return;
    const resolved = await resolveEffectiveBuildRunCommand(p, action);
    const effective = resolved.effective;
    if (edit || !effective) {
      const draft = effective
        ? ({ ...effective, env: Array.isArray(effective.env) ? effective.env : [] } as BuildRunCommandConfig)
        : ({ mode: "simple", commandText: "", cwd: "", env: [], backend: { kind: "system" } } as BuildRunCommandConfig);
      const advanced = draft.mode === "advanced";
      setBuildRunDialog({
        open: true,
        action,
        projectId: p.id,
        saveScope: resolved.defaultSaveScope,
        parentProjectId: resolved.parentProjectId,
        draft,
        advanced,
      });
      return;
    }

    const cwd = String(effective.cwd || "").trim() || p.winPath;
    const title = `${getDirNodeLabel(p)} ${action === "build" ? "Build" : "Run"}`;
    try {
      const res: any = await (window as any).host?.buildRun?.exec?.({ dir: p.winPath, cwd, title, command: effective });
      if (!(res && res.ok)) throw new Error(res?.error || "failed");
    } catch (e: any) {
      alert(String((t("projects:buildRunFailed", "执行失败：{{error}}") as any) || "").replace("{{error}}", String(e?.message || e)));
    }
  }, [getDirNodeLabel, resolveEffectiveBuildRunCommand, t]);

  /**
   * 保存 Build/Run 配置对话框的草稿到本地持久化存储。
   */
  const saveBuildRunDialog = useCallback(async () => {
    const dlg = buildRunDialog;
    if (!dlg.open) return;

    const target = projectsRef.current.find((x) => x.id === dlg.projectId) || null;
    if (!target) return;

    const parentIdFromTree = String(dirTreeStore.parentById[target.id] || "").trim();
    const parentId = String(dlg.parentProjectId || parentIdFromTree || "").trim();

    const saveProject = (() => {
      if (dlg.saveScope !== "parent") return target;
      if (!parentId) return target;
      return projectsRef.current.find((x) => x.id === parentId) || target;
    })();

    const draft = dlg.draft || ({} as any);
    const nextCmd: BuildRunCommandConfig = { ...draft } as any;
    nextCmd.cwd = String(draft.cwd || "").trim();
    nextCmd.backend = (draft.backend && typeof draft.backend === "object") ? draft.backend : { kind: "system" };
    nextCmd.env = Array.isArray(draft.env)
      ? draft.env.map((r: any) => ({ key: String(r?.key || ""), value: String(r?.value ?? "") }))
      : [];

    if (dlg.advanced) {
      nextCmd.mode = "advanced";
      nextCmd.commandText = undefined;
      nextCmd.cmd = String(draft.cmd || "").trim();
      nextCmd.args = Array.isArray(draft.args) ? draft.args.map((x: any) => String(x ?? "")).filter((x: string) => x.trim().length > 0) : [];
      if (!nextCmd.cmd) {
        alert(t("projects:buildRunMissingCmd", "请输入命令") as string);
        return;
      }
    } else {
      nextCmd.mode = "simple";
      nextCmd.cmd = undefined;
      nextCmd.args = undefined;
      nextCmd.commandText = String(draft.commandText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (!nextCmd.commandText) {
        alert(t("projects:buildRunMissingCmd", "请输入命令") as string);
        return;
      }
    }

    const existing = (await ensureBuildRunConfigLoaded(saveProject.winPath)) || {};
    const nextCfg: DirBuildRunConfig = { ...(existing as any), [dlg.action]: nextCmd } as any;
    const ok = await persistBuildRunConfig(saveProject.winPath, nextCfg);
    if (!ok) {
      alert(t("projects:buildRunSaveFailed", "保存失败") as string);
      return;
    }

    setBuildRunDialog((prev) => ({ ...prev, open: false }));
  }, [buildRunDialog, dirTreeStore.parentById, ensureBuildRunConfigLoaded, persistBuildRunConfig, t]);

  /**
   * 关闭 Build/Run 配置对话框（不保存）。
   */
  const closeBuildRunDialog = useCallback(() => {
    setBuildRunDialog((prev) => ({ ...prev, open: false }));
  }, []);

  /**
   * 将 child 节点挂载到 parent 作为“一级子级”，并同步 rootOrder/parentById/childOrderByParent。
   * - 仅用于 UI 结构（不代表文件系统父子）
   * - 若 parent 自身是子级，为避免产生二级层级，本次挂载会被忽略
   */
  const attachDirChildToParent = useCallback((parentId: string, childId: string) => {
    const parent = String(parentId || "").trim();
    const child = String(childId || "").trim();
    if (!parent || !child || parent === child) return;
    setDirTreeStore((prev) => {
      // 约束：父节点必须是根级（否则会产生二级层级）
      if (prev.parentById[parent]) return prev;

      const next: DirTreeStore = {
        ...prev,
        rootOrder: [...(prev.rootOrder || [])],
        parentById: { ...(prev.parentById || {}) },
        childOrderByParent: { ...(prev.childOrderByParent || {}) },
        expandedById: { ...(prev.expandedById || {}) },
        labelById: { ...(prev.labelById || {}) },
      };

      const removeFromArray = (arr: string[] | undefined, id: string): string[] => {
        const list = Array.isArray(arr) ? arr : [];
        return list.filter((x) => x !== id);
      };

      // 先从旧父节点移除
      const prevParent = next.parentById[child];
      if (prevParent) {
        next.childOrderByParent[prevParent] = removeFromArray(next.childOrderByParent[prevParent], child);
        delete next.parentById[child];
      }
      // 同时从根级移除（避免重复节点）
      next.rootOrder = removeFromArray(next.rootOrder, child);

      // 写入新父子关系
      next.parentById[child] = parent;
      const list = next.childOrderByParent[parent] || [];
      next.childOrderByParent[parent] = list.includes(child) ? list : [...list, child];
      next.expandedById[parent] = true;
      return next;
    });
  }, []);

  /**
   * 打开“从分支创建 worktree”面板，并加载 baseBranch 下拉的分支列表。
   */
  const openWorktreeCreateDialog = useCallback(async (repoProject: Project) => {
    const repoId = String(repoProject?.id || "").trim();
    if (!repoId) return;

    // 若该仓库的 worktree 创建任务仍在进行，则优先打开进度面板
    const runningTaskId = String(worktreeCreateRunningTaskIdByRepoIdRef.current[repoId] || "").trim();
    if (runningTaskId) {
      setWorktreeCreateProgress((prev) => {
        if (prev.taskId === runningTaskId) return { ...prev, open: true, repoProjectId: repoId };
        return { open: true, repoProjectId: repoId, taskId: runningTaskId, status: "running", log: "", logOffset: 0, updatedAt: 0, error: undefined };
      });
      return;
    }

    // 为 @ 引用准备文件索引根（避免用户未选中该项目时，@ 搜索仍指向旧项目）
    try { await setActiveFileIndexRoot(repoProject.winPath); } catch {}

    const defaultProvider: GitWorktreeProviderId =
      (activeProviderId === "codex" || activeProviderId === "claude" || activeProviderId === "gemini")
        ? (activeProviderId as any)
        : "codex";

    setWorktreeCreateDialog({
      open: true,
      repoProjectId: repoId,
      branches: [],
      baseBranch: "",
      loadingBranches: true,
      selectedChildWorktreeIds: [],
      promptChips: [],
      promptDraft: "",
      useMultipleModels: false,
      singleProviderId: defaultProvider,
      multiCounts: { codex: defaultProvider === "codex" ? 1 : 0, claude: defaultProvider === "claude" ? 1 : 0, gemini: defaultProvider === "gemini" ? 1 : 0 },
      creating: false,
      error: undefined,
    });

    try {
      const res: any = await (window as any).host?.gitWorktree?.listBranches?.(repoProject.winPath);
      if (!(res && res.ok)) throw new Error(res?.error || "failed");
      const branches = Array.isArray(res.branches) ? res.branches.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
      const current = String(res.current || "").trim();
      const baseBranch = current || branches[0] || "";
      setWorktreeCreateDialog((prev) => {
        if (!prev.open || prev.repoProjectId !== repoId) return prev;
        return {
          ...prev,
          branches,
          baseBranch,
          loadingBranches: false,
          error: baseBranch ? undefined : (t("projects:worktreeMissingBaseBranch", "未能读取到基分支") as string),
        };
      });
    } catch (e: any) {
      setWorktreeCreateDialog((prev) => {
        if (!prev.open || prev.repoProjectId !== repoId) return prev;
        return { ...prev, branches: [], baseBranch: "", loadingBranches: false, error: String(e?.message || e) };
      });
    }
  }, [activeProviderId, t]);

  /**
   * 关闭 worktree 创建面板（不执行创建）。
   */
  const closeWorktreeCreateDialog = useCallback(() => {
    setWorktreeCreateDialog((prev) => ({ ...prev, open: false, creating: false, error: undefined }));
  }, []);

  /**
   * 在指定目录中启动 Provider CLI（用于 worktree 创建后的“自动启动引擎实例”）。
   */
  const openProviderConsoleInProject = useCallback(async (args: {
    project: Project;
    providerId: GitWorktreeProviderId;
    startupCmd: string;
  }): Promise<{ ok: boolean; tabId?: string; error?: string }> => {
    const project = args.project;
    const providerId = args.providerId;
    if (!project?.id) return { ok: false, error: "missing project" };
    const env = getProviderEnv(providerId);

    const tabName = env.terminal !== "wsl"
      ? toShellLabel(env.terminal as any)
      : (env.distro || `Console ${((tabsByProjectRef.current[project.id] || []).length + 1).toString()}`);

    const tab: ConsoleTab = {
      id: uid(),
      name: String(tabName),
      providerId,
      logs: [],
      createdAt: Date.now(),
    };

    const notifyEnv = buildGeminiNotifyEnv(tab.id, tab.providerId, tab.name);

    let ptyId: string | undefined;
    try {
      const { id } = await window.host.pty.openWSLConsole({
        terminal: env.terminal,
        distro: env.distro,
        wslPath: project.wslPath,
        winPath: project.winPath,
        cols: 80,
        rows: 24,
        startupCmd: args.startupCmd,
        env: notifyEnv,
      });
      ptyId = id;
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }

    // 内置三引擎：即便会话记录落盘存在延迟，也先在 UI 侧标记，避免“自定义目录记录可移除”误判。
    if (isBuiltInSessionProviderId(providerId)) {
      markProjectHasBuiltInSessions(project.id);
    } else {
      void recordCustomProviderDirIfNeeded(project, providerId);
    }

    registerTabProject(tab.id, project.id);
    setTabsByProject((m) => ({ ...m, [project.id]: [...(m[project.id] || []), tab] }));

    if (ptyId) {
      ptyByTabRef.current[tab.id] = ptyId;
      setPtyByTab((m) => ({ ...m, [tab.id]: ptyId }));
      ptyAliveRef.current[tab.id] = true;
      setPtyAlive((m) => ({ ...m, [tab.id]: true }));
      registerPtyForTab(tab.id, ptyId);
      try { tm.setPty(tab.id, ptyId); } catch {}
    }

    try { window.host.projects.touch(project.id); } catch {}
    markProjectUsed(project.id);
    return { ok: true, tabId: tab.id };
  }, [getProviderEnv, markProjectHasBuiltInSessions, recordCustomProviderDirIfNeeded, tm, markProjectUsed]);

  /**
   * 在指定项目中启动某个引擎实例，并注入初始提示词（worktree 新建/复用共用）。
   */
  const startProviderInstanceInProject = useCallback(async (args: {
    project: Project;
    providerId: GitWorktreeProviderId;
    prompt: string;
  }): Promise<{ ok: boolean; tabId?: string; error?: string }> => {
    try {
      const project = args.project;
      const providerId = args.providerId;
      if (!project?.id) return { ok: false, error: "missing project" };
      const env = getProviderEnv(providerId);
      const baseCmd = buildProviderStartupCmd(providerId, env);
      const startupCmd = buildProviderStartupCmdWithInitialPrompt({ providerId, terminalMode: env.terminal as any, baseCmd, prompt: args.prompt });
      return await openProviderConsoleInProject({ project, providerId, startupCmd });
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, [buildProviderStartupCmd, getProviderEnv, openProviderConsoleInProject]);

  /**
   * 执行创建 worktree，并在每个 worktree 内启动对应引擎 CLI。
   * - 目录结构/复用规则由主进程完成；渲染层负责：避免重复节点、挂载到树、启动引擎
   */
  const createWorktreesAndStartAgents = useCallback(async (args: {
    repoProject: Project;
    baseBranch: string;
    instances: Array<{ providerId: GitWorktreeProviderId; count: number }>;
    prompt: string;
    /** 额外警告（用于把“复用已有 worktree 的启动失败”合并到同一份提示里）。 */
    extraWarnings?: string[];
  }) => {
    const repoProject = args.repoProject;
    const repoId = String(repoProject?.id || "").trim();
    if (!repoId) return;

    const baseBranch = String(args.baseBranch || "").trim();
    if (!baseBranch) {
      setNoticeDialog({ open: true, title: t("projects:worktreeCreateTitle", "从分支创建 worktree") as string, message: t("projects:worktreeMissingBaseBranch", "未能读取到基分支") as string });
      return;
    }

    const instances = Array.isArray(args.instances)
      ? args.instances.map((x) => ({ providerId: x.providerId, count: Math.max(0, Math.floor(Number(x.count) || 0)) })).filter((x) => x.count > 0)
      : [];
    if (instances.length === 0) return;

    // 若该仓库已有创建任务在跑，则直接打开“创建中”面板查看进度，避免重复创建
    const runningTaskId = String(worktreeCreateRunningTaskIdByRepoIdRef.current[repoId] || "").trim();
    if (runningTaskId) {
      setWorktreeCreateProgress((prev) => {
        if (prev.taskId === runningTaskId) return { ...prev, open: true, repoProjectId: repoId };
        return { open: true, repoProjectId: repoId, taskId: runningTaskId, status: "running", log: "", logOffset: 0, updatedAt: 0, error: undefined };
      });
      // 创建面板若仍打开则关闭（避免用户误以为会再创建一次）
      setWorktreeCreateDialog((prev) => (prev.open && prev.repoProjectId === repoId ? { ...prev, open: false, creating: false, error: undefined } : prev));
      return;
    }

    // 启动后台任务（主进程执行 git worktree add，并持续产生日志）
    let taskId = "";
    try {
      const res: any = await (window as any).host?.gitWorktree?.createTaskStart?.({
        repoDir: repoProject.winPath,
        baseBranch,
        instances,
        copyRules: gitWorktreeCopyRulesOnCreate,
      });
      if (!(res && res.ok && res.taskId)) throw new Error(res?.error || "create task start failed");
      taskId = String(res.taskId || "").trim();
    } catch (e: any) {
      setWorktreeCreateDialog((prev) => (prev.open && prev.repoProjectId === repoId ? { ...prev, creating: false, error: String(e?.message || e) } : prev));
      setNoticeDialog({
        open: true,
        title: t("projects:worktreeCreateTitle", "从分支创建 worktree") as string,
        message: String((t("projects:worktreeCreateFailed", "创建 worktree 失败：{{error}}") as any) || "").replace("{{error}}", String(e?.message || e)),
      });
      return;
    }

    if (!taskId) return;
    worktreeCreateRunningTaskIdByRepoIdRef.current[repoId] = taskId;

    // 进入“创建中”进度面板，并关闭“创建配置”面板
    setWorktreeCreateProgress({ open: true, repoProjectId: repoId, taskId, status: "running", log: "", logOffset: 0, updatedAt: Date.now(), error: undefined });
    setWorktreeCreateDialog((prev) => (prev.open && prev.repoProjectId === repoId ? { ...prev, open: false, creating: false, error: undefined } : prev));

    // 轮询任务输出（支持关闭 UI 后继续执行；重新打开时可继续看到日志）
    let snapshot: WorktreeCreateTaskSnapshot | null = null;
    let logText = "";
    let logOffset = 0;
    const startedAt = Date.now();
    while (true) {
      try {
        const pull: any = await (window as any).host?.gitWorktree?.createTaskGet?.({ taskId, from: logOffset });
        if (pull && pull.ok && pull.task) {
          snapshot = pull.task as WorktreeCreateTaskSnapshot;
          const append = String(pull.append || "");
          if (append) logText += append;
          logOffset = Math.max(logOffset, Math.floor(Number(snapshot.logSize) || 0));
          setWorktreeCreateProgress((prev) => {
            if (prev.taskId !== taskId) return prev;
            return {
              ...prev,
              status: snapshot!.status,
              log: logText,
              logOffset,
              updatedAt: Math.floor(Number(snapshot!.updatedAt) || Date.now()),
              error: snapshot!.error ? String(snapshot!.error || "") : undefined,
            };
          });
          if (snapshot.status !== "running") break;
        }
      } catch {}

      // 兜底：避免无限等待
      if (Date.now() - startedAt > 40 * 60_000) {
        snapshot = snapshot || null;
        setWorktreeCreateProgress((prev) => {
          if (prev.taskId !== taskId) return prev;
          return { ...prev, status: "error", error: "等待创建任务超时（请重试或在外部终端执行 git worktree add 诊断）" };
        });
        break;
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    // 创建任务结束：允许再次创建（无论成功或失败）
    try { delete worktreeCreateRunningTaskIdByRepoIdRef.current[repoId]; } catch {}

    // 失败：保留进度面板，让用户查看完整输出
    if (!(snapshot && snapshot.status === "success" && Array.isArray(snapshot.items))) {
      setWorktreeCreateProgress((prev) => (prev.taskId === taskId ? { ...prev, open: true } : prev));
      return;
    }

    const createdItems: CreatedWorktree[] = snapshot.items as any;
    const prompt = String(args.prompt || "");
    const warnings: string[] = Array.isArray(args.extraWarnings) ? args.extraWarnings.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
    let firstNewProjectId: string | null = null;
    let firstTabId: string | null = null;

    for (const item of createdItems) {
      const providerId = String(item?.providerId || "").trim().toLowerCase() as GitWorktreeProviderId;
      const worktreePath = String(item?.worktreePath || "").trim();
      if (!worktreePath) continue;

      // 将 worktree 目录加入项目列表（若已存在则复用）
      let wtProject: Project | null = null;
      try {
        const addRes: any = await window.host.projects.add({ winPath: worktreePath });
        if (addRes && addRes.ok && addRes.project) {
          wtProject = addRes.project as Project;
          upsertProjectInList(wtProject);
          // 若该 worktree 项目此前处于“隐藏项目”列表，则在创建时自动取消隐藏，避免用户误以为未创建成功
          unhideProject(wtProject);
        }
      } catch {}
      if (!wtProject) continue;
      if (!firstNewProjectId) firstNewProjectId = wtProject.id;

      // 挂载到 UI 树结构：作为当前仓库节点的一级子级
      attachDirChildToParent(repoId, wtProject.id);

      // 启动引擎 CLI（每个实例一个 worktree）
      const started = await startProviderInstanceInProject({ project: wtProject, providerId, prompt });
      if (started.ok && started.tabId) {
        if (!firstTabId) firstTabId = started.tabId;
      } else if (!started.ok && started.error) {
        warnings.push(`${providerId}: ${started.error}`);
      }

      // 规则文件复制的非致命警告
      try {
        const ws = Array.isArray(item?.warnings) ? item.warnings.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
        for (const w of ws) warnings.push(w);
      } catch {}
    }

    // 选择第一个新 worktree 节点
    if (firstNewProjectId) {
      suppressAutoSelectRef.current = true;
      setSelectedProjectId(firstNewProjectId);
      setCenterMode("console");
      setSelectedHistoryDir(null);
      setSelectedHistoryId(null);
      if (firstTabId) {
        setActiveTab(firstTabId, { projectId: firstNewProjectId, focusMode: "immediate", allowDuringRename: true, delay: 0 });
      }
    }

    // 创建完成：关闭面板
    setWorktreeCreateProgress((prev) => (prev.taskId === taskId ? { ...prev, open: false } : prev));

    // 提示：若有警告（如规则文件复制/启动失败），以轻量方式告知
    if (warnings.length > 0) {
      setNoticeDialog({
        open: true,
        title: t("projects:worktreeCreateTitle", "从分支创建 worktree") as string,
        message: (t("projects:worktreeCreateWarnings", "创建已完成，但存在警告：\n{{warnings}}") as any).replace("{{warnings}}", warnings.join("\n")),
      });
    }
  }, [attachDirChildToParent, gitWorktreeCopyRulesOnCreate, setActiveTab, startProviderInstanceInProject, t, unhideProject, upsertProjectInList]);

  /**
   * Ctrl+单击：快速创建（不弹确认/不打开面板）。
   */
  const quickCreateWorktree = useCallback(async (repoProject: Project) => {
    const repoId = String(repoProject?.id || "").trim();
    if (!repoId) return;

    const defaultProvider: GitWorktreeProviderId =
      (activeProviderId === "codex" || activeProviderId === "claude" || activeProviderId === "gemini")
        ? (activeProviderId as any)
        : "codex";

    // 优先使用已缓存的分支信息，失败则回退到分支列表
    const git = gitInfoByProjectId[repoId];
    let baseBranch = String(git?.branch || "").trim();
    if (!baseBranch) {
      try {
        const res: any = await (window as any).host?.gitWorktree?.listBranches?.(repoProject.winPath);
        const branches = Array.isArray(res?.branches) ? res.branches.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
        baseBranch = String(res?.current || "").trim() || branches[0] || "";
      } catch {}
    }
    if (!baseBranch) {
      // 无法自动解析基分支时回退到创建面板（保持 UI 风格一致，并让用户可手动选择）
      void openWorktreeCreateDialog(repoProject);
      return;
    }

    await createWorktreesAndStartAgents({
      repoProject,
      baseBranch,
      instances: [{ providerId: defaultProvider, count: 1 }],
      prompt: "",
    });
  }, [activeProviderId, createWorktreesAndStartAgents, gitInfoByProjectId, openWorktreeCreateDialog]);

  /**
   * 打开“Git 操作失败”弹窗（提供外部 Git 工具/终端快捷入口）。
   */
  const showGitActionErrorDialog = useCallback((args: { title: string; message: string; dir: string }) => {
    setGitActionErrorDialog({
      open: true,
      title: String(args.title || "").trim() || (t("projects:gitActionFailed", "Git 操作失败") as string),
      message: String(args.message || "").trim(),
      dir: String(args.dir || "").trim(),
    });
  }, [t]);

  /**
   * 关闭“Git 操作失败”弹窗。
   */
  const closeGitActionErrorDialog = useCallback(() => {
    setGitActionErrorDialog((prev) => ({ ...prev, open: false }));
  }, []);

  /**
   * 主动刷新指定项目的 git 状态（用于 worktree 删除后立即让 UI 降级为普通目录/禁用）。
   */
  const refreshGitInfoForProjectIds = useCallback(async (projectIds: string[]) => {
    const ids = Array.from(new Set((projectIds || []).map((x) => String(x || "").trim()).filter(Boolean)));
    if (ids.length === 0) return;
    const pairs = ids
      .map((id) => {
        const p = projectsRef.current.find((x) => x.id === id) || null;
        return p?.winPath ? { id, dir: p.winPath } : null;
      })
      .filter(Boolean) as Array<{ id: string; dir: string }>;
    if (pairs.length === 0) return;
    try {
      const res: any = await (window as any).host?.gitWorktree?.statusBatch?.(pairs.map((x) => x.dir));
      if (!(res && res.ok && Array.isArray(res.items))) return;
      const items = res.items as GitDirInfo[];
      setGitInfoByProjectId((prev) => {
        const next = { ...prev };
        for (let i = 0; i < pairs.length; i++) {
          const pid = pairs[i].id;
          const info = items[i];
          if (pid && info) next[pid] = info;
        }
        return next;
      });
    } catch {}
  }, []);

  /**
   * 中文说明：统计指定项目仍在运行的终端代理数量（以 tab 是否仍绑定 PTY 为准）。
   */
  const countRunningTerminalAgentsByProjectId = useCallback((projectId: string): number => {
    const pid = String(projectId || "").trim();
    if (!pid) return 0;
    let count = 0;
    const tabToProject = tabProjectRef.current;
    const ptyByTab = ptyByTabRef.current;
    for (const tabId of Object.keys(ptyByTab || {})) {
      if (tabToProject[tabId] === pid) count++;
    }
    return count;
  }, []);

  /**
   * 中文说明：若当前项目仍存在终端代理，则拦截 worktree 回收/删除，并提示用户先关闭终端代理。
   */
  const guardWorktreeRecycleAndDeleteByTerminalAgents = useCallback((project: Project): boolean => {
    const pid = String(project?.id || "").trim();
    if (!pid) return false;
    const runningCount = countRunningTerminalAgentsByProjectId(pid);
    if (runningCount <= 0) return true;
    setWorktreeBlockedDialog({ open: true, count: runningCount });
    return false;
  }, [countRunningTerminalAgentsByProjectId]);

  /**
   * 打开“回收 worktree 到基分支”对话框（默认分支来自 worktree 元数据）。
   */
	  const openWorktreeRecycleDialog = useCallback(async (project: Project) => {
	    const pid = String(project?.id || "").trim();
	    if (!pid) return;

	    // 若该 worktree 的回收任务仍在进行，则优先打开进度面板（可关闭/可重开）
	    const runningTaskId = String(worktreeRecycleRunningTaskIdByProjectIdRef.current[pid] || "").trim();
	    if (runningTaskId) {
	      setWorktreeRecycleProgress((prev) => {
	        if (prev.taskId === runningTaskId) return { ...prev, open: true, projectId: pid };
	        return { open: true, projectId: pid, taskId: runningTaskId, status: "running", log: "", logOffset: 0, updatedAt: 0, error: undefined };
	      });
	      return;
	    }
	    if (!guardWorktreeRecycleAndDeleteByTerminalAgents(project)) return;
	    setWorktreeRecycleDialog({
	      open: true,
	      projectId: pid,
      repoMainPath: "",
      branches: [],
      baseBranch: "",
      wtBranch: "",
      range: "since_fork",
      forkPointValue: "",
      forkPointTouched: false,
      forkPointPinned: [],
      forkPointSearchItems: [],
      forkPointSearchQuery: "",
      forkPointPinnedLoading: false,
      forkPointSearchLoading: false,
      forkPointError: undefined,
      mode: "squash",
      commitMessage: "",
      loading: true,
      running: false,
      error: undefined,
    });

    try {
      const metaRes: any = await (window as any).host?.gitWorktree?.getMeta?.(project.winPath);
      const meta = metaRes && metaRes.ok ? metaRes.meta : null;

      // 中文说明：创建记录缺失时，不阻断流程：优先从 git worktree 信息推断主 worktree 路径，并允许用户手动选择分支。
      let repoMainPath = String(meta?.repoMainPath || "").trim();
      let cachedWtBranch = "";
      if (!repoMainPath) {
        try {
          const st: any = await (window as any).host?.gitWorktree?.statusBatch?.([project.winPath]);
          const info = st && st.ok && Array.isArray(st.items) ? (st.items[0] as any) : null;
          const main = String(info?.mainWorktree || info?.repoRoot || "").trim();
          repoMainPath = main || project.winPath;
          const b = info && info.detached !== true ? String(info.branch || "").trim() : "";
          if (b) cachedWtBranch = b;
        } catch {
          repoMainPath = project.winPath;
        }
      } else {
        repoMainPath = String(meta.repoMainPath || project.winPath);
      }
      const listRes: any = await (window as any).host?.gitWorktree?.listBranches?.(repoMainPath);
      if (!(listRes && listRes.ok)) throw new Error(listRes?.error || (t("projects:worktreeListBranchesFailed", "读取分支列表失败") as string));
      const branchesRaw: string[] = Array.isArray(listRes.branches) ? listRes.branches.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
      const branches: string[] = Array.from(new Set<string>(branchesRaw));
      const branchSet = new Set<string>(branches);

      const metaBaseBranch = String(meta?.baseBranch || "").trim();
      const metaWtBranch = String(meta?.wtBranch || "").trim();
      const currentBranch = String(listRes.current || "").trim();
      const baseBranch =
        (metaBaseBranch && branchSet.has(metaBaseBranch) ? metaBaseBranch : "") ||
        (currentBranch && branchSet.has(currentBranch) ? currentBranch : "") ||
        branches[0] ||
        "";

      // 中文说明：源分支默认取创建记录；若该分支已不存在，则尝试读取 worktree 当前分支；仍不可用则留空让用户选择。
      let inferredWtBranch = "";
      if (metaWtBranch && !branchSet.has(metaWtBranch)) {
        try {
          const st: any = await (window as any).host?.gitWorktree?.statusBatch?.([project.winPath]);
          const info = st && st.ok && Array.isArray(st.items) ? (st.items[0] as any) : null;
          const b = info && info.detached !== true ? String(info.branch || "").trim() : "";
          if (b && branchSet.has(b)) inferredWtBranch = b;
        } catch {}
      } else if (!metaWtBranch && cachedWtBranch && branchSet.has(cachedWtBranch)) {
        inferredWtBranch = cachedWtBranch;
	      }
	      const wtBranch = metaWtBranch && branchSet.has(metaWtBranch) ? metaWtBranch : inferredWtBranch || "";
	      const commitMessage = "";

      setWorktreeRecycleDialog((prev) => {
        if (!prev.open || prev.projectId !== pid) return prev;
        return { ...prev, repoMainPath, branches, baseBranch, wtBranch, commitMessage, loading: false, error: undefined };
      });
    } catch (e: any) {
      setWorktreeRecycleDialog((prev) => {
        if (!prev.open || prev.projectId !== pid) return prev;
        return { ...prev, loading: false, error: String(e?.message || e) };
      });
    }
  }, [guardWorktreeRecycleAndDeleteByTerminalAgents, t]);

  /**
   * 关闭“回收 worktree”对话框。
   */
  const closeWorktreeRecycleDialog = useCallback(() => {
    setWorktreeRecycleDialog((prev) => ({ ...prev, open: false, running: false, loading: false }));
  }, []);

  /**
   * 中文说明：校验并应用用户手动输入的分叉点引用（提交号/引用名）。
   */
  const validateAndSelectForkPointRef = useCallback(async (raw: string) => {
    const dlg = worktreeRecycleDialog;
    if (!dlg.open) return;
    const pid = String(dlg.projectId || "").trim();
    if (!pid) return;
    const project = projectsRef.current.find((x) => x.id === pid) || null;
    if (!project) return;
    const wtBranch = String(dlg.wtBranch || "").trim();
    const ref = String(raw || "").trim();
    if (!wtBranch || !ref) return;

    const requestId = ++worktreeRecycleForkPointReqIdRef.current;
    setWorktreeRecycleDialog((prev) => {
      if (!prev.open || prev.projectId !== pid) return prev;
      return { ...prev, forkPointPinnedLoading: true, forkPointError: undefined };
    });

    try {
      const res: any = await (window as any).host?.gitWorktree?.validateForkPointRef?.({ worktreePath: project.winPath, wtBranch, ref });
      if (worktreeRecycleForkPointReqIdRef.current !== requestId) return;
      if (res && res.ok && res.commit) {
        const sha = String(res.commit.sha || "").trim();
        const subject = String(res.commit.subject || "").trim() || "(no subject)";
        const shortSha = String(res.commit.shortSha || "").trim() || sha.slice(0, 7);
        const tagManual = t("projects:worktreeRecycleForkPointTagManual", "手动") as string;
        const option: ForkPointOption = { value: sha, title: subject, subtitle: shortSha, tag: tagManual };
        setWorktreeRecycleDialog((prev) => {
          if (!prev.open || prev.projectId !== pid) return prev;
          const merged = new Map<string, ForkPointOption>();
          for (const it of prev.forkPointPinned || []) merged.set(it.value, it);
          const existed = merged.get(option.value);
          if (existed) {
            const tags = new Set<string>(String(existed.tag || "").split("/").map((x) => x.trim()).filter(Boolean));
            if (option.tag) tags.add(option.tag);
            merged.set(option.value, { ...existed, tag: Array.from(tags).join(" / ") || undefined });
          } else {
            merged.set(option.value, option);
          }
          return {
            ...prev,
            forkPointPinned: Array.from(merged.values()),
            forkPointValue: option.value,
            forkPointTouched: true,
            forkPointSearchQuery: "",
            forkPointPinnedLoading: false,
            forkPointError: undefined,
          };
        });
        return;
      }
      const msg = String(res?.error || "invalid fork point ref").trim();
      setWorktreeRecycleDialog((prev) => {
        if (!prev.open || prev.projectId !== pid) return prev;
        return { ...prev, forkPointPinnedLoading: false, forkPointError: msg || (t("projects:worktreeRecycleForkPointInvalid", "分叉点无效") as string) };
      });
    } catch (e: any) {
      if (worktreeRecycleForkPointReqIdRef.current !== requestId) return;
      const msg = String(e?.message || e).trim();
      setWorktreeRecycleDialog((prev) => {
        if (!prev.open || prev.projectId !== pid) return prev;
        return { ...prev, forkPointPinnedLoading: false, forkPointError: msg || (t("projects:worktreeRecycleForkPointInvalid", "分叉点无效") as string) };
      });
    }
  }, [t, worktreeRecycleDialog]);

  /**
   * 中文说明：当选择“仅分叉点之后”回收时，自动解析并置顶展示分叉点候选（创建记录/自动推断）。
   */
  useEffect(() => {
    if (!worktreeRecycleDialog.open) return;
    if (worktreeRecycleDialog.range !== "since_fork") return;
    const pid = String(worktreeRecycleDialog.projectId || "").trim();
    if (!pid) return;

    const project = projectsRef.current.find((x) => x.id === pid) || null;
    if (!project) return;
    const baseBranch = String(worktreeRecycleDialog.baseBranch || "").trim();
    const wtBranch = String(worktreeRecycleDialog.wtBranch || "").trim();
    if (!baseBranch || !wtBranch) return;

    const requestId = ++worktreeRecycleForkPointReqIdRef.current;
    setWorktreeRecycleDialog((prev) => {
      if (!prev.open || prev.projectId !== pid) return prev;
      return { ...prev, forkPointPinnedLoading: true, forkPointError: undefined };
    });

    void (async () => {
      try {
        const res: any = await (window as any).host?.gitWorktree?.resolveForkPoint?.({ worktreePath: project.winPath, baseBranch, wtBranch });
        if (worktreeRecycleForkPointReqIdRef.current !== requestId) return;

        const tagRecorded = t("projects:worktreeRecycleForkPointTagRecorded", "创建记录") as string;
        const tagAuto = t("projects:worktreeRecycleForkPointTagAuto", "自动") as string;

        const build = (commit: any, tag: string): ForkPointOption | null => {
          const sha = String(commit?.sha || "").trim();
          if (!sha) return null;
          const subject = String(commit?.subject || "").trim() || "(no subject)";
          const shortSha = String(commit?.shortSha || "").trim() || sha.slice(0, 7);
          return { value: sha, title: subject, subtitle: shortSha, tag };
        };

        const mergeOptions = (items: Array<ForkPointOption | null | undefined>): ForkPointOption[] => {
          const map = new Map<string, ForkPointOption>();
          for (const it of items) {
            if (!it) continue;
            const existed = map.get(it.value);
            if (!existed) {
              map.set(it.value, it);
              continue;
            }
            const tags = new Set<string>(String(existed.tag || "").split("/").map((x) => x.trim()).filter(Boolean));
            if (it.tag) tags.add(it.tag);
            map.set(it.value, { ...existed, tag: Array.from(tags).join(" / ") || undefined });
          }
          return Array.from(map.values());
        };

        if (res && res.ok && res.forkPoint) {
          const fp = res.forkPoint as any;
          const pinned = mergeOptions([build(fp.recordedCommit, tagRecorded), build(fp.autoCommit, tagAuto)]);
          const recordedApplies = fp.recordedApplies === true;
          const recordedSha = String(fp.recordedCommit?.sha || "").trim();
          const autoSha = String(fp.autoCommit?.sha || "").trim() || String(fp.sha || "").trim();
          const preferred = (recordedApplies && recordedSha) ? recordedSha : (autoSha || recordedSha);

          setWorktreeRecycleDialog((prev) => {
            if (!prev.open || prev.projectId !== pid) return prev;
            const nextValue = prev.forkPointTouched ? prev.forkPointValue : (preferred || prev.forkPointValue || "");
            return { ...prev, forkPointPinned: pinned, forkPointPinnedLoading: false, forkPointValue: nextValue, forkPointError: undefined };
          });
          return;
        }

        const err = String(res?.error || "resolve fork point failed").trim();
        const fp = (res && res.forkPoint) ? res.forkPoint : null;
        const pinned = mergeOptions([build(fp?.recordedCommit, tagRecorded)]);
        setWorktreeRecycleDialog((prev) => {
          if (!prev.open || prev.projectId !== pid) return prev;
          return { ...prev, forkPointPinned: pinned, forkPointPinnedLoading: false, forkPointError: err || undefined };
        });
      } catch (e: any) {
        if (worktreeRecycleForkPointReqIdRef.current !== requestId) return;
        const err = String(e?.message || e).trim();
        setWorktreeRecycleDialog((prev) => {
          if (!prev.open || prev.projectId !== pid) return prev;
          return { ...prev, forkPointPinnedLoading: false, forkPointError: err || undefined };
        });
      }
    })();
  }, [
    t,
    worktreeRecycleDialog.open,
    worktreeRecycleDialog.projectId,
    worktreeRecycleDialog.range,
    worktreeRecycleDialog.baseBranch,
    worktreeRecycleDialog.wtBranch,
  ]);

  /**
   * 中文说明：加载分叉点候选提交列表（可搜索）。
   */
  useEffect(() => {
    if (!worktreeRecycleDialog.open) return;
    if (worktreeRecycleDialog.range !== "since_fork") return;
    const pid = String(worktreeRecycleDialog.projectId || "").trim();
    if (!pid) return;
    const project = projectsRef.current.find((x) => x.id === pid) || null;
    if (!project) return;
    const wtBranch = String(worktreeRecycleDialog.wtBranch || "").trim();
    if (!wtBranch) return;

    const query = String(worktreeRecycleDialog.forkPointSearchQuery || "");
    const requestId = ++worktreeRecycleForkPointSearchReqIdRef.current;
    setWorktreeRecycleDialog((prev) => {
      if (!prev.open || prev.projectId !== pid) return prev;
      return { ...prev, forkPointSearchLoading: true };
    });

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res: any = await (window as any).host?.gitWorktree?.searchForkPointCommits?.({
            worktreePath: project.winPath,
            wtBranch,
            query: String(query || "").trim() || undefined,
            limit: 200,
          });
          if (worktreeRecycleForkPointSearchReqIdRef.current !== requestId) return;
          if (res && res.ok && Array.isArray(res.items)) {
            const items: ForkPointOption[] = (res.items as any[])
              .map((c) => {
                const sha = String(c?.sha || "").trim();
                if (!sha) return null;
                const subject = String(c?.subject || "").trim() || "(no subject)";
                const shortSha = String(c?.shortSha || "").trim() || sha.slice(0, 7);
                return { value: sha, title: subject, subtitle: shortSha } as ForkPointOption;
              })
              .filter(Boolean) as ForkPointOption[];

            setWorktreeRecycleDialog((prev) => {
              if (!prev.open || prev.projectId !== pid) return prev;
              const pinnedSet = new Set<string>((prev.forkPointPinned || []).map((x) => String(x.value || "").trim()).filter(Boolean));
              const filtered = items.filter((x) => !pinnedSet.has(x.value));
              return { ...prev, forkPointSearchItems: filtered, forkPointSearchLoading: false };
            });
            return;
          }
          setWorktreeRecycleDialog((prev) => {
            if (!prev.open || prev.projectId !== pid) return prev;
            return { ...prev, forkPointSearchItems: [], forkPointSearchLoading: false };
          });
        } catch {
          if (worktreeRecycleForkPointSearchReqIdRef.current !== requestId) return;
          setWorktreeRecycleDialog((prev) => {
            if (!prev.open || prev.projectId !== pid) return prev;
            return { ...prev, forkPointSearchItems: [], forkPointSearchLoading: false };
          });
        }
      })();
    }, 250);
    return () => {
      try { window.clearTimeout(timer); } catch {}
    };
  }, [
    worktreeRecycleDialog.open,
    worktreeRecycleDialog.projectId,
    worktreeRecycleDialog.range,
    worktreeRecycleDialog.wtBranch,
    worktreeRecycleDialog.forkPointSearchQuery,
  ]);

	  /**
	   * 执行“回收 worktree”。
	   */
		  const submitWorktreeRecycle = useCallback(async (opts?: { autoStashBaseWorktree?: boolean }) => {
		    const dlg = worktreeRecycleDialog;
		    if (dlg.running || dlg.loading) return;
		    const project = projectsRef.current.find((x) => x.id === dlg.projectId) || null;
		    if (!project) return;
		    if (!guardWorktreeRecycleAndDeleteByTerminalAgents(project)) return;
		    const baseBranch = String(dlg.baseBranch || "").trim();
		    const wtBranch = String(dlg.wtBranch || "").trim();
		    if (!baseBranch || !wtBranch) return;

		    const range = dlg.range === "full" ? "full" : "since_fork";
		    const forkBaseRef = range === "since_fork" ? String(dlg.forkPointValue || "").trim() || undefined : undefined;
		    if (range === "since_fork" && !forkBaseRef) {
		      setWorktreeRecycleDialog((prev) => ({
		        ...prev,
		        forkPointError: t(
		          "projects:worktreeRecycleForkPointMissing",
		          "无法确定分叉点：请等待自动推断完成，或手动指定分叉点，或切换到“完整回收”。"
		        ) as string,
		        error: undefined,
		      }));
		      return;
		    }

	      // 中文说明：仅当用户在“主 worktree 脏”弹窗中确认继续时才启用自动 stash/恢复。
	      const autoStashBaseWorktree = opts?.autoStashBaseWorktree === true;

		    setWorktreeRecycleDialog((prev) => ({ ...prev, running: true, error: undefined }));

		    // 与“worktree 自动提交”共用同一串行队列，避免 git lock / index 冲突。
		    const queueKey = String(project.id || "").trim();
		    const prev = (autoCommitQueueByProjectIdRef.current[queueKey] || Promise.resolve());
		    const preCommitMessage = (dlg.mode === "squash" ? String(dlg.commitMessage || "").trim() : "") || `pre-recycle: ${wtBranch} -> ${baseBranch}`;
	      let preCommitted = false;
        let recycleTaskId = "";

		    const kickoff = prev
		      .catch(() => {})
		      .then(async () => {
		        // 回收前：若 worktree 仍有未提交修改，则先提交一次，避免修改丢失/导致 rebase 模式失败。
		        const pre: any = await (window as any).host?.gitWorktree?.autoCommit?.({ worktreePath: project.winPath, message: preCommitMessage });
		        if (!(pre && pre.ok)) throw new Error(pre?.error || (t("projects:worktreeAutoCommitFailed", "worktree 自动提交失败") as string));
		        preCommitted = pre?.committed === true;

            // 启动回收后台任务：主进程执行，并持续产生日志
            const start: any = await (window as any).host?.gitWorktree?.recycleTaskStart?.({
              worktreePath: project.winPath,
              baseBranch,
              wtBranch,
              range,
              forkBaseRef,
              mode: dlg.mode,
              commitMessage: dlg.mode === "squash" ? String(dlg.commitMessage || "").trim() || undefined : undefined,
              autoStashBaseWorktree,
            });
            if (!(start && start.ok && start.taskId)) throw new Error(start?.error || "recycle task start failed");
            recycleTaskId = String(start.taskId || "").trim();
            return { taskId: recycleTaskId, preCommitted };
		      });

			    autoCommitQueueByProjectIdRef.current[queueKey] = kickoff.then(() => {}).catch(() => {});
			    try {
			      const out = await kickoff;
	          const taskId = String(out?.taskId || "").trim();
	        preCommitted = out?.preCommitted === true;

		        const preCommitHint = preCommitted
		          ? `提示：合并前检测到未提交修改，已在分支 ${wtBranch} 自动提交一次（${summarizeForCommitMessage(preCommitMessage, 96)}）。`
		          : undefined;

	          if (!taskId) throw new Error("recycle task id missing");

	          // 回收任务开始：记录 taskId，便于侧栏再次点击“回收”时直接打开进度窗口
	          const wtPid = String(project.id || "").trim();
	          if (wtPid) worktreeRecycleRunningTaskIdByProjectIdRef.current[wtPid] = taskId;

	          // 关闭“配置弹窗”，切换到“进度弹窗”
			      setWorktreeRecycleDialog((prev) => ({ ...prev, open: false, running: false, loading: false }));
	          setWorktreeRecycleProgress({ open: true, projectId: project.id, taskId, status: "running", log: "", logOffset: 0, updatedAt: Date.now(), error: undefined });

          // 轮询任务输出（支持实时日志）
          let snapshot: WorktreeRecycleTaskSnapshot | null = null;
          let logText = "";
          let logOffset = 0;
          const startedAt = Date.now();
          while (true) {
            try {
              const pull: any = await (window as any).host?.gitWorktree?.recycleTaskGet?.({ taskId, from: logOffset });
              if (pull && pull.ok && pull.task) {
                snapshot = pull.task as WorktreeRecycleTaskSnapshot;
                const append = String(pull.append || "");
                if (append) logText += append;
                logOffset = Math.max(logOffset, Math.floor(Number(snapshot.logSize) || 0));
                setWorktreeRecycleProgress((prev) => {
                  if (prev.taskId !== taskId) return prev;
                  return {
                    ...prev,
                    status: snapshot!.status,
                    log: logText,
                    logOffset,
                    updatedAt: Math.floor(Number(snapshot!.updatedAt) || Date.now()),
                    error: snapshot!.error ? String(snapshot!.error || "") : undefined,
                  };
                });
                if (snapshot.status !== "running") break;
              }
            } catch {}

            // 兜底：避免无限等待
            if (Date.now() - startedAt > 40 * 60_000) {
              setWorktreeRecycleProgress((prev) => {
                if (prev.taskId !== taskId) return prev;
                return { ...prev, status: "error", error: "等待合并任务超时（请在外部 Git 工具/终端查看状态并处理）" };
              });
              break;
            }
	            await new Promise((r) => setTimeout(r, 250));
	          }

	          // 回收任务结束：允许再次回收（无论成功或失败）
	          try { delete worktreeRecycleRunningTaskIdByProjectIdRef.current[wtPid]; } catch {}

	          const res: any = snapshot?.result;
	          if (!snapshot || !res) {
	            const msg = snapshot?.error || "合并任务未返回结果（请重试或在外部 Git 工具排查）";
	            setWorktreeRecycleProgress((prev) => (prev.taskId === taskId ? { ...prev, open: true, status: "error", error: msg } : prev));
            showGitActionErrorDialog({
              title: t("projects:worktreeRecycleFailed", "合并 worktree 失败") as string,
              message: `${msg}${preCommitHint ? `\n\n${preCommitHint}` : ""}`,
              dir: dlg.repoMainPath || project.winPath,
            });
            return;
          }

          // BASE_WORKTREE_DIRTY：不直接失败结束，弹窗让用户选择（取消/外部工具/继续）
          if (res && res.ok === false && String(res.errorCode || "") === "BASE_WORKTREE_DIRTY" && !autoStashBaseWorktree) {
            setWorktreeRecycleProgress((prev) => (prev.taskId === taskId ? { ...prev, open: false } : prev));
            setBaseWorktreeDirtyDialog({
              open: true,
              repoMainPath: String(res?.details?.repoMainPath || dlg.repoMainPath || project.winPath),
              preCommitHint,
            });
            return;
          }

          // 其它失败：统一走结构化错误码 + i18n 映射（进度弹窗保留以便查看日志）
          if (!(res && res.ok)) {
            const errorCode = String(res?.errorCode || "").trim();
            const details = res?.details || {};
            const repoMainPath = String(details?.repoMainPath || dlg.repoMainPath || project.winPath);
            const dirForDialog = errorCode === "WORKTREE_DIRTY" ? project.winPath : repoMainPath;
            const stashInfo = parseRecycleStashes(details, t);
            const stashLine = stashInfo.stashLine;
            const hasStash = stashInfo.items.length > 0;
            const restoreCmd = stashInfo.restoreCmd;
            const restoreLine = restoreCmd
              ? (t("projects:worktreeRecycleSuggestedRestore", "待主 worktree 状态正常后，可手动执行：{cmd}", { cmd: restoreCmd }) as string)
              : "";
            const mapped =
              errorCode === "FORK_POINT_UNAVAILABLE"
                ? (t("projects:worktreeRecycleError_FORK_POINT_UNAVAILABLE", "无法自动确定分叉点。请在回收设置中手动指定分叉点，或切换到“完整回收”。") as string)
                : errorCode === "FORK_POINT_INVALID"
                  ? (t("projects:worktreeRecycleError_FORK_POINT_INVALID", "分叉点无效（需为源分支祖先提交）。请手动指定正确的分叉点，或切换到“完整回收”。") as string)
                  : errorCode === "BASE_WORKTREE_IN_PROGRESS"
                ? (t("projects:worktreeRecycleError_BASE_WORKTREE_IN_PROGRESS", "主 worktree 存在未完成的 Git 操作或冲突文件。请先在外部工具完成/中止当前操作后再重试。") as string)
                : errorCode === "BASE_WORKTREE_LOCKED"
                  ? (t("projects:worktreeRecycleError_BASE_WORKTREE_LOCKED", "仓库当前被锁定（可能存在 index.lock 或其他 Git 进程正在运行）。请关闭占用进程后重试。") as string)
                  : errorCode === "BASE_WORKTREE_STASH_FAILED"
                    ? (t("projects:worktreeRecycleError_BASE_WORKTREE_STASH_FAILED", "自动暂存主 worktree 失败。请在外部工具检查 Git 状态并手动处理。") as string)
                    : errorCode === "BASE_WORKTREE_DIRTY_AFTER_STASH"
                      ? (t("projects:worktreeRecycleError_BASE_WORKTREE_DIRTY_AFTER_STASH", "已创建 stash，但主 worktree 仍然不干净（例如子模块/嵌套仓库修改等 stash 无法覆盖的情况）。请在外部工具处理。") as string)
                      : errorCode === "WORKTREE_DIRTY"
                        ? (t("projects:worktreeRecycleError_WORKTREE_DIRTY", "该 worktree 存在未提交修改。请先提交/暂存或取消修改后再回收。") as string)
                        : errorCode === "RECYCLE_FAILED"
                          ? (hasStash
                              ? (t("projects:worktreeRecycleError_RECYCLE_FAILED_STASHED", "回收过程中失败。为避免把主 worktree 改动叠加到冲突/中断态，未自动恢复 stash。请先在外部工具中处理回收失败原因后再自行恢复。") as string)
                              : (t("projects:worktreeRecycleError_RECYCLE_FAILED", "回收过程中失败。请在外部工具中查看冲突/中断/hook 等原因并处理后再重试。") as string))
	                          : (String(details?.stderr || details?.error || "").trim() || (t("projects:worktreeRecycleFailed", "合并 worktree 失败") as string));

            const message = [mapped, stashLine, restoreLine, preCommitHint ? `\n${preCommitHint}` : ""].filter((x) => String(x || "").trim()).join("\n\n");
            setWorktreeRecycleProgress((prev) => (prev.taskId === taskId ? { ...prev, status: "error", error: mapped } : prev));
	            showGitActionErrorDialog({
	              title: t("projects:worktreeRecycleFailed", "合并 worktree 失败") as string,
	              message,
	              dir: dirForDialog,
	            });
            return;
          }

          // 成功：关闭进度弹窗，进入“是否删除 worktree”步骤
          setWorktreeRecycleProgress((prev) => (prev.taskId === taskId ? { ...prev, open: false } : prev));
		      const squashHint =
		        dlg.mode === "squash"
		          ? (t("projects:worktreeRecycleSquashAfterHint", "提示：你选择的是“提交压缩（squash）”回收。该方式不会把 worktree 分支的提交历史合并到基分支，所以删除分支时 Git 会判定“未合并”，需要强制删除（不会影响已回收的改动）。") as string)
		          : undefined;

          const warningCode = String(res?.warningCode || "").trim();
          const details = res?.details || {};
          const stashInfo = parseRecycleStashes(details, t);
          const stashMsg = stashInfo.stashMsgForWarning;
          const stashSha = stashInfo.stashShaForWarning;
          const restoreCmd = stashInfo.restoreCmd;
          const warningHint =
            warningCode === "BASE_WORKTREE_RESTORE_CONFLICT"
              ? (t("projects:worktreeRecycleWarning_BASE_WORKTREE_RESTORE_CONFLICT", "提示：回收已完成，但主 worktree 自动恢复发生冲突。请用外部工具解决冲突；stash 仍保留：{msg} {sha}", { msg: stashMsg || "-", sha: stashSha || "" }) as string)
              : warningCode === "BASE_WORKTREE_RESTORE_FAILED"
                ? (t("projects:worktreeRecycleWarning_BASE_WORKTREE_RESTORE_FAILED", "提示：回收已完成，但主 worktree 自动恢复失败。stash 仍保留：{msg} {sha}\n你可以手动执行：{cmd}", { msg: stashMsg || "-", sha: stashSha || "", cmd: restoreCmd || (stashSha ? `git stash apply --index ${stashSha}` : "") }) as string)
                : warningCode === "BASE_WORKTREE_STASH_DROP_FAILED"
                  ? (t("projects:worktreeRecycleWarning_BASE_WORKTREE_STASH_DROP_FAILED", "提示：回收已完成且已尝试恢复，但自动清理 stash 失败。你可以稍后手动删除该 stash：{sha}", { sha: stashSha || "" }) as string)
                  : undefined;

          const hint = [preCommitHint, squashHint, warningHint].filter(Boolean).join("\n") || undefined;
          setWorktreePostRecycleDialog({ open: true, projectId: project.id, hint });
		    } catch (e: any) {
			      const preCommitHint = preCommitted
		          ? `\n\n提示：合并前检测到未提交修改，已在分支 ${wtBranch} 自动提交一次（${summarizeForCommitMessage(preCommitMessage, 96)}）。`
		          : "";
		      setWorktreeRecycleDialog((prev) => ({ ...prev, running: false, error: String(e?.message || e) }));
          setWorktreeRecycleProgress((prev) => (prev.taskId && prev.taskId === recycleTaskId ? { ...prev, status: "error", error: String(e?.message || e) } : prev));
			      showGitActionErrorDialog({
			        title: t("projects:worktreeRecycleFailed", "合并 worktree 失败") as string,
			        message: `${String(e?.message || e)}${preCommitHint}`,
			        dir: dlg.repoMainPath || project.winPath,
			      });
		    }
		  }, [guardWorktreeRecycleAndDeleteByTerminalAgents, showGitActionErrorDialog, t, worktreeRecycleDialog]);

  /**
   * 打开“删除 worktree / 对齐到主工作区”对话框。
   */
		  const openWorktreeDeleteDialog = useCallback((project: Project, afterRecycle?: boolean, action?: "delete" | "reset", afterRecycleHint?: string) => {
		    const pid = String(project?.id || "").trim();
		    if (!pid) return;

		    // 回收进行中：禁止删除（避免与回收流程并发导致状态不一致）
		    const runningRecycleTaskId = String(worktreeRecycleRunningTaskIdByProjectIdRef.current[pid] || "").trim();
		    if (runningRecycleTaskId) {
		      setNoticeDialog({
		        open: true,
		        title: t("projects:worktreeDeleteTitle", "删除 worktree") as string,
		        message: t(
		          "projects:worktreeDeleteBlockedByRecycling",
		          "该 worktree 正在回收中，暂不可删除。你可以点击“回收”查看进度。"
		        ) as string,
		      });
		      setWorktreeRecycleProgress((prev) => {
		        if (prev.taskId === runningRecycleTaskId) return { ...prev, open: true, projectId: pid };
		        return { open: true, projectId: pid, taskId: runningRecycleTaskId, status: "running", log: "", logOffset: 0, updatedAt: 0, error: undefined };
		      });
		      return;
		    }
		    if (!guardWorktreeRecycleAndDeleteByTerminalAgents(project)) return;
		    if (worktreeDeleteInFlightByProjectIdRef.current[pid]) {
		      setNoticeDialog({
		        open: true,
	        title: t("projects:worktreeDeleteTitle", "删除 worktree") as string,
	        message: t("projects:worktreeDeleteInProgress", "该 worktree 正在删除中，请勿重复操作。") as string,
	      });
	      return;
	    }
	    setWorktreeDeleteDialog({
	      open: true,
	      projectId: pid,
	      action: action === "reset" ? "reset" : "delete",
	      afterRecycle: !!afterRecycle,
	      afterRecycleHint: afterRecycleHint || undefined,
	      running: false,
	      needsForceRemoveWorktree: false,
	      needsForceDeleteBranch: false,
	      needsForceResetWorktree: false,
	      error: undefined,
	    });
	  }, [guardWorktreeRecycleAndDeleteByTerminalAgents, t]);

  /**
   * 关闭“删除 worktree / 对齐到主工作区”对话框。
   */
	  const closeWorktreeDeleteDialog = useCallback(() => {
	    setWorktreeDeleteDialog((prev) => ({
	      ...prev,
	      open: false,
	      action: "delete",
	      afterRecycleHint: undefined,
	      running: false,
	      needsForceRemoveWorktree: false,
	      needsForceDeleteBranch: false,
	      needsForceResetWorktree: false,
	      error: undefined,
	    }));
	  }, []);

  /**
   * 执行“删除 worktree / 对齐到主工作区”。
   * - 删除：worktree remove + 删除专用分支；必要时二次强确认。
   * - 对齐：保持目录不删除，将该子 worktree 强制更新到主工作区当前基线并恢复为干净状态；必要时二次强确认。
   */
	  const submitWorktreeDelete = useCallback(async (opts?: { forceRemoveWorktree?: boolean; forceDeleteBranch?: boolean; forceResetWorktree?: boolean }) => {
	    const dlg = worktreeDeleteDialog;
	    if (!dlg.open || dlg.running) return;
	    if (worktreeDeleteSubmitGuardRef.current) return;
	    const project = projectsRef.current.find((x) => x.id === dlg.projectId) || null;
	    if (!project) return;

	    // 回收进行中：禁止删除（避免与回收流程并发导致状态不一致）
	    const pid = String(project.id || "").trim();
		    const runningRecycleTaskId = String(worktreeRecycleRunningTaskIdByProjectIdRef.current[pid] || "").trim();
		    if (runningRecycleTaskId) {
		      setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: false, error: t("projects:worktreeDeleteBlockedByRecycling", "该 worktree 正在合并中，暂不可删除。你可以点击“合并”查看进度。") as string } : prev));
		      setWorktreeRecycleProgress((prev) => {
		        if (prev.taskId === runningRecycleTaskId) return { ...prev, open: true, projectId: pid };
		        return { open: true, projectId: pid, taskId: runningRecycleTaskId, status: "running", log: "", logOffset: 0, updatedAt: 0, error: undefined };
		      });
	      return;
	    }
	    if (!guardWorktreeRecycleAndDeleteByTerminalAgents(project)) return;
	
	    // 防重复：即使用户关闭弹窗后再次打开，也不允许重复触发同一 worktree 的删除
	    if (worktreeDeleteInFlightByProjectIdRef.current[String(project.id || "").trim()]) {
      setNoticeDialog({
        open: true,
        title: t("projects:worktreeDeleteTitle", "删除 worktree") as string,
        message: t("projects:worktreeDeleteInProgress", "该 worktree 正在删除中，请勿重复操作。") as string,
      });
      return;
    }

    worktreeDeleteSubmitGuardRef.current = true;
    setWorktreeDeleteInFlight(project.id, true);

    setWorktreeDeleteDialog((prev) => ({ ...prev, running: true, error: undefined }));
    try {
      if (dlg.action === "reset") {
        const res: any = await (window as any).host?.gitWorktree?.reset?.({
          worktreePath: project.winPath,
          force: opts?.forceResetWorktree === true,
        });
        if (res && res.ok) {
          setWorktreeDeleteDialog((prev) => ({ ...prev, open: false, running: false }));
          void refreshGitInfoForProjectIds([project.id]);
          return;
        }
        if (res?.needsForce) {
          setWorktreeDeleteDialog((prev) => ({ ...prev, running: false, needsForceResetWorktree: true, error: String(res?.error || "") }));
          return;
        }
        throw new Error(res?.error || "reset failed");
      } else {
        const res: any = await (window as any).host?.gitWorktree?.remove?.({
          worktreePath: project.winPath,
          deleteBranch: true,
          forceRemoveWorktree: opts?.forceRemoveWorktree === true,
          forceDeleteBranch: opts?.forceDeleteBranch === true,
        });
        if (res && res.ok) {
          setWorktreeDeleteDialog((prev) => ({ ...prev, open: false, running: false }));
          void refreshGitInfoForProjectIds([project.id]);
          return;
        }
        if (res?.needsForceRemoveWorktree) {
          setWorktreeDeleteDialog((prev) => ({ ...prev, running: false, needsForceRemoveWorktree: true, error: String(res?.error || "") }));
          return;
        }
        if (res?.needsForceDeleteBranch) {
          setWorktreeDeleteDialog((prev) => ({ ...prev, running: false, needsForceDeleteBranch: true, error: String(res?.error || "") }));
          return;
        }
        throw new Error(res?.error || "delete failed");
      }
    } catch (e: any) {
      setWorktreeDeleteDialog((prev) => ({ ...prev, running: false, error: String(e?.message || e) }));
      showGitActionErrorDialog({
        title: dlg.action === "reset" ? (t("projects:worktreeResetFailed", "重置失败") as string) : (t("projects:worktreeDeleteFailed", "删除 worktree 失败") as string),
        message: String(e?.message || e),
        dir: project.winPath,
      });
    } finally {
      worktreeDeleteSubmitGuardRef.current = false;
      setWorktreeDeleteInFlight(project.id, false);
    }
  }, [guardWorktreeRecycleAndDeleteByTerminalAgents, refreshGitInfoForProjectIds, setWorktreeDeleteInFlight, showGitActionErrorDialog, t, worktreeDeleteDialog]);

	  /**
	   * 若当前项目满足“worktree 自动提交”条件，则将一次自动提交加入队列（同一项目串行执行，避免 git lock 冲突）。
	   */
	  const enqueueAutoCommit = useCallback((projectId: string, source: "user" | "agent", text: string) => {
	    if (!gitWorktreeAutoCommitEnabled) return;
	    const pid = String(projectId || "").trim();
	    if (!pid) return;
	    const project = projectsRef.current.find((x) => x.id === pid) || null;
	    if (!project?.winPath) return;
	    // 关键修复：不要依赖前端的 git 状态缓存是否已刷新（新建 worktree 后第一轮可能尚未写入 gitInfoByProjectId）。
	    // 是否为“非主 worktree 根目录”的最终判定交由主进程完成，避免首次对话漏触发导致“第二次对话才提交”的体验问题。

	    const message = buildAutoCommitMessage(source, text);
	    if (!message.trim()) return;

	    const key = pid;
	    const prev = autoCommitQueueByProjectIdRef.current[key] || Promise.resolve();
	    autoCommitQueueByProjectIdRef.current[key] = prev
	      .catch(() => {})
	      .then(async () => {
	        try {
	          const res: any = await (window as any).host?.gitWorktree?.autoCommit?.({ worktreePath: project.winPath, message });
	          if (res && res.ok) return;
	          throw new Error(res?.error || "autoCommit failed");
	        } catch (e: any) {
	          showGitActionErrorDialog({
	            title: t("projects:autoCommitFailedTitle", "自动提交失败") as string,
	            message: String(e?.message || e),
	            dir: project.winPath,
	          });
	        }
	      });
	  }, [gitWorktreeAutoCommitEnabled, showGitActionErrorDialog, t]);

  /**
   * 中文说明：移除项目的“自定义 Provider 目录记录”。
   * - 若该项目仅由目录记录产生，则会从项目列表中移除（等同于“删除该项目条目”）。
   * - 若该项目已存在内置会话，则仅清空目录记录，项目仍保留。
   */
  const removeProjectDirRecord = useCallback(async (target: Project | null) => {
    const project = target;
    if (!project) return;
    // 优先关闭菜单，避免重复触发或遮挡提示
    setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
    try {
      const res: any = await window.host.projects.removeDirRecord({ id: project.id });
      if (res && res.ok && res.removed) {
        if (res.project) upsertProjectInList(res.project as Project);
        else removeProjectFromUIList(project);
      }
    } catch {}
  }, [removeProjectFromUIList, upsertProjectInList]);

  /**
   * 中文说明：打开历史记录“删除到回收站”确认弹窗（用于悬停快捷键 D）。
   */
  const openHistoryDeleteConfirm = useCallback((item: HistorySession | null, groupKey: string | null) => {
    if (!item) return;
    setConfirmDelete({ open: true, item, groupKey });
    setHistoryCtxMenu((m) => ({ ...m, show: false }));
  }, []);

  /**
   * 中文说明：判断当前是否存在打开的应用内 Dialog（用于避免悬停快捷键在弹窗期间误触）。
   */
  const hasAnyOpenDialog = useCallback((): boolean => {
    try {
      if (typeof document === "undefined") return false;
      return !!document.querySelector('[data-cf-dialog-content="true"]');
    } catch {
      return false;
    }
  }, []);

  /**
   * 中文说明：判断键盘事件是否应忽略悬停快捷键（IME/组合键/弹窗打开/指定输入区域等）。
   */
  const shouldIgnoreHoverShortcutEvent = useCallback((event: KeyboardEvent): boolean => {
    if (!event) return true;
    if (event.defaultPrevented) return true;
    if ((event as any).isComposing) return true;
    if (event.repeat) return true;
    if (event.ctrlKey || event.metaKey || event.altKey) return true;
    if (hasAnyOpenDialog()) return true;
    try {
      const el = event.target as any;
      if (el && typeof el.closest === "function" && el.closest('[data-cf-hover-shortcuts-ignore="true"]')) return true;
    } catch {}
    return false;
  }, [hasAnyOpenDialog]);

  useEffect(() => {
    /**
     * 中文说明：悬停快捷键处理器。
     * - 项目列表：H=隐藏/取消隐藏；D=删除 worktree 或移除目录记录
     * - 历史列表：D=删除历史对话（删除到回收站）
     */
    const handler = (event: KeyboardEvent) => {
      const k = String(event?.key || "");
      const key = k.toLowerCase();
      if (key !== "h" && key !== "d") return;
      if (shouldIgnoreHoverShortcutEvent(event)) return;

      // 历史项优先：D = 删除历史对话（删除到回收站）
      if (key === "d") {
        try {
          const hoverEl = document.querySelector('[data-cf-history-row-id]:hover') as HTMLElement | null;
          if (hoverEl) {
            const hoverId = String(hoverEl.getAttribute("data-cf-history-row-id") || "").trim();
            const hoverGroupKey = String(hoverEl.getAttribute("data-cf-history-group-key") || "").trim();
            if (hoverId && hoverGroupKey) {
              const cached = hoveredHistoryShortcutRef.current;
              const item =
                cached && cached.item && cached.item.id === hoverId && cached.groupKey === hoverGroupKey
                  ? cached.item
                  : (historySessionsRef.current.find((s) => s.id === hoverId) || null);
              if (item) {
                event.preventDefault();
                openHistoryDeleteConfirm(item, hoverGroupKey);
                hoveredHistoryShortcutRef.current = null;
                return;
              }
            }
          }
        } catch {}
      }

      // 项目列表：H = 隐藏/取消隐藏；D = 删除（worktree 删除 或 移除目录记录）
      try {
        const hoverEl = document.querySelector('[data-cf-project-row-id]:hover') as HTMLElement | null;
        if (!hoverEl) return;
        const hoverId = String(hoverEl.getAttribute("data-cf-project-row-id") || "").trim();
        if (!hoverId) return;

        const cached = hoveredProjectShortcutRef.current;
        const project =
          cached && cached.project && cached.project.id === hoverId
            ? cached.project
            : (projectsRef.current.find((p) => p.id === hoverId) || null);
        if (!project) return;

        const isHidden = cached && cached.project && cached.project.id === hoverId ? cached.isHidden : hiddenProjectIdSet.has(project.id);
        const canRemoveDirRecord =
          cached && cached.project && cached.project.id === hoverId
            ? cached.canRemoveDirRecord
            : !!(project.dirRecord && project.dirRecord.kind === "custom_provider" && project.hasBuiltInSessions !== true);
        const canDeleteWorktree =
          cached && cached.project && cached.project.id === hoverId
            ? cached.canDeleteWorktree
            : (() => {
                const git = gitInfoByProjectId[project.id];
                const isWorktreeNode = !!git?.isWorktree && !!git?.isRepoRoot;
                const isMainWorktree =
                  isWorktreeNode &&
                  !!git?.mainWorktree &&
                  toDirKeyForCache(String(git.mainWorktree || "")) === toDirKeyForCache(String(git.dir || ""));
                return isWorktreeNode && !isMainWorktree;
              })();

        if (key === "h") {
          event.preventDefault();
          if (isHidden) unhideProject(project);
          else setHideProjectConfirm({ open: true, project });
          hoveredProjectShortcutRef.current = null;
          return;
        }

        if (key === "d") {
          if (canDeleteWorktree) {
            event.preventDefault();
            openWorktreeDeleteDialog(project, false);
            hoveredProjectShortcutRef.current = null;
            return;
          }
          if (canRemoveDirRecord) {
            event.preventDefault();
            void removeProjectDirRecord(project);
            hoveredProjectShortcutRef.current = null;
            return;
          }
        }
      } catch {}
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [gitInfoByProjectId, hiddenProjectIdSet, openHistoryDeleteConfirm, openWorktreeDeleteDialog, removeProjectDirRecord, shouldIgnoreHoverShortcutEvent, unhideProject]);

  // ---------- Renderers ----------

  const Sidebar = (
    <div className="flex h-full min-h-0 min-w-0 flex-col border-r bg-white/50 dark:border-slate-800 dark:bg-slate-900/40">
	      <div className="flex items-center gap-2 px-3 py-3">
	        <DropdownMenu>
	          <DropdownMenuTrigger>
	            <button className="flex items-center gap-2 cursor-pointer select-none" title={t("settings:terminalMode.label") as string}>
	              <Badge variant="secondary" className="gap-2">
	                <PlugZap className="h-4 w-4" /> {toShellLabel(terminalMode)} <StatusDot ok={true} /> <ChevronDown className="h-3.5 w-3.5 opacity-70" />
	              </Badge>
	              {terminalMode === "wsl" ? (
	                <span className="text-xs text-slate-500">{wslDistro}</span>
	              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs text-slate-500">
              {t("settings:terminalMode.label")}
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="flex items-center justify-between gap-2"
              onClick={async () => {
                const nextEnv: Required<ProviderEnv> = { ...getProviderEnv(activeProviderId), terminal: "wsl" };
                const nextMap = { ...providerEnvById, [activeProviderId]: nextEnv };
                setProviderEnvById(nextMap);
                setTerminalMode("wsl");
                setWslDistro(nextEnv.distro);
                await persistProviders({ activeId: activeProviderId, items: providerItems, env: nextMap });
              }}
            >
              <span>{t("settings:terminalMode.wsl")}</span>
              {terminalMode === "wsl" ? <Check className="h-4 w-4 text-slate-600" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex items-center justify-between gap-2"
              onClick={async () => {
                const nextEnv: Required<ProviderEnv> = { ...getProviderEnv(activeProviderId), terminal: "windows" };
                const nextMap = { ...providerEnvById, [activeProviderId]: nextEnv };
                setProviderEnvById(nextMap);
                setTerminalMode("windows" as any);
                await persistProviders({ activeId: activeProviderId, items: providerItems, env: nextMap });
              }}
            >
              <span>{t("settings:terminalMode.windows")}</span>
              {terminalMode === "windows" ? <Check className="h-4 w-4 text-slate-600" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex items-center justify-between gap-2"
              onClick={async () => {
                const nextEnv: Required<ProviderEnv> = { ...getProviderEnv(activeProviderId), terminal: "pwsh" };
                const nextMap = { ...providerEnvById, [activeProviderId]: nextEnv };
                setProviderEnvById(nextMap);
                setTerminalMode("pwsh" as any);
                await persistProviders({ activeId: activeProviderId, items: providerItems, env: nextMap });
              }}
            >
              <span>{t("settings:terminalMode.pwsh")}</span>
              {terminalMode === "pwsh" ? <Check className="h-4 w-4 text-slate-600" /> : null}
            </DropdownMenuItem>

            {terminalMode === "wsl" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-slate-500">{t("settings:wslDistro")}</DropdownMenuLabel>
                {(availableDistros.length > 0 ? availableDistros : [wslDistro]).map((name) => (
                  <DropdownMenuItem
                    key={name}
                    className="flex items-center justify-between gap-2"
                    onClick={async () => {
                      const nextEnv: Required<ProviderEnv> = { ...getProviderEnv(activeProviderId), distro: name };
                      const nextMap = { ...providerEnvById, [activeProviderId]: nextEnv };
                      setProviderEnvById(nextMap);
                      setWslDistro(name);
                      await persistProviders({ activeId: activeProviderId, items: providerItems, env: nextMap });
                    }}
                  >
                    <span className="truncate">{name}</span>
                    {wslDistro === name ? <Check className="h-4 w-4 text-slate-600" /> : null}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('projects:searchPlaceholder') as string}
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setQuery((e.target as any).value)}
            className="h-9"
            data-cf-hover-shortcuts-ignore="true"
          />
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
            title={t('projects:sortTitle', { label: projectSortLabel }) as string}
              >
                <ArrowDownAZ className="h-3.5 w-3.5 text-slate-600" />
                <span className="sr-only">{t('projects:sortLabel') as string}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-slate-500">{t('projects:sortLabel')}</DropdownMenuLabel>
              <DropdownMenuItem
                className="flex items-center justify-between gap-2"
                onClick={() => handleProjectSortChange("recent")}
              >
                <span>{t('projects:sortRecent')}</span>
                {projectSort === "recent" ? <Check className="h-4 w-4 text-slate-600" /> : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex items-center justify-between gap-2"
                onClick={() => handleProjectSortChange("name")}
              >
                <span>{t('projects:sortName')}</span>
                {projectSort === "name" ? <Check className="h-4 w-4 text-slate-600" /> : null}
              </DropdownMenuItem>
              
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={() => setShowHiddenProjects((prev) => !prev)}
            title={(showHiddenProjects ? t('projects:hideHiddenProjects') : t('projects:showHiddenProjects')) as string}
          >
            {showHiddenProjects ? <Eye className="h-3.5 w-3.5 text-slate-600" /> : <EyeOff className="h-3.5 w-3.5 text-slate-600" />}
            <span className="sr-only">{(showHiddenProjects ? t('projects:hideHiddenProjects') : t('projects:showHiddenProjects')) as string}</span>
          </Button>
          {/* 统一入口：打开项目并自动创建控制台 */}
          <Button
            size="icon"
            variant="secondary"
            className="h-9 w-9 shrink-0"
            onClick={() => openProjectPicker()}
            title={t('projects:openProject') as string}
          >
            <FolderOpen className="h-4 w-4" />
            <span className="sr-only">{t('projects:openProject') as string}</span>
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0 pl-2 pr-[5px] pb-6">
        <div
          className="space-y-1 relative"
          onDragOver={(e) => {
            if (!dirDrag?.draggingId) return;
            // 若目标在行内，则由行自身处理，避免 root-end 覆盖 before/after/asChild 的落点判断
            try {
              const el = e.target as any;
              if (el && typeof el.closest === "function" && el.closest("[data-dir-row]")) return;
            } catch {}
            e.preventDefault();
            try { e.dataTransfer.dropEffect = "move"; } catch {}
            // 落到空白区域：视为移动到根级末尾
            if (!dirDrag.overId || dirDrag.position !== "root-end") {
              setDirDrag((prev) => prev ? { ...prev, overId: "", position: "root-end" } : null);
            }
          }}
          onDrop={(e) => {
            const src = dirDrag?.draggingId;
            if (!src) return;
            try {
              const el = e.target as any;
              if (el && typeof el.closest === "function" && el.closest("[data-dir-row]")) return;
            } catch {}
            e.preventDefault();
            applyDirDrop(src, null, "root-end");
            setDirDrag(null);
          }}
        >
          {dirDrag?.draggingId && dirDrag.position === "root-end" && !dirDrag.overId ? (
            <div className="pointer-events-none absolute left-3 right-3 -bottom-1 h-[2px] rounded-full bg-[var(--cf-accent)]/60" />
          ) : null}
          {(query.trim() ? filtered.map((p) => ({ project: p, depth: 0 as const })) : dirTreeRows).map((row) => {
            const p = row.project;
            const depth = row.depth;
            const tabsInProject = tabsByProject[p.id] || [];
            const liveCount = tabsInProject.filter((tab) => !!ptyAlive[tab.id]).length;
            const pendingCount = pendingByProject[p.id] ?? 0;
            const isHidden = hiddenProjectIdSet.has(p.id);
            const git = gitInfoByProjectId[p.id];
            const exists = git ? git.exists && git.isDirectory : true;
            const isRepoRoot = !!git?.isRepoRoot;
            const branchFull = git?.branch || "";
            const isDetached = !!git?.detached;
            const branch = formatBranchLabel(branchFull);
            const isMainWorktree = !!git?.isWorktree && !!git?.mainWorktree && toDirKeyForCache(git.mainWorktree) === toDirKeyForCache(git.dir);
            const isWorktreeNode = !!git?.isWorktree && !!git?.isRepoRoot;
            const isSecondaryWorktree = isWorktreeNode && !isMainWorktree;
            const selected = p.id === selectedProjectId;
            const hasChildren = depth === 0 && hasDirChildren(p.id);
            const expanded = hasChildren && dirTreeStore.expandedById[p.id] !== false;
            const canOperateOnDir = exists;
            const canDrag = !query.trim();
            const isEditingDirLabel = dirLabelDialog.open && dirLabelDialog.projectId === p.id;
            const isChildNode = isDirChild(p.id);
            const canCreateWorktree = canOperateOnDir && isRepoRoot && !isSecondaryWorktree && !isChildNode;
            const canRemoveDirRecord = !!(p.dirRecord && p.dirRecord.kind === "custom_provider" && p.hasBuiltInSessions !== true);

            const rowClass = `group relative flex items-center justify-between rounded-lg transition cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 ${isHidden ? "opacity-60" : ""} ${selected ? "bg-slate-100 dark:bg-slate-800/80 dark:text-slate-100" : ""}`;
            const rowPadding = depth === 1 ? "pl-1 pr-2" : "pl-[1px] pr-[7px]";

            return (
              <div
                key={p.id}
                data-dir-row="1"
                data-cf-project-row-id={p.id}
                className={`${rowClass} ${rowPadding} h-14`}
                onMouseEnter={() => {
                  hoveredProjectShortcutRef.current = { project: p, isHidden, canRemoveDirRecord, canDeleteWorktree: isSecondaryWorktree };
                }}
                onMouseLeave={() => {
                  const cur = hoveredProjectShortcutRef.current;
                  if (cur?.project?.id === p.id) hoveredProjectShortcutRef.current = null;
                }}
                onClick={() => {
                  // 点击项目时默认进入控制台，并清除历史选择（避免自动跳到历史详情）
                  suppressAutoSelectRef.current = true;
                  setSelectedProjectId(p.id);
                  setCenterMode("console");
                  setSelectedHistoryDir(null);
                  setSelectedHistoryId(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectCtxMenu({ show: true, x: e.clientX, y: e.clientY, project: p });
                }}
	                onDragOver={(e) => {
	                  const src = dirDrag?.draggingId;
	                  if (!src) return;
	                  if (depth !== 0) {
	                    // 子级不作为 drop target：仅清理落点提示，不允许 drop
	                    setDirDrag((prev) => (prev && prev.draggingId === src ? { draggingId: src } : prev));
	                    return;
	                  }
	                  if (src === p.id) return;
	                  e.preventDefault();
	                  try { e.dataTransfer.dropEffect = "move"; } catch {}
	                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
	                  const y = e.clientY - rect.top;
	                  const ratio = rect.height > 0 ? y / rect.height : 0.5;
	                  // 说明：拖到中间区域默认作为子级移动；拖到上下边缘可提升为根级并参与根级排序
	                  const srcHasChildren = hasDirChildren(src);
	                  const allowAsChild = !srcHasChildren && !isDirChild(p.id);
	                  const pos = resolveDirRowDropPosition(ratio, { allowAsChild });
	                  setDirDrag({ draggingId: src, overId: p.id, position: pos });
	                }}
                onDrop={(e) => {
                  const src = dirDrag?.draggingId;
                  const pos = dirDrag?.position;
                  if (!src || !pos) return;
                  e.preventDefault();
                  if (depth !== 0) return;
                  if (src === p.id) return;
                  applyDirDrop(src, p.id, pos === "asChild" ? "asChild" : (pos === "before" ? "before" : "after"));
                  setDirDrag(null);
                }}
              >
                {dirDrag?.draggingId && depth === 0 && dirDrag.overId === p.id ? (
                  <div className="pointer-events-none absolute inset-0">
                    {dirDrag.position === "asChild" ? (
                      <div className="absolute inset-0 rounded-lg ring-2 ring-[var(--cf-accent)]/35" />
                    ) : null}
                    {dirDrag.position === "before" ? (
                      <div className="absolute left-2 right-2 top-0 h-[2px] rounded-full bg-[var(--cf-accent)]/80" />
                    ) : null}
                    {dirDrag.position === "after" ? (
                      <div className="absolute left-2 right-2 bottom-0 h-[2px] rounded-full bg-[var(--cf-accent)]/80" />
                    ) : null}
                  </div>
                ) : null}

                {/* 左侧：展开/收起 + 名称与路径；拖拽仅绑定在名称与路径区域，避免按钮误触 */}
                <div className="flex-1 min-w-0 flex items-start gap-[1px]">
                  <div className="mt-[4px] shrink-0">
                    {hasChildren ? (
                      <MiniIconButton
                        title={expanded ? t("common:collapse", "收起") as string : t("common:expand", "展开") as string}
                        onClick={(e) => { e.stopPropagation(); toggleDirExpanded(p.id); }}
                      >
                        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </MiniIconButton>
                    ) : (
                      <span className="block h-[12px] w-[12px]" />
                    )}
                  </div>
                  <div
                    className="flex-1 min-w-0"
                    draggable={canDrag && !isEditingDirLabel}
                    onDragStart={(e) => onDirDragStart(e, p.id)}
                    onDragEnd={onDirDragEnd}
                  >
                    <div className="flex items-center gap-2 font-medium dark:text-[var(--cf-text-primary)]">
                      {isEditingDirLabel ? (
                        <input
                          autoFocus
                          data-cf-hover-shortcuts-ignore="true"
                          onFocus={(e) => { try { (e.target as HTMLInputElement).select(); } catch {} }}
                          onMouseDown={(e) => { e.stopPropagation(); }}
                          className="h-6 flex-1 min-w-0 max-w-[16rem] bg-transparent px-1 -mx-1 rounded-apple-sm border border-transparent outline-none focus:border-[var(--cf-border)] focus:bg-white/60 dark:focus:bg-slate-900/60"
                          value={String(dirLabelDialog.draft || "")}
                          placeholder={String(p.name || "").trim() || (t("projects:renameLabelPlaceholder", "留空表示无备注") as string)}
                          onChange={(e) => setDirLabelDialog((prev) => ({ ...prev, draft: String(e.target.value || "") }))}
                          onBlur={(e) => submitDirLabelDialog((e.target as HTMLInputElement).value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              submitDirLabelDialog((e.target as HTMLInputElement).value);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              closeDirLabelDialog();
                            }
                          }}
                        />
                      ) : (
                        <span
                          className="truncate max-w-[16rem]"
                          title={getDirNodeLabel(p)}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openDirLabelDialog(p);
                          }}
                        >
                          {getDirNodeLabel(p)}
                        </span>
                      )}
                      {!exists ? (
                        <span className="inline-flex items-center" title={t('terminal:dirMissing') as string}>
                          <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      ) : null}
                      {isHidden ? (
                        <span className="inline-flex items-center" title={t("projects:hiddenTag") as string}>
                          <EyeOff className="h-3.5 w-3.5 text-slate-500 dark:text-[var(--cf-text-muted)]" />
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-[var(--cf-text-muted)] overflow-x-auto no-scrollbar whitespace-nowrap pr-1" title={p.winPath}>
                      {p.winPath}
                    </div>
                  </div>
                </div>

                {/* 右侧：动作区（目录缺失时仍允许选择/展开，仅禁用需要真实目录的操作） */}
                <div className="ml-2 shrink-0 flex items-center gap-1">
	                  {canOperateOnDir ? (
	                    <WorktreeControlPad
	                      mode={isSecondaryWorktree ? "secondary" : isRepoRoot ? "root" : "normal"}
	                      deleteDisabledReason={
	                        isSecondaryWorktree && !!worktreeDeleteInFlightByProjectId[p.id]
	                          ? "deleting"
	                          : isSecondaryWorktree && !!String(worktreeRecycleRunningTaskIdByProjectIdRef.current[p.id] || "").trim()
	                            ? "recycling"
	                            : undefined
	                      }
	                      branch={
	                        isSecondaryWorktree || isRepoRoot
	                          ? {
	                              short: branch.short || (isDetached ? "DET" : ""),
                              full: branch.full,
                              isDetached,
                              headSha: git?.headSha,
                              disabled: !canCreateWorktree && isRepoRoot,
                              title:
                                isRepoRoot && !canCreateWorktree
                                  ? (t("projects:worktreeCreateDisabledChild", "该节点已为子级，无法再创建 worktree（层级至多一级）") as string)
                                  : isDetached
                                  ? `Detached HEAD ${git?.headSha ? `(${git.headSha})` : ""}`.trim()
                                  : isRepoRoot
                                  ? `${branch.full}\n${t("projects:worktreeCreateBranchHint", "单击：打开创建面板；Ctrl + 左键：快速创建工作区") as string}`
                                  : branch.full,
                            }
                          : undefined
                      }
                      onBranchClick={(e) => {
                        e.stopPropagation();
                        if (!canCreateWorktree || !isRepoRoot) return;
                        if (e.ctrlKey) void quickCreateWorktree(p);
                        else void openWorktreeCreateDialog(p);
	                      }}
	                      onBuild={(isRightClick) => void triggerBuildRun(p, "build", isRightClick)}
	                      onRun={(isRightClick) => void triggerBuildRun(p, "run", isRightClick)}
	                      onRecycle={() => void openWorktreeRecycleDialog(p)}
	                      onDelete={() => void openWorktreeDeleteDialog(p, false)}
	                      t={t}
	                    />
	                  ) : null}

                  {pendingCount > 0 ? (
                    <span
                      className="ml-1 inline-flex h-2 w-2 rounded-full bg-red-500 dark:bg-[var(--cf-red)] dark:shadow-sm"
                      title={t("common:notifications.openTabHint", "点击查看详情") as string}
                    ></span>
                  ) : null}
                  {liveCount > 0 ? (
                    <span className="ml-1 inline-flex items-center justify-center rounded-full bg-[var(--cf-accent)] text-white text-[10px] font-apple-semibold h-5 min-w-[20px] px-1 shadow-apple-xs ring-1 ring-[var(--cf-accent)]/20">
                      {liveCount}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );

  const [projPathExists, setProjPathExists] = useState<boolean | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateDialog, setUpdateDialog] = useState<{ show: boolean; latest?: { version: string; notes?: string; notesLocales?: Record<string, string>; url?: string }; current?: string }>(() => ({ show: false }));
  const [noUpdateDialog, setNoUpdateDialog] = useState(false);
  const [updateErrorDialog, setUpdateErrorDialog] = useState<{ show: boolean; reason: UpdateCheckErrorType; message?: string }>({ show: false, reason: "unknown" });
  const latestNotesText = useMemo(
    () => resolveLocalizedText(updateDialog.latest?.notesLocales, updateDialog.latest?.notes),
    [resolveLocalizedText, updateDialog.latest?.notes, updateDialog.latest?.notesLocales]
  );
  const [appVersion, setAppVersion] = useState<string>("");
  const resolvedNoUpdateMessage = useMemo(() => {
    if (appVersion) {
      return t('about:noUpdate.message', { version: `v${appVersion}` });
    }
    return t('about:noUpdate.messageNoVersion');
  }, [appVersion, t]);
  const updateErrorMessage = useMemo(() => {
    if (!updateErrorDialog.show) return "";
    switch (updateErrorDialog.reason) {
      case "timeout":
        return t("about:updateError.timeout");
      case "invalid":
        return t("about:updateError.invalid");
      case "network":
        return t("about:updateError.network");
      default:
        return t("about:updateError.unknown");
    }
  }, [t, updateErrorDialog.reason, updateErrorDialog.show]);
  const closeTabLabel = t('common:close') as string;
  useEffect(() => {
    (async () => {
      try {
        if (!selectedProject?.winPath) { setProjPathExists(null); return; }
        const res: any = await window.host.utils.pathExists(selectedProject.winPath, true);
        setProjPathExists(!!(res && res.ok && res.exists));
      } catch { setProjPathExists(null); }
    })();
  }, [selectedProject?.winPath]);

	  const TopBar = (
	    <div className="relative z-40 flex items-center justify-between border-b bg-white/70 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/60">
	      <div className="flex min-w-0 items-center gap-3">
		        <ProviderSwitcher
		          activeId={activeProviderId}
		          providers={providerItems}
		          onChange={changeActiveProvider}
		          terminalMode={terminalMode}
		          distro={terminalMode === "wsl" ? wslDistro : undefined}
		          themeMode={themeMode}
		        />
	      </div>
	      <div className={`flex items-center gap-2 ${showHistoryPanel ? "" : "pr-[44px]"}`}>
        {/* 目录缺失提示：若选中项目的 Windows 路径不存在则提示 */}
        {selectedProject?.winPath && (
          <span className="hidden" data-proj-path={selectedProject.winPath}></span>
        )}
        <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon className="mr-2 h-4 w-4" /> {t('settings:title')}
        </Button>
        <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setAboutOpen(true)}>
          <InfoIcon className="mr-2 h-4 w-4" /> {t('about:openButton')}
        </Button>
      </div>
    </div>
  );


  const ConsoleArea = (
    <div className="flex h-full min-h-0 flex-col gap-0 p-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* 新建代理按钮已移至标签区域（与 Chrome 标签页行为类似） */}
        </div>
      </div>

      <Tabs value={activeTabId || undefined} onValueChange={(v) => setActiveTab(v ?? null)} className="flex w-full flex-1 min-h-0 flex-col">
        <div className="rounded-md bg-white/90 border border-slate-100 px-2 py-1 dark:border-slate-700 dark:bg-slate-900/90">
          <TabsList ref={tabsListRef} className="w-full h-8 flex items-center justify-start overflow-x-auto no-scrollbar whitespace-nowrap">
            {tabs.length === 0 ? (
              projPathExists === false ? (
                <Badge variant="outline" className="mx-2">{t('terminal:dirMissing')}</Badge>
              ) : (
                <div className="px-1">
                  <Button 
                    size="sm" 
                    variant="default"
                    className="h-[25px] px-2.5 gap-1.5 text-sm font-apple-medium shadow-apple hover:shadow-apple-md transition-all duration-apple opacity-90 hover:opacity-100" 
                    onClick={openNewConsole}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{t('terminal:newConsole')}</span>
                  </Button>
                </div>
              )
            ) : (
              <>
            {tabs.map((tab) => {
              const pendingCount = pendingCompletions[tab.id] ?? 0;
              const hasPending = pendingCount > 0;
              const isActiveTab = activeTabId === tab.id;
              const providerIconSrc = getProviderIconSrc(tab.providerId, providerItemById, themeMode);
              return (
                <div
                  key={tab.id}
                  className="group/tab relative flex items-center shrink-0 h-6"
                  data-state={isActiveTab ? 'active' : 'inactive'}
                  onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); startEditTab(tab.id, tab.name); }}
                  onContextMenu={(e) => openTabContextMenu(e, tab.id, "tabs-header")}
                >
                  <TabsTrigger
                    value={tab.id}
                    className="flex-1 min-w-0"
                    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); startEditTab(tab.id, tab.name); }}
                    onContextMenu={(e) => openTabContextMenu(e, tab.id, "tab-trigger")}
                  >
                    {providerIconSrc ? (
                      <img
                        src={providerIconSrc}
                        className="mr-1.5 h-3.5 w-3.5 shrink-0 object-contain"
                        alt={tab.providerId}
                      />
                    ) : (
                      <TerminalSquare className="mr-1.5 h-3.5 w-3.5 text-[var(--cf-text-secondary)] group-data-[state=active]/tab:text-[var(--cf-text-primary)]" />
                    )}
                    {editingTabId === tab.id ? (
                      <input
                        id={`tab-input-${tab.id}`}
                        ref={(el) => { editInputRef.current = el; }}
                        onFocus={(e) => { try { (e.target as HTMLInputElement).select(); } catch {} }}
                        autoFocus
                        onMouseDown={(e) => { e.stopPropagation(); }}
                        style={{ width: renameWidth ? `${renameWidth}px` : undefined }}
                        className="bg-transparent outline-none text-xs"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => {
                          const projKey = selectedProjectId;
                          const newName = String(renameDraft || tab.name).trim();
                          setTabsByProject((m) => {
                            const list = (m[projKey] || []).map((x) => x.id === tab.id ? { ...x, name: newName } : x);
                            return { ...m, [projKey]: list };
                          });
                          setEditingTabId(null);
                          setRenameWidth(null);
                          if (activeTabId === tab.id) scheduleFocusForTab(tab.id, { immediate: true, allowDuringRename: true });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const projKey = selectedProjectId;
                            const newName = String(renameDraft || tab.name).trim();
                            setTabsByProject((m) => {
                              const list = (m[projKey] || []).map((x) => x.id === tab.id ? { ...x, name: newName } : x);
                              return { ...m, [projKey]: list };
                            });
                            setEditingTabId(null);
                            setRenameWidth(null);
                            if (activeTabId === tab.id) scheduleFocusForTab(tab.id, { immediate: true, allowDuringRename: true });
                          } else if (e.key === 'Escape') {
                            setEditingTabId(null);
                            setRenameWidth(null);
                            if (activeTabId === tab.id) scheduleFocusForTab(tab.id, { immediate: true, allowDuringRename: true });
                          }
                        }}
                      />
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-1">
                        <span id={`tab-label-${tab.id}`} className="truncate max-w-[8rem]">{tab.name}</span>
                        {hasPending ? (
                          <span
                            className="inline-flex h-2 w-2 rounded-full bg-red-500 dark:bg-[var(--cf-red)] dark:shadow-sm"
                            title={t('common:notifications.openTabHint', '点击查看详情') as string}
                          ></span>
                        ) : null}
                      </span>
                    )}
                  </TabsTrigger>
                  <button
                    type="button"
                    aria-label={closeTabLabel}
                    title={closeTabLabel}
                    className={`pointer-events-auto absolute right-1 top-1/2 inline-flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full border border-transparent text-[var(--cf-text-secondary)] transition-all duration-apple ease-apple opacity-0 scale-90 group-hover/tab:opacity-100 group-hover/tab:scale-100 group-focus-within/tab:opacity-100 group-focus-within/tab:scale-100 hover:bg-[var(--cf-tab-pill-hover)] hover:text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-app-bg)] ${isActiveTab ? 'opacity-100 scale-100 bg-[var(--cf-tab-pill-hover)] text-[var(--cf-text-primary)]' : ''}`}
                    onMouseDown={(e) => { e.stopPropagation(); }}
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
                {/* Tabs 区右侧的紧凑新建按钮 */}
                <div className="flex items-center pl-2">
                  <Button variant="default" size="icon" className="p-0" onClick={openNewConsole} title={t('terminal:newConsole') as string} style={{ height: 24, width: 24, borderRadius: 12, padding: 0 }}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </TabsList>
        </div>
          {tabs.map((tab) => {
            const isInputFullscreen = !!inputFullscreenByTab[tab.id];
            const isInputClosing = !!inputFullscreenClosingTabs[tab.id];
            const showFullscreenInput = isInputFullscreen || isInputClosing;
            const fullscreenState = isInputClosing ? "closing" : "open";
            const inputPlaceholder = t('terminal:inputPlaceholder') as string;
            const sendLabel = t('terminal:send') as string;
            const expandLabel = isInputFullscreen ? (t('terminal:collapseInput') as string) : (t('terminal:expandInput') as string);

            return (
              <TabsContent
                key={tab.id}
                value={tab.id}
                className="mt-1 flex flex-1 min-h-0 flex-col space-y-1"
                onContextMenu={(e: React.MouseEvent) => openTabContextMenu(e, tab.id, "tab-content")}
              >
                <Card className="flex flex-1 min-h-0 flex-col">
                  <CardContent className="relative flex flex-1 min-h-0 flex-col p-0">
                    <div className={`relative flex-1 min-h-0 transition-opacity ${isInputFullscreen ? 'pointer-events-none select-none opacity-35' : ''}`}>
                      <TerminalView
                        logs={tab.logs}
                        tabId={tab.id}
                        ptyId={ptyByTab[tab.id]}
                        attachTerminal={attachTerminal}
                        onContextMenuDebug={(event) => openTabContextMenu(event, tab.id, "terminal-body")}
                        theme={terminalThemeDef}
                      />
                    </div>

                    {showFullscreenInput ? (
                      <div
                        data-state={fullscreenState}
                        className={`absolute inset-0 z-20 flex flex-col rounded-none overflow-hidden p-0 backdrop-blur-apple shadow-apple-xl transition-all bg-transparent ${isInputClosing ? 'pointer-events-none' : 'pointer-events-auto'} animate-[cfFullscreenOverlayEnter_260ms_cubic-bezier(0.4,0,0.2,1)_both] data-[state=closing]:animate-[cfFullscreenOverlayExit_220ms_cubic-bezier(0.4,0,0.2,1)_forwards]`}
                      >
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/95 via-white/90 to-white/85 dark:from-slate-900/95 dark:via-slate-900/92 dark:to-slate-900/88"
                        ></div>
                        <div className="relative z-10 flex flex-1 p-1">
                          <div
                            data-state={fullscreenState}
                          className="relative flex flex-1 flex-col rounded-[26px] bg-[var(--cf-surface-solid)] shadow-apple-lg animate-[cfFullscreenPanelEnter_260ms_cubic-bezier(0.4,0,0.2,1)_both] data-[state=closing]:animate-[cfFullscreenPanelExit_220ms_cubic-bezier(0.4,0,0.2,1)_forwards]"
                          >
                            <PathChipsInput
                              placeholder={inputPlaceholder}
                              chips={chipsByTab[tab.id] || []}
                              onChipsChange={(next) => setChipsByTab((m) => ({ ...m, [tab.id]: next }))}
                              draft={draftByTab[tab.id] || ""}
                              onDraftChange={(v) => setDraftByTab((m) => ({ ...m, [tab.id]: v }))}
                              winRoot={selectedProject?.winPath}
                              projectWslRoot={selectedProject?.wslPath}
                              projectName={selectedProject?.name}
                              projectPathStyle={projectPathStyle}
                              warnOutsideProjectDrop={dragDropWarnOutsideProject}
                              onWarnOutsideProjectDropChange={updateWarnOutsideProjectDrop}
                              runEnv={terminalMode}
                              multiline
                              onKeyDown={(e: any) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { sendCommand(); e.preventDefault(); } }}
                              className="flex flex-1 flex-col min-h-[24rem] overflow-auto h-full"
                              balancedScrollbarGutter
                              draftInputClassName="flex-1 min-h-[18rem]"
                            />
                            <div className="pointer-events-auto absolute right-2 bottom-2 flex flex-row gap-2">
                              <Button
                                size="icon"
                                aria-label={sendLabel}
                                title={sendLabel}
                                onClick={sendCommand}
                                className="h-8 w-8 rounded-full shadow-sm"
                              >
                                <Send className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="secondary"
                                size="icon"
                                aria-label={expandLabel}
                                title={expandLabel}
                                onClick={() => toggleInputFullscreen(tab.id)}
                                className="h-8 w-8 rounded-full shadow-sm"
                              >
                                <Minimize2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {!isInputFullscreen ? (
                      <div className="mt-3 w-full">
                        <div className="relative w-full">
                          <PathChipsInput
                            placeholder={inputPlaceholder}
                            chips={chipsByTab[tab.id] || []}
                            onChipsChange={(next) => setChipsByTab((m) => ({ ...m, [tab.id]: next }))}
                            draft={draftByTab[tab.id] || ""}
                            onDraftChange={(v) => setDraftByTab((m) => ({ ...m, [tab.id]: v }))}
                            winRoot={selectedProject?.winPath}
                            projectWslRoot={selectedProject?.wslPath}
                            projectName={selectedProject?.name}
                            projectPathStyle={projectPathStyle}
                            warnOutsideProjectDrop={dragDropWarnOutsideProject}
                            onWarnOutsideProjectDropChange={updateWarnOutsideProjectDrop}
                            runEnv={terminalMode}
                            multiline
                            onKeyDown={(e: any) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { sendCommand(); e.preventDefault(); } }}
                            className=""
                          />

                          <div className="absolute right-2 bottom-2 flex flex-row gap-2">
                            <Button
                              size="icon"
                              aria-label={sendLabel}
                              title={sendLabel}
                              onClick={sendCommand}
                              className="h-8 w-8 rounded-full shadow-sm"
                            >
                              <Send className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="secondary"
                              size="icon"
                              aria-label={expandLabel}
                              title={expandLabel}
                              onClick={() => toggleInputFullscreen(tab.id)}
                              className="h-8 w-8 rounded-full shadow-sm"
                            >
                              <Maximize2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </TabsContent>
            );
          })}
      </Tabs>
    </div>
  );

	  const findSessionForFile = (filePath?: string): HistorySession | undefined => {
	    if (!filePath) return undefined;
	    const direct = historySessions.find((x) => x.filePath === filePath);
	    if (direct) return direct;
	    return historySessions.find((x) => x.id === filePath);
	  };

	  /**
	   * 从历史会话中解析出稳定的 ProviderId（避免脏数据导致分支异常）。
	   */
	  const resolveHistoryProviderId = (session?: HistorySession | null): HistorySession["providerId"] => {
	    const id = session?.providerId;
	    if (id === "claude" || id === "gemini" || id === "codex") return id;
	    return "codex";
	  };

	  /**
	   * 获取“继续对话”应使用的执行环境：始终以该会话所属 Provider 的记忆环境为准。
	   * 说明：这里不读取当前 activeProviderId / terminalMode，避免切换引擎后误用环境。
	   */
	  const resolveResumeEnv = (filePath?: string, preferredSession?: HistorySession | null): { session?: HistorySession; providerId: HistorySession["providerId"]; env: Required<ProviderEnv> } => {
	    const session = preferredSession ?? findSessionForFile(filePath);
	    const providerId = resolveHistoryProviderId(session ?? null);
	    return { session: session ?? undefined, providerId, env: getProviderEnv(providerId) };
	  };

	  /**
	   * 获取“继续对话（外部）”按钮显示用的环境文案（保证与实际执行环境一致）。
	   */
	  const resolveResumeShellLabel = (filePath?: string, preferredSession?: HistorySession | null): ShellLabel => {
	    const { env } = resolveResumeEnv(filePath, preferredSession);
	    return toShellLabel(env.terminal as any);
	  };

	  /**
	   * 构造“继续对话”的启动命令（按 provider 分流）。
	   * - Codex：优先 resume <id>，失败回退 experimental_resume
	   * - Claude：优先 --resume <sessionId>，失败回退 --continue
	   * - Gemini：优先 --resume <sessionId>，缺失则 --resume latest
	   */
	  const buildResumeStartup = (filePath: string, mode: TerminalMode, options?: { forceLegacyCli?: boolean }): ResumeStartup => {
	    const session = findSessionForFile(filePath);
	    const providerId = resolveHistoryProviderId(session ?? null);

	    // ---- Claude ----
	    if (providerId === "claude") {
      const baseName = (() => {
        try {
          const raw = String(filePath || "").replace(/\\/g, "/");
          const last = raw.split("/").pop() || "";
          const noExt = last.replace(/\.(jsonl|ndjson)$/i, "");
          return noExt.trim();
        } catch {
          return "";
        }
      })();
      const sessionId = String(session?.resumeId || baseName || "").trim() || null;
      const providerCmd = resolveProvider(providerItemById["claude"] ?? { id: "claude" }).startupCmd || "claude";
      const startupCmd = buildClaudeResumeStartupCmd({ cmd: providerCmd, terminalMode: mode, sessionId });
      return { providerId: "claude", startupCmd, session, resumeLabel: sessionId || "continue" };
    }

    // ---- Gemini ----
    if (providerId === "gemini") {
      const sessionId = String(session?.resumeId || "").trim() || null;
      const providerCmd = resolveProvider(providerItemById["gemini"] ?? { id: "gemini" }).startupCmd || "gemini";
      const startupCmd = buildGeminiResumeStartupCmd({ cmd: providerCmd, terminalMode: mode, sessionId });
      return { providerId: "gemini", startupCmd, session, resumeLabel: sessionId || "latest" };
    }

    // ---- Codex ----
    const preferredId = typeof session?.resumeId === 'string' ? session.resumeId : null;
    const guessedId = inferSessionUuid(session, filePath);
    const resumeSessionId = [preferredId, guessedId].find((v) => isUuidLike(v)) || null;
    const resumeModeHintRaw: 'modern' | 'legacy' | 'unknown' = session?.resumeMode || 'unknown';
    const resumeModeHint: 'modern' | 'legacy' = resumeModeHintRaw === 'modern' ? 'modern' : 'legacy';
	    const forceLegacyCli = !!options?.forceLegacyCli;
	    const preferLegacyOnly = forceLegacyCli || resumeModeHint === 'legacy';
	    const cmdRaw = String(codexCmd || 'codex').trim();
	    const baseCmd = cmdRaw.length > 0 ? cmdRaw : 'codex';
	    const injectTrace = (cmd: string | null | undefined) => injectCodexTraceEnv({ cmd, traceEnabled: codexTraceEnabled, terminalMode: mode });
	    if (isWindowsLike(mode)) {
	      const resumePath = toWindowsResumePath(filePath);
	      if (forceLegacyCli) {
	        const escapedResume = resumePath.replace(/"/g, '\"');
	        const startupCmd = `npx --yes @openai/codex@0.31.0 -c experimental_resume="${escapedResume}"`;
        return { providerId: "codex", startupCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy: 'force-legacy-cli', resumeHint: 'legacy', forceLegacyCli: true };
      }
	      const resumeArg = `experimental_resume="${resumePath.replace(/"/g, '\\"')}"`;
	      const baseArgv = splitCommandLineToArgv(baseCmd);
	      const base = baseArgv.length > 0 ? baseArgv : ["codex"];
	      const fallbackCall = buildPowerShellCall([...base, "-c", resumeArg]);
	      const fallbackCmd = injectTrace(fallbackCall);
	      if (!preferLegacyOnly && resumeSessionId) {
	        const resumeCall = buildPowerShellCall([...base, "resume", resumeSessionId]);
	        const resumeCmd = injectTrace(resumeCall);
	        const startupCmd = `${resumeCmd}; if ($LASTEXITCODE -ne 0) { ${fallbackCmd} }`;
	        return { providerId: "codex", startupCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy: 'resume+fallback', resumeHint: resumeModeHint, forceLegacyCli: false };
	      }
      const strategy = preferLegacyOnly ? 'legacy-only' : 'experimental_resume';
      return { providerId: "codex", startupCmd: fallbackCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy, resumeHint: resumeModeHint, forceLegacyCli: false };
	    }
	    const resumePath = toWSLForInsert(filePath);
	    if (forceLegacyCli) {
	      const escapedResume = resumePath.replace(/"/g, '\"');
	      const startupCmd = injectTrace(`npx --yes @openai/codex@0.31.0 -c experimental_resume=\"${escapedResume}\"`);
	      return { providerId: "codex", startupCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy: 'force-legacy-cli', resumeHint: 'legacy', forceLegacyCli: true };
	    }
	    const fallbackCmd = injectTrace(`${baseCmd} -c experimental_resume="${resumePath}"`);
	    if (!preferLegacyOnly && resumeSessionId) {
	      const resumeCmd = injectTrace(`${baseCmd} resume ${resumeSessionId}`);
	      // 避免使用 `if ...; then ...; else ...; fi`（包含分号），以兼容 Windows Terminal `wt.exe` 的参数解析。
	      const startupCmd = `${resumeCmd} || ${fallbackCmd}`;
	      return { providerId: "codex", startupCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy: 'resume+fallback', resumeHint: resumeModeHint, forceLegacyCli: false };
	    }
	    const strategy = preferLegacyOnly ? 'legacy-only' : 'experimental_resume';
	    return { providerId: "codex", startupCmd: fallbackCmd, session, resumeLabel: resumePath, sessionId: resumeSessionId, strategy, resumeHint: resumeModeHint, forceLegacyCli: false };
	  };

  const isLegacyHistory = (filePath?: string): boolean => {
    if (!filePath) return false;
    const session = findSessionForFile(filePath);
	    return (session?.resumeMode || 'unknown') === 'legacy';
	  };

	  /**
	   * 执行“继续对话”。注意：执行环境必须由调用方显式传入（通常来自会话所属 Provider 的记忆环境）。
	   */
	  const executeResume = async (filePath: string, mode: ResumeExecutionMode, execEnv: Required<ProviderEnv>, forceLegacyCli: boolean): Promise<boolean> => {
	    try {
	      if (!filePath || !selectedProject) return false;
	      const { providerId, startupCmd, session, sessionId, resumeLabel, strategy, resumeHint, forceLegacyCli: finalForceLegacy } = buildResumeStartup(filePath, execEnv.terminal as any, { forceLegacyCli });
	      try {
	        const base = `[ui] history.resume ${mode} provider=${providerId} terminal=${execEnv.terminal} target=${resumeLabel}`;
	        const extra = providerId === "codex"
	          ? ` strategy=${strategy} resumeHint=${resumeHint} forceLegacy=${finalForceLegacy ? '1' : '0'} sessionId=${sessionId || 'none'} sessionRaw=${session?.id || 'n/a'}`
	          : ` sessionRaw=${session?.id || 'n/a'}`;
	        await (window as any).host?.utils?.perfLog?.(`${base}${extra}`);
	      } catch {}
	      if (mode === 'internal') {
	        const tabName = isWindowsLike(execEnv.terminal as any)
	          ? toShellLabel(execEnv.terminal as any)
	          : (execEnv.distro || `Console ${((tabsByProject[selectedProject.id] || []).length + 1).toString()}`);
        const tab: ConsoleTab = {
          id: uid(),
          name: String(tabName),
          providerId,
          logs: [],
          createdAt: Date.now(),
        };
        const notifyEnv = buildGeminiNotifyEnv(tab.id, tab.providerId, tab.name);
        let ptyId: string | undefined;
        try {
          await (window as any).host?.utils?.perfLog?.(`[ui] history.resume openWSLConsole start tab=${tab.id}`);
        } catch {}
	        try {
          const { id } = await window.host.pty.openWSLConsole({
            terminal: execEnv.terminal as any,
            distro: execEnv.distro,
            wslPath: selectedProject.wslPath,
            winPath: selectedProject.winPath,
            cols: 80,
            rows: 24,
            startupCmd,
            env: notifyEnv,
          });
          try {
            await (window as any).host?.utils?.perfLog?.(`[ui] history.resume pty=${id} tab=${tab.id} - registering listener`);
          } catch {}
          ptyId = id;
        } catch (err) {
          console.warn('executeResume failed', err);
          alert(String(t('history:resumeFailed', { error: String((err as any)?.message || err) })));
          return false;
        }
        registerTabProject(tab.id, selectedProject.id);
        setTabsByProject((m) => ({ ...m, [selectedProject.id]: [...(m[selectedProject.id] || []), tab] }));
        setActiveTab(tab.id, { focusMode: 'immediate', allowDuringRename: true, delay: 0 });
        try {
          setCenterMode('console');
          requestAnimationFrame(() => {
            try { scheduleFocusForTab(tab.id, { immediate: true, allowDuringRename: true }); } catch {}
          });
        } catch {}
        if (ptyId) {
          ptyByTabRef.current[tab.id] = ptyId;
          setPtyByTab((m) => ({ ...m, [tab.id]: ptyId }));
          ptyAliveRef.current[tab.id] = true;
          setPtyAlive((m) => ({ ...m, [tab.id]: true }));
          registerPtyForTab(tab.id, ptyId);
          try {
            await (window as any).host?.utils?.perfLog?.(`[ui] history.resume pty=${ptyId} tab=${tab.id} - listener registered`);
          } catch {}
          try { tm.setPty(tab.id, ptyId); } catch (err) { console.warn('tm.setPty failed', err); }
        }
        try { window.host.projects.touch(selectedProject.id); } catch {}
        // 内存也更新最近使用时间，并抑制历史面板自动切换
        markProjectUsed(selectedProject.id);
        return true;
	      }
	      const res: any = await (window.host.utils as any).openExternalConsole({
	        terminal: execEnv.terminal,
	        wslPath: selectedProject.wslPath,
	        winPath: selectedProject.winPath,
	        distro: execEnv.distro,
	        startupCmd,
	        title: getProviderLabel(providerId),
	      });
	      if (!(res && res.ok)) throw new Error(res?.error || 'failed');
      return true;
    } catch (err) {
      console.warn('executeResume failed', err);
      try {
        await (window as any).host?.utils?.perfLog?.(`[ui] history.resume ${mode} error ${String((err as any)?.stack || err)}`);
      } catch {}
      alert(String(t('history:resumeFailed', { error: String((err as any)?.message || err) })));
      return false;
    }
	  };

	  const requestResume = async (filePath?: string, mode: ResumeExecutionMode = 'internal', options?: { skipPrompt?: boolean; forceLegacyCli?: boolean }): Promise<'prompt' | 'ok' | 'blocked-shell' | 'error'> => {
	    if (!filePath) return 'error';
	    const { session, env } = resolveResumeEnv(filePath);
	    const sessionMode = session?.resumeMode || 'unknown';
	    const enforceShell = sessionMode !== 'legacy' && !options?.forceLegacyCli;
	    if (enforceShell) {
	      const sessionShell = session?.runtimeShell === 'windows' ? 'windows' : (session?.runtimeShell === 'wsl' ? 'wsl' : null);
	      if (sessionShell) {
	        const mismatch = sessionShell === 'wsl' ? env.terminal !== 'wsl' : !isWindowsLike(env.terminal as any);
	        if (mismatch) {
	          const expected = toShellLabel(sessionShell === 'wsl' ? 'wsl' : 'windows');
	          const current = toShellLabel(env.terminal as any);
	          setBlockingNotice({ type: 'shell-mismatch', expected, current });
	          return 'blocked-shell';
	        }
	      }
	    }
    const needPrompt = !options?.forceLegacyCli && !options?.skipPrompt && isLegacyHistory(filePath);
    if (needPrompt) {
      setLegacyResumePrompt({ filePath, mode });
      return 'prompt';
	    }
	    const useLegacy = !!options?.forceLegacyCli || isLegacyHistory(filePath);
	    const ok = await executeResume(filePath, mode, env, useLegacy);
	    return ok ? 'ok' : 'error';
	  };

  const cancelLegacyResume = () => {
    if (legacyResumeLoading) return;
    setLegacyResumePrompt(null);
  };

  const confirmLegacyResume = async () => {
    if (!legacyResumePrompt || legacyResumeLoading) return;
    const payload = legacyResumePrompt;
    setLegacyResumeLoading(true);
    try {
      const status = await requestResume(payload.filePath, payload.mode, { skipPrompt: true, forceLegacyCli: true });
      if (status === 'blocked-shell') return;
	      if (status === 'error') {
	        if (payload.mode === 'external') {
	          const env = resolveResumeShellLabel(payload.filePath);
	          setBlockingNotice({ type: 'external-console', env });
	        } else {
	          console.warn('legacy resume failed');
	        }
      }
    } finally {
      setLegacyResumeLoading(false);
      setLegacyResumePrompt(null);
    }
  };

  const timelineGroups = useMemo<HistoryTimelineGroup[]>(() => {
    const baseNow = historyNow;
    const mp = new Map<string, HistoryTimelineGroup>();
    const labelOf = (bucket: HistoryTimelineBucket, anchor: Date | null, count: number): string => {
      switch (bucket) {
        case 'today':
          return t('history:groupToday') as string;
        case 'yesterday':
          return t('history:groupYesterday') as string;
        case 'last7':
          return t('history:groupLast7Days') as string;
        case 'month': {
          const ref = anchor || baseNow;
          const monthText = monthFormatter.format(ref);
          return t('history:groupEarlierInMonth', { month: monthText, year: ref.getFullYear(), count }) as string;
        }
        default:
          return t('history:groupUnknown') as string;
      }
    };
    for (const s of historySessions) {
      const meta = resolveHistoryTimelineMeta(s, baseNow);
      const key = meta.key;
      const group =
        mp.get(key) ||
        { key, label: '', bucket: meta.bucket, anchor: meta.anchor || null, latest: Number.NEGATIVE_INFINITY, sessions: [], latestTitle: undefined, latestRaw: undefined };
      group.anchor = group.anchor || meta.anchor || null;
      group.sessions.push(s);
      const anchor = historySessionDate(s);
      let ts = 0;
      if (anchor && !isNaN(anchor.getTime())) ts = anchor.getTime();
      else if (s.date) {
        const iso = new Date(s.date);
        if (!isNaN(iso.getTime())) ts = iso.getTime();
      }
      if (ts >= group.latest) {
        group.latest = ts;
        group.latestTitle = s.title;
        group.latestRaw = (s.rawDate ? String(s.rawDate) : String(s.date));
      }
      mp.set(key, group);
    }
    const sorted = Array.from(mp.values()).sort((a, b) => b.latest - a.latest);
    for (const g of sorted) {
      g.label = labelOf(g.bucket, g.anchor, g.sessions.length);
      g.sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }
    return sorted;
  }, [historySessions, todayKey, monthFormatter, t, historyNow]);

  const filteredTimelineGroups = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return timelineGroups;
    return timelineGroups.filter((g) => {
      if ((g.label || '').toLowerCase().includes(q)) return true;
      if ((g.latestTitle || '').toLowerCase().includes(q)) return true;
      return g.sessions.some((s) => sessionMatchesQuery(s, q));
    });
  }, [timelineGroups, historyQuery, sessionMatchesQuery]);

  const HistorySidebar = (
    <div className="grid h-full min-w-[240px] grid-rows-[auto_auto_auto_1fr] min-h-0 border-l bg-white/70 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/60">
      {/* Header with enhanced modern styling */}
      <div className="flex items-center justify-between px-3 pt-3 pb-5 border-b border-slate-100 dark:border-slate-700/50">
        <div className="flex items-center gap-2 font-medium shrink-0">
          <HistoryIcon className="h-4 w-4" /> {t('history:panelTitle')}
        </div>
      </div>
      
      {/* Enhanced search with original design */}
      <div className="px-3 py-2">
        <Input
          value={historyQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setHistoryQuery((e.target as any).value)}
          placeholder={t('history:searchPlaceholder') as string}
          title={t('history:searchPlaceholderHint') as string}
          className="h-9"
          data-cf-hover-shortcuts-ignore="true"
          onKeyDown={(e: React.KeyboardEvent<any>) => {
            if (e.key === 'Enter') {
              const q = historyQuery.trim().toLowerCase();
              if (!q) return;
              const first = historySessions
                .filter((s) => sessionMatchesQuery(s, q))
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
              if (first) {
                const key = historyTimelineGroupKey(first, new Date());
                setSelectedHistoryDir(key);
                setSelectedHistoryId(first.id);
                setCenterMode('history');
              }
            }
          }}
        />
      </div>
      <ScrollArea className="history-scroll-area h-full min-h-0 px-2 pb-2">
        <div className="space-y-1 pt-2">
          {filteredTimelineGroups.map((g) => {
            const inGroup = g.sessions;
            const q = historyQuery.trim().toLowerCase();
            const match = q ? inGroup.find((s) => sessionMatchesQuery(s, q)) : null;
            const target = match || inGroup[0] || null;
            const latestLabel = (() => {
              if (!target) return '';
              const candidate = target.filePath || '';
              const byName = parseDateFromFilename(candidate);
              if (byName) return formatAsLocal(byName);
              const fromRaw = parseRawDate(target.rawDate);
              if (fromRaw) return formatAsLocal(fromRaw);
              if (target.date) {
                const dt = new Date(target.date);
                if (!isNaN(dt.getTime())) return formatAsLocal(dt);
              }
              return timeFromFilename(candidate);
            })();
            const defaultExpanded = (!!q && !!match) || selectedHistoryDir === g.key;
            const expanded = (expandedGroups[g.key] ?? defaultExpanded);
            const displayList = q ? inGroup.filter((s) => sessionMatchesQuery(s, q)) : inGroup;
            const isSelectedGroup = selectedHistoryDir === g.key;
            const groupShellClass = `rounded-xl bg-transparent overflow-hidden`;
            const headerButtonClass = `group sticky -top-1 z-20 flex items-center gap-2 px-2 py-1.5 w-full text-left border border-transparent outline-none focus:outline-none transition-colors ${
              isSelectedGroup
                ? 'bg-slate-100 border-slate-200/60 text-[var(--cf-text-primary)] font-medium dark:bg-slate-800/80 dark:border-slate-700 dark:text-[var(--cf-text-primary)]'
                : 'bg-transparent text-[var(--cf-text-secondary)] hover:bg-slate-100 hover:border-slate-200/40 dark:hover:bg-slate-800/60 dark:hover:border-slate-600/30'
            } rounded-lg`;

            return (
              <div key={g.key} className={groupShellClass}>
                <button
                  className={headerButtonClass}
                  onClick={() => {
                    setExpandedGroups((m) => ({ ...m, [g.key]: !expanded }));
                  }}
                >
                  <div
                    className="h-5 w-5 flex items-center justify-center rounded hover:bg-slate-200/50 dark:hover:bg-slate-700/50 shrink-0"
                    aria-label={expanded ? (t('history:collapse') as string) : (t('history:expand') as string)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedGroups((m) => ({ ...m, [g.key]: !expanded }));
                    }}
                  >
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium max-w-full truncate" title={g.label}>
                      {clampText(g.label, HISTORY_TITLE_MAX_CHARS)}
                    </div>
                    <div className="mt-0 max-w-full truncate text-[11px] text-slate-500" title={g.latestRaw || latestLabel}>{latestLabel}</div>
                  </div>
                  
                </button>
                {expanded && displayList.length > 0 && (
                  <div className="pb-1 pl-2 pr-2 space-y-0.5 mt-0.5">
                    {displayList.map((s) => {
                      const anchor = historySessionDate(s);
                      const absoluteLabel = anchor ? formatAsLocal(anchor) : timeFromFilename(s.filePath);
                      const active = selectedHistoryId === s.id;
                      const previewSource = sessionPreviewMap[s.filePath || s.id] || s.preview || s.title || s.filePath || '';
                      const providerIconSrc = getProviderIconSrc(s.providerId, providerItemById, themeMode);
                      const relativeLabel = describeRelativeAge(anchor, historyNow) || '--';
                      const tooltip = [absoluteLabel, previewSource].filter(Boolean).join('  ');
                      const itemClass = `block w-full rounded px-2 py-0.5 text-left text-xs border outline-none focus:outline-none ${
                        active
                          ? 'bg-slate-200 border-slate-300 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-100'
                          : 'bg-transparent border-transparent text-slate-800 dark:text-slate-200 hover:bg-slate-100 hover:border-slate-200 dark:hover:bg-slate-900/40 dark:hover:border-slate-700'
                      }`;

                      return (
                        <button
                          key={s.filePath || s.id}
                          data-cf-history-row-id={s.id}
                          data-cf-history-group-key={g.key}
                          onClick={() => { setSelectedHistoryDir(g.key); setSelectedHistoryId(s.id); setCenterMode('history'); }}
                          onContextMenu={(e) => { e.preventDefault(); setHistoryCtxMenu({ show: true, x: e.clientX, y: e.clientY, item: s, groupKey: g.key }); }}
                          onMouseEnter={() => { hoveredHistoryShortcutRef.current = { item: s, groupKey: g.key }; }}
                          onMouseLeave={() => {
                            const cur = hoveredHistoryShortcutRef.current;
                            if (cur?.item?.id === s.id) hoveredHistoryShortcutRef.current = null;
                          }}
                          className={itemClass}
                          title={tooltip}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              {providerIconSrc ? <img src={providerIconSrc} className="h-3.5 w-3.5 shrink-0 opacity-90" alt={s.providerId} /> : null}
                              <span className={`text-sm leading-5 truncate ${active ? 'text-slate-900 dark:text-slate-50 font-medium' : 'text-slate-800 dark:text-slate-200'}`}>{previewSource || absoluteLabel || '--'}</span>
                            </div>
                            <span className={`shrink-0 text-[11px] ${active ? 'text-slate-600 dark:text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}>{relativeLabel}</span>
                          </div>
                        </button>
                      );
                    })}
                    {!q && inGroup.length > displayList.length && (
                      <div className="px-2 py-1 text-[11px] text-slate-500">{t('history:showing', { total: inGroup.length, count: displayList.length })}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {historySessions.length === 0 && !historyLoading && (
            <div className="px-4 py-8 text-center">
              <div className="mb-3 flex justify-center">
                <div className="p-3 rounded-xl bg-slate-100/60 dark:bg-slate-800/60">
                  <FileClock className="h-6 w-6 text-[var(--cf-text-muted)]" />
                </div>
              </div>
              <div className="text-sm text-[var(--cf-text-muted)] font-apple-medium">{t('history:empty')}</div>
            </div>
          )}
          {historySessions.length > 0 && historyQuery.trim().length > 0 && filteredTimelineGroups.length === 0 && (
            <div className="px-4 py-8 text-center">
              <div className="mb-3 flex justify-center">
                <div className="p-3 rounded-xl bg-slate-100/60 dark:bg-slate-800/60">
                  <Search className="h-6 w-6 text-[var(--cf-text-muted)]" />
                </div>
              </div>
              <div className="text-sm text-[var(--cf-text-muted)] font-apple-medium">{t('history:noMatch')}</div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 退出确认弹窗（优化版：简洁自然） */}
      <Dialog
        open={quitConfirm.open}
        onOpenChange={(open) => {
          if (!open) {
            void respondQuitConfirm(false);
            try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
            try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
            return;
          }
          setQuitConfirm((prev) => ({ ...prev, open: true }));
        }}
      >
        <DialogContent className="max-w-[400px] p-6 border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-2xl sm:rounded-xl">
          <div className="flex flex-col gap-5">
            <div className="flex gap-4 items-start">
              <TriangleAlert className="h-6 w-6 text-[var(--cf-yellow)] mt-0.5 shrink-0" />
              <div className="flex-1">
                <DialogTitle className="text-lg font-semibold leading-none mb-2">
                  {t("common:quitConfirm.title")}
                </DialogTitle>
                <div className="text-sm text-[var(--cf-text-muted)] space-y-1">
                  <p className="leading-normal">{t("common:quitConfirm.message", { count: quitConfirm.count })}</p>
                  <p className="text-xs opacity-70 leading-normal">{t("common:quitConfirm.detail")}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 mt-1">
              <Button variant="outline" className="h-9 px-4 min-w-[80px]" onClick={() => { void respondQuitConfirm(false); }}>
                {t("common:cancel")}
              </Button>
              <Button variant="danger" className="h-9 px-4 min-w-[80px]" onClick={() => { void respondQuitConfirm(true); }}>
                {t("common:quitConfirm.quit")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 历史删除确认弹窗（非阻塞） */}
      <Dialog open={confirmDelete.open} onOpenChange={(v) => {
        setConfirmDelete((m) => ({ ...m, open: v }));
        if (!v) {
          try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
          try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('settings:cleanupConfirm.title')}</DialogTitle>
            <DialogDescription>
              {t('history:confirmPermanentDelete')}
              {confirmDelete.item && (
                <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
                  <div className="font-semibold text-[var(--cf-text-primary)] mb-1 truncate">
                    {confirmDelete.item.title || t('history:untitledSessionTitle')}
                  </div>
                  {confirmDelete.item.preview && (
                    <div className="line-clamp-3 opacity-80 whitespace-pre-wrap font-mono text-[11px]">
                      {confirmDelete.item.preview}
                    </div>
                  )}
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmDelete((m) => ({ ...m, open: false }))}>{t('common:cancel')}</Button>
            <Button className="border border-red-200 text-red-600 hover:bg-red-50 dark:border-[var(--cf-red-light)] dark:text-[var(--cf-red)] dark:hover:bg-[var(--cf-red-light)]" variant="secondary" onClick={async () => {
              try {
                const it = confirmDelete.item; const fallbackKey = it ? historyTimelineGroupKey(it, new Date()) : HISTORY_UNKNOWN_GROUP_KEY;
                const key = confirmDelete.groupKey || fallbackKey;
                if (!it?.filePath) { setConfirmDelete((m) => ({ ...m, open: false })); return; }
                const res: any = await window.host.history.trash({ filePath: it.filePath });
                if (!(res && res.ok)) { alert(String(t('history:cannotDelete', { error: res && res.error ? res.error : 'unknown' }))); setConfirmDelete((m) => ({ ...m, open: false })); return; }
                setHistorySessions((cur) => {
                  const list = cur.filter((x) => (x.filePath || x.id) !== (it.filePath || it.id));
                  const projectKey = canonicalizePath((selectedProject?.wslPath || selectedProject?.winPath || selectedProject?.id || '') as string);
                  if (projectKey) historyCacheRef.current[projectKey] = list;
                  if (selectedHistoryId === it.id) {
                    const nowRef = new Date();
                    const keyOf = (item?: HistorySession) => historyTimelineGroupKey(item, nowRef);
                    const restInGroup = list
                      .filter((x) => keyOf(x) === key)
                      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                    if (restInGroup.length > 0) {
                      setSelectedHistoryId(restInGroup[0].id);
                    } else {
                      const groups = Array.from(new Set(list.map((x) => keyOf(x))));
                      const firstKey = groups[0] || null;
                      setSelectedHistoryDir(firstKey);
                      if (firstKey) {
                        const firstInDir = list
                          .filter((x) => keyOf(x) === firstKey)
                          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                        setSelectedHistoryId(firstInDir ? firstInDir.id : null);
                      } else {
                        setSelectedHistoryId(null);
                      }
                    }
                    setCenterMode('history');
                  }
                  return list;
                });
              } catch (err: any) {
                alert(String(t('history:deleteFailed', { error: String(err) })));
              } finally {
                setConfirmDelete((m) => ({ ...m, open: false }));
                // 释放可能残留的指针捕获
                try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
                try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
              }
            }}>
              <Trash2 className="mr-2 h-4 w-4" /> {t('settings:cleanupConfirm.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      
    </div>
  );

  return (
    <TooltipProvider>
      <div className={`grid h-screen min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden ${showHistoryPanel ? 'grid-cols-[222px_1fr_240px]' : 'grid-cols-[222px_1fr]'}`}>
        {Sidebar}
        <div className="grid h-full min-w-0 grid-rows-[auto_1fr] bg-white/60 min-h-0 overflow-hidden dark:bg-slate-900/40 dark:text-slate-100">
          {TopBar}
          {selectedProject ? (
            <div className="min-h-0 h-full">
              {centerMode === 'console' ? (
                ConsoleArea
              ) : (
                <HistoryDetail sessions={historySessions} selectedHistoryId={selectedHistoryId} onBack={() => {
                  dumpOverlayDiagnostics('onBack.enter');
                  // 返回控制台：先关闭任意可能遗留的全屏遮罩，避免拦截点击/键盘事件
                  try { setHistoryCtxMenu((m) => ({ ...m, show: false })); } catch {}
                  try { setProjectCtxMenu((m) => ({ ...m, show: false })); } catch {}
                  // 释放可能卡死的鼠标捕获：主动派发一次 mouseup/pointerup
                  try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
                  try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
                  // 切回控制台视图
                  setCenterMode('console');
                  // 下一帧主动刷新并聚焦活跃终端，修复可能的焦点丢失
                  try {
                    const id = activeTabId;
                    requestAnimationFrame(() => {
                      try { scheduleFocusForTab(id, { immediate: true, allowDuringRename: true }); } catch {}
                      try { (window as any).focus?.(); } catch {}
                      dumpOverlayDiagnostics('onBack.afterFocus');
                    });
                  } catch {}
	                }} onResume={(fp) => requestResume(fp, 'internal')} getResumeShellLabel={resolveResumeShellLabel} onResumeExternal={async (filePath?: string) => {
	                  try {
	                    if (!filePath || !selectedProject) return;
	                    const status = await requestResume(filePath, 'external');
	                    if (status === 'error') {
	                      const env = resolveResumeShellLabel(filePath);
	                      setBlockingNotice({ type: 'external-console', env });
	                    }
	                  } catch (e) {
	                    console.warn('resume external panel failed', e);
                  }
                }} />
              )}
            </div>
          ) : (
            <EmptyState onCreate={() => { try { openProjectPicker(); } catch {} }} />
          )}
        </div>
        {showHistoryPanel && HistorySidebar}
      </div>

      <div className="fixed right-4 top-3 z-40">
        <HistoryPanelToggleButton
          expanded={showHistoryPanel}
          label={String(showHistoryPanel ? t("history:hidePanel") : t("history:showPanel"))}
          onToggle={() => setShowHistoryPanel((v) => !v)}
        />
      </div>

      {historyCtxMenu.show && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setHistoryCtxMenu((m) => ({ ...m, show: false }))}
          onContextMenu={(e) => { e.preventDefault(); setHistoryCtxMenu((m) => ({ ...m, show: false })); }}
        >
          <div
            ref={historyCtxMenuRef}
            className="absolute z-50 min-w-[160px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple shadow-apple-lg p-1.5 text-sm text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg"
            style={{ left: historyCtxMenu.x, top: historyCtxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {historyCtxMenu.item?.filePath ? (
              <>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={async () => {
                    try {
                      const it = historyCtxMenu.item;
                      if (!it || !it.filePath || !selectedProject) { setHistoryCtxMenu((m) => ({ ...m, show: false })); return; }
                      await requestResume(it.filePath, 'internal');
                    } catch (err) {
                      console.warn('resume session failed', err);
                    }
                    setHistoryCtxMenu((m) => ({ ...m, show: false }));
                  }}
                >
                  {t('history:continueConversation')}
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={async () => {
                    try {
	                      const it = historyCtxMenu.item;
	                      if (!it || !it.filePath || !selectedProject) { setHistoryCtxMenu((m) => ({ ...m, show: false })); return; }
	                      const status = await requestResume(it.filePath, 'external');
	                      if (status === 'error') {
	                        const env = resolveResumeShellLabel(it.filePath, it);
	                        setBlockingNotice({ type: 'external-console', env });
	                      }
	                    } catch (e) {
	                      console.warn('resume external failed', e);
                    }
                    setHistoryCtxMenu((m) => ({ ...m, show: false }));
                  }}
	                >
	                  <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('history:continueExternalWith', { env: resolveResumeShellLabel(historyCtxMenu.item?.filePath, historyCtxMenu.item) })}
	                </button>
	              </>
	            ) : null}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
              onClick={async () => {
                const f = historyCtxMenu.item?.filePath;
                if (f) { try { await window.host.utils.copyText(f); } catch {} }
                setHistoryCtxMenu((m) => ({ ...m, show: false }));
              }}
            >
              <CopyIcon className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('history:copyPath')}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
              onClick={async () => {
                const f = historyCtxMenu.item?.filePath;
                if (f) {
                  try {
                    const res: any = await window.host.utils.showInFolder(f);
                    if (!(res && res.ok)) throw new Error(res?.error || 'failed');
                  } catch (e) { alert(String(t('history:cannotOpenContaining'))); }
                }
                setHistoryCtxMenu((m) => ({ ...m, show: false }));
              }}
            >
              <FolderOpen className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('history:openContaining')}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
              onClick={async () => {
                const f = historyCtxMenu.item?.filePath;
                if (f) {
                  try {
                    const res: any = await window.host.utils.openPath(f);
                    if (!(res && res.ok)) throw new Error(res?.error || 'failed');
                  } catch (e) { alert(String(t('history:cannotOpenDefault'))); }
                }
                setHistoryCtxMenu((m) => ({ ...m, show: false }));
              }}
            >
              <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('history:openWithDefault')}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-red)] rounded-apple-sm hover:bg-[var(--cf-red-light)] transition-all duration-apple-fast"
              onClick={() => {
                const it = historyCtxMenu.item;
                const key = historyCtxMenu.groupKey || (it ? historyTimelineGroupKey(it, new Date()) : HISTORY_UNKNOWN_GROUP_KEY);
                if (!it?.filePath) { setHistoryCtxMenu((m) => ({ ...m, show: false })); return; }
                openHistoryDeleteConfirm(it, key);
              }}
            >
              <Trash2 className="h-4 w-4" /> {t('history:deleteToTrash')} (D)
            </button>
          </div>
        </div>
      )}

      {/* 全局项目右键菜单：与历史面板解耦，避免被隐藏 */}
      {projectCtxMenu.show && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setProjectCtxMenu((m) => ({ ...m, show: false }))}
          onContextMenu={(e) => { e.preventDefault(); setProjectCtxMenu((m) => ({ ...m, show: false })); }}
        >
          {(function renderProjectMenu() {
            const menuItems: JSX.Element[] = [];
            const proj = projectCtxMenu.project;
            const projGit = proj ? gitInfoByProjectId[proj.id] : undefined;
            const dirExists = proj ? (projGit ? !!(projGit.exists && projGit.isDirectory) : true) : false;
            const dirRequiredBtnCls = "disabled:opacity-50 disabled:pointer-events-none";
            menuItems.push(
              <button
                key="show-in-explorer"
                disabled={!dirExists}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast ${dirRequiredBtnCls}`}
                onClick={async () => {
                  if (proj) {
                    try {
                      const res: any = await window.host.utils.showInFolder(proj.winPath);
                      if (!(res && res.ok)) throw new Error(res?.error || 'failed');
                    } catch (e) { alert(String(t('history:cannotOpenContaining'))); }
                  }
                  setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                }}
              >
                <FolderOpen className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxShowInExplorer')}
              </button>
            );
            menuItems.push(
              <button
                key="open-git-tool"
                disabled={!dirExists}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast ${dirRequiredBtnCls}`}
                onClick={async () => {
                  if (proj) {
                    try { await (window as any).host?.gitWorktree?.openExternalTool?.(proj.winPath); } catch {}
                  }
                  setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                }}
              >
                <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t("projects:ctxOpenExternalGitTool", "在外部 Git 工具中打开") as string}
              </button>
            );
            menuItems.push(
              <button
                key="open-git-terminal"
                disabled={!dirExists}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast ${dirRequiredBtnCls}`}
                onClick={async () => {
                  if (proj) {
                    try { await (window as any).host?.gitWorktree?.openTerminal?.(proj.winPath); } catch {}
                  }
                  setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                }}
              >
                <TerminalSquare className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t("projects:ctxOpenGitTerminal", "在外部终端 / Git Bash 打开") as string}
              </button>
            );
            menuItems.push(
              <button
                key="open-external"
                disabled={!dirExists}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast ${dirRequiredBtnCls}`}
                onClick={async () => {
	                  if (proj) {
	                    try {
	                      const env = getProviderEnv(activeProviderId);
	                      const startupCmd = buildProviderStartupCmd(activeProviderId, env);
	                      const res: any = await (window.host.utils as any).openExternalConsole({
	                        terminal: env.terminal,
	                        wslPath: proj.wslPath,
	                        winPath: proj.winPath,
	                        distro: env.distro,
	                        startupCmd,
	                        title: getProviderLabel(activeProviderId),
	                      });
	                      if (!(res && res.ok)) throw new Error(res?.error || 'failed');
	                    } catch (e) {
	                      const envLabel = toShellLabel(getProviderEnv(activeProviderId).terminal as any);
	                      setBlockingNotice({ type: 'external-console', env: envLabel });
	                    }
	                  }
	                  setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
	                }}
	              >
	                <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxOpenExternalConsoleWith', { env: toShellLabel(getProviderEnv(activeProviderId).terminal as any), provider: getProviderLabel(activeProviderId) })}
	              </button>
	            );
            if (proj) {
              const isHidden = hiddenProjectIdSet.has(proj.id);
              if (isHidden) {
                menuItems.push(
                  <button
                    key="unhide-project"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                    onClick={() => {
                      unhideProject(proj);
                      setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                    }}
                  >
                    <Eye className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxUnhideProject')} (H)
                  </button>
                );
              } else {
                menuItems.push(
                  <button
                    key="hide-project"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                    onClick={() => {
                      setHideProjectConfirm({ open: true, project: proj });
                      setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                    }}
                  >
                    <EyeOff className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxHideTemporarily')} (H)
                  </button>
                );
              }
            }
            // “移除目录记录”：仅对自定义引擎记录的目录开放；内置三引擎会话目录不展示该选项
            if (proj && proj.dirRecord && proj.dirRecord.kind === "custom_provider" && proj.hasBuiltInSessions !== true) {
              menuItems.push(
                <button
                  key="remove-dir-record"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-red)] rounded-apple-sm hover:bg-[var(--cf-red-light)] transition-all duration-apple-fast"
                  onClick={() => { void removeProjectDirRecord(projectCtxMenu.project); }}
                >
                  <X className="h-4 w-4" /> {t('projects:ctxRemoveDirRecord')} (D)
                </button>
              );
            }
            return (
              <div
                ref={projectCtxMenuRef}
                className="absolute z-50 min-w-[160px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple shadow-apple-lg p-1.5 text-sm text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg"
                style={{ left: projectCtxMenu.x, top: projectCtxMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                {menuItems}
              </div>
            );
          })()}
        </div>
      )}

      {/* Build/Run 配置对话框（仅影响 Build/Run 的外部终端执行链路） */}
      <Dialog
        open={buildRunDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          closeBuildRunDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader className="pb-2 border-b border-slate-100 dark:border-slate-800/50">
            <DialogTitle>
              {buildRunDialog.action === "build"
                ? (t("projects:buildCommandTitle", "配置 Build 命令") as string)
                : (t("projects:runCommandTitle", "配置 Run 命令") as string)}
            </DialogTitle>
            <DialogDescription>
              {t("projects:buildRunDialogDesc", "首次配置后将直接执行；右键按钮可随时编辑。") as string}
            </DialogDescription>
          </DialogHeader>
          {(function renderBuildRunDialogBody() {
            const target = projectsRef.current.find((x) => x.id === buildRunDialog.projectId) || null;
            if (!target) return null;
            const parentId = String(buildRunDialog.parentProjectId || dirTreeStore.parentById[target.id] || "").trim();
            const parent = parentId ? (projectsRef.current.find((x) => x.id === parentId) || null) : null;
            const canChooseParent = !!parentId && !!parent;
            const override = buildRunDialog.saveScope === "self";

            const draft = buildRunDialog.draft || ({} as any);
            const envRows = Array.isArray(draft.env) ? (draft.env as any[]) : [];
            const backendKind = String((draft.backend as any)?.kind || "system");
            const wslDistroDraft = String((draft.backend as any)?.distro || "").trim();

            const setDraft = (patch: Partial<BuildRunCommandConfig>) => {
              setBuildRunDialog((prev) => ({ ...prev, draft: { ...(prev.draft as any), ...(patch as any) } }));
            };
            const setEnvRow = (idx: number, next: { key: string; value: string }) => {
              const list = Array.isArray(envRows) ? [...envRows] : [];
              list[idx] = next as any;
              setDraft({ env: list as any });
            };
            const removeEnvRow = (idx: number) => {
              const list = Array.isArray(envRows) ? envRows.filter((_: any, i: number) => i !== idx) : [];
              setDraft({ env: list as any });
            };
            const addEnvRow = () => {
              const list = Array.isArray(envRows) ? [...envRows] : [];
              list.push({ key: "", value: "" });
              setDraft({ env: list as any });
            };

            const labelClass = "text-[10px] font-bold uppercase tracking-wider text-slate-500/80 dark:text-slate-400/80 mb-1 block";

            return (
              <div className="flex flex-col max-h-[75vh]">
                <ScrollArea className="flex-1 pr-3">
                  <div className="space-y-4 py-1">
                    {canChooseParent ? (
                      <div
                        className={`rounded-md border px-2.5 py-1.5 transition-colors cursor-pointer flex items-start gap-2.5 ${
                          override
                            ? "border-[var(--cf-accent)]/30 bg-[var(--cf-accent)]/5 dark:border-[var(--cf-accent)]/40 dark:bg-[var(--cf-accent)]/10"
                            : "border-slate-200/70 bg-white/60 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]"
                        }`}
                        onClick={() => {
                            setBuildRunDialog((prev) => ({
                              ...prev,
                              saveScope: override ? "parent" : "self",
                              parentProjectId: parentId || prev.parentProjectId,
                            }));
                        }}
                      >
                        <div className="pt-0.5 shrink-0">
                           <div className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center transition-colors ${
                              override ? "border-[var(--cf-accent)] bg-[var(--cf-accent)]" : "border-slate-400 bg-transparent"
                           }`}>
                              {override && <Check className="h-2.5 w-2.5 text-white" />}
                           </div>
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800 dark:text-[var(--cf-text-primary)] leading-none">
                            {t("projects:worktreeOverride", "对此 worktree 覆盖") as string}
                          </div>
                          <p className="text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)] mt-1 leading-tight">
                            {override
                              ? (t("projects:worktreeOverrideOn", "将该命令保存到当前 worktree。") as string)
                              : (t("projects:worktreeOverrideOff", "默认继承父项目命令；保存将写入父项目。") as string)}
                          </p>
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className={labelClass}>
                            {t("projects:buildRunCommandLabel", "命令")}
                          </span>
                          <div className="flex bg-slate-100 dark:bg-slate-800 rounded p-0.5">
                            <button
                              type="button"
                              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-all ${
                                !buildRunDialog.advanced
                                  ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm"
                                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                              }`}
                              onClick={() => setBuildRunDialog((prev) => ({ ...prev, advanced: false }))}
                            >
                              {t("projects:buildRunSimple", "简洁") as string}
                            </button>
                            <button
                              type="button"
                              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-all ${
                                buildRunDialog.advanced
                                  ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm"
                                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                              }`}
                              onClick={() => setBuildRunDialog((prev) => ({ ...prev, advanced: true }))}
                            >
                              {t("projects:buildRunAdvanced", "高级") as string}
                            </button>
                          </div>
                        </div>

                        {!buildRunDialog.advanced ? (
                          <div className="space-y-2">
                            <Input
                              multiline
                              value={String(draft.commandText || "")}
                              onChange={(e: any) => setDraft({ commandText: e.target.value, mode: "simple" } as any)}
                              placeholder={t("projects:buildRunCommandPlaceholder", "例如：npm run build") as string}
                              className="font-mono text-xs min-h-[4rem]"
                            />

                            <details className="group rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                              <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-600 dark:text-[var(--cf-text-secondary)] flex items-center gap-1 focus:outline-none">
                                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                                {t("projects:buildRunMoreOptions", "更多选项") as string}
                              </summary>
                              <div className="mt-2 space-y-3 pl-3 border-l border-slate-200 dark:border-slate-700 ml-1">
                                <div className="space-y-1">
                                    <label className={labelClass}>{t("projects:buildRunCwd", "工作目录")}</label>
                                    <Input
                                      value={String(draft.cwd || "")}
                                      onChange={(e: any) => setDraft({ cwd: e.target.value } as any)}
                                      placeholder={t("projects:buildRunCwdPlaceholder", "默认为当前节点") as string}
                                      className="font-mono text-xs h-7"
                                    />
                                </div>

                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between">
                                    <label className={labelClass}>
                                      {t("projects:buildRunEnv", "环境变量")}
                                    </label>
                                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={addEnvRow}>
                                      <Plus className="h-2.5 w-2.5 mr-1" />
                                      {t("common:add", "添加") as string}
                                    </Button>
                                  </div>
                                  {envRows.length === 0 ? (
                                    <div className="text-[10px] text-slate-400 italic px-1">{t("projects:buildRunEnvEmpty", "无自定义环境变量") as string}</div>
                                  ) : (
                                    <div className="space-y-1.5">
                                      {envRows.map((row: any, idx: number) => (
                                        <div key={idx} className="flex gap-1.5">
                                          <Input
                                            value={String(row?.key || "")}
                                            onChange={(e: any) => setEnvRow(idx, { key: e.target.value, value: String(row?.value ?? "") })}
                                            placeholder="KEY"
                                            className="h-7 font-mono text-[10px] flex-1 min-w-0"
                                          />
                                          <Input
                                            value={String(row?.value ?? "")}
                                            onChange={(e: any) => setEnvRow(idx, { key: String(row?.key || ""), value: e.target.value })}
                                            placeholder="VALUE"
                                            className="h-7 font-mono text-[10px] flex-1 min-w-0"
                                          />
                                          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-slate-400 hover:text-red-500" onClick={() => removeEnvRow(idx)} title={t("common:remove", "移除") as string}>
                                            <X className="h-3 w-3" />
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </details>
                          </div>
                        ) : (
                          <div className="space-y-3">
                             {/* Advanced Mode: CMD + ARGS */}
                            <div className="space-y-1">
                              <label className={labelClass}>{t("projects:buildRunCmd", "cmd")}</label>
                              <Input
                                value={String(draft.cmd || "")}
                                onChange={(e: any) => setDraft({ cmd: e.target.value, mode: "advanced" } as any)}
                                placeholder="cmd"
                                className="h-8 font-mono text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className={labelClass}>{t("projects:buildRunArgs", "args（每行一个）")}</label>
                              <Input
                                multiline
                                value={(Array.isArray(draft.args) ? (draft.args as any[]).map((x) => String(x ?? "")).join("\n") : "")}
                                onChange={(e: any) => {
                                  const lines = String(e.target.value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
                                  setDraft({ args: lines, mode: "advanced" } as any);
                                }}
                                placeholder="arg1\narg2"
                                className="font-mono text-xs min-h-[3rem]"
                              />
                            </div>

                            <div className="space-y-1">
                              <div className={labelClass}>{t("projects:buildRunBackend", "终端后端")}</div>
                              <select
                                className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 focus:border-[var(--cf-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:text-[var(--cf-text-primary)]"
                                value={backendKind}
                                onChange={(e) => {
                                  const kind = e.target.value;
                                  if (kind === "wsl") setDraft({ backend: { kind: "wsl", distro: wslDistroDraft } as any } as any);
                                  else if (kind === "pwsh") setDraft({ backend: { kind: "pwsh" } as any } as any);
                                  else if (kind === "git_bash") setDraft({ backend: { kind: "git_bash" } as any } as any);
                                  else setDraft({ backend: { kind: "system" } as any } as any);
                                }}
                              >
                                <option value="system">{t("projects:buildRunBackendSystem", "系统默认") as string}</option>
                                <option value="pwsh">{t("projects:buildRunBackendPwsh", "PowerShell 7") as string}</option>
                                <option value="git_bash">{t("projects:buildRunBackendGitBash", "Git Bash") as string}</option>
                                <option value="wsl">{t("projects:buildRunBackendWsl", "WSL") as string}</option>
                              </select>
                              {backendKind === "wsl" ? (
                                <Input
                                  value={wslDistroDraft}
                                  onChange={(e: any) => setDraft({ backend: { kind: "wsl", distro: e.target.value } as any } as any)}
                                  placeholder={t("projects:buildRunWslDistro", "发行版（可选）") as string}
                                  className="h-8 font-mono text-xs mt-1"
                                />
                              ) : null}
                            </div>

                            <div className="space-y-1">
                              <label className={labelClass}>{t("projects:buildRunCwd", "工作目录")}</label>
                              <Input
                                value={String(draft.cwd || "")}
                                onChange={(e: any) => setDraft({ cwd: e.target.value } as any)}
                                placeholder={t("projects:buildRunCwdPlaceholder", "默认为当前节点") as string}
                                className="font-mono text-xs h-8"
                              />
                            </div>

                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between">
                                <label className={labelClass}>{t("projects:buildRunEnv", "环境变量")}</label>
                                <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={addEnvRow}>
                                  <Plus className="h-2.5 w-2.5 mr-1" />
                                  {t("common:add", "添加") as string}
                                </Button>
                              </div>
                              {envRows.length === 0 ? (
                                <div className="text-[10px] text-slate-400 italic px-1">{t("projects:buildRunEnvEmpty", "无自定义环境变量") as string}</div>
                              ) : (
                                <div className="space-y-1.5">
                                  {envRows.map((row: any, idx: number) => (
                                    <div key={idx} className="flex gap-1.5">
                                      <Input
                                        value={String(row?.key || "")}
                                        onChange={(e: any) => setEnvRow(idx, { key: e.target.value, value: String(row?.value ?? "") })}
                                        placeholder="KEY"
                                        className="h-7 font-mono text-[10px] flex-1 min-w-0"
                                      />
                                      <Input
                                        value={String(row?.value ?? "")}
                                        onChange={(e: any) => setEnvRow(idx, { key: String(row?.key || ""), value: e.target.value })}
                                        placeholder="VALUE"
                                        className="h-7 font-mono text-[10px] flex-1 min-w-0"
                                      />
                                      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-slate-400 hover:text-red-500" onClick={() => removeEnvRow(idx)} title={t("common:remove", "移除") as string}>
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                    </div>
                  </div>
                </ScrollArea>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/50 mt-2 shrink-0">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeBuildRunDialog}>
                    {t("common:cancel", "取消") as string}
                  </Button>
                  <Button variant="secondary" size="sm" className="h-8 text-xs min-w-[4rem]" onClick={() => void saveBuildRunDialog()}>
                    {t("common:save", "保存") as string}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* 从分支创建 worktree：创建后会在对应 worktree 内启动引擎 CLI（不影响 Build/Run 的终端链路） */}
      <Dialog
        open={worktreeCreateDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          closeWorktreeCreateDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader className="pb-2">
            <DialogTitle>{t("projects:worktreeCreateTitle", "从分支创建 worktree") as string}</DialogTitle>
            <DialogDescription>
              {t("projects:worktreeCreateDesc", "每个引擎实例需要一个 worktree，并在控制台中启动对应 CLI。") as string}
            </DialogDescription>
          </DialogHeader>
          {(function renderWorktreeCreateBody() {
            const repo = projectsRef.current.find((x) => x.id === worktreeCreateDialog.repoProjectId) || null;
            if (!repo) return null;

            const providerQueue = buildWorktreeProviderQueue({
              useMultipleModels: worktreeCreateDialog.useMultipleModels,
              singleProviderId: worktreeCreateDialog.singleProviderId,
              multiCounts: worktreeCreateDialog.multiCounts,
            });
            const total = providerQueue.length;
            const tooMany = total > 8;

            const childIds = dirTreeStore.childOrderByParent[worktreeCreateDialog.repoProjectId] || [];
            const childWorktrees = childIds
              .map((id) => projectsRef.current.find((x) => x.id === id) || null)
              .filter((p): p is Project => !!p)
              .filter((p) => !!gitInfoByProjectId[p.id]?.isWorktree);
            const childWorktreeIdsOrdered = childWorktrees.map((p) => p.id);
            const selectedChildIdsOrdered = trimSelectedIdsByOrder({
              selectedIds: worktreeCreateDialog.selectedChildWorktreeIds,
              allowedOrder: childWorktreeIdsOrdered,
              limit: total,
            });
            const reuseCount = selectedChildIdsOrdered.length;
            const createCount = Math.max(0, total - reuseCount);

            const canSubmit =
              !worktreeCreateDialog.creating &&
              total > 0 &&
              !tooMany &&
              (createCount === 0 ? true : (!worktreeCreateDialog.loadingBranches && !!worktreeCreateDialog.baseBranch && !worktreeCreateDialog.error));

            const setDialog = (patch: Partial<WorktreeCreateDialogState>) => {
              setWorktreeCreateDialog((prev) => ({ ...prev, ...(patch as any) }));
            };

            const setMultiCount = (pid: GitWorktreeProviderId, nextValue: number) => {
              const v = Math.max(0, Math.min(8, Math.floor(Number(nextValue) || 0)));
              setWorktreeCreateDialog((prev) => ({ ...prev, multiCounts: { ...(prev.multiCounts as any), [pid]: v } }));
            };

            const submit = async () => {
              if (!canSubmit) return;
              setDialog({ creating: true, error: undefined });

              const prompt = compileWorktreePromptText({
                chips: worktreeCreateDialog.promptChips,
                draft: worktreeCreateDialog.promptDraft,
                projectWinRoot: repo.winPath,
                projectWslRoot: repo.wslPath,
              });

              // 1) 优先在已选子 worktree 中启动实例（1:1 分配）
              const extraWarnings: string[] = [];
              let firstReuseProjectId: string | null = null;
              let firstReuseTabId: string | null = null;
              for (let i = 0; i < selectedChildIdsOrdered.length; i++) {
                const projectId = selectedChildIdsOrdered[i];
                const wtProject = childWorktrees.find((p) => p.id === projectId) || null;
                if (!wtProject) continue;
                const providerId = providerQueue[i] || worktreeCreateDialog.singleProviderId;
                // 用户主动选择：若该 worktree 被隐藏，则自动取消隐藏
                unhideProject(wtProject);
                const started = await startProviderInstanceInProject({ project: wtProject, providerId, prompt });
                if (started.ok && started.tabId) {
                  if (!firstReuseTabId) firstReuseTabId = started.tabId;
                } else if (!started.ok && started.error) {
                  extraWarnings.push(`${providerId}: ${started.error} (${getDirNodeLabel(wtProject)})`);
                }
                if (!firstReuseProjectId) firstReuseProjectId = wtProject.id;
              }

              // 2) 剩余实例才创建新 worktree
              const remainingQueue = providerQueue.slice(selectedChildIdsOrdered.length);
              const remainingInstances = collapseWorktreeProviderQueueToInstances(remainingQueue);
              if (remainingInstances.length > 0) {
                const baseBranch = String(worktreeCreateDialog.baseBranch || "").trim();
                if (!baseBranch) {
                  setDialog({ creating: false, error: t("projects:worktreeMissingBaseBranch", "未能读取到基分支") as string });
                  return;
                }
                await createWorktreesAndStartAgents({ repoProject: repo, baseBranch, instances: remainingInstances, prompt, extraWarnings });
                return;
              }

              // 仅复用：关闭面板，并将焦点切换到第一个已启动实例
              closeWorktreeCreateDialog();
              if (firstReuseProjectId) {
                suppressAutoSelectRef.current = true;
                setSelectedProjectId(firstReuseProjectId);
                setCenterMode("console");
                setSelectedHistoryDir(null);
                setSelectedHistoryId(null);
                if (firstReuseTabId) {
                  setActiveTab(firstReuseTabId, { projectId: firstReuseProjectId, focusMode: "immediate", allowDuringRename: true, delay: 0 });
                }
              }
              if (extraWarnings.length > 0) {
                setNoticeDialog({
                  open: true,
                  title: t("projects:worktreeCreateTitle", "从分支创建 worktree") as string,
                  message: (t("projects:worktreeCreateWarnings", "创建已完成，但存在警告：\n{{warnings}}") as any).replace("{{warnings}}", extraWarnings.join("\n")),
                });
              }
            };

            const labelClass = "text-[10px] font-bold uppercase tracking-wider text-slate-500/80 dark:text-slate-400/80 mb-1 block";
            const selectedSet = new Set(selectedChildIdsOrdered);
            const assignedProviderByWorktreeId = new Map<string, GitWorktreeProviderId>();
            for (let i = 0; i < selectedChildIdsOrdered.length; i++) {
              const projectId = selectedChildIdsOrdered[i];
              const providerId = providerQueue[i];
              if (projectId && providerId) assignedProviderByWorktreeId.set(projectId, providerId);
            }

            const primaryActionLabel =
              createCount > 0
                ? (reuseCount > 0
                    ? (t("projects:worktreeCreateAndStartAction", "创建并启动") as string)
                    : (t("projects:worktreeCreateAction", "创建") as string))
                : (t("projects:worktreeStartAction", "启动") as string);
            const primaryActionWorkingLabel =
              createCount > 0
                ? (t("projects:worktreeCreating", "创建中…") as string)
                : (t("projects:worktreeStarting", "启动中…") as string);

            /**
             * 切换复用子 worktree 的选中状态（受总实例数限制）。
             */
            const toggleChildWorktree = (projectId: string) => {
              const id = String(projectId || "").trim();
              if (!id) return;
              if (worktreeCreateDialog.creating) return;
              setWorktreeCreateDialog((prev) => {
                if (!prev.open) return prev;
                const cur = Array.isArray(prev.selectedChildWorktreeIds) ? prev.selectedChildWorktreeIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
                if (cur.includes(id)) return { ...prev, selectedChildWorktreeIds: cur.filter((x) => x !== id) };
                const max = buildWorktreeProviderQueue({ useMultipleModels: prev.useMultipleModels, singleProviderId: prev.singleProviderId, multiCounts: prev.multiCounts }).length;
                if (cur.length >= max) return prev;
                return { ...prev, selectedChildWorktreeIds: [...cur, id] };
              });
            };

            /**
             * 清空复用子 worktree 选择。
             */
            const clearChildWorktreeSelection = () => {
              if (worktreeCreateDialog.creating) return;
              setDialog({ selectedChildWorktreeIds: [] });
            };

            return (
              <div className="space-y-3">
                {worktreeCreateDialog.error ? (
                  <div
                    className={`rounded-md border px-3 py-1.5 text-[11px] font-medium flex items-center gap-2 ${
                      createCount > 0
                        ? "border-red-200 bg-red-50 text-red-800"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                    }`}
                  >
                    <TriangleAlert className="h-3.5 w-3.5" />
                    <span className="break-words">
                      {worktreeCreateDialog.error}
                      {createCount === 0 ? (t("projects:worktreeCreateErrorCreateOnly", "（仅影响新建）") as string) : null}
                    </span>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <label className={labelClass}>
                    {t("projects:worktreeBaseBranch", "基分支（baseBranch）")}
                  </label>
                  <select
                    className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 focus:border-[var(--cf-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:text-[var(--cf-text-primary)]"
                    value={worktreeCreateDialog.baseBranch}
                    disabled={worktreeCreateDialog.loadingBranches || worktreeCreateDialog.creating || createCount === 0}
                    onChange={(e) => setDialog({ baseBranch: e.target.value })}
                  >
                    {(worktreeCreateDialog.branches.length > 0 ? worktreeCreateDialog.branches : [worktreeCreateDialog.baseBranch]).filter(Boolean).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <label className={labelClass}>
                            {t("projects:worktreeModelSelection", "模型实例")}
                        </label>
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)] cursor-pointer select-none hover:text-slate-800 dark:hover:text-slate-300 transition-colors">
                          <input
                            type="checkbox"
                            className="h-3 w-3 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]"
                            checked={worktreeCreateDialog.useMultipleModels}
                            onChange={(e) => setDialog({ useMultipleModels: e.target.checked })}
                            disabled={worktreeCreateDialog.creating}
                          />
                          {t("projects:worktreeUseMultipleModels", "并行混合模式")}
                        </label>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {(["codex", "claude", "gemini"] as const).map((pid) => {
                          const icon = pid === "codex" ? (themeMode === "dark" ? openaiDarkIconUrl : openaiIconUrl) : pid === "claude" ? claudeIconUrl : geminiIconUrl;
                          const isMulti = worktreeCreateDialog.useMultipleModels;
                          const count = Math.max(0, Math.floor(Number(worktreeCreateDialog.multiCounts?.[pid]) || 0));
                          const enabledInMulti = count > 0;
                          const selectedInSingle = worktreeCreateDialog.singleProviderId === pid;
                          const isActive = isMulti ? enabledInMulti : selectedInSingle;

                          return (
                              <div
                                  key={pid}
                                  onClick={() => {
                                      if (worktreeCreateDialog.creating) return;
                                      if (isMulti) {
                                          setMultiCount(pid, enabledInMulti ? 0 : 1);
                                      } else {
                                          setDialog({ singleProviderId: pid });
                                      }
                                  }}
                                  className={`group relative cursor-pointer rounded-md border px-2 py-1.5 transition-all flex flex-col items-center justify-center gap-1 h-16 ${
                                      isActive
                                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent)]/5 ring-1 ring-[var(--cf-accent)] shadow-sm"
                                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:hover:bg-[var(--cf-surface-hover)]"
                                  } ${worktreeCreateDialog.creating ? "opacity-50 pointer-events-none" : ""}`}
                              >
                                  {isMulti && (
                                      <div className="absolute top-1 left-1">
                                          <input
                                              type="checkbox"
                                              className="h-3 w-3 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] pointer-events-none"
                                              checked={enabledInMulti}
                                              readOnly
                                          />
                                      </div>
                                  )}
                                  
                                  <img 
                                      src={icon} 
                                      alt={pid} 
                                      className={`h-4 w-4 object-contain transition-all ${isActive ? "opacity-100 scale-110" : "opacity-60 grayscale group-hover:opacity-80 group-hover:grayscale-0"}`} 
                                  />
                                  <span className={`font-medium text-[10px] ${isActive ? "text-[var(--cf-accent)]" : "text-slate-500 dark:text-[var(--cf-text-secondary)]"}`}>
                                      {getProviderLabel(pid)}
                                  </span>

                                  {isMulti && (
                                      <div 
                                          className={`absolute bottom-1 right-1 transition-all ${isActive ? "opacity-100 scale-100" : "opacity-0 scale-90 pointer-events-none"}`}
                                          onClick={(e) => e.stopPropagation()} 
                                      >
                                          <div className="flex items-center bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 px-1 h-5 shadow-sm">
                                              <span className="text-[9px] text-slate-400 mr-1 font-bold">x</span>
                                              <input
                                                  type="number"
                                                  min={1}
                                                  max={8}
                                                  value={String(count || "")}
                                                  onChange={(e) => setMultiCount(pid, Number(e.target.value))}
                                                  disabled={!enabledInMulti || worktreeCreateDialog.creating}
                                                  className="cf-number-input w-5 text-center text-[10px] font-mono bg-transparent outline-none p-0 focus:ring-0 leading-none"
                                              />
                                          </div>
                                      </div>
                                  )}
                              </div>
                          );
                      })}
                    </div>
                    
                    {worktreeCreateDialog.useMultipleModels && (
                        <div className="flex items-center justify-end h-3 gap-2">
                          <span className={`text-[10px] font-medium ${tooMany ? "text-red-600" : "text-slate-400"}`}>
                            {t("projects:worktreeTotalCount", "总计：{count} / 8", { count: total }) as string}
                          </span>
                          {tooMany ? <TriangleAlert className="h-3 w-3 text-red-600" /> : null}
                        </div>
                    )}
                </div>

                {childWorktrees.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className={labelClass}>
                        {t("projects:worktreeReuseChildWorktrees", "复用已有子 worktree（可选）")}
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                          {t("projects:worktreeReuseSelectedCount", "已选：{selected} / {max}", { selected: reuseCount, max: total }) as string}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={clearChildWorktreeSelection}
                          disabled={reuseCount === 0 || worktreeCreateDialog.creating}
                        >
                          {t("projects:worktreeReuseClear", "清空") as string}
                        </Button>
                      </div>
                    </div>

                    <div className="text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                      {t("projects:worktreeReuseHint", "默认不勾选任何已有子 worktree。勾选后将优先把引擎实例分配到这些 worktree；剩余实例再新建。") as string}
                    </div>

                    <div className="rounded-md border border-slate-200/70 bg-white/50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] overflow-hidden">
                      <div className="max-h-40 overflow-auto divide-y divide-slate-100 dark:divide-slate-800/50">
                        {childWorktrees.map((p) => {
                          const checked = selectedSet.has(p.id);
                          const disabled = worktreeCreateDialog.creating || (!checked && reuseCount >= total) || total === 0;
                          const assigned = assignedProviderByWorktreeId.get(p.id);
                          const displayLabel = getDirNodeLabel(p);
                          return (
                            <label
                              key={p.id}
                              className={`flex items-center gap-2 px-2.5 py-2 text-xs ${
                                disabled ? "opacity-60" : "cursor-pointer hover:bg-slate-50 dark:hover:bg-[var(--cf-surface-hover)]"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="h-3 w-3 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleChildWorktree(p.id)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-slate-700 dark:text-[var(--cf-text-primary)] truncate">
                                    {displayLabel}
                                  </span>
                                  {checked && assigned ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                      {getProviderLabel(assigned)}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono truncate">{p.winPath}</div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <span className="text-[10px] text-slate-400">
                        {t("projects:worktreeReuseSummary", "复用 {reuse}，新建 {create}", { reuse: reuseCount, create: createCount }) as string}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <div className="text-xs font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
                    {t("projects:worktreeInitialPrompt", "初始提示词（可选）") as string}
                  </div>
                  <PathChipsInput
                    multiline
                    chips={worktreeCreateDialog.promptChips}
                    onChipsChange={(next) => setDialog({ promptChips: next })}
                    draft={worktreeCreateDialog.promptDraft}
                    onDraftChange={(v) => setDialog({ promptDraft: v })}
                    winRoot={repo.winPath}
                    projectWslRoot={repo.wslPath}
                    className="min-h-[3rem] text-xs"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/50 mt-1">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeWorktreeCreateDialog} disabled={worktreeCreateDialog.creating}>
                    {t("common:cancel", "取消") as string}
                  </Button>
                  <Button variant="secondary" size="sm" className="h-8 text-xs min-w-[4rem]" onClick={() => void submit()} disabled={!canSubmit}>
                    {worktreeCreateDialog.creating ? primaryActionWorkingLabel : primaryActionLabel}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* worktree 创建进度：展示主进程执行 git worktree add 的输出，可关闭并重新打开查看进度 */}
      <Dialog
        open={worktreeCreateProgress.open}
        onOpenChange={(open) => {
          if (open) return;
          setWorktreeCreateProgress((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader className="pb-2">
            <DialogTitle>{t("projects:worktreeCreateProgressTitle", "创建 worktree（进度）") as string}</DialogTitle>
            <DialogDescription>
              {t("projects:worktreeCreateProgressDesc", "你可以随时关闭该窗口；重新点击项目右侧的分支徽标可再次打开查看进度。") as string}
            </DialogDescription>
          </DialogHeader>
          {(function renderWorktreeCreateProgressBody() {
            const repo = projectsRef.current.find((x) => x.id === worktreeCreateProgress.repoProjectId) || null;
            const status = worktreeCreateProgress.status;
            const statusLabel =
              status === "running"
                ? (t("projects:worktreeCreating", "创建中…") as string)
                : status === "success"
                ? (t("common:done", "完成") as string)
                : (t("common:failed", "失败") as string);
            const statusIcon =
              status === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
              ) : status === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-red-600" />
              );

            return (
              <div className="space-y-3">
                {repo ? (
                  <div className="rounded-lg border border-slate-200/70 bg-white/60 px-3 py-2 text-xs text-slate-600 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)] space-y-1">
                    <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Repo</div>
                    <div className="font-mono break-all">{repo.winPath}</div>
                    <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider mt-1">Task</div>
                    <div className="font-mono break-all">{worktreeCreateProgress.taskId}</div>
                  </div>
                ) : null}

                <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-[var(--cf-text-primary)]">
                  {statusIcon}
                  <span className="font-semibold">{statusLabel}</span>
                  {worktreeCreateProgress.updatedAt ? (
                    <span className="text-[10px] text-slate-400">
                      {new Date(worktreeCreateProgress.updatedAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                </div>

                {worktreeCreateProgress.error ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 whitespace-pre-wrap break-words">
                    {worktreeCreateProgress.error}
                  </div>
                ) : null}

                <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] overflow-hidden">
                  <ScrollArea className="h-[22rem]">
                    <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words p-3 text-slate-700 dark:text-[var(--cf-text-secondary)]">
                      {worktreeCreateProgress.log || ""}
                    </pre>
                  </ScrollArea>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setWorktreeCreateProgress((prev) => ({ ...prev, open: false }))}>
                    {t("common:close", "关闭") as string}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={async () => {
                      try { if (repo?.winPath) await (window as any).host?.gitWorktree?.openExternalTool?.(repo.winPath); } catch {}
                    }}
                    disabled={!repo?.winPath}
                  >
                    {t("projects:gitOpenExternalTool", "打开外部 Git 工具") as string}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={async () => {
                      try { if (repo?.winPath) await (window as any).host?.gitWorktree?.openTerminal?.(repo.winPath); } catch {}
                    }}
                    disabled={!repo?.winPath}
                  >
                    {t("projects:gitOpenTerminal", "在外部终端 / Git Bash 打开") as string}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
	      </Dialog>

		      {/* worktree 合并进度：展示主进程执行合并流程的实时输出，可关闭查看 */}
	      <Dialog
	        open={worktreeRecycleProgress.open}
	        onOpenChange={(open) => {
	          if (open) return;
	          setWorktreeRecycleProgress((prev) => ({ ...prev, open: false }));
	        }}
	      >
	        <DialogContent className="max-w-3xl">
	          <DialogHeader className="pb-2">
		            <DialogTitle>{t("projects:worktreeRecycleProgressTitle", "合并 worktree（进度）") as string}</DialogTitle>
		            <DialogDescription>
		              {t("projects:worktreeRecycleProgressDesc", "展示合并过程的实时日志；你可以随时关闭该窗口，合并仍会继续执行。") as string}
		            </DialogDescription>
	          </DialogHeader>
	          {(function renderWorktreeRecycleProgressBody() {
	            const project = projectsRef.current.find((x) => x.id === worktreeRecycleProgress.projectId) || null;
	            const status = worktreeRecycleProgress.status;
	            const statusLabel =
		              status === "running"
		                ? (t("projects:worktreeRecycling", "合并中…") as string)
		                : status === "success"
	                  ? (t("common:done", "完成") as string)
	                  : (t("common:failed", "失败") as string);
	            const statusIcon =
	              status === "running" ? (
	                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
	              ) : status === "success" ? (
	                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
	              ) : (
	                <TriangleAlert className="h-4 w-4 text-red-600" />
	              );

	            const dirForOpen = String(worktreeRecycleDialog.repoMainPath || project?.winPath || "").trim();

	            return (
	              <div className="space-y-3">
	                {project ? (
	                  <div className="rounded-lg border border-slate-200/70 bg-white/60 px-3 py-2 text-xs text-slate-600 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)] space-y-1">
	                    <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Worktree</div>
	                    <div className="font-mono break-all">{project.winPath}</div>
	                    <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider mt-1">Task</div>
	                    <div className="font-mono break-all">{worktreeRecycleProgress.taskId}</div>
	                  </div>
	                ) : null}

	                <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-[var(--cf-text-primary)]">
	                  {statusIcon}
	                  <span className="font-semibold">{statusLabel}</span>
	                  {worktreeRecycleProgress.updatedAt ? (
	                    <span className="text-[10px] text-slate-400">
	                      {new Date(worktreeRecycleProgress.updatedAt).toLocaleTimeString()}
	                    </span>
	                  ) : null}
	                </div>

	                {worktreeRecycleProgress.error ? (
	                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 whitespace-pre-wrap break-words">
	                    {worktreeRecycleProgress.error}
	                  </div>
	                ) : null}

	                <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] overflow-hidden">
	                  <ScrollArea className="h-[22rem]">
	                    <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words p-3 text-slate-700 dark:text-[var(--cf-text-secondary)]">
	                      {worktreeRecycleProgress.log || ""}
	                    </pre>
	                  </ScrollArea>
	                </div>

	                <div className="flex justify-end gap-2 pt-1">
	                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setWorktreeRecycleProgress((prev) => ({ ...prev, open: false }))}>
	                    {t("common:close", "关闭") as string}
	                  </Button>
	                  <Button
	                    variant="secondary"
	                    size="sm"
	                    className="h-8 text-xs"
	                    onClick={async () => {
	                      try { if (dirForOpen) await (window as any).host?.gitWorktree?.openExternalTool?.(dirForOpen); } catch {}
	                    }}
	                    disabled={!dirForOpen}
	                  >
	                    {t("projects:gitOpenExternalTool", "打开外部 Git 工具") as string}
	                  </Button>
	                  <Button
	                    variant="secondary"
	                    size="sm"
	                    className="h-8 text-xs"
	                    onClick={async () => {
	                      try { if (dirForOpen) await (window as any).host?.gitWorktree?.openTerminal?.(dirForOpen); } catch {}
	                    }}
	                    disabled={!dirForOpen}
	                  >
	                    {t("projects:gitOpenTerminal", "在外部终端 / Git Bash 打开") as string}
	                  </Button>
	                </div>
	              </div>
	            );
	          })()}
	        </DialogContent>
	      </Dialog>

		      {/* 将 worktree 变更合并到目标分支（squash/rebase） */}
	      <Dialog
	        open={worktreeRecycleDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          closeWorktreeRecycleDialog();
        }}
      >
        <DialogContent className="max-w-md">
	          <DialogHeader className="pb-2 border-b border-slate-100 dark:border-slate-800/50">
		            <DialogTitle>{t("projects:worktreeRecycleTitle", "将 worktree 变更合并到目标分支") as string}</DialogTitle>
		            <DialogDescription>{t("projects:worktreeRecycleDesc", "将源分支的提交合并到目标分支。若发生冲突，请先解决冲突后再继续；必要时可使用命令行 Git 完成操作。") as string}</DialogDescription>
	          </DialogHeader>
          {(function renderRecycleBody() {
            const project = projectsRef.current.find((x) => x.id === worktreeRecycleDialog.projectId) || null;
            if (!project) return null;
            const branches = Array.isArray(worktreeRecycleDialog.branches) ? worktreeRecycleDialog.branches : [];
            const base = String(worktreeRecycleDialog.baseBranch || "").trim();
            const wt = String(worktreeRecycleDialog.wtBranch || "").trim();
            const branchOptions = Array.from(new Set(branches.map((x) => String(x || "").trim()).filter(Boolean)));
            const forkBaseRefForSubmit = String(worktreeRecycleDialog.forkPointValue || "").trim();
            const canSubmitRecycle =
              !worktreeRecycleDialog.loading &&
              !worktreeRecycleDialog.running &&
              !!base &&
              !!wt &&
              (worktreeRecycleDialog.range !== "since_fork" || !!forkBaseRefForSubmit);

            return (
              <div className="space-y-3">
                {worktreeRecycleDialog.error ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-medium text-red-800 flex items-center gap-2">
                    <TriangleAlert className="h-3.5 w-3.5" />
                    {worktreeRecycleDialog.error}
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                        {t("projects:worktreeRecycleBaseBranch", "目标分支") as string}
                      </label>
                      <select
                        className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 focus:border-[var(--cf-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:text-[var(--cf-text-primary)]"
                        value={base}
                        disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
                        onChange={(e) =>
                          setWorktreeRecycleDialog((prev) => ({
                            ...prev,
                            baseBranch: e.target.value,
                            forkPointValue: "",
                            forkPointTouched: false,
                            forkPointPinned: [],
                            forkPointSearchItems: [],
                            forkPointSearchQuery: "",
                            forkPointPinnedLoading: false,
                            forkPointSearchLoading: false,
                            forkPointError: undefined,
                            error: undefined,
                          }))
                        }
                      >
                        {!base ? (
                          <option value="" disabled>
                            {t("projects:worktreeRecycleSelectBranchPlaceholder", "请选择") as string}
                          </option>
                        ) : null}
                        {branchOptions.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
                        {t("projects:worktreeRecycleWtBranch", "源分支") as string}
                      </label>
                      <select
                        className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 focus:border-[var(--cf-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-solid)] dark:text-[var(--cf-text-primary)]"
                        value={wt}
                        disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
                        onChange={(e) =>
                          setWorktreeRecycleDialog((prev) => ({
                            ...prev,
                            wtBranch: e.target.value,
                            forkPointValue: "",
                            forkPointTouched: false,
                            forkPointPinned: [],
                            forkPointSearchItems: [],
                            forkPointSearchQuery: "",
                            forkPointPinnedLoading: false,
                            forkPointSearchLoading: false,
                            forkPointError: undefined,
                            error: undefined,
                          }))
                        }
                      >
                        {!wt ? (
                          <option value="" disabled>
                            {t("projects:worktreeRecycleSelectBranchPlaceholder", "请选择") as string}
                          </option>
                        ) : null}
                        {branchOptions.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                </div>

	                <div className="space-y-1.5">
	                  <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                    {t("projects:worktreeRecycleRange", "合并范围") as string}
	                  </div>
                  <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-md">
                    {(["since_fork", "full"] as const).map((r) => {
                      const isSelected = worktreeRecycleDialog.range === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setWorktreeRecycleDialog((prev) => ({ ...prev, range: r, forkPointError: undefined, error: undefined }))}
                          disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
                          className={`flex-1 py-1 text-[10px] font-medium rounded transition-all ${
                            isSelected
                              ? "bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm"
                              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
	                          {r === "since_fork"
	                            ? (t("projects:worktreeRecycleRangeSinceFork", "仅包含分叉点之后的提交（推荐）") as string)
	                            : (t("projects:worktreeRecycleRangeFull", "包含全部提交") as string)}
	                        </button>
	                      );
	                    })}
	                  </div>
	                  <p className="text-[9px] text-slate-500 px-1 italic">
	                    {worktreeRecycleDialog.range === "since_fork"
	                      ? (t("projects:worktreeRecycleRangeHintSinceFork", "以分叉点（merge-base）为边界，仅纳入后续提交，通常可降低冲突概率。") as string)
	                      : (t("projects:worktreeRecycleRangeHintFull", "纳入源分支的全部提交。") as string)}
	                  </p>
	                </div>

                {worktreeRecycleDialog.range === "since_fork" ? (
                  <div className="space-y-2">
	                    <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                      {t("projects:worktreeRecycleForkPointTitle", "分叉点（merge-base）") as string}
	                    </div>
                      <p className="text-[9px] text-slate-500 px-1 italic">
                        {t("projects:worktreeRecycleForkPointDesc", "用于确定“分叉点之后”的提交范围。") as string}
                      </p>

	                    <Combobox
	                      showTagInTrigger
	                      value={String(worktreeRecycleDialog.forkPointValue || "").trim()}
	                      onValueChange={(v) =>
	                        setWorktreeRecycleDialog((prev) => ({
	                          ...prev,
	                          forkPointValue: v,
                          forkPointTouched: true,
                          forkPointSearchQuery: "",
                          forkPointError: undefined,
                          error: undefined,
                        }))
                      }
                      groups={[
                        {
                          key: "pinned",
                          label: t("projects:worktreeRecycleForkPointGroupPinned", "推荐") as string,
                          items: (worktreeRecycleDialog.forkPointPinned || []).map((x) => ({
                            value: x.value,
                            title: x.title,
                            subtitle: x.subtitle,
                            tag: x.tag,
                          })),
                        },
                        {
                          key: "history",
                          label: t("projects:worktreeRecycleForkPointGroupHistory", "提交记录") as string,
                          items: (worktreeRecycleDialog.forkPointSearchItems || []).map((x) => ({
                            value: x.value,
                            title: x.title,
                            subtitle: x.subtitle,
                            tag: x.tag,
                          })),
                        },
                      ]}
                      placeholder={t("projects:worktreeRecycleForkPointPlaceholder", "选择分叉点…") as string}
                      searchPlaceholder={t("projects:worktreeRecycleForkPointSearchPlaceholder", "搜索提交信息（支持粘贴提交号/引用并回车校验）") as string}
                      emptyText={t("projects:worktreeRecycleForkPointEmpty", "无匹配提交") as string}
                      disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
                      loading={worktreeRecycleDialog.forkPointPinnedLoading || worktreeRecycleDialog.forkPointSearchLoading}
                      searchValue={String(worktreeRecycleDialog.forkPointSearchQuery || "")}
                      onSearchValueChange={(q) => setWorktreeRecycleDialog((prev) => ({ ...prev, forkPointSearchQuery: String(q ?? "") }))}
                      customEntry={{
                        title: (ref) => (t("projects:worktreeRecycleForkPointCustomTitle", "使用：{ref}", { ref }) as string),
                        subtitle: () => (t("projects:worktreeRecycleForkPointCustomSubtitle", "校验并使用该引用") as string),
                        tag: t("projects:worktreeRecycleForkPointTagManual", "手动") as string,
                      }}
                      onEnterCustomValue={(raw) => void validateAndSelectForkPointRef(raw)}
                    />

                    {worktreeRecycleDialog.forkPointError ? (
                      <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-800 whitespace-pre-wrap break-words">
                        {worktreeRecycleDialog.forkPointError}
                      </div>
                    ) : null}
                  </div>
                ) : null}

	                <div className="space-y-1.5">
	                  <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                    {t("projects:worktreeRecycleMode", "合并方式") as string}
	                  </div>
                  <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-md">
                    {(["squash", "rebase"] as const).map((m) => {
                        const isSelected = worktreeRecycleDialog.mode === m;
                        return (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setWorktreeRecycleDialog((prev) => ({ ...prev, mode: m }))}
                                disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
                                className={`flex-1 py-1 text-[10px] font-medium rounded transition-all ${
                                    isSelected
                                        ? "bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm"
                                        : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                                }`}
	                            >
	                                {m === "squash"
	                                    ? t("projects:worktreeRecycleModeSquash", "压缩（Squash，推荐）")
	                                    : t("projects:worktreeRecycleModeRebase", "变基（Rebase）")}
	                            </button>
	                        );
	                    })}
	                  </div>
	                  <p className="text-[9px] text-slate-500 px-1 italic">
	                      {worktreeRecycleDialog.mode === "squash"
	                        ? t("projects:worktreeRecycleSquashHint", "将源分支的所有提交压缩为一个提交，使目标分支历史更整洁。")
	                        : t("projects:worktreeRecycleRebaseHint", "将源分支的提交按顺序重放到目标分支之上，保留每个提交。")}
	                  </p>
	                </div>

                {worktreeRecycleDialog.mode === "squash" ? (
	                  <div className="space-y-1">
	                    <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                      {t("projects:worktreeRecycleCommitMessage", "提交说明（可选）") as string}
	                    </div>
                    <Input
                      value={String(worktreeRecycleDialog.commitMessage || "")}
                      onChange={(e: any) => setWorktreeRecycleDialog((prev) => ({ ...prev, commitMessage: e.target.value }))}
	                      placeholder={t("projects:worktreeRecycleCommitMessagePlaceholder", "squash: <源分支> -> <目标分支>") as string}
	                      className="h-8 font-mono text-[11px]"
	                      disabled={worktreeRecycleDialog.loading || worktreeRecycleDialog.running}
	                    />
	                  </div>
                ) : null}

                <div className="flex justify-end gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/50">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeWorktreeRecycleDialog} disabled={worktreeRecycleDialog.running}>
                    {t("common:cancel", "取消") as string}
                  </Button>
	                  <Button variant="secondary" size="sm" className="h-8 text-xs" onClick={() => void submitWorktreeRecycle()} disabled={!canSubmitRecycle}>
	                    {worktreeRecycleDialog.running ? (t("projects:worktreeRecycling", "合并中…") as string) : (t("projects:worktreeRecycleAction", "合并") as string)}
	                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

	      {/* 删除 worktree / 重置为主 worktree 状态（必要时强确认） */}
      <Dialog
        open={worktreeDeleteDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          closeWorktreeDeleteDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-2 border-b border-slate-100 dark:border-slate-800/50">
	            <DialogTitle>
	              {worktreeDeleteDialog.action === "reset"
	                ? (t("projects:worktreeResetTitle", "重置为主 worktree 状态") as string)
	                : worktreeDeleteDialog.afterRecycle
	                  ? (t("projects:worktreeDeleteAfterRecycleTitle", "合并成功，是否删除该 worktree？") as string)
	                  : (t("projects:worktreeDeleteTitle", "删除 worktree") as string)}
	            </DialogTitle>
	            <DialogDescription className={worktreeDeleteDialog.action === "reset" ? "whitespace-pre-line" : ""}>
	              {worktreeDeleteDialog.action === "reset"
	                ? (t("projects:worktreeResetDesc", "将此 worktree 重置到与主 worktree 当前签出的修订版一致，并清理工作区使其恢复为干净状态。\n此操作会丢弃未提交的修改，并删除未跟踪的文件（默认不删除被忽略的文件）。") as string)
	                : (t("projects:worktreeDeleteDesc", "将执行 git worktree remove，并删除该 worktree 的专用分支。") as string)}
	            </DialogDescription>
          </DialogHeader>
          {(function renderDeleteBody() {
            const project = projectsRef.current.find((x) => x.id === worktreeDeleteDialog.projectId) || null;
            if (!project) return null;
            const isReset = worktreeDeleteDialog.action === "reset";
	            const needForceReset = isReset && worktreeDeleteDialog.needsForceResetWorktree === true;
            const needForceRemove = !isReset && worktreeDeleteDialog.needsForceRemoveWorktree === true;
            const needForceBranch = !isReset && worktreeDeleteDialog.needsForceDeleteBranch === true;
	            const forceHint = needForceReset
	              ? (t("projects:worktreeResetForceHint", "检测到未提交修改：强制重置将丢弃这些修改。") as string)
	              : needForceRemove
	                ? (t("projects:worktreeDeleteForceRemoveHint", "检测到未提交修改：强制移除将丢弃这些修改。") as string)
                : needForceBranch
                  ? (t("projects:worktreeDeleteForceBranchHint", "分支未合并：强制删除将丢失该分支上的提交。") as string)
                  : "";
	            const primaryLabel = isReset
	              ? (needForceReset ? (t("projects:worktreeResetForceAction", "强制重置") as string) : (t("projects:worktreeResetAction", "重置") as string))
	              : needForceRemove || needForceBranch
	                ? (t("projects:worktreeDeleteForceAction", "强制删除") as string)
	                : (t("projects:worktreeDeleteAction", "删除") as string);
	            const runningLabel = isReset ? (t("projects:worktreeResetting", "重置中…") as string) : (t("projects:worktreeDeleting", "删除中…") as string);
            const doSubmit = () =>
              isReset ? void submitWorktreeDelete({ forceResetWorktree: needForceReset }) : void submitWorktreeDelete({ forceRemoveWorktree: needForceRemove, forceDeleteBranch: needForceBranch });

	            return (
	              <div className="space-y-3">
	                <div className="rounded-md border border-slate-200/60 bg-slate-50/50 px-2.5 py-1.5 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
	                  <div className="text-[9px] uppercase font-bold text-slate-400 mb-0.5 tracking-wider">{t("projects:worktreePath", "PATH") as string}</div>
	                  <div className="font-mono text-[10px] break-all text-slate-700 dark:text-[var(--cf-text-secondary)] leading-tight">{project.winPath}</div>
	                </div>

                  <div className="rounded-md border border-slate-200/60 bg-white/60 px-2.5 py-2 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                    <label className="flex gap-2 items-start cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={worktreeDeleteDialog.action === "reset"}
                        disabled={worktreeDeleteDialog.running}
                        onChange={(e) =>
                          setWorktreeDeleteDialog((prev) => ({
                            ...prev,
                            action: e.target.checked ? "reset" : "delete",
                            needsForceRemoveWorktree: false,
                            needsForceDeleteBranch: false,
                            needsForceResetWorktree: false,
                            error: undefined,
                          }))
                        }
                      />
                      <div className="space-y-0.5">
	                        <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
	                          {t("projects:worktreeDeleteResetOption", "保留并重置该目录（不移除worktree）") as string}
	                        </div>
	                        <div className="text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)] leading-snug">
	                          {t(
	                            "projects:worktreeDeleteResetHint",
	                            "仅重置到与主 worktree 当前签出的修订版一致并清理；不会执行“移除worktree”。"
	                          ) as string}
	                        </div>
                      </div>
                    </label>
                  </div>
	                {worktreeDeleteDialog.afterRecycleHint ? (
	                  <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 whitespace-pre-line">
	                    {worktreeDeleteDialog.afterRecycleHint}
	                  </div>
	                ) : null}
	                {forceHint ? (
	                  <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 flex gap-2 items-start">
                    <TriangleAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-amber-800 leading-normal font-medium">
	                    {forceHint}
	                  </div>
	</div>
                ) : null}
                {worktreeDeleteDialog.error ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10px] font-medium text-red-800 flex items-center gap-2">
                    <TriangleAlert className="h-3.5 w-3.5" />
                    {worktreeDeleteDialog.error}
                  </div>
                ) : null}

                <div className="flex justify-end gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/50">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeWorktreeDeleteDialog} disabled={worktreeDeleteDialog.running}>
                    {t("common:cancel", "取消") as string}
                  </Button>
                  <Button 
                    variant={needForceReset || needForceRemove || needForceBranch ? "danger" : "secondary"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={doSubmit} 
                    disabled={worktreeDeleteDialog.running}
                  >
                    {worktreeDeleteDialog.running ? runningLabel : primaryLabel}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

	      {/* 合并完成后的可选操作：删除 / 重置 / 稍后 */}
      <Dialog
        open={worktreePostRecycleDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          setWorktreePostRecycleDialog((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-2 border-b border-slate-100 dark:border-slate-800/50">
	            <DialogTitle>{t("projects:worktreePostRecycleTitle", "合并完成") as string}</DialogTitle>
	            <DialogDescription>
	              {t("projects:worktreePostRecycleDesc", "已将变更合并到目标分支。你可以选择删除该 worktree，或将其重置为主 worktree 状态以便复用。") as string}
	            </DialogDescription>
          </DialogHeader>
          {(function renderPostRecycleBody() {
            const project = projectsRef.current.find((x) => x.id === worktreePostRecycleDialog.projectId) || null;
            if (!project) return null;
            const hint = worktreePostRecycleDialog.hint;
            const close = () => setWorktreePostRecycleDialog((prev) => ({ ...prev, open: false }));
            return (
              <div className="space-y-3">
                {hint ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 whitespace-pre-line dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
                    {hint}
                  </div>
                ) : null}

                <div className="flex justify-end gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/50">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={close}>
                    {t("projects:worktreePostRecycleActionLater", "稍后") as string}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      close();
                      openWorktreeDeleteDialog(project, true, "reset", hint);
                    }}
                  >
	                    {t("projects:worktreePostRecycleActionReset", "重置为主 worktree 状态") as string}
	                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      close();
                      openWorktreeDeleteDialog(project, true, "delete", hint);
                    }}
                  >
                    {t("projects:worktreePostRecycleActionDelete", "删除该子 worktree") as string}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog
        open={worktreeBlockedDialog.open}
        onOpenChange={(open) => {
          if (!open) setWorktreeBlockedDialog((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("projects:worktreeActionBlockedTitle", "操作不可用") as string}</DialogTitle>
            <DialogDescription>
              {t(
                "projects:worktreeActionBlockedByTerminals",
                "当前项目存在 {count} 个终端代理，工作树回收/删除功能不可用。请关闭所有终端代理再尝试。",
                { count: worktreeBlockedDialog.count }
              ) as string}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setWorktreeBlockedDialog((prev) => ({ ...prev, open: false }))}>
              {t("common:close", "关闭") as string}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 主 worktree 不干净：允许用户选择外部处理或“我知道风险，继续（自动 stash/恢复）” */}
      <Dialog
        open={baseWorktreeDirtyDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          setBaseWorktreeDirtyDialog((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("projects:worktreeRecycleBaseDirtyTitle", "主 worktree 不干净") as string}</DialogTitle>
            <DialogDescription>
              {t("projects:worktreeRecycleBaseDirtyDesc", "回收需要在主 worktree 上执行 checkout/merge 等操作。检测到主 worktree 存在未提交修改，你可以选择：") as string}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {baseWorktreeDirtyDialog.repoMainPath ? (
              <div className="rounded-lg border border-slate-200/70 bg-white/60 px-3 py-2 text-xs text-slate-600 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
                <div className="font-mono break-all">{baseWorktreeDirtyDialog.repoMainPath}</div>
              </div>
            ) : null}
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 whitespace-pre-line">
              {t(
                "projects:worktreeRecycleBaseDirtyBody",
                "继续将执行以下操作：\n- 创建“事务化快照”，最大化保持主 worktree 的三态（已暂存/未暂存/未跟踪）：\n  - 执行 `git stash push -u` 保存工作区内容（含未跟踪；不含 ignored）。\n  - 同时对 `.git/index` 做字节级快照，用于 100% 还原 staged 语义。\n- 回收完成后自动恢复：先清空到确定态，再“只覆盖、不合并”回放工作区快照，并原样恢复 index；会做一致性校验。\n- 若恢复/校验失败：stash/快照将保留，你需要用外部 Git 工具手动处理。"
              ) as string}
            </div>
            {baseWorktreeDirtyDialog.preCommitHint ? (
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 whitespace-pre-line">
                {baseWorktreeDirtyDialog.preCommitHint}
              </div>
            ) : null}
	            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
	              <Button className="w-full" variant="outline" onClick={() => setBaseWorktreeDirtyDialog((prev) => ({ ...prev, open: false }))}>
	                {t("common:cancel", "取消") as string}
	              </Button>
	              <Button
	                className="w-full !h-auto !whitespace-normal leading-snug"
	                variant="secondary"
	                onClick={async () => {
	                  const dir = String(baseWorktreeDirtyDialog.repoMainPath || "").trim();
		                  try {
	                    const r: any = await (window as any).host?.gitWorktree?.openExternalTool?.(dir);
	                    if (!(r && r.ok)) throw new Error("打开外部 Git 工具失败");
	                  } catch {
	                    try { await (window as any).host?.gitWorktree?.openTerminal?.(dir); } catch {}
	                  }
                  setBaseWorktreeDirtyDialog((prev) => ({ ...prev, open: false }));
	                }}
	                disabled={!baseWorktreeDirtyDialog.repoMainPath}
	              >
	                {t("projects:gitOpenExternalOrTerminal", "打开外部 Git 工具/终端处理") as string}
	              </Button>
	              <Button
	                className="w-full !h-auto !whitespace-normal leading-snug"
	                variant="danger"
	                onClick={() => {
	                  setBaseWorktreeDirtyDialog((prev) => ({ ...prev, open: false }));
	                  void submitWorktreeRecycle({ autoStashBaseWorktree: true });
                }}
                disabled={worktreeRecycleDialog.running}
	              >
	                {t("projects:worktreeRecycleBaseDirtyContinue", "我知道风险，继续") as string}
	              </Button>
	            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Git 失败兜底弹窗：提供外部 Git 工具/终端快捷入口 */}
      <Dialog
        open={gitActionErrorDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          closeGitActionErrorDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{gitActionErrorDialog.title}</DialogTitle>
            <DialogDescription>{t("projects:gitActionFailedHint", "请在外部工具中处理冲突/中断/hook 等问题后再重试。") as string}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {gitActionErrorDialog.dir ? (
              <div className="rounded-lg border border-slate-200/70 bg-white/60 px-3 py-2 text-xs text-slate-600 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
                <div className="font-mono break-all">{gitActionErrorDialog.dir}</div>
              </div>
            ) : null}
	            {gitActionErrorDialog.message ? (
	              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 whitespace-pre-line">
	                {gitActionErrorDialog.message}
	              </div>
	            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={closeGitActionErrorDialog}>
                {t("common:close", "关闭") as string}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  try { if (gitActionErrorDialog.dir) await (window as any).host?.gitWorktree?.openExternalTool?.(gitActionErrorDialog.dir); } catch {}
                  closeGitActionErrorDialog();
                }}
                disabled={!gitActionErrorDialog.dir}
              >
                {t("projects:gitOpenExternalTool", "打开外部 Git 工具") as string}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  try { if (gitActionErrorDialog.dir) await (window as any).host?.gitWorktree?.openTerminal?.(gitActionErrorDialog.dir); } catch {}
                  closeGitActionErrorDialog();
                }}
                disabled={!gitActionErrorDialog.dir}
              >
                {t("projects:gitOpenTerminal", "在外部终端 / Git Bash 打开") as string}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 通用提示弹窗：用于替代 alert，保持应用整体风格一致 */}
      <Dialog
        open={noticeDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          setNoticeDialog((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{noticeDialog.title || (t("common:notice", "提示") as string)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {noticeDialog.message ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 whitespace-pre-wrap break-words dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-secondary)]">
                {noticeDialog.message}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setNoticeDialog((prev) => ({ ...prev, open: false }))}>
                {t("common:close", "关闭") as string}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={hideProjectConfirm.open} onOpenChange={(open) => {
        setHideProjectConfirm((prev) => ({ open, project: open ? prev.project : null }));
        if (!open) {
          try { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
          try { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true } as any)); } catch {}
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('projects:hideTemporaryTitle')}</DialogTitle>
            <DialogDescription>
              {t('projects:hideTemporaryDescription')}
              {hideProjectConfirm.project?.name && (
                <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-center dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                  <div className="text-sm font-semibold text-slate-900 dark:text-[var(--cf-text-primary)]">
                    {hideProjectConfirm.project.name}
                  </div>
                  {hideProjectConfirm.project.id && dirTreeStore.labelById[hideProjectConfirm.project.id] && (
                    <div className="mt-1 text-xs text-slate-500 dark:text-[var(--cf-text-muted)] truncate">
                      {dirTreeStore.labelById[hideProjectConfirm.project.id]}
                    </div>
                  )}
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setHideProjectConfirm({ open: false, project: null })}>{t('common:cancel')}</Button>
            <Button
              variant="secondary"
              onClick={() => hideProject(hideProjectConfirm.project)}
              disabled={!hideProjectConfirm.project}
            >
              {t('projects:hideTemporaryConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {tabCtxMenu.show && showNotifDebugMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => closeTabContextMenu("backdrop-click")}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); closeTabContextMenu("backdrop-contextmenu"); }}
        >
          <div
            className="absolute z-50"
            style={{ left: tabCtxMenu.x, top: tabCtxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {renderTabContextMenu()}
          </div>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        values={{
          providers: { activeId: activeProviderId, items: providerItems, env: providerEnvById },
          sendMode,
          locale,
          projectPathStyle,
          dragDropWarnOutsideProject,
          theme: themeSetting,
          multiInstanceEnabled,
          notifications: notificationPrefs,
          network: networkPrefs,
          codexAccount: { recordEnabled: codexAccountRecordEnabled },
          terminalFontFamily,
          terminalTheme,
          claudeCodeReadAgentHistory,
          gitWorktree: {
            gitPath: gitWorktreeGitPath,
            externalGitToolId: gitWorktreeExternalGitToolId,
            externalGitToolCustomCommand: gitWorktreeExternalGitToolCustomCommand,
            terminalCommand: gitWorktreeTerminalCommand,
            autoCommitEnabled: gitWorktreeAutoCommitEnabled,
            copyRulesOnCreate: gitWorktreeCopyRulesOnCreate,
          },
        }}
        onSave={async (v) => {
          const nextProviders = v.providers as any;
          const nextSend = v.sendMode;
          const nextStyle = v.projectPathStyle || 'absolute';
          const nextLocale = v.locale;
          const nextWarnOutsideProjectDrop = !!(v as any).dragDropWarnOutsideProject;
          const nextNotifications = normalizeCompletionPrefs(v.notifications);
          const nextFontFamily = normalizeTerminalFontFamily(v.terminalFontFamily);
          const nextTerminalTheme = normalizeTerminalTheme(v.terminalTheme);
          const nextTheme = normalizeThemeSetting(v.theme);
          const nextClaudeAgentHistory = !!v.claudeCodeReadAgentHistory;
          const nextMultiInstanceEnabled = !!v.multiInstanceEnabled;
          const nextGitWorktree = (v as any).gitWorktree || {};
          const nextGitWorktreeGitPath = String(nextGitWorktree.gitPath || "");
          const nextExternalGitToolIdRaw = String(nextGitWorktree.externalGitToolId || "rider").trim().toLowerCase();
          const nextExternalGitToolId: ExternalGitToolId =
            (nextExternalGitToolIdRaw === "rider" || nextExternalGitToolIdRaw === "sourcetree" || nextExternalGitToolIdRaw === "fork" || nextExternalGitToolIdRaw === "gitkraken" || nextExternalGitToolIdRaw === "custom")
              ? (nextExternalGitToolIdRaw as ExternalGitToolId)
              : "rider";
          const nextExternalGitToolCustomCommand = String(nextGitWorktree.externalGitToolCustomCommand || "");
          const nextGitWorktreeTerminalCommand = String(nextGitWorktree.terminalCommand || "");
          const nextGitWorktreeAutoCommitEnabled = nextGitWorktree.autoCommitEnabled !== false;
          const nextGitWorktreeCopyRulesOnCreate = nextGitWorktree.copyRulesOnCreate !== false;
          // 先切换语言（内部会写入 settings 并广播），再持久化其它字段
          try { await (window as any).host?.i18n?.setLocale?.(nextLocale); setLocale(nextLocale); } catch {}
          try {
            const codexItem = Array.isArray(nextProviders?.items) ? nextProviders.items.find((x: any) => x && x.id === "codex") : null;
            const codexResolved = resolveProvider(codexItem ?? { id: "codex" });
            const codexEnv = (nextProviders?.env && nextProviders.env.codex) ? nextProviders.env.codex : (providerEnvById.codex || { terminal: "wsl", distro: wslDistro });
            await window.host.settings.update({
              providers: nextProviders,
              terminal: codexEnv.terminal,
              distro: codexEnv.distro,
              codexCmd: codexResolved.startupCmd || "codex",
              sendMode: nextSend,
              projectPathStyle: nextStyle,
              dragDrop: { warnOutsideProject: nextWarnOutsideProjectDrop },
              theme: nextTheme,
              experimental: { multiInstanceEnabled: nextMultiInstanceEnabled },
              notifications: nextNotifications,
              network: v.network,
              codexAccount: v.codexAccount as any,
              gitWorktree: {
                gitPath: nextGitWorktreeGitPath,
                externalGitTool: { id: nextExternalGitToolId, customCommand: nextExternalGitToolCustomCommand },
                terminalCommand: nextGitWorktreeTerminalCommand,
                autoCommitEnabled: nextGitWorktreeAutoCommitEnabled,
                copyRulesOnCreate: nextGitWorktreeCopyRulesOnCreate,
              },
              terminalFontFamily: nextFontFamily,
              terminalTheme: nextTerminalTheme,
              claudeCode: { readAgentHistory: nextClaudeAgentHistory },
            });
          } catch (e) { console.warn('settings.update failed', e); }
          try {
            const legacyTerminal = normalizeTerminalMode((nextProviders as any)?.env?.codex?.terminal ?? providerEnvById.codex?.terminal ?? terminalMode);
            const legacyDistro = String((nextProviders as any)?.env?.codex?.distro ?? providerEnvById.codex?.distro ?? wslDistro);
            const legacyCodexCmd = String(resolveProvider((nextProviders as any)?.items?.find((x: any) => x && x.id === "codex") ?? { id: "codex" }).startupCmd || codexCmd);
            const normalizedProviders = normalizeProvidersSettings(nextProviders, {
              terminal: legacyTerminal,
              distro: legacyDistro,
              codexCmd: legacyCodexCmd,
            });
            setProviderItems(normalizedProviders.items);
            setProviderEnvById(normalizedProviders.env);
            setActiveProviderId(normalizedProviders.activeId);
            const activeEnv = normalizedProviders.env[normalizedProviders.activeId] || { terminal: legacyTerminal, distro: legacyDistro };
            setTerminalMode(activeEnv.terminal);
            setWslDistro(activeEnv.distro);
            const codexItem = normalizedProviders.items.find((x) => x.id === "codex");
            setCodexCmd(resolveProvider(codexItem ?? { id: "codex" }).startupCmd || legacyCodexCmd);
          } catch {}
          setSendMode(nextSend);
          setProjectPathStyle(nextStyle);
          setDragDropWarnOutsideProject(nextWarnOutsideProjectDrop);
          setThemeSetting(nextTheme);
          writeThemeSettingCache(nextTheme);
          setNotificationPrefs(nextNotifications);
          setNetworkPrefs(v.network);
          setCodexAccountRecordEnabled(!!v.codexAccount?.recordEnabled);
          setMultiInstanceEnabled(nextMultiInstanceEnabled);
          setTerminalFontFamily(nextFontFamily);
          setTerminalTheme(nextTerminalTheme);
          setClaudeCodeReadAgentHistory(nextClaudeAgentHistory);
          setGitWorktreeAutoCommitEnabled(nextGitWorktreeAutoCommitEnabled);
          setGitWorktreeCopyRulesOnCreate(nextGitWorktreeCopyRulesOnCreate);
          setGitWorktreeGitPath(nextGitWorktreeGitPath);
          setGitWorktreeExternalGitToolId(nextExternalGitToolId);
          setGitWorktreeExternalGitToolCustomCommand(nextExternalGitToolCustomCommand);
          setGitWorktreeTerminalCommand(nextGitWorktreeTerminalCommand);
        }}
      />

      {/* 关于 & 支持作者 */}
          <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
            <DialogContent className="max-w-3xl w-[80vw]">
              <DialogHeader>
                <DialogTitle>{t('about:dialogTitle')}</DialogTitle>
              </DialogHeader>
          <AboutSupport onCheckUpdate={({ result, resolvedNotes }) => {
            if (result.status === "update" && result.latest) {
              setUpdateDialog({
                show: true,
                current: result.current || appVersion,
                latest: {
                  version: String(result.latest.version || ""),
                  notes: resolvedNotes ?? result.latest.notes,
                  notesLocales: result.latest.notesLocales,
                  url: result.latest.url
                }
              });
              return;
            }
            if (result.status === "failed" || result.source !== "network") {
              setUpdateErrorDialog({ show: true, reason: result.error?.type ?? "network", message: result.error?.message });
              return;
            }
            setNoUpdateDialog(true);
          }} />
        </DialogContent>
      </Dialog>

      {/* 新版本提示 */}
      <Dialog open={updateDialog.show} onOpenChange={(v) => setUpdateDialog((s) => ({ ...s, show: v }))}>
        <DialogContent className="w-[420px] p-0 overflow-hidden">
          <div className="bg-slate-900 px-6 py-5 text-white">
            <div className="text-xs uppercase tracking-wide text-slate-300">{t('about:update.badge')}</div>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-xl font-semibold">{t('about:update.title', { version: updateDialog.latest?.version || '—' })}</span>
              {updateDialog.current ? <span className="text-xs text-slate-400">{t('about:update.current', { version: updateDialog.current })}</span> : null}
            </div>
            <div className="mt-3 text-xs text-slate-300/80">{t('about:update.intro')}</div>
          </div>
          <div className="px-6 py-5 space-y-4">
            {latestNotesText ? (
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t('about:update.notesTitle')}</div>
                <ScrollArea className="max-h-48 rounded border border-slate-200 bg-slate-50">
                  <div className="whitespace-pre-wrap p-3 text-sm leading-relaxed text-slate-700">
                    {latestNotesText}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <div className="text-sm text-slate-600">{t('about:update.notesFallback')}</div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setUpdateDialog({ show: false })}>{t('about:update.later')}</Button>
              <Button variant="outline" onClick={async () => { try { await (window as any)?.host?.debug?.update?.({ updates: { skipVersion: String(updateDialog.latest?.version || '') } }); } catch {}; setUpdateDialog({ show: false }); }}>{t('about:update.skip')}</Button>
              <Button onClick={() => { try { const u = String(updateDialog.latest?.url || ''); if (u) (window as any).host?.utils?.openExternalUrl?.(u); } catch {}; setUpdateDialog({ show: false }); }}>{t('about:update.download')}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={noUpdateDialog} onOpenChange={setNoUpdateDialog}>
        <DialogContent className="w-[340px] p-0 overflow-hidden">
          <div className="px-6 py-5 text-slate-800">
            <div className="text-sm font-semibold">{t('about:noUpdate.title')}</div>
            <div className="mt-2 text-sm text-slate-600 leading-relaxed">{resolvedNoUpdateMessage}</div>
          </div>
          <div className="flex justify-end border-t border-slate-200 bg-slate-50 px-4 py-3">
            <Button onClick={() => setNoUpdateDialog(false)}>{t('about:noUpdate.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={updateErrorDialog.show}
        onOpenChange={(open) => {
          if (!open) setUpdateErrorDialog({ show: false, reason: "unknown" });
        }}
      >
        <DialogContent className="w-[340px] p-0 overflow-hidden">
          <div className="px-6 py-5 text-slate-800">
            <div className="text-sm font-semibold">{t('about:updateError.title')}</div>
            <div className="mt-2 text-sm text-slate-600 leading-relaxed">{updateErrorMessage}</div>
            {updateErrorDialog.message ? (
              <div className="mt-3 text-xs text-slate-400 break-words">{updateErrorDialog.message}</div>
            ) : null}
          </div>
          <div className="flex justify-end border-t border-slate-200 bg-slate-50 px-4 py-3">
            <Button onClick={() => setUpdateErrorDialog({ show: false, reason: "unknown" })}>{t('about:updateError.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {blockingNotice ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setBlockingNotice(null);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {blockingNotice.type === 'shell-mismatch'
                  ? t('history:resumeShellMismatchTitle')
                  : t('projects:externalConsoleBlockedTitle')}
              </DialogTitle>
              <DialogDescription>
                {blockingNotice.type === 'shell-mismatch'
                  ? t('history:resumeShellMismatch', { expected: blockingNotice.expected, current: blockingNotice.current })
                  : t('projects:externalConsoleBlockedDesc', { env: blockingNotice.env })}
              </DialogDescription>
            </DialogHeader>
            {blockingNotice.type === 'shell-mismatch' ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">{t('history:resumeShellMismatchExpectedLabel')}</span>
                  <span className="font-medium">{blockingNotice.expected}</span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-slate-500">{t('history:resumeShellMismatchCurrentLabel')}</span>
                  <span className="font-medium">{blockingNotice.current}</span>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-slate-700">
                <span>{t('projects:externalConsoleBlockedHint')}</span>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button onClick={() => setBlockingNotice(null)}>{t('common:ok')}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog
        open={!!legacyResumePrompt}
        onOpenChange={(open) => {
          if (!open && !legacyResumeLoading) setLegacyResumePrompt(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('history:legacyResumeTitle')}</DialogTitle>
            <DialogDescription>{t('history:legacyResumeDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-slate-600">
            <p>{t('history:legacyResumeBody')}</p>
            <div className="rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700">npx --yes @openai/codex@0.31.0</div>
	            <p>
	              {legacyResumePrompt?.mode === 'external'
	                ? t('history:legacyResumeExternalHint', { env: resolveResumeShellLabel(legacyResumePrompt?.filePath) })
	                : t('history:legacyResumeInternalHint')}
	            </p>
	          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={cancelLegacyResume} disabled={legacyResumeLoading}>
              {t('history:legacyResumeCancel')}
            </Button>
            <Button onClick={confirmLegacyResume} disabled={legacyResumeLoading}>
              {legacyResumeLoading ? t('history:legacyResumeWorking') : t('history:legacyResumeConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 发送行为说明：当前"发送并确认"仅为文案，逻辑仍为直接写入并回车；如需真正的确认弹窗，后续在此处接入。 */}
    </TooltipProvider>
  );
}

// ---------- Subcomponents ----------

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation(['projects']);
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <TerminalSquare className="mb-3 h-10 w-10 text-slate-400" />
      <div className="text-lg font-medium">{t('projects:selectProjectLeft')}</div>
      <div className="mt-1 text-sm text-slate-500">{t('projects:createOneToStart')}</div>
      <Button className="mt-4" onClick={onCreate}>
        {t('projects:openProject')}
      </Button>
    </div>
  );
}

type FieldMatch = {
  matchId: string;
  start: number;
  length: number;
};

type FieldMatchMap = Record<string, FieldMatch[]>;

function highlightSearchMatches(text: string, matches?: FieldMatch[], activeMatchId?: string): React.ReactNode {
  const value = String(text || "");
  if (!matches || matches.length === 0) return value;
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  let counter = 0;
  for (const span of sorted) {
    const start = Math.max(0, Math.min(span.start, value.length));
    const end = Math.max(start, Math.min(start + span.length, value.length));
    if (start > cursor) {
      fragments.push(<React.Fragment key={`text-${counter++}`}>{value.slice(cursor, start)}</React.Fragment>);
    }
    if (start === end) continue;
    const isActive = span.matchId === activeMatchId;
    fragments.push(
      <span
        key={`match-${span.matchId}`}
        data-match-id={span.matchId}
        className={`rounded-apple px-1 py-0.5 transition-all duration-200 ${isActive ? 'bg-[var(--cf-accent)] text-white font-apple-semibold ring-2 ring-[var(--cf-accent)]/50 ring-offset-1 shadow-lg' : 'bg-yellow-200/80 dark:bg-yellow-500/30 text-[var(--cf-text-primary)] font-apple-medium'}`}
      >
        {value.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < value.length) {
    fragments.push(<React.Fragment key={`text-${counter++}`}>{value.slice(cursor)}</React.Fragment>);
  }
  return fragments.length > 0 ? fragments : value;
}

function ContentRenderer({ items, kprefix, fieldMatches, activeMatchId }: { items: MessageContent[]; kprefix?: string; fieldMatches?: FieldMatchMap; activeMatchId?: string }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const buildFieldKey = (suffix: string) => `${kprefix || 'itm'}-${suffix}`;
  const highlightText = (value: string, suffix: string) => highlightSearchMatches(value, fieldMatches?.[buildFieldKey(suffix)], activeMatchId);
  return (
    <div className="space-y-2">
      {items.map((c, i) => {
        const ty = (c?.type || '').toLowerCase();
        const text = String(c?.text ?? '');
        if (ty === 'user_instructions') {
          // 展开显示 user_instructions（移除折叠）
          return (
            <div key={`${kprefix || 'itm'}-uinst-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>user_instructions</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        // 修复：原先误用未定义变量 t，应使用已归一化的小写类型 ty
        if (ty === 'environment_context') {
          // 展开显示 environment_context（移除折叠）
          return (
            <div key={`${kprefix || 'itm'}-env-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>environment_context</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        if (ty === 'instructions') {
          // 展开显示 instructions（移除折叠）
          return (
            <div key={`${kprefix || 'itm'}-instr-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>instructions</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        if (ty === 'code') {
          return (
            <div key={`${kprefix || 'itm'}-code-${i}`} className="relative">
              <HistoryCopyButton text={text} variant="secondary" className="absolute right-2 top-2" />
              <pre className="overflow-x-auto rounded-apple bg-[var(--cf-surface-muted)] border border-[var(--cf-border)] p-3 text-xs text-[var(--cf-text-primary)] font-mono shadow-apple-inner">
                <code>{highlightText(text, `item-${i}`)}</code>
              </pre>
            </div>
          );
        }
        if (ty === 'function_call') {
          // 展开显示 function_call
          return (
            <div key={`${kprefix || 'itm'}-fnc-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-accent-light)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-accent)] font-apple-semibold">
                <div>function_call</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        if (ty === 'function_output') {
          // 展开显示 function_output
          return (
            <div key={`${kprefix || 'itm'}-fno-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-teal-light)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-teal)] font-apple-semibold">
                <div>function_output</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        if (ty === 'summary') {
          return (
            <div key={`${kprefix || 'itm'}-sum-${i}`} className="relative rounded-apple border border-[var(--cf-border)] bg-[var(--cf-purple-light)] p-2 text-xs text-[var(--cf-text-primary)] font-apple-regular">
              <HistoryCopyButton text={text} className="absolute right-2 top-2" />
              {highlightText(text, `item-${i}`)}
            </div>
          );
        }
        if (ty === 'git') {
          // 展开显示 git
          return (
            <div key={`${kprefix || 'itm'}-git-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>git</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        if (ty === 'input_text') {
          return (
            <div key={`${kprefix || 'itm'}-in-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-3 text-sm leading-6 text-[var(--cf-text-primary)] shadow-apple-xs">
              <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wider text-[var(--cf-text-secondary)] font-apple-semibold">
                <span>input</span>
                <HistoryCopyButton text={text} />
              </div>
              <div className="whitespace-pre-wrap break-words font-apple-regular">{highlightText(text, `item-${i}`)}</div>
            </div>
          );
        }
        if (ty === 'output_text') {
          return (
            <div key={`${kprefix || 'itm'}-out-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-3 text-sm leading-6 text-[var(--cf-text-primary)] shadow-apple-xs">
              <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wider text-[var(--cf-text-secondary)] font-apple-semibold">
                <span>output</span>
                <HistoryCopyButton text={text} />
              </div>
              <div className="whitespace-pre-wrap break-words font-apple-regular">{highlightText(text, `item-${i}`)}</div>
            </div>
          );
        }
        if (ty === 'state') {
          // 展开显示 state
          return (
            <div key={`${kprefix || 'itm'}-state-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>state</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code>{highlightText(text, `item-${i}`)}</code>
              </pre>
            </div>
          );
        }
        if (ty === 'session_meta') {
          // 展开显示 session_meta
          return (
            <div key={`${kprefix || 'itm'}-meta-${i}`} className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] p-2 text-xs text-[var(--cf-text-primary)]">
              <div className="flex items-center justify-between text-[var(--cf-text-secondary)] font-apple-medium">
                <div>session_meta</div>
                <HistoryCopyButton text={text} />
              </div>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular"><code>{highlightText(text, `item-${i}`)}</code></pre>
            </div>
          );
        }
        // default: treat as plain text, including input_text/output_text etc.
        return (
          <div key={`${kprefix || 'itm'}-txt-${i}`} className="relative">
            <HistoryCopyButton text={text} className="absolute right-0 -top-1" />
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--cf-text-primary)] font-apple-regular">{highlightText(text, `item-${i}`)}</p>
          </div>
        );
      })}
    </div>
  );
}

type SearchMatch = {
  id: string;
  messageKey: string;
  fieldKey?: string;
};

type HistoryFilterResult = {
  messages: HistoryMessage[];
  matches: SearchMatch[];
  fieldMatches: FieldMatchMap;
};

type HistoryRenderOptions = {
  fieldMatches?: FieldMatchMap;
  activeMessageKey?: string;
  activeMatchId?: string;
  registerMessageRef?: (key: string, node: HTMLDivElement | null) => void;
};

function renderHistoryBlocks(session: HistorySession, messages: HistoryMessage[], options?: HistoryRenderOptions) {
  if (!session) return null;
  return (
    <div>
      {/* 详情标题：显示本地时间（优先 rawDate -> date -> 文件名推断），tooltip 同时展示本地与原始信息 */}
      <h3 className="mb-1.5 max-w-full truncate text-sm font-apple-medium text-[var(--cf-text-secondary)]" title={`${toLocalDisplayTime(session)} ${session.rawDate ? '• ' + session.rawDate : (session.date ? '• ' + session.date : '')}`}>
        {toLocalDisplayTime(session)}
      </h3>
      <div className="space-y-2">
        {messages.map((m, i) => {
          const messageKey = `${session.id}-${i}`;
          const isActive = options?.activeMessageKey === messageKey;
          const roleFieldKey = `${messageKey}-role`;
          const roleText = highlightSearchMatches(m.role, options?.fieldMatches?.[roleFieldKey], options?.activeMatchId);
          return (
            <div
              key={messageKey}
              ref={(node) => options?.registerMessageRef?.(messageKey, node)}
              className={`rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-2 shadow-apple-sm text-[var(--cf-text-primary)] transition-all duration-apple hover:shadow-apple dark:shadow-apple-dark-sm dark:hover:shadow-apple-dark ${isActive ? 'ring-1 ring-[var(--cf-accent)]/70 shadow-apple dark:ring-[var(--cf-accent)]/40' : ''}`}
            >
              <div className="mb-1 text-xs uppercase tracking-wider font-apple-semibold text-[var(--cf-text-secondary)]">{roleText}</div>
              <ContentRenderer items={m.content} kprefix={messageKey} fieldMatches={options?.fieldMatches} activeMatchId={options?.activeMatchId} />
            </div>
          );
        })}
      </div>
    </div>
  );
}


function filterHistoryMessages(session: HistorySession, typeFilter: Record<string, boolean>, normalizedSearch: string): HistoryFilterResult {
  const allowItem = (item: any) => {
    if (!typeFilter) return true;
    const keys = keysOfItemCanonical(item);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(typeFilter, key) && !!(typeFilter as any)[key]) return true;
    }
    return !!(typeFilter as any)["other"];
  };

  const candidateMessages = (session.messages || []).map((m) => ({
    ...m,
    content: (m.content || []).filter((item) => allowItem(item)),
  }));

  const nonEmptyMessages = candidateMessages.filter((m) =>
    Array.isArray(m.content) && m.content.some((item) => String((item as any)?.text ?? "").trim().length > 0),
  );

  const matches: SearchMatch[] = [];
  const fieldMatches: FieldMatchMap = {};
  let matchCounter = 0;

  const addFieldMatch = (fieldKey: string, matchId: string, start: number, length: number) => {
    const next = fieldMatches[fieldKey] || [];
    next.push({ matchId, start, length });
    fieldMatches[fieldKey] = next;
  };

  const captureTextMatches = (messageKey: string, fieldKey: string, value: string): boolean => {
    if (!normalizedSearch) return false;
    const lower = String(value).toLowerCase();
    if (!lower) return false;
    let idx = lower.indexOf(normalizedSearch);
    let found = false;
    while (idx !== -1) {
      found = true;
      const matchId = `${fieldKey}-${matchCounter++}`;
      matches.push({ id: matchId, messageKey, fieldKey });
      addFieldMatch(fieldKey, matchId, idx, normalizedSearch.length);
      idx = lower.indexOf(normalizedSearch, idx + normalizedSearch.length);
    }
    return found;
  };

  const captureMetaMatch = (messageKey: string, descriptor: string): boolean => {
    const matchId = `${messageKey}-${descriptor}-${matchCounter++}`;
    matches.push({ id: matchId, messageKey });
    return true;
  };

  const filteredMessages: HistoryMessage[] = [];
  const searchActive = normalizedSearch.length > 0;
  for (const message of nonEmptyMessages) {
    if (!searchActive) {
      filteredMessages.push(message);
      continue;
    }
    const projectedIndex = filteredMessages.length;
    const messageKey = `${session.id}-${projectedIndex}`;
    let hit = false;
    if (message.role) {
      if (captureTextMatches(messageKey, `${messageKey}-role`, message.role)) hit = true;
    }
    for (let itemIndex = 0; itemIndex < (message.content || []).length; itemIndex += 1) {
      const item = message.content?.[itemIndex];
      const fieldKey = `${messageKey}-item-${itemIndex}`;
      const text = String((item as any)?.text ?? "");
      if (captureTextMatches(messageKey, fieldKey, text)) hit = true;
      const type = String((item as any)?.type ?? "").toLowerCase();
      if (type && type.includes(normalizedSearch)) {
        hit = captureMetaMatch(messageKey, `type-${itemIndex}`) || hit;
      }
      const tags = Array.isArray((item as any)?.tags) ? (item as any).tags : [];
      for (const tag of tags) {
        if (String(tag ?? "").toLowerCase().includes(normalizedSearch)) {
          hit = captureMetaMatch(messageKey, `tag-${itemIndex}-${tag}`) || hit;
        }
      }
    }
    if (hit) {
      filteredMessages.push(message);
    }
  }

  return { messages: filteredMessages, matches, fieldMatches };
}

function HistoryDetail({ sessions, selectedHistoryId, onBack, onResume, onResumeExternal, getResumeShellLabel }: { sessions: HistorySession[]; selectedHistoryId: string | null; onBack?: () => void; onResume?: (filePath?: string) => void; onResumeExternal?: (filePath?: string) => void; getResumeShellLabel: (filePath?: string) => ShellLabel }) {
  const { t } = useTranslation(['history', 'common']);
  const MAX_HISTORY_MESSAGE_CACHE = 5;
  const [loaded, setLoaded] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const [localSessions, setLocalSessions] = useState<HistorySession[]>(() => sessions.map((s) => ({ ...s, messages: [] })));
  const messageCacheIdsRef = useRef<string[]>([]);
  const pruneMessages = useCallback((list: HistorySession[], allowed: Set<string>) => {
    if (!Array.isArray(list) || list.length === 0) return list;
    if (allowed.size === 0) return list.map((s) => ({ ...s, messages: [] }));
    return list.map((s) => (allowed.has(s.id) ? s : { ...s, messages: [] }));
  }, []);
  const touchMessageCache = useCallback((id?: string | null) => {
    if (!id) return messageCacheIdsRef.current;
    const next = messageCacheIdsRef.current.filter((x) => x !== id);
    next.unshift(id);
    if (next.length > MAX_HISTORY_MESSAGE_CACHE) next.length = MAX_HISTORY_MESSAGE_CACHE;
    messageCacheIdsRef.current = next;
    return messageCacheIdsRef.current;
  }, [MAX_HISTORY_MESSAGE_CACHE]);
  const [typeFilter, setTypeFilter] = useState<Record<string, boolean>>({});
  const [detailSearch, setDetailSearch] = useState("");
  const reqSeq = useRef(0);
  const lastLoadedFingerprintRef = useRef<string>("");
  const selectedSession = useMemo(() => sessions.find((x) => x.id === selectedHistoryId) || null, [sessions, selectedHistoryId]);
  const selectedLocalSession = useMemo(
    () => localSessions.find((x) => x.id === selectedHistoryId) || null,
    [localSessions, selectedHistoryId],
  );
  const selectedSessionFingerprint = useMemo(() => {
    if (!selectedSession) return "none";
    return [
      selectedSession.providerId,
      selectedSession.id,
      selectedSession.filePath || "",
      selectedSession.date || "",
      selectedSession.resumeMode || "",
      selectedSession.resumeId || "",
      selectedSession.preview || "",
      selectedSession.rawDate || "",
      selectedSession.runtimeShell || "",
    ].join("|");
  }, [selectedSession]);

  // 刷新列表时保留已加载的消息内容，避免详情面板闪烁
  useEffect(() => {
    const filteredIds = messageCacheIdsRef.current.filter((id) => sessions.some((s) => s.id === id));
    messageCacheIdsRef.current = filteredIds;
    const allowed = new Set(filteredIds);
    setLocalSessions((cur) => {
      const prevMap = new Map(cur.map((x) => [x.id, x]));
      const merged = sessions.map((s) => {
        const prev = prevMap.get(s.id);
        if (!prev) return allowed.has(s.id) ? s : { ...s, messages: [] };
        const prevMsgs = Array.isArray(prev.messages) ? prev.messages : [];
        const nextMsgs = Array.isArray(s.messages) ? s.messages : [];
        if (allowed.has(s.id) && nextMsgs.length === 0 && prevMsgs.length > 0) return { ...s, messages: prevMsgs };
        if (!allowed.has(s.id)) return { ...s, messages: [] };
        return s;
      });
      return pruneMessages(merged, allowed);
    });
  }, [sessions, pruneMessages]);

  useEffect(() => {
    setDetailSearch("");
  }, [selectedHistoryId]);

  const detailSession = selectedLocalSession || selectedSession;
  const normalizedDetailSearch = useMemo(() => detailSearch.trim().toLowerCase(), [detailSearch]);
  const detailSearchActive = normalizedDetailSearch.length > 0;

  const filteredHistory = useMemo(() => {
    if (!detailSession) return { messages: [], matches: [], fieldMatches: {} };
    return filterHistoryMessages(detailSession, typeFilter, normalizedDetailSearch);
  }, [selectedHistoryId, detailSession, typeFilter, normalizedDetailSearch]);

  const filteredMessages = filteredHistory.messages;
  const matches = filteredHistory.matches;
  const fieldMatches = filteredHistory.fieldMatches;
  const showNoMatch = detailSearchActive && filteredMessages.length === 0;

  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const registerMessageRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) {
      messageRefs.current[key] = node;
    } else {
      delete messageRefs.current[key];
    }
  }, []);

  useEffect(() => {
    messageRefs.current = {};
  }, [detailSession, filteredMessages.length]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [detailSearchActive]);

  useEffect(() => {
    if (matches.length === 0) {
      if (activeMatchIndex !== 0) setActiveMatchIndex(0);
      return;
    }
    if (activeMatchIndex >= matches.length) {
      setActiveMatchIndex(matches.length - 1);
    }
  }, [matches.length, activeMatchIndex]);

  const normalizedMatchIndex = matches.length === 0 ? 0 : Math.min(activeMatchIndex, matches.length - 1);
  const activeMatch = matches[normalizedMatchIndex] || null;

  useEffect(() => {
    if (!detailSearchActive || !activeMatch) return;
    requestAnimationFrame(() => {
      try {
        const el = document.querySelector(`[data-match-id="${activeMatch.id}"]`) as HTMLElement | null;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          return;
        }
        const node = messageRefs.current[activeMatch.messageKey];
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch {}
    });
  }, [detailSearchActive, activeMatch?.id, activeMatch?.messageKey]);

  const goToNextMatch = useCallback(() => {
    if (!matches.length) return;
    setActiveMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (!matches.length) return;
    setActiveMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!detailSearchActive || !matches.length) return;
      const key = event.key;
      const isF3 = key === 'F3';
      const isCtrlG = key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey);
      if (isF3 && !event.shiftKey) {
        event.preventDefault();
        goToNextMatch();
        return;
      }
      if (isF3 && event.shiftKey) {
        event.preventDefault();
        goToPrevMatch();
        return;
      }
      if (isCtrlG && event.shiftKey) {
        event.preventDefault();
        goToPrevMatch();
        return;
      }
      if (isCtrlG && !event.shiftKey) {
        event.preventDefault();
        goToNextMatch();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [detailSearchActive, matches.length, goToNextMatch, goToPrevMatch]);

  useEffect(() => {
    if (!selectedHistoryId || !selectedSession || !selectedSession.filePath) return;
    const signature = selectedSessionFingerprint;
    const hasMessages = !!(selectedLocalSession && Array.isArray(selectedLocalSession.messages) && selectedLocalSession.messages.length > 0);
    if (hasMessages && lastLoadedFingerprintRef.current === signature) return;
    setLoaded(false);
    const seq = ++reqSeq.current;
    (async () => {
      try {
        const res: any = await window.host.history.read({ filePath: String(selectedSession.filePath || ''), providerId: selectedSession.providerId });
        const msgs = (res.messages || []).map((m: any) => ({ role: m.role as any, content: m.content }));
        if (seq === reqSeq.current) {
          const allowedIds = new Set(touchMessageCache(selectedHistoryId));
          setLocalSessions((cur) => {
            const next = cur.map((x) => (x.id === selectedHistoryId ? { ...x, messages: msgs } : x));
            return pruneMessages(next, allowedIds);
          });
          setSkipped(res.skippedLines || 0);
          setLoaded(true);
          lastLoadedFingerprintRef.current = signature;
        }
        try {
          const allKeys = new Set<string>();
          for (const mm of msgs) {
            for (const it of (mm.content || [])) for (const k of keysOfItemCanonical(it)) allKeys.add(k);
          }
          // 去重策略：若同时存在 base 与 message.<base>，则仅保留 base（避免重复展示）。
          const BASES = new Set(['input_text','output_text','text','code','json','instructions','environment_context','summary']);
          const hasBase = (b: string) => allKeys.has(b);
          const filtered: string[] = [];
          for (const k of Array.from(allKeys)) {
            if (k.startsWith('message.')) {
              const tail = k.slice('message.'.length);
              if (BASES.has(tail) && hasBase(tail)) continue;
            }
            filtered.push(k);
          }
          filtered.sort();
          // 默认仅勾选 input_text 与 output_text，以突出用户与助手的主要对话内容
          const next: Record<string, boolean> = {};
          for (const k of filtered) next[k] = (k === 'input_text' || k === 'output_text');
          if (seq === reqSeq.current) setTypeFilter(next);
        } catch {}
      } catch (e) {
        console.warn('history.read failed', e);
        if (seq === reqSeq.current) setLoaded(true);
      }
    })();
  }, [selectedHistoryId, selectedSession, selectedSessionFingerprint, selectedLocalSession, pruneMessages, touchMessageCache]);

  function buildFilteredText(): string {
    if (!selectedHistoryId) return '';
    const s = localSessions.find((x) => x.id === selectedHistoryId);
    if (!s) return '';
    const allowItem = (it: any) => {
      const keys = keysOfItemCanonical(it);
      for (const k of keys) { if (Object.prototype.hasOwnProperty.call(typeFilter, k) && !!typeFilter[k]) return true; }
      return !!typeFilter['other'];
    };
    const lines: string[] = [];
    // 导出头部：首行标题保留原有 title；Date 行显示本地时间，并附原始（若有）
    lines.push(`# ${s.title}`);
    const local = toLocalDisplayTime(s);
    const raw = s?.rawDate ? s.rawDate : (s?.date ? String(s.date) : '');
    lines.push(`Date: ${local}${raw ? ` (raw: ${raw})` : ''}`);
    for (const m of (s.messages || [])) {
      const items = (m.content || []).filter((it) => allowItem(it));
      if (items.length === 0) continue;
      lines.push(`\n[${m.role}]`);
      for (const it of items) {
        const header = (it as any)?.type ? `${(it as any).type}:` : '';
        lines.push(header);
        lines.push(String((it as any)?.text ?? ''));
      }
    }
    return lines.join("\n");
  }

  const [filtersExpanded, setFiltersExpanded] = useState(false);

  return (
    <>
      <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr]">
      {/* 紧凑的标题栏 - 减少垂直间距 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--cf-border)]">
        <div className="flex items-center gap-2 text-sm">
          {/* 返回箭头：点击返回到控制台 */}
          <button className="flex items-center gap-2 text-sm font-apple-medium text-[var(--cf-text-secondary)] hover:text-[var(--cf-text-primary)] transition-colors duration-apple" onClick={() => { if (onBack) onBack(); }} aria-label={t('history:detailTitle') as string}>
            <ChevronLeft className="h-4 w-4" /> <span>{t('history:detailTitle')}</span>
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {detailSession?.filePath ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => {
                try {
                  if (!selectedHistoryId) return;
                  const s = localSessions.find((x) => x.id === selectedHistoryId);
                  if (!s || !s.filePath) return;
                  onResume?.(s.filePath);
                } catch {}
              }}>{t('history:continueConversation')}</Button>
              <Button size="sm" variant="secondary" onClick={() => {
                try {
                  if (!selectedHistoryId) return;
                  const s = localSessions.find((x) => x.id === selectedHistoryId);
                  if (!s || !s.filePath) return;
                  onResumeExternal?.(s.filePath);
                } catch {}
              }}>{t('history:continueExternalWith', { env: getResumeShellLabel(detailSession?.filePath) })}</Button>
            </>
          ) : null}
          <Button size="sm" variant="secondary" onClick={async () => {
            const text = buildFilteredText();
            try { await window.host.utils.copyText(text); } catch { try { await navigator.clipboard.writeText(text); } catch {} }
          }}>{t('history:copyAll')}</Button>
          <Button size="sm" variant="secondary" onClick={async () => {
            const text = buildFilteredText();
            try { await window.host.utils.saveText(text, `${selectedHistoryId || 'history'}.txt`); } catch {}
          }}>{t('history:export')}</Button>
        </div>
      </div>

      {/* 紧凑的过滤和搜索区域 */}
      <div className="flex flex-col gap-1.5 px-3 py-1.5 text-xs text-[var(--cf-text-secondary)] bg-[var(--cf-bg-secondary)]">
        {/* 第一行：搜索框和过滤器切换 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Input
              value={detailSearch}
              onChange={(e) => setDetailSearch((e.target as HTMLInputElement).value)}
              placeholder={t('history:detailSearchPlaceholder') as string}
              title={t('history:detailSearchHint') as string}
              aria-label={t('history:detailSearchHint') as string}
              className="pl-8 h-8 text-xs"
            />
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-muted)]" />
          </div>
          
          {detailSearchActive && matches.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="text-[0.65rem] text-[var(--cf-text-muted)] font-apple-medium whitespace-nowrap">
                {normalizedMatchIndex + 1} / {matches.length}
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={goToPrevMatch}
                  disabled={matches.length === 0}
                  className="h-6 w-6"
                  title="上一个 (Shift+F3 / Ctrl+Shift+G)"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={goToNextMatch}
                  disabled={matches.length === 0}
                  className="h-6 w-6"
                  title="下一个 (F3 / Ctrl+G)"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
          
          {detailSearchActive && matches.length === 0 && (
            <div className="text-[0.65rem] text-[var(--cf-text-muted)] font-apple-regular whitespace-nowrap">
              {t('history:detailSearchMatches', { count: 0 })}
            </div>
          )}

          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-[var(--cf-text-muted)] font-apple-medium whitespace-nowrap">{Object.values(typeFilter).filter(Boolean).length}/{Object.keys(typeFilter).length}</span>
            <Button 
              size="sm" 
              variant="ghost" 
              className="h-7 px-2 text-xs"
              onClick={() => setFiltersExpanded(!filtersExpanded)}
            >
              {t('history:filterTypes')} {filtersExpanded ? '▼' : '▶'}
            </Button>
          </div>
        </div>

        {/* 可折叠的过滤器区域 - 苹果风格设计 */}
        {filtersExpanded && (
          <div className="animate-in slide-in-from-top-1 duration-300 ease-apple">
            <div className="mx-2 mt-1 rounded-xl bg-white/5 backdrop-blur-sm border border-white/10 shadow-lg shadow-black/5 p-2">
              {/* 头部：操作按钮组 + 关闭按钮 */}
              <div className="flex items-center justify-between gap-1.5 mb-2">
                <div className="flex items-center gap-2">
                  <Button 
                    size="xs"
                    variant="outline"
                    className="h-7 px-2 text-xs font-medium"
                    onClick={() => {
                      const keys = Object.keys(typeFilter);
                      const next: Record<string, boolean> = {};
                      for (const k of keys) next[k] = true;
                      setTypeFilter(next);
                    }}
                  >
                    {t('history:selectAll')}
                  </Button>
                  <Button 
                    size="xs"
                    variant="outline"
                    className="h-7 px-2 text-xs font-medium"
                    onClick={() => {
                      const keys = Object.keys(typeFilter);
                      const next: Record<string, boolean> = {};
                      for (const k of keys) next[k] = false;
                      setTypeFilter(next);
                    }}
                  >
                    {t('history:deselectAll')}
                  </Button>
                  <Button 
                    size="xs"
                    variant="outline"
                    className="h-7 px-2 text-xs font-medium"
                    onClick={() => {
                      const keys = Object.keys(typeFilter);
                      setTypeFilter((cur) => {
                        const next: Record<string, boolean> = {};
                        for (const k of keys) next[k] = !cur[k];
                        return next;
                      });
                    }}
                  >
                    {t('history:invertSelection')}
                  </Button>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setFiltersExpanded(false)}
                  className="shrink-0"
                  title={t('common:close') as string}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* 紧凑的复选框网格 */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-1.5 gap-y-1">
                {Object.keys(typeFilter).length > 0 ? (
                  Object.keys(typeFilter).sort().map((k) => (
                    <label 
                      key={k} 
                      className="flex items-center gap-1 cursor-pointer group hover:bg-white/5 rounded-md px-1 py-0.5 transition-all duration-200 ease-apple"
                    >
                      {/* 紧凑的复选框 */}
                      <div className="relative flex-shrink-0">
                        <input 
                          type="checkbox" 
                          className="sr-only peer" 
                          checked={!!typeFilter[k]} 
                          onChange={(e) => setTypeFilter((cur) => ({ ...cur, [k]: e.target.checked }))} 
                        />
                        <div className={`w-3.5 h-3.5 rounded border transition-all duration-200 ease-apple ${
                          typeFilter[k] 
                            ? 'bg-[var(--cf-accent)] border-[var(--cf-accent)] shadow-sm shadow-[var(--cf-accent)]/20' 
                            : 'border-[var(--cf-border)] group-hover:border-[var(--cf-accent)]/50 bg-transparent'
                        }`}>
                          {typeFilter[k] && (
                            <svg 
                              className="w-3.5 h-3.5 text-white" 
                              fill="none" 
                              stroke="currentColor" 
                              strokeWidth="3" 
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <span className="text-[0.68rem] font-apple-regular text-[var(--cf-text-primary)] truncate leading-tight">
                        {k}
                      </span>
                    </label>
                  ))
                ) : (
                  <div className="col-span-full flex items-center justify-center py-2 text-[var(--cf-text-muted)] font-apple-regular text-[0.68rem]">
                    {t('history:loadingFilters')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ScrollArea key={selectedHistoryId || 'none'} className="h-full min-h-0 p-2">
        {selectedHistoryId ? (
          showNoMatch ? (
            <div className="p-4 text-sm text-[var(--cf-text-secondary)] font-apple-regular">{t('history:noMatch')}</div>
          ) : (
            <div className="space-y-2">
              {detailSession
                ? renderHistoryBlocks(detailSession, filteredMessages, {
                    fieldMatches,
                    activeMessageKey: detailSearchActive ? activeMatch?.messageKey : undefined,
                    activeMatchId: detailSearchActive ? activeMatch?.id : undefined,
                    registerMessageRef,
                  })
                : (selectedSession
                    ? renderHistoryBlocks(selectedSession, filteredMessages, {
                        fieldMatches,
                        activeMessageKey: detailSearchActive ? activeMatch?.messageKey : undefined,
                        activeMatchId: detailSearchActive ? activeMatch?.id : undefined,
                        registerMessageRef,
                      })
                    : null)
              }
              {loaded && skipped > 0 && <div className="text-xs text-[var(--cf-text-secondary)] font-apple-regular">{t('history:skippedLines', { count: skipped })}</div>}
            </div>
          )
        ) : (
          <div className="p-4 text-sm text-[var(--cf-text-secondary)] font-apple-regular">{t('history:selectRightToView')}</div>
        )}
      </ScrollArea>
      </div>
    </>
  );
}

function OpenProjectDialog({ onAdd }: { onAdd: (name: string, winPath: string) => void }) {
  const { t } = useTranslation(['common']);
  // 现在"新建"改为"打开项目"：弹出系统选择目录对话，选中后加入项目并打开控制台
  const [loading, setLoading] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          setLoading(true);
          const res: any = await (window.host.utils as any).chooseFolder();
          if (!(res && res.ok && res.path)) { setLoading(false); return; }
          const winPath = String(res.path || '').trim();
          if (!winPath) { setLoading(false); return; }
          // 调用主进程保存项目记录
          const added: any = await window.host.projects.add({ winPath });
          if (added && added.ok && added.project) {
            const name = added.project.name || (winPath.split(/[/\\]/).pop() || winPath);
            onAdd(name, added.project.winPath || winPath);
          } else if (added && added.project) {
            const name = added.project.name || (winPath.split(/[/\\]/).pop() || winPath);
            onAdd(name, added.project.winPath || winPath);
          }
        } catch (e) {
          console.warn('open project failed', e);
        } finally { setLoading(false); }
      }}
    >
      <Plus className="mr-2 h-4 w-4" /> {t('common:open')}
    </Button>
  );
}
