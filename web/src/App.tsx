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
  FilePenLine,
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
import { resolveStartupCmdWithYolo } from "@/lib/providers/yolo";
import { injectCodexTraceEnv } from "@/providers/codex/commands";
import { buildClaudeResumeStartupCmd } from "@/providers/claude/commands";
import { buildGeminiResumeStartupCmd } from "@/providers/gemini/commands";
import {
  BUILT_IN_RULE_PROVIDER_IDS,
  getProjectRuleFilePath,
  getProviderRuleFileName,
  type BuiltInRuleProviderId,
} from "@/lib/engine-rules";
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
import {
  clearWorktreeCreatePromptPrefs,
  loadWorktreeCreatePrefs,
  saveWorktreeCreatePrefs,
  type PersistedWorktreePromptChip,
  type WorktreeCreatePrefs,
} from "@/lib/worktree-create-prefs";
import {
  loadWorktreeDeletePrefs,
  saveWorktreeDeletePrefs,
} from "@/lib/worktree-delete-prefs";
import type {
  AppSettings,
  BuildRunCommandConfig,
  DirBuildRunConfig,
  DirTreeStore,
  GitDirInfo,
  Project,
  ProviderItem,
  ProviderEnv,
  WorktreeCreateTaskItemSnapshot,
  WorktreeCreateTaskItemStatus,
  WorktreeCreateTaskSnapshot,
  WorktreeCreateTaskStatus,
  WorktreeRecycleTaskSnapshot,
  WorktreeRecycleTaskStatus,
} from "@/types/host";
import type { TerminalThemeId } from "@/types/terminal-theme";

import {
  clampText,
  DEFAULT_COMPLETION_PREFS,
  HISTORY_TITLE_MAX_CHARS,
  HISTORY_UNKNOWN_GROUP_KEY,
  INPUT_FULLSCREEN_TRANSITION_MS,
  MAX_OSC_BUFFER_LENGTH,
  MiniIconButton,
  OSC_BUFFER_SOFT_LIMIT,
  OSC_NOTIFICATION_PREFIX,
  OSC_TAIL_WINDOW,
  OSC_TERMINATOR_BEL,
  OSC_TERMINATOR_ST,
  PROJECT_SORT_STORAGE_KEY,
  StatusDot,
  TAB_FOCUS_DELAY,
  TerminalView,
  WorktreeControlPad,
  areStringArraysEqual,
  buildAutoCommitMessage,
  buildProviderNotifyEnv,
  buildProviderItemIndex,
  buildProviderStartupCmdWithInitialPrompt,
  buildWorktreeProviderQueue,
  canonicalFilterKey,
  canonicalizePath,
  collapseWorktreeProviderQueueToInstances,
  compileWorktreePromptText,
  describeRelativeAge,
  fmtIsoDateTime,
  formatAsLocal,
  formatBranchLabel,
  getDir,
  getProviderIconSrc,
  historySessionDate,
  historyTimelineGroupKey,
  inferSessionUuid,
  isAgentCompletionMessage,
  isWindowsLike,
  isUuidLike,
  keysOfItemCanonical,
  normDir,
  normalizeCompletionPrefs,
  normalizeCompletionPreview,
  normalizeDirTreeStore,
  normalizeMsToIso,
  normalizeResumeMode,
  normalizeTerminalMode,
  normalizeThemeSetting,
  parseDateFromFilename,
  parseRawDate,
  parseRecycleStashes,
  pickUuidFromString,
  resolveHistoryTimelineMeta,
  startOfLocalDay,
  summarizeForCommitMessage,
  sumWorktreeProviderCounts,
  timeFromFilename,
  toDirKeyForCache,
  toLocalDisplayTime,
  toShellLabel,
  toWorktreePromptRelPath,
  toWindowsResumePath,
  trimSelectedIdsByOrder,
  uid,
} from "@/app/app-shared";
import type {
  BaseWorktreeDirtyDialogState,
  BlockingNotice,
  BuildRunAction,
  BuildRunDialogState,
  CompletionPreferences,
  ConsoleTab,
  DirLabelDialogState,
  ExternalGitToolId,
  ForkPointOption,
  GitActionErrorDialogState,
  GitWorktreeProviderId,
  HistoryMessage,
  HistorySession,
  HistoryTimelineBucket,
  HistoryTimelineGroup,
  HistoryTimelineMeta,
  InputFullscreenCloseOptions,
  LegacyResumePrompt,
  MessageContent,
  NetworkPrefs,
  NoticeDialogState,
  ProjectSortKey,
  ResumeExecutionMode,
  ResumeStartup,
  ResumeStrategy,
  ShellLabel,
  TerminalMode,
  WorktreeCreateDialogState,
  WorktreeCreateProgressState,
  WorktreeDeleteDialogState,
  WorktreePostRecycleDialogState,
  WorktreeProviderCounts,
  WorktreeRecycleDialogState,
  WorktreeRecycleProgressState,
} from "@/app/app-shared";

type AgentTurnTimerStatus = "working" | "done" | "interrupted";

type AgentTurnTimerState = {
  status: AgentTurnTimerStatus;
  startedAt: number;
  elapsedMs: number;
  finishedAt?: number;
};

/**
 * 中文说明：将耗时（毫秒）格式化为带单位文本（如 `2s`、`1m 05s`、`1h 02m 05s`）。
 */
function formatElapsedClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return `${hours}h ${mm}m ${ss}s`;
  }
  if (minutes > 0) {
    const ss = String(seconds).padStart(2, "0");
    return `${minutes}m ${ss}s`;
  }
  return `${seconds}s`;
}

/**
 * 中文说明：计算当前计时状态对应的“展示耗时”（工作中按当前时间实时增长，完成态使用固定耗时）。
 */
function resolveAgentTurnElapsedMs(state?: AgentTurnTimerState): number {
  if (!state) return 0;
  if (state.status === "working") return Math.max(0, Date.now() - state.startedAt);
  return Math.max(0, Number(state.elapsedMs) || 0);
}

/**
 * 中文说明：判断某个 DOM 节点是否位于终端区域内，用于识别“终端内按下 ESC”。
 */
function isNodeInsideTerminal(node: EventTarget | null | undefined): boolean {
  const el = node && typeof (node as any).closest === "function" ? (node as HTMLElement) : null;
  if (!el) return false;
  return !!el.closest(".xterm, .cf-terminal-chrome");
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
    useYolo: true,
    useMultipleModels: false,
    singleProviderId: "codex",
    multiCounts: { codex: 1, claude: 0, gemini: 0 },
	    creating: false,
	    error: undefined,
	  }));
	  const [worktreeCreatePromptFullscreenOpen, setWorktreeCreatePromptFullscreenOpen] = useState<boolean>(false);
	  const worktreeCreateRunningTaskIdByRepoIdRef = useRef<Record<string, string>>({});
	  /** worktree 创建面板的“上次设置”缓存：按 repoProjectId 隔离，避免不同项目互相覆盖。 */
	  const worktreeCreateDraftByRepoIdRef = useRef<Record<string, {
	    baseBranch: string;
	    selectedChildWorktreeIds: string[];
	    promptChips: PathChip[];
	    promptDraft: string;
	    useYolo: boolean;
	    useMultipleModels: boolean;
	    singleProviderId: GitWorktreeProviderId;
	    multiCounts: WorktreeProviderCounts;
	  }>>({});
	  /** worktree 创建面板偏好落盘防抖计时器（localStorage，按 repo 隔离）。 */
	  const worktreeCreatePrefsPersistTimersRef = useRef<Record<string, number>>({});
	  /** 回收任务运行中的 taskId（用于“可关闭/可重开”的进度面板）。 */
	  const worktreeRecycleRunningTaskIdByProjectIdRef = useRef<Record<string, string>>({});
	  /** 回收弹窗：分叉点解析的请求序号（用于避免竞态覆盖）。 */
	  const worktreeRecycleForkPointReqIdRef = useRef<number>(0);
	  /** 回收弹窗：分叉点搜索的请求序号（用于避免竞态覆盖）。 */
	  const worktreeRecycleForkPointSearchReqIdRef = useRef<number>(0);

	  /**
	   * 中文说明：worktree 创建面板关闭时，同步关闭“初始提示词大屏编辑”弹窗，避免状态残留导致下次打开直接弹出。
	   */
		  useEffect(() => {
		    if (!worktreeCreateDialog.open) setWorktreeCreatePromptFullscreenOpen(false);
		  }, [worktreeCreateDialog.open]);

		  /**
		   * 中文说明：将 worktree 创建面板的 PathChip 转为可持久化的最小结构（用于 localStorage）。
		   * - 会过滤 `fromPaste` 的临时图片：这些文件会在应用关闭/下次启动时清理，跨会话持久化没有意义；
		   * - 去除 blob/previewUrl 等运行态字段，避免序列化失败或产生无效数据。
		   */
		  const toPersistedWorktreePromptChips = useCallback((chips: PathChip[]): PersistedWorktreePromptChip[] => {
		    const list = Array.isArray(chips) ? chips : [];
		    const out: PersistedWorktreePromptChip[] = [];
		    for (const chip of list) {
		      if (!chip) continue;
		      if ((chip as any).fromPaste) continue;
		      const winPath = String((chip as any).winPath || "").trim();
		      const wslPath = String((chip as any).wslPath || "").trim();
		      const fileName = String((chip as any).fileName || "").trim();
		      const rulePath = String((chip as any).rulePath || "").trim();
		      const kind = String((chip as any).chipKind || "").trim();
		      const chipKind = (kind === "file" || kind === "image" || kind === "rule") ? (kind as any) : undefined;
		      const isDir = typeof (chip as any).isDir === "boolean" ? (chip as any).isDir : undefined;
		      if (!winPath && !wslPath && !fileName && !rulePath) continue;
		      out.push({
		        chipKind,
		        winPath: winPath || undefined,
		        wslPath: wslPath || undefined,
		        fileName: fileName || undefined,
		        isDir,
		        rulePath: rulePath || undefined,
		      });
		    }
		    return out;
		  }, []);

		  /**
		   * 中文说明：将持久化的提示词 chips 还原为 PathChip（不恢复预览，仅用于显示与插入路径）。
		   */
		  const restoreWorktreePromptChips = useCallback((chips: PersistedWorktreePromptChip[] | null | undefined): PathChip[] => {
		    const list = Array.isArray(chips) ? chips : [];
		    const out: PathChip[] = [];
		    for (const chip of list) {
		      if (!chip) continue;
		      const winPath = String(chip.winPath || "").trim();
		      const wslPath = String(chip.wslPath || "").trim();
		      const fileName = String(chip.fileName || "").trim();
		      const rulePath = String(chip.rulePath || "").trim();
		      const kind = String(chip.chipKind || "").trim();
		      const chipKind = (kind === "file" || kind === "image" || kind === "rule") ? (kind as any) : undefined;
		      const isDir = typeof chip.isDir === "boolean" ? chip.isDir : undefined;
		      if (!winPath && !wslPath && !fileName && !rulePath) continue;
		      out.push({
		        id: uid(),
		        blob: new Blob(),
		        previewUrl: "",
		        type: chipKind === "rule" ? "text/rule" : "text/path",
		        size: 0,
		        saved: true,
		        fromPaste: false,
		        winPath: winPath || undefined,
		        wslPath: wslPath || undefined,
		        fileName: fileName || (wslPath ? (wslPath.split("/").pop() || "") : "") || undefined,
		        chipKind,
		        rulePath: rulePath || undefined,
		        isDir: isDir as any,
		      } as any);
		    }
		    return out;
		  }, []);

		  /**
		   * 中文说明：从 worktreeCreateDialog 状态提取可持久化偏好（用于“每个项目独立记录上次设置”）。
		   */
		  const buildWorktreeCreatePrefsFromDialog = useCallback((state: WorktreeCreateDialogState): WorktreeCreatePrefs => {
		    const singleProviderId: GitWorktreeProviderId =
		      (state.singleProviderId === "codex" || state.singleProviderId === "claude" || state.singleProviderId === "gemini")
		        ? state.singleProviderId
		        : "codex";
		    const multiCounts: WorktreeProviderCounts = {
		      codex: Math.max(0, Math.min(8, Math.floor(Number((state.multiCounts as any)?.codex) || 0))),
		      claude: Math.max(0, Math.min(8, Math.floor(Number((state.multiCounts as any)?.claude) || 0))),
		      gemini: Math.max(0, Math.min(8, Math.floor(Number((state.multiCounts as any)?.gemini) || 0))),
		    };
		    return {
		      baseBranch: String(state.baseBranch || "").trim(),
		      selectedChildWorktreeIds: Array.isArray(state.selectedChildWorktreeIds) ? state.selectedChildWorktreeIds.map((x) => String(x || "").trim()).filter(Boolean) : [],
		      promptChips: toPersistedWorktreePromptChips(state.promptChips),
		      promptDraft: String(state.promptDraft ?? ""),
		      useYolo: !!state.useYolo,
		      useMultipleModels: !!state.useMultipleModels,
		      singleProviderId,
		      multiCounts,
		    };
		  }, [toPersistedWorktreePromptChips]);

		  /**
		   * 中文说明：当初始提示词“已发送”后，清空其记录（内存缓存 + localStorage + 当前 UI 状态）。
		   * - 仅清空提示词，不影响其他设置（baseBranch/引擎选择等仍会保留）。
		   */
			  const clearWorktreeCreateInitialPromptRecord = useCallback((repoProjectId: string) => {
			    const repoId = String(repoProjectId || "").trim();
			    if (!repoId) return;

		    // 1) 内存缓存：清空提示词字段
		    try {
		      const prev = worktreeCreateDraftByRepoIdRef.current[repoId];
		      if (prev) worktreeCreateDraftByRepoIdRef.current[repoId] = { ...prev, promptChips: [], promptDraft: "" };
		    } catch {}

		    // 2) localStorage：清空提示词字段
		    try { clearWorktreeCreatePromptPrefs(repoId); } catch {}

		    // 3) 当前 UI：若仍对应同一 repo，则同步清空，避免后续防抖持久化把提示词写回
			    setWorktreeCreateDialog((prev) => {
			      if (prev.repoProjectId !== repoId) return prev;
			      if ((prev.promptChips?.length || 0) === 0 && !String(prev.promptDraft || "").trim()) return prev;
			      return { ...prev, promptChips: [], promptDraft: "" };
			    });
			  }, []);

			  /**
			   * 中文说明：worktree 创建面板字段变更时，更新“按项目隔离”的内存缓存，并防抖写入 localStorage。
			   */
			  useEffect(() => {
			    const repoId = String(worktreeCreateDialog.repoProjectId || "").trim();
			    if (!repoId) return;

			    // 内存缓存：保留完整 chips（含 fromPaste），保证“关闭/重新打开面板”时体验一致
			    worktreeCreateDraftByRepoIdRef.current[repoId] = {
			      baseBranch: String(worktreeCreateDialog.baseBranch || "").trim(),
			      selectedChildWorktreeIds: Array.isArray(worktreeCreateDialog.selectedChildWorktreeIds) ? worktreeCreateDialog.selectedChildWorktreeIds : [],
			      promptChips: Array.isArray(worktreeCreateDialog.promptChips) ? worktreeCreateDialog.promptChips : [],
			      promptDraft: String(worktreeCreateDialog.promptDraft ?? ""),
			      useYolo: !!worktreeCreateDialog.useYolo,
			      useMultipleModels: !!worktreeCreateDialog.useMultipleModels,
			      singleProviderId: worktreeCreateDialog.singleProviderId,
			      multiCounts: worktreeCreateDialog.multiCounts,
			    };

				    // localStorage：仅保存可跨会话复用的字段（过滤 fromPaste、去掉运行态字段）
				    try {
				      const timers = worktreeCreatePrefsPersistTimersRef.current;
				      const prevTimer = timers[repoId];
				      if (typeof prevTimer === "number") {
				        window.clearTimeout(prevTimer);
				        delete timers[repoId];
				      }
				      const snapshot = worktreeCreateDialog;
				      const timer = window.setTimeout(() => {
				        try { saveWorktreeCreatePrefs(repoId, buildWorktreeCreatePrefsFromDialog(snapshot)); } catch {}
				        try { delete worktreeCreatePrefsPersistTimersRef.current[repoId]; } catch {}
				      }, 240);
				      timers[repoId] = timer;
				    } catch {}
				  }, [
			    buildWorktreeCreatePrefsFromDialog,
			    worktreeCreateDialog.baseBranch,
			    worktreeCreateDialog.multiCounts,
			    worktreeCreateDialog.promptChips,
			    worktreeCreateDialog.promptDraft,
			    worktreeCreateDialog.repoProjectId,
			    worktreeCreateDialog.selectedChildWorktreeIds,
			    worktreeCreateDialog.singleProviderId,
			    worktreeCreateDialog.useMultipleModels,
			    worktreeCreateDialog.useYolo,
			  ]);
			  const [worktreeCreateProgress, setWorktreeCreateProgress] = useState<WorktreeCreateProgressState>(() => ({
			    open: false,
			    repoProjectId: "",
			    taskId: "",
	    status: "running",
	    log: "",
	    logOffset: 0,
	    totalCount: 0,
	    completedCount: 0,
	    successCount: 0,
	    failedCount: 0,
	    allCompleted: false,
	    worktreeStates: [],
	    postStateByKey: {},
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
    prefsKey: undefined,
    alignedToMain: undefined,
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
  const [worktreeBlockedDialog, setWorktreeBlockedDialog] = useState<{ open: boolean; count: number }>(() => ({ open: false, count: 0 }));
  const [worktreeRecycleTerminalAgentsDialog, setWorktreeRecycleTerminalAgentsDialog] = useState<{ open: boolean; count: number }>(() => ({ open: false, count: 0 }));
  const worktreeRecycleTerminalAgentsDialogResolverRef = useRef<((proceed: boolean) => void) | null>(null);
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
  const [agentTurnTimerByTab, setAgentTurnTimerByTab] = useState<Record<string, AgentTurnTimerState>>({});
  const agentTurnTimerByTabRef = useRef<Record<string, AgentTurnTimerState>>({});
  const [agentTurnClockTick, setAgentTurnClockTick] = useState(0);
  const [agentTurnCtxMenu, setAgentTurnCtxMenu] = useState<{ show: boolean; x: number; y: number; tabId: string | null }>({
    show: false,
    x: 0,
    y: 0,
    tabId: null,
  });
  const agentTurnCtxMenuRef = useRef<HTMLDivElement | null>(null);
  const completionSnapshotRef = useRef<Record<string, { preview: string; ts: number }>>({});
  const resumeCompletionGuardByTabRef = useRef<Record<string, number>>({});
  const ptyNotificationBuffersRef = useRef<Record<string, string>>({});
  const ptyListenersRef = useRef<Record<string, () => void>>({});
  const ptyToTabRef = useRef<Record<string, string>>({});
  const tabProjectRef = useRef<Record<string, string>>({});
  const tabsByProjectRef = useRef<Record<string, ConsoleTab[]>>(tabsByProject);
  const projectsRef = useRef<Project[]>(projects);
  const audioContextRef = useRef<AudioContext | null>(null);
  const userInputCountByTabIdRef = useRef<Record<string, number>>({});
  const autoCommitQueueByProjectIdRef = useRef<Record<string, Promise<void>>>({});
  const RESUME_COMPLETION_GUARD_MS = 8_000;

  useEffect(() => { editingTabIdRef.current = editingTabId; }, [editingTabId]);
  useEffect(() => { notificationPrefsRef.current = notificationPrefs; }, [notificationPrefs]);
  useEffect(() => { agentTurnTimerByTabRef.current = agentTurnTimerByTab; }, [agentTurnTimerByTab]);
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

  /**
   * 中文说明：按标签页 id 反查当前 providerId（用于判断是否允许启用计时功能）。
   */
  const resolveTabProviderId = useCallback((tabId: string): string => {
    const id = String(tabId || "").trim();
    if (!id) return "";
    for (const list of Object.values(tabsByProjectRef.current || {})) {
      for (const tab of list || []) {
        if (tab?.id === id) return String(tab.providerId || "").trim();
      }
    }
    return "";
  }, []);

  /**
   * 中文说明：判断某个 provider 是否允许触发“Working/完成计时”功能（仅会话型内置引擎）。
   */
  const shouldEnableAgentTimerForProvider = useCallback((providerId: string): boolean => {
    const pid = String(providerId || "").trim();
    if (!pid) return false;
    return isBuiltInSessionProviderId(pid);
  }, []);

  /**
   * 中文说明：在用户发送消息时启动计时；若当前标签页已在计时中则保持不变，避免重复发送打断计时。
   */
  const startAgentTurnTimer = useCallback((tabId: string) => {
    const id = String(tabId || "").trim();
    if (!id) return;
    const now = Date.now();
    setAgentTurnTimerByTab((prev) => {
      const current = prev[id];
      if (current?.status === "working") return prev;
      return {
        ...prev,
        [id]: {
          status: "working",
          startedAt: now,
          elapsedMs: 0,
        },
      };
    });
    notifyLog(`agentTimer.start tab=${id}`);
  }, [notifyLog]);

  /**
   * 中文说明：在收到代理完成通知时结束计时，并固化本轮总耗时。
   */
  const completeAgentTurnTimer = useCallback((tabId: string) => {
    const id = String(tabId || "").trim();
    if (!id) return;
    const now = Date.now();
    setAgentTurnTimerByTab((prev) => {
      const current = prev[id];
      if (!current || current.status !== "working") return prev;
      const elapsedMs = Math.max(0, now - current.startedAt);
      return {
        ...prev,
        [id]: {
          ...current,
          status: "done",
          elapsedMs,
          finishedAt: now,
        },
      };
    });
    notifyLog(`agentTimer.done tab=${id}`);
  }, [notifyLog]);

  /**
   * 中文说明：将指定标签页的计时标记为“中断”，并保留当前已耗时（用于终端 ESC 中断场景）。
   */
  const interruptAgentTurnTimer = useCallback((tabId: string, source: string) => {
    const id = String(tabId || "").trim();
    if (!id) return;
    const now = Date.now();
    setAgentTurnTimerByTab((prev) => {
      const current = prev[id];
      if (!current || current.status !== "working") return prev;
      const elapsedMs = Math.max(0, now - current.startedAt);
      return {
        ...prev,
        [id]: {
          ...current,
          status: "interrupted",
          elapsedMs,
          finishedAt: now,
        },
      };
    });
    notifyLog(`agentTimer.interrupt tab=${id} source=${source}`);
  }, [notifyLog]);

  /**
   * 中文说明：取消指定标签页的计时状态（用于右键手动取消）。
   */
  const cancelAgentTurnTimer = useCallback((tabId: string, source: string) => {
    const id = String(tabId || "").trim();
    if (!id) return;
    setAgentTurnTimerByTab((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    notifyLog(`agentTimer.cancel tab=${id} source=${source}`);
  }, [notifyLog]);

  /**
   * 中文说明：生成标签页计时状态展示文本，支持“计时中/已完成”两种状态。
   */
  const resolveAgentTurnStatusText = useCallback((tabId: string): string => {
    const id = String(tabId || "").trim();
    if (!id) return "";
    const state = agentTurnTimerByTab[id];
    if (!state) return "";
    const elapsed = formatElapsedClock(resolveAgentTurnElapsedMs(state));
    if (state.status === "working") return t("terminal:agentWorking", { elapsed }) as string;
    if (state.status === "interrupted") return t("terminal:agentInterrupted", { elapsed }) as string;
    return t("terminal:agentDone", { elapsed }) as string;
  }, [agentTurnClockTick, agentTurnTimerByTab, t]);

  /**
   * 中文说明：打开计时状态的右键菜单，提供“取消计时”操作入口。
   */
  const openAgentTurnContextMenu = useCallback((event: React.MouseEvent, tabId: string) => {
    const id = String(tabId || "").trim();
    if (!id || !agentTurnTimerByTabRef.current[id]) return;
    event.preventDefault();
    event.stopPropagation();
    setAgentTurnCtxMenu({ show: true, x: event.clientX, y: event.clientY, tabId: id });
  }, []);

  /**
   * 中文说明：渲染输入区上方的计时状态条（仅在存在计时状态时显示）。
   */
  const renderAgentTurnStatusBar = useCallback((tabId: string, wrapperClassName: string = "mb-0.5 px-1") => {
    const id = String(tabId || "").trim();
    const state = id ? agentTurnTimerByTab[id] : undefined;
    if (!state) return null;
    const working = state?.status === "working";
    const interrupted = state?.status === "interrupted";
    const statusText = resolveAgentTurnStatusText(id);
    return (
      <div className={wrapperClassName}>
        <div className="relative">
          <div
            className={working
              ? "text-[10px] sm:text-xs text-slate-500/80 dark:text-slate-400/70 px-2 py-0.5 flex items-center gap-2 select-none cursor-default hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              : "text-[10px] sm:text-xs text-slate-500/80 dark:text-slate-400/70 px-2 py-0.5 flex items-center gap-2 select-none cursor-default transition-colors"}
            onContextMenu={(event) => {
              openAgentTurnContextMenu(event, id);
            }}
            title={t("terminal:timerContextHint") as string}
          >
            {working ? (
              <span className="flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sky-500"></span>
                </span>
                {statusText}
              </span>
            ) : interrupted ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400"></span>
                {statusText}
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-600"></span>
                {statusText}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }, [agentTurnTimerByTab, openAgentTurnContextMenu, resolveAgentTurnStatusText, t]);

  /**
   * 中文说明：判断是否存在任意“进行中”计时；存在时驱动 1 秒一次的 UI 刷新。
   */
  const hasWorkingAgentTimer = useMemo(() => {
    for (const state of Object.values(agentTurnTimerByTab)) {
      if (state?.status === "working") return true;
    }
    return false;
  }, [agentTurnTimerByTab]);

  /**
   * 中文说明：存在运行中计时时，每秒更新一次渲染节拍以刷新“已耗时”显示。
   */
  useEffect(() => {
    if (!hasWorkingAgentTimer) return;
    const timer = window.setInterval(() => setAgentTurnClockTick((tick) => tick + 1), 1000);
    return () => { window.clearInterval(timer); };
  }, [hasWorkingAgentTimer]);

  /**
   * 中文说明：监听键盘 ESC；当焦点位于终端区域且该标签页计时中时，执行取消计时。
   */
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isNodeInsideTerminal(event.target) && !isNodeInsideTerminal(document.activeElement)) return;
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const state = agentTurnTimerByTabRef.current[tabId];
      if (!state || state.status !== "working") return;
      interruptAgentTurnTimer(tabId, "terminal-esc");
    };
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => { document.removeEventListener("keydown", onKeyDownCapture, true); };
  }, [interruptAgentTurnTimer]);

  /**
   * 中文说明：当标签集合变化时，清理已不存在标签页的计时状态，防止状态泄漏。
   */
  useEffect(() => {
    const activeTabSet = new Set<string>();
    const tabProviderById: Record<string, string> = {};
    for (const list of Object.values(tabsByProject)) {
      for (const tab of list || []) {
        const id = String(tab.id || "").trim();
        if (!id) continue;
        activeTabSet.add(id);
        tabProviderById[id] = String(tab.providerId || "").trim();
      }
    }
    setAgentTurnTimerByTab((prev) => {
      let changed = false;
      const next: Record<string, AgentTurnTimerState> = {};
      for (const [tabId, state] of Object.entries(prev)) {
        if (!activeTabSet.has(tabId)) {
          changed = true;
          continue;
        }
        if (!shouldEnableAgentTimerForProvider(tabProviderById[tabId] || "")) {
          changed = true;
          continue;
        }
        next[tabId] = state;
      }
      if (!changed) return prev;
      return next;
    });
    // 清理已不存在标签页的恢复期完成通知守卫，防止状态泄漏。
    for (const tabId of Object.keys(resumeCompletionGuardByTabRef.current)) {
      if (activeTabSet.has(tabId)) continue;
      delete resumeCompletionGuardByTabRef.current[tabId];
    }
    setAgentTurnCtxMenu((prev) => {
      if (!prev.show || !prev.tabId) return prev;
      if (activeTabSet.has(prev.tabId)) return prev;
      return { show: false, x: 0, y: 0, tabId: null };
    });
  }, [shouldEnableAgentTimerForProvider, tabsByProject]);

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
   * 中文说明：为“继续对话”创建的标签页设置短时守卫，避免会话恢复阶段误触发完成通知。
   */
  function armResumeCompletionGuard(tabId: string, providerId: string) {
    const safeId = String(tabId || "").trim();
    if (!safeId) return;
    const pid = String(providerId || "").trim().toLowerCase();
    if (pid !== "codex") return;
    resumeCompletionGuardByTabRef.current[safeId] = Date.now() + RESUME_COMPLETION_GUARD_MS;
    notifyLog(`resumeGuard.arm tab=${safeId} ttlMs=${RESUME_COMPLETION_GUARD_MS}`);
  }

  /**
   * 中文说明：判断并消费恢复期守卫；命中时返回 true，表示本次完成通知应被抑制。
   * 说明：守卫仅在 Codex 恢复路径中被设置，因此这里不再依赖 providerId，避免标签映射尚未同步时误清除守卫。
   */
  function consumeResumeCompletionGuardIfNeeded(tabId: string, hasWorkingTimer: boolean): boolean {
    const safeId = String(tabId || "").trim();
    if (!safeId) return false;
    const expireAt = Number(resumeCompletionGuardByTabRef.current[safeId] || 0);
    if (!expireAt) return false;
    const now = Date.now();
    if (now > expireAt) {
      delete resumeCompletionGuardByTabRef.current[safeId];
      notifyLog(`resumeGuard.expire tab=${safeId}`);
      return false;
    }
    // 一旦进入真实“working”状态，说明用户已发起新一轮输入，不再拦截完成通知。
    if (hasWorkingTimer) {
      delete resumeCompletionGuardByTabRef.current[safeId];
      notifyLog(`resumeGuard.clear-working tab=${safeId}`);
      return false;
    }
    delete resumeCompletionGuardByTabRef.current[safeId];
    notifyLog(`resumeGuard.hit tab=${safeId}`);
    return true;
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

  /**
   * 中文说明：处理代理完成事件，统一刷新通知、铃声、用量与本轮输入计时状态。
   */
  function handleAgentCompletion(tabId: string, preview: string) {
    if (!tabId) return;
    const hasWorkingTimer = agentTurnTimerByTabRef.current[String(tabId || "")]?.status === "working";
    if (consumeResumeCompletionGuardIfNeeded(tabId, hasWorkingTimer)) return;
    const providerId = resolveTabProviderId(tabId);
    if (shouldEnableAgentTimerForProvider(providerId)) completeAgentTurnTimer(tabId);
    else cancelAgentTurnTimer(tabId, "provider-not-supported");
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
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyNextOffset, setHistoryNextOffset] = useState(0);
  const historyHasMoreRef = useRef<boolean>(false);
  const historyNextOffsetRef = useRef<number>(0);
  const historyLoadingMoreRef = useRef<boolean>(false);
  useEffect(() => { historyHasMoreRef.current = historyHasMore; }, [historyHasMore]);
  useEffect(() => { historyNextOffsetRef.current = historyNextOffset; }, [historyNextOffset]);
  useEffect(() => { historyLoadingMoreRef.current = historyLoadingMore; }, [historyLoadingMore]);
  const [selectedHistoryDir, setSelectedHistoryDir] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  // 用于在点击项目时抑制自动选中历史的标志
  const suppressAutoSelectRef = useRef(false);
  useEffect(() => { historySessionsRef.current = historySessions; }, [historySessions]);

  const projectRowFocusTimerRef = useRef<number | null>(null);
  const projectRowFocusSeqRef = useRef<number>(0);

  /**
   * 在左侧项目列表中定位并聚焦指定项目：
   * - 若目标为子节点且其父节点处于折叠状态，则自动展开父节点
   * - 通过有限次数重试等待渲染完成，避免因异步渲染导致定位失败
   */
  const revealProjectRowInSidebar = React.useCallback((projectId: string) => {
    const id = String(projectId || "").trim();
    if (!id) return;

    // 先确保“子节点的父级”处于展开状态（否则子节点行不会被渲染出来）
    setDirTreeStore((prev) => {
      const parentId = String(prev.parentById[id] || "").trim();
      if (!parentId) return prev;
      if (prev.expandedById[parentId] !== false) return prev;
      return { ...prev, expandedById: { ...prev.expandedById, [parentId]: true } };
    });

    // 取消上一次尚未完成的聚焦请求，避免多次滚动抢占
    if (projectRowFocusTimerRef.current) {
      try { window.clearTimeout(projectRowFocusTimerRef.current); } catch {}
      projectRowFocusTimerRef.current = null;
    }
    const seq = (projectRowFocusSeqRef.current += 1);
    const maxAttempts = 8;
    const delayMs = 60;

    /**
     * 查找当前 DOM 中的项目行元素（使用 data 属性定位，避免对 id 格式做假设）。
     */
    const findRow = (): HTMLElement | null => {
      try {
        const nodes = document.querySelectorAll<HTMLElement>("[data-cf-project-row-id]");
        for (const node of Array.from(nodes)) {
          if (String(node.getAttribute("data-cf-project-row-id") || "") === id) return node;
        }
      } catch {}
      return null;
    };

    /**
     * 判断目标行是否需要滚动到可视区域（优先以滚动容器 viewport 为基准）。
     */
    const shouldScroll = (el: HTMLElement): boolean => {
      try {
        const rect = el.getBoundingClientRect();
        const container = el.closest(".cf-scroll-area") as HTMLElement | null;
        if (!container) return true;
        const cRect = container.getBoundingClientRect();
        const margin = 48;
        const topLimit = cRect.top + margin;
        const bottomLimit = cRect.bottom - margin;
        return rect.top < topLimit || rect.bottom > bottomLimit;
      } catch {
        return true;
      }
    };

    /**
     * 按次数重试：等待渲染完成后定位元素并滚动聚焦。
     */
    const attemptFocus = (attempt: number) => {
      if (projectRowFocusSeqRef.current !== seq) return;
      const target = findRow();
      if (target) {
        if (!shouldScroll(target)) return;
        try {
          target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        } catch {}
        return;
      }
      if (attempt >= maxAttempts) return;
      projectRowFocusTimerRef.current = window.setTimeout(() => attemptFocus(attempt + 1), delayMs);
    };

    // defer：等待 React commit 后再尝试定位元素
    try {
      requestAnimationFrame(() => attemptFocus(0));
    } catch {
      attemptFocus(0);
    }
  }, [setDirTreeStore]);

  /**
   * 从完成通知跳转到指定 Tab：
   * - 自动切换到该 Tab 所属项目
   * - 必要时展开父级并滚动到项目行，确保上下文可见
   */
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
    revealProjectRowInSidebar(projectId);
    setCenterMode('console');
    setSelectedHistoryDir(null);
    setSelectedHistoryId(null);
    setActiveTab(tabId, { focusMode: 'immediate', allowDuringRename: true, delay: 0, projectId });
  }, [revealProjectRowInSidebar, selectedProjectId, setActiveTab, setCenterMode, setSelectedHistoryDir, setSelectedHistoryId, setSelectedProjectId]);

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
  type ProjectRuleMenuEntry = {
    providerId: BuiltInRuleProviderId;
    fileName: string;
    filePath: string;
  };
  const [projectCtxRuleEntries, setProjectCtxRuleEntries] = useState<ProjectRuleMenuEntry[]>([]);
  const projectCtxRuleScanSeqRef = useRef<number>(0);
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
  type HistoryProjectCacheEntry = { sessions: HistorySession[]; hasMore: boolean; nextOffset: number };
  // 项目历史缓存：仅保留最近使用的少量项目，避免切换大量项目导致内存持续增长
  const HISTORY_PROJECT_CACHE_MAX = 6;
  const HISTORY_PAGE_INITIAL_LIMIT = 300;
  const HISTORY_PAGE_SIZE = 200;
  const historyCacheRef = useRef<Map<string, HistoryProjectCacheEntry>>(new Map());
  /**
   * 读取指定项目的历史缓存，并刷新 LRU 顺序。
   */
  const getHistoryCache = useCallback((projectKey: string): HistoryProjectCacheEntry | undefined => {
    const key = String(projectKey || "").trim();
    if (!key) return undefined;
    const mp = historyCacheRef.current;
    const cached = mp.get(key);
    if (!cached) return undefined;
    mp.delete(key);
    mp.set(key, cached);
    return cached;
  }, []);
  /**
   * 写入指定项目的历史缓存，并控制缓存项目数量上限。
   */
  const setHistoryCache = useCallback((projectKey: string, entry: HistoryProjectCacheEntry): void => {
    const key = String(projectKey || "").trim();
    if (!key) return;
    const mp = historyCacheRef.current;
    mp.delete(key);
    mp.set(key, entry);
    while (mp.size > HISTORY_PROJECT_CACHE_MAX) {
      const oldest = mp.keys().next().value;
      if (!oldest) break;
      mp.delete(String(oldest));
    }
  }, []);
  /**
   * 删除指定项目的历史缓存。
   */
  const deleteHistoryCache = useCallback((projectKey: string): void => {
    const key = String(projectKey || "").trim();
    if (!key) return;
    historyCacheRef.current.delete(key);
  }, []);
  // Gemini：基于项目路径计算 projectHash，用于在会话缺失 cwd 时仍能正确归属到项目。
  const geminiProjectHashNeedlesRef = useRef<Set<string>>(new Set());

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
      const titleSource = (session.title || '').toLowerCase();
      const pathSource = (session.filePath || '').toLowerCase();
      const previewSource = (session.preview || '').toLowerCase();
      const normalizedQuery = q.replace(/\\/g, '/');
      const relaxedQuery = normalizedQuery.replace(/\/+$/g, '');
      const normalizedTitle = titleSource.replace(/\\/g, '/');
      const normalizedPath = pathSource.replace(/\\/g, '/');
      const normalizedPreview = previewSource.replace(/\\/g, '/');
      return (
        titleSource.includes(q) ||
        pathSource.includes(q) ||
        previewSource.includes(q) ||
        normalizedTitle.includes(normalizedQuery) ||
        normalizedPath.includes(normalizedQuery) ||
        normalizedPreview.includes(normalizedQuery) ||
        (!!relaxedQuery && (
          normalizedTitle.includes(relaxedQuery) ||
          normalizedPath.includes(relaxedQuery) ||
          normalizedPreview.includes(relaxedQuery)
        ))
      );
    },
    []
  );
  const selectedProjectHistoryKeyRef = useRef<string>("");
  useEffect(() => {
    if (!selectedProject) {
      selectedProjectHistoryKeyRef.current = "";
      return;
    }
    selectedProjectHistoryKeyRef.current = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
  }, [selectedProject]);

  /**
   * 更新历史分页状态，并同步 ref（供异步加载逻辑读取最新值）。
   */
  const applyHistoryPagination = useCallback((state: { hasMore: boolean; nextOffset: number }) => {
    const nextHasMore = !!state.hasMore;
    const nextOffset = Math.max(0, Number(state.nextOffset || 0));
    historyHasMoreRef.current = nextHasMore;
    historyNextOffsetRef.current = nextOffset;
    setHistoryHasMore(nextHasMore);
    setHistoryNextOffset(nextOffset);
  }, []);
  /**
   * 将后端 history.list 的单条记录映射为前端会话结构。
   */
  const mapHistoryListItemToSession = useCallback((it: any): HistorySession => {
    return {
      providerId: (it?.providerId === "claude" || it?.providerId === "gemini") ? it.providerId : "codex",
      id: String(it?.id || ""),
      title: typeof it?.rawDate === "string" ? String(it.rawDate) : String(it?.title || ""),
      date: normalizeMsToIso(it?.date),
      rawDate: (typeof it?.rawDate === "string" ? it.rawDate : undefined),
      preview: (typeof it?.preview === "string" ? String(it.preview) : undefined),
      messages: [],
      filePath: String(it?.filePath || ""),
      resumeMode: normalizeResumeMode(it?.resumeMode),
      resumeId: typeof it?.resumeId === "string" ? it.resumeId : undefined,
      runtimeShell: it?.runtimeShell === "windows" ? "windows" : (it?.runtimeShell === "wsl" ? "wsl" : "unknown"),
    };
  }, []);
  /**
   * 按会话主键合并历史列表，并按时间倒序返回。
   */
  const mergeHistorySessions = useCallback((base: HistorySession[], incoming: HistorySession[]): HistorySession[] => {
    const mp = new Map<string, HistorySession>();
    for (const it of base) mp.set(String(it.filePath || it.id), it);
    for (const it of incoming) mp.set(String(it.filePath || it.id), it);
    return Array.from(mp.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, []);
  /**
   * 拉取指定项目的一页历史记录。
   */
  const fetchHistoryPage = useCallback(async (project: Project, offset: number, limit: number): Promise<HistorySession[]> => {
    const safeOffset = Math.max(0, Number(offset || 0));
    const safeLimit = Math.max(1, Number(limit || 1));
    const res: any = await window.host.history.list({
      projectWslPath: project.wslPath,
      projectWinPath: project.winPath,
      limit: safeLimit,
      offset: safeOffset,
    });
    if (!(res && res.ok && Array.isArray(res.sessions))) throw new Error("history.list failed");
    return res.sessions.map((h: any) => mapHistoryListItemToSession(h));
  }, [mapHistoryListItemToSession]);
  /**
   * 加载当前项目的下一页历史记录，并同步缓存与分页状态。
   */
  const loadMoreHistorySessions = useCallback(async (): Promise<number> => {
    if (!selectedProject) return 0;
    if (!historyHasMoreRef.current) return 0;
    if (historyLoadingMoreRef.current) return 0;
    const targetProjectKey = selectedProjectHistoryKeyRef.current;
    if (!targetProjectKey) return 0;
    const offset = Math.max(0, Number(historyNextOffsetRef.current || 0));
    historyLoadingMoreRef.current = true;
    setHistoryLoadingMore(true);
    try {
      const page = await fetchHistoryPage(selectedProject, offset, HISTORY_PAGE_SIZE);
      if (targetProjectKey !== selectedProjectHistoryKeyRef.current) return 0;
      const loadedCount = page.length;
      const nextOffset = offset + loadedCount;
      const hasMore = loadedCount >= HISTORY_PAGE_SIZE;
      applyHistoryPagination({ hasMore, nextOffset });
      setHistorySessions((cur) => {
        const merged = mergeHistorySessions(cur, page);
        setHistoryCache(targetProjectKey, { sessions: merged, hasMore, nextOffset });
        return merged;
      });
      return loadedCount;
    } catch (e) {
      console.warn("history.loadMore failed", e);
      return 0;
    } finally {
      historyLoadingMoreRef.current = false;
      setHistoryLoadingMore(false);
    }
  }, [selectedProject, fetchHistoryPage, HISTORY_PAGE_SIZE, applyHistoryPagination, mergeHistorySessions, setHistoryCache]);
  /**
   * 为查询补齐分页范围：当前无命中时继续加载，直到出现命中或无更多数据。
   */
  const ensureHistoryMatchLoaded = useCallback(async (query: string): Promise<void> => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return;
    const maxRounds = 20;
    for (let round = 0; round < maxRounds; round++) {
      const hasMatch = historySessionsRef.current.some((s) => sessionMatchesQuery(s, q));
      if (hasMatch) return;
      if (!historyHasMoreRef.current) return;
      const loaded = await loadMoreHistorySessions();
      if (loaded <= 0) return;
    }
  }, [sessionMatchesQuery, loadMoreHistorySessions]);
  /**
   * 处理历史搜索回车：优先补齐可搜索分页，再定位到最新命中。
   */
  const handleHistorySearchEnter = useCallback(async (): Promise<void> => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return;
    await ensureHistoryMatchLoaded(q);
    const first = historySessionsRef.current
      .filter((s) => sessionMatchesQuery(s, q))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    if (!first) return;
    const key = historyTimelineGroupKey(first, new Date());
    setSelectedHistoryDir(key);
    setSelectedHistoryId(first.id);
    setCenterMode("history");
  }, [historyQuery, ensureHistoryMatchLoaded, sessionMatchesQuery]);

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

  // Auto-adjust agent timer context menu position to stay within viewport (pre-paint to avoid visible jump)
  useLayoutEffect(() => {
    if (!agentTurnCtxMenu.show) return;
    const margin = 8;
    const adjust = () => {
      try {
        const el = agentTurnCtxMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        let left = agentTurnCtxMenu.x;
        let top = agentTurnCtxMenu.y;
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        if (left > maxLeft) left = maxLeft;
        if (top > maxTop) top = maxTop;
        if (left < margin) left = margin;
        if (top < margin) top = margin;
        if (left !== agentTurnCtxMenu.x || top !== agentTurnCtxMenu.y) {
          setAgentTurnCtxMenu((m) => ({ ...m, x: left, y: top }));
        }
      } catch {}
    };
    adjust();
    const onResize = () => adjust();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); };
  }, [agentTurnCtxMenu.show, agentTurnCtxMenu.x, agentTurnCtxMenu.y]);

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
   * 构造 worktree 创建面板用的 Provider 启动命令（可临时覆盖 YOLO，不写入全局设置）。
   */
  const buildProviderStartupCmdForWorktreeCreate = useCallback((args: {
    providerId: GitWorktreeProviderId;
    env: Required<ProviderEnv>;
    useYolo?: boolean;
  }): string => {
    const providerId = args.providerId;
    const env = args.env;
    if (typeof args.useYolo !== "boolean") return buildProviderStartupCmd(providerId, env);

    const item = providerItems.find((x) => x.id === providerId) ?? { id: providerId };
    const resolved = resolveProvider(item);
    const raw = providerId === "codex" ? (resolved.startupCmd || codexCmd) : resolved.startupCmd;
    const adjusted = resolveStartupCmdWithYolo({ providerId, startupCmd: raw, enabled: args.useYolo });

    if (providerId === "codex") {
      return injectCodexTraceEnv({ cmd: adjusted || raw || codexCmd, traceEnabled: codexTraceEnabled, terminalMode: env.terminal as any });
    }
    return adjusted;
  }, [buildProviderStartupCmd, codexCmd, codexTraceEnabled, providerItems]);

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


  // 防御性清理：当视图中心从历史切回控制台、或窗口可见性发生变化时，强制关闭所有全屏遮罩
  useEffect(() => {
    if (centerMode === 'console') {
      dumpOverlayDiagnostics('before-clear-onCenterConsole');
      try { setHistoryCtxMenu((m) => ({ ...m, show: false })); } catch {}
      try { setProjectCtxMenu((m) => ({ ...m, show: false })); } catch {}
      try { setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null })); } catch {}
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
      try { setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null })); } catch {}
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
	          // 中文说明：静默更新检查的降级路径属于“正常可用但无网络结果”的场景，避免在未开启调试时污染控制台。
	          uiLog(`Silent update check fallback: ${String(res.error || res.source || "")}`);
	        }
	      } catch {}
	    })();
	  }, [uiLog]);

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

  // 监听主进程转发的外部完成通知（Gemini/Claude，JSONL 桥接）
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = window.host.notifications?.onExternalAgentComplete?.((payload: { providerId?: string; tabId?: string; envLabel?: string; preview?: string; timestamp?: string; eventId?: string }) => {
        const providerId = String(payload?.providerId || "").trim().toLowerCase();
        if (providerId && providerId !== "gemini" && providerId !== "claude") return;
        const preview = String(payload?.preview || "");
        const resolvedTabId = resolveExternalTabId({
          tabId: payload?.tabId,
          providerId: providerId || "gemini",
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
      if (projectKey) deleteHistoryCache(projectKey);
    } catch {}
    setSelectedProjectId((prev) => (prev === project.id ? "" : prev));
    try { suppressAutoSelectRef.current = true; } catch {}
    setSelectedHistoryDir(null);
    setSelectedHistoryId(null);
    setCenterMode('console');
  }, [activeTabId, deleteHistoryCache, setActiveTab, tabsByProject, tm]);

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
    const notifyEnv = buildProviderNotifyEnv(tab.id, tab.providerId, tab.name);
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
    const notifyEnv = buildProviderNotifyEnv(tab.id, tab.providerId, tab.name);
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
        applyHistoryPagination({ hasMore: false, nextOffset: 0 });
        historyLoadingMoreRef.current = false;
        setHistoryLoadingMore(false);
        setSelectedHistoryDir(null);
        setSelectedHistoryId(null);
        setHistoryLoading(false);
        return;
      }
      // 如果是用户刚刚通过点击项目触发的切换，则抑制自动选中历史（保持控制台视图）
      const skipAuto = suppressAutoSelectRef.current;
      const projectKey = canonicalizePath(selectedProject.wslPath || selectedProject.winPath || selectedProject.id);
      // 先显示缓存
      const cached = getHistoryCache(projectKey);
      const cachedSessions = cached?.sessions || [];
      const hasCache = cachedSessions.length > 0;
      setHistoryLoading(!hasCache);
      if (hasCache) {
        setHistorySessions(cachedSessions);
        applyHistoryPagination({
          hasMore: !!cached?.hasMore,
          nextOffset: Math.max(0, Number(cached?.nextOffset || cachedSessions.length)),
        });
        // 若当前选择无效或为空，重置为缓存中的第一组（除非是点击项目触发的切换）
        if (!skipAuto) {
          const nowRef = new Date();
          const keyOf = (item?: HistorySession) => historyTimelineGroupKey(item, nowRef);
          const dirs = new Set(cachedSessions.map((x) => keyOf(x)));
          const ids = new Set(cachedSessions.map((x) => x.id));
          const invalidSelection = (!selectedHistoryId || !ids.has(selectedHistoryId) || !selectedHistoryDir || !dirs.has(selectedHistoryDir));
          const firstKey = cachedSessions.length > 0 ? keyOf(cachedSessions[0]) : null;
          if (invalidSelection && firstKey) {
            // 仅优化默认 UI：展开最新分组，不自动选择会话，也不切换到详情
            setSelectedHistoryDir(null);
            setSelectedHistoryId(null);
            setExpandedGroups({ [firstKey]: true });
          }
        }
      } else {
        setHistorySessions([]);
        applyHistoryPagination({ hasMore: false, nextOffset: 0 });
        setSelectedHistoryDir(null);
        setSelectedHistoryId(null);
      }
      try {
        // 固定为项目范围历史（分页首屏）
        const mapped = await fetchHistoryPage(selectedProject, 0, HISTORY_PAGE_INITIAL_LIMIT);
        if (cancelled) return;
        const hasMore = mapped.length >= HISTORY_PAGE_INITIAL_LIMIT;
        const nextOffset = mapped.length;
        applyHistoryPagination({ hasMore, nextOffset });
        setHistorySessions(mapped as any);
        setHistoryCache(projectKey, { sessions: mapped, hasMore, nextOffset });
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
  }, [selectedProject, historyInvalidateNonce, getHistoryCache, fetchHistoryPage, HISTORY_PAGE_INITIAL_LIMIT, applyHistoryPagination, setHistoryCache]);

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
    const upsertSessions = (items: any[]) => {
      if (!Array.isArray(items) || items.length === 0) return;
      setHistorySessions((cur) => {
        const mp = new Map<string, HistorySession>();
        for (const s of cur) mp.set(String(s.filePath || s.id), s);
        let changed = false;
        for (const it of items) {
          if (!belongsToSelected(it)) continue;
          const s = mapHistoryListItemToSession(it);
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
          setHistoryCache(projectKey, {
            sessions: next,
            hasMore: historyHasMoreRef.current,
            nextOffset: historyNextOffsetRef.current,
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
          setHistoryCache(projectKey, {
            sessions: next,
            hasMore: historyHasMoreRef.current,
            nextOffset: historyNextOffsetRef.current,
          });
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
        deleteHistoryCache(projectKey);
      } catch {}
      try { setHistoryInvalidateNonce((x) => x + 1); } catch {}
    }) || (() => {});
    return () => { try { unsubAdd(); } catch {}; try { unsubUpd(); } catch {}; try { unsubRem(); } catch {}; try { unsubInvalidate(); } catch {}; };
  }, [selectedProject, selectedHistoryId, selectedHistoryDir, setHistoryCache, deleteHistoryCache, mapHistoryListItemToSession]);

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

  /**
   * 中文说明：将输入区内容发送到当前标签页终端，并在首条发送时启动“Working 计时”。
   */
  function sendCommand() {
    if (!activeTab) return;
    const text = compileTextFromChipsAndDraft(activeTab.id);
    if (!text.trim()) return;
    const pid = ptyByTabRef.current[activeTab.id];
    if (!pid) return;
    // 用户开始新一轮输入后，立即取消恢复期守卫，避免影响真实完成通知。
    delete resumeCompletionGuardByTabRef.current[activeTab.id];
    if (shouldEnableAgentTimerForProvider(activeTab.providerId)) startAgentTurnTimer(activeTab.id);
    else cancelAgentTurnTimer(activeTab.id, "provider-not-supported");
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

  /**
   * 中文说明：关闭指定标签页，并清理与该标签页关联的 PTY、通知和计时状态。
   */
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
    cancelAgentTurnTimer(id, "close-tab");
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
	        return {
	          open: true,
	          repoProjectId: repoId,
	          taskId: runningTaskId,
	          status: "running",
	          log: "",
	          logOffset: 0,
	          totalCount: 0,
	          completedCount: 0,
	          successCount: 0,
	          failedCount: 0,
	          allCompleted: false,
	          worktreeStates: [],
	          postStateByKey: {},
	          updatedAt: 0,
	          error: undefined,
	        };
	      });
	      return;
	    }

    // 为 @ 引用准备文件索引根（避免用户未选中该项目时，@ 搜索仍指向旧项目）
    try { await setActiveFileIndexRoot(repoProject.winPath); } catch {}

	    const defaultProvider: GitWorktreeProviderId =
	      (activeProviderId === "codex" || activeProviderId === "claude" || activeProviderId === "gemini")
	        ? (activeProviderId as any)
	        : "codex";

	    // 读取“按项目隔离”的上次设置：优先内存缓存（保留 fromPaste 图片），其次 localStorage（过滤 fromPaste）
	    const cached = worktreeCreateDraftByRepoIdRef.current[repoId] || null;
	    const persisted = loadWorktreeCreatePrefs(repoId);
	    const restored = cached
	      ? ({
	          baseBranch: cached.baseBranch,
	          selectedChildWorktreeIds: cached.selectedChildWorktreeIds,
	          promptChips: cached.promptChips,
	          promptDraft: cached.promptDraft,
	          useYolo: cached.useYolo,
	          useMultipleModels: cached.useMultipleModels,
	          singleProviderId: cached.singleProviderId,
	          multiCounts: cached.multiCounts,
	        } as const)
	      : (persisted
	          ? ({
	              baseBranch: persisted.baseBranch,
	              selectedChildWorktreeIds: persisted.selectedChildWorktreeIds,
	              promptChips: restoreWorktreePromptChips(persisted.promptChips),
	              promptDraft: persisted.promptDraft,
	              useYolo: persisted.useYolo,
	              useMultipleModels: persisted.useMultipleModels,
	              singleProviderId: persisted.singleProviderId as any,
	              multiCounts: (persisted.multiCounts as any) as WorktreeProviderCounts,
	            } as const)
	          : null);

	    const singleProviderId: GitWorktreeProviderId = restored?.singleProviderId || defaultProvider;
	    const multiCountsDefault: WorktreeProviderCounts = { codex: defaultProvider === "codex" ? 1 : 0, claude: defaultProvider === "claude" ? 1 : 0, gemini: defaultProvider === "gemini" ? 1 : 0 };
	    const multiCountsSource: WorktreeProviderCounts = restored?.multiCounts || multiCountsDefault;
	    const multiCounts: WorktreeProviderCounts = { ...multiCountsSource };
	    // 兜底：多模型模式若合计为 0，则默认给 singleProviderId 置 1，避免面板打开即不可用
	    if (restored?.useMultipleModels && sumWorktreeProviderCounts(multiCounts) === 0) {
	      multiCounts[singleProviderId] = 1;
	    }

	    setWorktreeCreateDialog({
	      open: true,
	      repoProjectId: repoId,
	      branches: [],
	      baseBranch: restored?.baseBranch || "",
	      loadingBranches: true,
	      selectedChildWorktreeIds: restored?.selectedChildWorktreeIds || [],
	      promptChips: restored?.promptChips || [],
	      promptDraft: restored?.promptDraft || "",
	      useYolo: typeof restored?.useYolo === "boolean" ? restored.useYolo : true,
	      useMultipleModels: typeof restored?.useMultipleModels === "boolean" ? restored.useMultipleModels : false,
	      singleProviderId,
	      multiCounts,
	      creating: false,
	      error: undefined,
	    });

    try {
	      const res: any = await (window as any).host?.gitWorktree?.listBranches?.(repoProject.winPath);
	      if (!(res && res.ok)) throw new Error(res?.error || "failed");
	      const branches = Array.isArray(res.branches) ? res.branches.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
	      const current = String(res.current || "").trim();
	      setWorktreeCreateDialog((prev) => {
	        if (!prev.open || prev.repoProjectId !== repoId) return prev;
	        const preferred = String(prev.baseBranch || "").trim();
	        const baseBranch = (preferred && branches.includes(preferred)) ? preferred : (current || branches[0] || "");
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
	  }, [activeProviderId, restoreWorktreePromptChips, t]);

  /**
   * 关闭 worktree 创建面板（不执行创建）。
   */
  const closeWorktreeCreateDialog = useCallback(() => {
    setWorktreeCreatePromptFullscreenOpen(false);
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

    const notifyEnv = buildProviderNotifyEnv(tab.id, tab.providerId, tab.name);

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
   * - 支持通过 useYolo 临时覆盖 YOLO 预设（仅本次生效，不写入设置）。
   */
  const startProviderInstanceInProject = useCallback(async (args: {
    project: Project;
    providerId: GitWorktreeProviderId;
    prompt: string;
    useYolo?: boolean;
  }): Promise<{ ok: boolean; tabId?: string; error?: string }> => {
    try {
      const project = args.project;
      const providerId = args.providerId;
      if (!project?.id) return { ok: false, error: "missing project" };
      const env = getProviderEnv(providerId);
      const baseCmd = buildProviderStartupCmdForWorktreeCreate({ providerId, env, useYolo: args.useYolo });
      const startupCmd = buildProviderStartupCmdWithInitialPrompt({ providerId, terminalMode: env.terminal as any, baseCmd, prompt: args.prompt });
      return await openProviderConsoleInProject({ project, providerId, startupCmd });
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, [buildProviderStartupCmdForWorktreeCreate, getProviderEnv, openProviderConsoleInProject]);

  /**
   * 执行创建 worktree，并在每个 worktree 内启动对应引擎 CLI。
   * - 目录结构/复用规则由主进程完成；渲染层负责：避免重复节点、挂载到树、启动引擎
   */
  const createWorktreesAndStartAgents = useCallback(async (args: {
    repoProject: Project;
    baseBranch: string;
    instances: Array<{ providerId: GitWorktreeProviderId; count: number }>;
    prompt: string;
    /** 是否在本次创建/启动中临时启用 YOLO（不影响全局设置）。 */
    useYolo?: boolean;
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
      ? args.instances.map((item) => ({ providerId: item.providerId, count: Math.max(0, Math.floor(Number(item.count) || 0)) })).filter((item) => item.count > 0)
      : [];
    if (instances.length === 0) return;

    /**
     * 中文说明：以统一结构重置“创建进度”面板状态，避免字段遗漏导致 UI 状态不一致。
     */
    const createWorktreeProgressInitialState = (nextTaskId: string): WorktreeCreateProgressState => ({
      open: true,
      repoProjectId: repoId,
      taskId: nextTaskId,
      status: "running",
      log: "",
      logOffset: 0,
      totalCount: 0,
      completedCount: 0,
      successCount: 0,
      failedCount: 0,
      allCompleted: false,
      worktreeStates: [],
      postStateByKey: {},
      updatedAt: Date.now(),
      error: undefined,
    });

    // 若该仓库已有创建任务在跑，则直接打开“创建中”面板查看进度，避免重复创建
    const runningTaskId = String(worktreeCreateRunningTaskIdByRepoIdRef.current[repoId] || "").trim();
    if (runningTaskId) {
      setWorktreeCreateProgress((prev) => (prev.taskId === runningTaskId ? { ...prev, open: true, repoProjectId: repoId } : createWorktreeProgressInitialState(runningTaskId)));
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
    setWorktreeCreateProgress(createWorktreeProgressInitialState(taskId));
    setWorktreeCreateDialog((prev) => (prev.open && prev.repoProjectId === repoId ? { ...prev, open: false, creating: false, error: undefined } : prev));

    const prompt = String(args.prompt || "");
    const warningSet = new Set<string>(
      Array.isArray(args.extraWarnings) ? args.extraWarnings.map((item: any) => String(item || "").trim()).filter(Boolean) : []
    );
    const scheduledPostKeys = new Set<string>();
    const postJobs: Promise<void>[] = [];
    let promptCleared = false;
    let firstNewProjectId: string | null = null;
    let firstTabId: string | null = null;
    let snapshot: WorktreeCreateTaskSnapshot | null = null;
    let logText = "";
    let logOffset = 0;
    const startedAt = Date.now();
    let stopPostCreate = false;

    /**
     * 中文说明：去重追加警告，避免重复提示相同信息。
     */
    const addWarning = (text: string): void => {
      const msg = String(text || "").trim();
      if (!msg) return;
      warningSet.add(msg);
    };

    /**
     * 中文说明：更新单个 worktree 的“后续逻辑”状态（启动中/成功/失败），供进度面板集中展示。
     */
    const updatePostState = (worktreeKey: string, patch: { status: "idle" | "running" | "success" | "error"; error?: string; projectId?: string; tabId?: string }): void => {
      const key = String(worktreeKey || "").trim();
      if (!key) return;
      setWorktreeCreateProgress((prev) => {
        if (prev.taskId !== taskId) return prev;
        const previous = prev.postStateByKey?.[key] || { status: "idle" as const };
        return {
          ...prev,
          postStateByKey: {
            ...(prev.postStateByKey || {}),
            [key]: {
              ...previous,
              ...patch,
              error: typeof patch.error === "string" ? String(patch.error || "").trim() || undefined : previous.error,
            },
          },
        };
      });
    };

    /**
     * 中文说明：若任务进入取消态，则停止分发/执行后续启动逻辑。
     */
    const stopPostCreateIfCanceled = (taskStatus: WorktreeCreateTaskStatus): void => {
      if (taskStatus === "canceling" || taskStatus === "canceled") {
        stopPostCreate = true;
      }
    };

    /**
     * 中文说明：当后续流程被取消时，统一将对应条目标记为“已取消”并终止执行。
     */
    const haltPostCreateIfCanceled = (worktreeKey: string, projectId?: string): boolean => {
      if (!stopPostCreate) return false;
      updatePostState(worktreeKey, {
        status: "error",
        error: t("projects:worktreeCreateCanceled", "已取消") as string,
        projectId,
      });
      return true;
    };

    /**
     * 中文说明：单个 worktree 创建成功后，立即并发执行后续逻辑（入库、挂树、启动对应引擎）。
     */
    const runPostCreateForWorktreeAsync = async (state: WorktreeCreateTaskItemSnapshot): Promise<void> => {
      const worktreeKey = String(state?.key || "").trim();
      if (!worktreeKey) return;
      if (haltPostCreateIfCanceled(worktreeKey)) return;
      updatePostState(worktreeKey, { status: "running", error: undefined });
      try {
        const providerIdRaw = String(state?.providerId || "").trim().toLowerCase();
        const providerId = (providerIdRaw === "codex" || providerIdRaw === "claude" || providerIdRaw === "gemini")
          ? (providerIdRaw as GitWorktreeProviderId)
          : null;
        const worktreePath = String(state?.worktreePath || "").trim();
        if (!providerId || !worktreePath) {
          const reason = t("projects:worktreeCreatePostMissingInfo", "缺少工作区信息，无法启动后续逻辑") as string;
          updatePostState(worktreeKey, { status: "error", error: reason });
          addWarning(reason);
          return;
        }
        if (haltPostCreateIfCanceled(worktreeKey)) return;

        let wtProject: Project | null = null;
        try {
          const addRes: any = await window.host.projects.add({ winPath: worktreePath });
          if (addRes && addRes.ok && addRes.project) {
            wtProject = addRes.project as Project;
            upsertProjectInList(wtProject);
            unhideProject(wtProject);
          }
        } catch {}

        if (!wtProject) {
          const reason = (t("projects:worktreeCreatePostProjectAttachFailed", "工作区已创建，但加入项目列表失败：{path}") as any).replace("{path}", worktreePath);
          updatePostState(worktreeKey, { status: "error", error: reason });
          addWarning(reason);
          return;
        }
        if (haltPostCreateIfCanceled(worktreeKey, wtProject.id)) return;

        if (!firstNewProjectId) firstNewProjectId = wtProject.id;
        attachDirChildToParent(repoId, wtProject.id);

        const started = await startProviderInstanceInProject({ project: wtProject, providerId, prompt, useYolo: args.useYolo });
        if (started.ok && started.tabId) {
          if (!firstTabId) firstTabId = started.tabId;
          if (!promptCleared && prompt.trim()) {
            promptCleared = true;
            clearWorktreeCreateInitialPromptRecord(repoId);
          }
          updatePostState(worktreeKey, { status: "success", projectId: wtProject.id, tabId: started.tabId, error: undefined });
        } else {
          const reason = `${providerId}: ${String(started.error || t("projects:worktreeCreatePostStartFailed", "启动实例失败") as string)}`;
          updatePostState(worktreeKey, { status: "error", error: reason, projectId: wtProject.id });
          addWarning(reason);
        }

        for (const warning of Array.isArray(state?.warnings) ? state.warnings : []) {
          const normalized = String(warning || "").trim();
          if (normalized) addWarning(normalized);
        }
      } catch (e: any) {
        const reason = String(e?.message || e || t("projects:worktreeCreatePostStartFailed", "启动实例失败"));
        updatePostState(worktreeKey, { status: "error", error: reason });
        addWarning(reason);
      }
    };

    /**
     * 中文说明：为新出现的成功项分发后续并发任务（同一 key 只分发一次）。
     */
    const dispatchPostCreateJobs = (states: WorktreeCreateTaskItemSnapshot[]): void => {
      if (stopPostCreate) return;
      for (const state of states) {
        if (!state || state.status !== "success") continue;
        const key = String(state.key || "").trim();
        if (!key || scheduledPostKeys.has(key)) continue;
        scheduledPostKeys.add(key);
        const job = runPostCreateForWorktreeAsync(state).catch(() => {});
        postJobs.push(job);
      }
    };

    // 轮询任务输出（支持关闭 UI 后继续执行；重新打开时可继续看到日志）
    while (true) {
      try {
        const pull: any = await (window as any).host?.gitWorktree?.createTaskGet?.({ taskId, from: logOffset });
        if (pull && pull.ok && pull.task) {
          snapshot = pull.task as WorktreeCreateTaskSnapshot;
          const append = String(pull.append || "");
          if (append) logText += append;
          logOffset = Math.max(logOffset, Math.floor(Number(snapshot.logSize) || 0));
          stopPostCreateIfCanceled(snapshot.status);
          const worktreeStates = Array.isArray(snapshot.worktreeStates) ? snapshot.worktreeStates : [];
          setWorktreeCreateProgress((prev) => {
            if (prev.taskId !== taskId) return prev;
            return {
              ...prev,
              status: snapshot!.status,
              log: logText,
              logOffset,
              totalCount: Math.max(0, Math.floor(Number(snapshot!.totalCount) || 0)),
              completedCount: Math.max(0, Math.floor(Number(snapshot!.completedCount) || 0)),
              successCount: Math.max(0, Math.floor(Number(snapshot!.successCount) || 0)),
              failedCount: Math.max(0, Math.floor(Number(snapshot!.failedCount) || 0)),
              allCompleted: snapshot!.allCompleted === true,
              worktreeStates,
              updatedAt: Math.floor(Number(snapshot!.updatedAt) || Date.now()),
              error: snapshot!.error ? String(snapshot!.error || "") : undefined,
            };
          });
          dispatchPostCreateJobs(worktreeStates);
          if (snapshot.status !== "running" && snapshot.status !== "canceling") break;
        }
      } catch {}

      // 兜底：避免无限等待
      if (Date.now() - startedAt > 40 * 60_000) {
        setWorktreeCreateProgress((prev) => {
          if (prev.taskId !== taskId) return prev;
          return {
            ...prev,
            status: "error",
            allCompleted: true,
            error: "等待创建任务超时（请重试或在外部终端执行 git worktree add 诊断）",
          };
        });
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // 创建任务结束：允许再次创建（无论成功或失败）
    try { delete worktreeCreateRunningTaskIdByRepoIdRef.current[repoId]; } catch {}

    if (postJobs.length > 0) {
      await Promise.allSettled(postJobs);
    }

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

    if (snapshot && snapshot.status === "success") {
      setWorktreeCreateProgress((prev) => (prev.taskId === taskId ? { ...prev, open: false } : prev));
    } else {
      setWorktreeCreateProgress((prev) => (prev.taskId === taskId ? { ...prev, open: true } : prev));
    }

    const warnings = Array.from(warningSet.values());
    if (warnings.length > 0) {
      setNoticeDialog({
        open: true,
        title: t("projects:worktreeCreateTitle", "从分支创建 worktree") as string,
        message: (t("projects:worktreeCreateWarnings", "创建已完成，但存在警告：\n{{warnings}}") as any).replace("{{warnings}}", warnings.join("\n")),
      });
    }
  }, [attachDirChildToParent, clearWorktreeCreateInitialPromptRecord, gitWorktreeCopyRulesOnCreate, setActiveTab, startProviderInstanceInProject, t, unhideProject, upsertProjectInList]);

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
  const showGitActionErrorDialog = useCallback((args: { title: string; message: string; dir: string; hint?: string }) => {
    setGitActionErrorDialog({
      open: true,
      title: String(args.title || "").trim() || (t("projects:gitActionFailed", "Git 操作失败") as string),
      hint: typeof args.hint === "string" ? String(args.hint || "").trim() || undefined : undefined,
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
   * 中文说明：若当前项目仍存在终端代理，则拦截 worktree 删除/重置，并提示用户先关闭终端代理。
   */
  const guardWorktreeDeleteAndResetByTerminalAgents = useCallback((project: Project): boolean => {
    const pid = String(project?.id || "").trim();
    if (!pid) return false;
    const runningCount = countRunningTerminalAgentsByProjectId(pid);
    if (runningCount <= 0) return true;
    setWorktreeBlockedDialog({ open: true, count: runningCount });
    return false;
  }, [countRunningTerminalAgentsByProjectId]);

  /**
   * 中文说明：关闭“合并前终端代理提醒”弹窗，并将用户选择回写给等待中的 Promise。
   */
  const resolveWorktreeRecycleTerminalAgentsConfirm = useCallback((proceed: boolean) => {
    const resolver = worktreeRecycleTerminalAgentsDialogResolverRef.current;
    worktreeRecycleTerminalAgentsDialogResolverRef.current = null;
    setWorktreeRecycleTerminalAgentsDialog((prev) => ({ ...prev, open: false }));
    if (resolver) resolver(proceed);
  }, []);

  /**
   * 中文说明：若当前项目仍存在终端代理，则在“合并(worktree 回收)”前弹出确认（取消/继续）。
   * @returns 用户是否选择继续合并
   */
  const confirmWorktreeRecycleByTerminalAgents = useCallback(async (project: Project): Promise<boolean> => {
    const pid = String(project?.id || "").trim();
    if (!pid) return false;
    const runningCount = countRunningTerminalAgentsByProjectId(pid);
    if (runningCount <= 0) return true;

    // 若上一次确认尚未返回，默认取消，避免悬挂 Promise。
    const prev = worktreeRecycleTerminalAgentsDialogResolverRef.current;
    if (prev) {
      try { prev(false); } catch {}
      worktreeRecycleTerminalAgentsDialogResolverRef.current = null;
    }

    return await new Promise<boolean>((resolve) => {
      worktreeRecycleTerminalAgentsDialogResolverRef.current = resolve;
      setWorktreeRecycleTerminalAgentsDialog({ open: true, count: runningCount });
    });
  }, [countRunningTerminalAgentsByProjectId]);

  /**
   * 中文说明：计算“删除/对齐偏好”的仓库维度 key。
   * - 优先使用主 worktree 路径（同仓库多个子 worktree 共用一份记忆）；
   * - 回退到当前项目路径，保证异常场景下仍可用。
   */
  const resolveWorktreeDeletePrefsKey = useCallback((project: Project | null): string => {
    const pid = String(project?.id || "").trim();
    if (!pid) return "";
    const info = gitInfoByProjectId[pid];
    const mainWorktree = String(info?.mainWorktree || "").trim();
    const fallback = String(project?.winPath || "").trim();
    return toDirKeyForCache(mainWorktree || fallback);
  }, [gitInfoByProjectId]);

  /**
   * 中文说明：主动查询“当前 worktree 与主 worktree 是否已对齐”。
   * - 优先使用主进程只读接口直接比较提交 SHA，避免受前端缓存影响；
   * - 仅在删除/重置弹窗仍停留在同一 projectId 时写回结果，避免竞态覆盖。
   */
  const refreshWorktreeDeleteAlignedState = useCallback(async (project: Project): Promise<void> => {
    const pid = String(project?.id || "").trim();
    const worktreePath = String(project?.winPath || "").trim();
    if (!pid || !worktreePath) return;
    try {
      const res: any = await (window as any).host?.gitWorktree?.isAlignedToMain?.({ worktreePath });
      const aligned = !!(res && res.ok && res.aligned === true);
      setWorktreeDeleteDialog((prev) => {
        if (!prev.open || prev.projectId !== pid) return prev;
        if (aligned !== true) return { ...prev, alignedToMain: false };
        // 已对齐时不允许勾选“保留目录并对齐到主 worktree”，避免无意义操作。
        return {
          ...prev,
          alignedToMain: true,
          action: "delete",
          needsForceRemoveWorktree: false,
          needsForceDeleteBranch: false,
          needsForceResetWorktree: false,
          error: undefined,
        };
      });
    } catch {
      setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, alignedToMain: false } : prev));
    }
  }, []);

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
  }, [t]);

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
		    if (!(await confirmWorktreeRecycleByTerminalAgents(project))) return;
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
		  }, [confirmWorktreeRecycleByTerminalAgents, showGitActionErrorDialog, t, worktreeRecycleDialog]);

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
		    if (!guardWorktreeDeleteAndResetByTerminalAgents(project)) return;
		    if (worktreeDeleteInFlightByProjectIdRef.current[pid]) {
		      setNoticeDialog({
		        open: true,
	        title: t("projects:worktreeDeleteTitle", "删除 worktree") as string,
	        message: t("projects:worktreeDeleteInProgress", "该 worktree 正在删除中，请勿重复操作。") as string,
	      });
	      return;
	    }
	    const prefsKey = resolveWorktreeDeletePrefsKey(project);
	    const persisted = prefsKey ? loadWorktreeDeletePrefs(prefsKey) : null;
	    const rememberedAction: "delete" | "reset" = persisted?.preferResetToMain ? "reset" : "delete";
	    const nextAction: "delete" | "reset" = action === "reset" ? "reset" : action === "delete" ? "delete" : rememberedAction;
	    if (prefsKey) saveWorktreeDeletePrefs(prefsKey, { preferResetToMain: nextAction === "reset" });
	    setWorktreeDeleteDialog({
	      open: true,
	      projectId: pid,
	      prefsKey: prefsKey || undefined,
	      alignedToMain: undefined,
	      action: nextAction,
	      afterRecycle: !!afterRecycle,
	      afterRecycleHint: afterRecycleHint || undefined,
	      running: false,
	      needsForceRemoveWorktree: false,
	      needsForceDeleteBranch: false,
	      needsForceResetWorktree: false,
	      error: undefined,
	    });
	    void refreshWorktreeDeleteAlignedState(project);
	  }, [guardWorktreeDeleteAndResetByTerminalAgents, refreshWorktreeDeleteAlignedState, resolveWorktreeDeletePrefsKey, t]);

  /**
   * 关闭“删除 worktree / 对齐到主工作区”对话框。
   */
		  const closeWorktreeDeleteDialog = useCallback(() => {
		    setWorktreeDeleteDialog((prev) => ({
		      ...prev,
		      open: false,
		      prefsKey: undefined,
		      alignedToMain: undefined,
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
	    if (!guardWorktreeDeleteAndResetByTerminalAgents(project)) return;

	    // 防重复：即使用户关闭弹窗后再次打开，也不允许重复触发同一 worktree 的删除
	    if (worktreeDeleteInFlightByProjectIdRef.current[String(project.id || "").trim()]) {
      setNoticeDialog({
        open: true,
        title: t("projects:worktreeDeleteTitle", "删除 worktree") as string,
        message: t("projects:worktreeDeleteInProgress", "该 worktree 正在删除中，请勿重复操作。") as string,
      });
      return;
    }

    setWorktreeDeleteInFlight(project.id, true);

    setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: true, error: undefined } : prev));
    try {
      if (dlg.action === "reset") {
        const res: any = await (window as any).host?.gitWorktree?.reset?.({
          worktreePath: project.winPath,
          force: opts?.forceResetWorktree === true,
        });
        if (res && res.ok) {
          setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, open: false, running: false } : prev));
          void refreshGitInfoForProjectIds([project.id]);
          return;
        }
        if (res?.needsForce) {
          setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: false, needsForceResetWorktree: true, error: String(res?.error || "") } : prev));
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
          setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, open: false, running: false } : prev));
          void refreshGitInfoForProjectIds([project.id]);
          try {
            const exists: any = await (window as any).host?.utils?.pathExists?.(project.winPath, true);
            if (exists && exists.ok && exists.exists) {
              showGitActionErrorDialog({
                title: t("projects:worktreeDeleteManualCleanupTitle", "目录未完全删除") as string,
                hint: t("projects:worktreeDeleteManualCleanupHint", "目录可能因文件占用未能删除。") as string,
                message: (t("projects:worktreeDeleteManualCleanupDesc", "已解除 worktree 关联并删除分支，但目录仍存在：\n{path}\n请打开文件夹手动删除（可能有文件占用）。", { path: project.winPath }) as string),
                dir: project.winPath,
              });
            }
          } catch {}
          return;
        }
        if (res?.needsForceRemoveWorktree) {
          setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: false, needsForceRemoveWorktree: true, error: String(res?.error || "") } : prev));
          return;
        }
        if (res?.needsForceDeleteBranch) {
          setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: false, needsForceDeleteBranch: true, error: String(res?.error || "") } : prev));
          return;
        }
        throw new Error(res?.error || "delete failed");
      }
    } catch (e: any) {
      setWorktreeDeleteDialog((prev) => (prev.open && prev.projectId === pid ? { ...prev, running: false, error: String(e?.message || e) } : prev));
      showGitActionErrorDialog({
        title: dlg.action === "reset" ? (t("projects:worktreeResetFailed", "重置失败") as string) : (t("projects:worktreeDeleteFailed", "删除 worktree 失败") as string),
        message: String(e?.message || e),
        dir: project.winPath,
      });
    } finally {
      setWorktreeDeleteInFlight(project.id, false);
    }
  }, [guardWorktreeDeleteAndResetByTerminalAgents, refreshGitInfoForProjectIds, setWorktreeDeleteInFlight, showGitActionErrorDialog, t, worktreeDeleteDialog]);

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
   * 中文说明：扫描项目目录下存在的项目级规则文件（AGENTS/CLAUDE/GEMINI）。
   */
  const scanProjectRuleEntries = useCallback(async (project: Project | null): Promise<ProjectRuleMenuEntry[]> => {
    const root = String(project?.winPath || "").trim();
    if (!root) return [];
    const out: ProjectRuleMenuEntry[] = [];
    for (const providerId of BUILT_IN_RULE_PROVIDER_IDS) {
      const filePath = getProjectRuleFilePath(providerId, root);
      let exists = false;
      try {
        const stat = await window.host.utils.pathExists(filePath);
        exists = !!(stat && stat.ok && stat.exists && stat.isFile);
      } catch {}
      if (!exists) continue;
      out.push({
        providerId,
        fileName: getProviderRuleFileName(providerId),
        filePath,
      });
    }
    return out;
  }, []);

  /**
   * 中文说明：打开项目右键菜单，并异步加载“项目级规则文件”可编辑入口。
   */
  const openProjectContextMenu = useCallback((project: Project, x: number, y: number) => {
    setProjectCtxMenu({ show: true, x, y, project });
    setProjectCtxRuleEntries([]);
    const scanSeq = projectCtxRuleScanSeqRef.current + 1;
    projectCtxRuleScanSeqRef.current = scanSeq;
    void (async () => {
      const entries = await scanProjectRuleEntries(project);
      if (projectCtxRuleScanSeqRef.current !== scanSeq) return;
      setProjectCtxRuleEntries(entries);
    })();
  }, [scanProjectRuleEntries]);

  /**
   * 中文说明：打开项目级规则文件进行编辑（系统默认编辑器）。
   */
  const editProjectRuleFile = useCallback(async (filePath: string) => {
    const target = String(filePath || "").trim();
    if (!target) return;
    try {
      const res: any = await window.host.utils.openPath(target);
      if (!(res && res.ok)) throw new Error(res?.error || "failed");
    } catch {
      alert(String(t("common:files.cannotOpenPath")));
    } finally {
      setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
    }
  }, [t]);

  /**
   * 中文说明：打开历史记录“删除到回收站”确认弹窗（用于悬停快捷键 Delete/Del）。
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
     * - 历史列表：Delete/Del=删除历史对话（删除到回收站）
     */
    const handler = (event: KeyboardEvent) => {
      const k = String(event?.key || "");
      const code = String((event as any)?.code || "");
      const key = k.toLowerCase();
      const isHistoryDeleteKey = key === "delete" || code === "Delete";
      if (!isHistoryDeleteKey && key !== "h" && key !== "d") return;
      if (shouldIgnoreHoverShortcutEvent(event)) return;

      // 历史项优先：Delete/Del = 删除历史对话（删除到回收站）
      if (isHistoryDeleteKey) {
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

        // Delete/Del：在未命中历史项时，退化为项目列表删除快捷键（等同于 D）
        if (key === "d" || isHistoryDeleteKey) {
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
                  openProjectContextMenu(p, e.clientX, e.clientY);
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
            const hasAgentTimer = !!agentTurnTimerByTab[tab.id];
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
                            {renderAgentTurnStatusBar(tab.id, "px-4 pt-0.5 pb-0.5")}
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
                      <div className={`${hasAgentTimer ? "mt-0.5" : "mt-3"} w-full`}>
                        <div className="relative w-full">
                          {renderAgentTurnStatusBar(tab.id)}
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
        const notifyEnv = buildProviderNotifyEnv(tab.id, tab.providerId, tab.name);
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
          armResumeCompletionGuard(tab.id, providerId);
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
              void handleHistorySearchEnter();
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
                      const previewSource = s.preview || s.title || s.filePath || '';
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
          {historySessions.length > 0 && historyHasMore && (
            <div className="px-2 py-1">
              <Button
                variant="outline"
                className="w-full h-8 text-xs"
                disabled={historyLoadingMore}
                onClick={() => { void loadMoreHistorySessions(); }}
              >
                {historyLoadingMore ? (t("history:loading", "加载中…") as string) : (t("history:loadMore", "加载更多历史") as string)}
              </Button>
            </div>
          )}
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
              {historyHasMore && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={historyLoadingMore}
                    onClick={() => { void ensureHistoryMatchLoaded(historyQuery); }}
                  >
                    {historyLoadingMore ? (t("history:loading", "加载中…") as string) : (t("history:loadMoreAndSearch", "继续加载并搜索") as string)}
                  </Button>
                </div>
              )}
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
                  if (projectKey) {
                    setHistoryCache(projectKey, {
                      sessions: list,
                      hasMore: historyHasMoreRef.current,
                      nextOffset: historyNextOffsetRef.current,
                    });
                  }
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
                  try { setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null })); } catch {}
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
            if (proj && projectCtxRuleEntries.length > 0) {
              menuItems.push(
                <div
                  key="project-rule-separator"
                  className="my-1 h-px bg-[var(--cf-border)]"
                />,
              );
              for (const ruleEntry of projectCtxRuleEntries) {
                menuItems.push(
                  <button
                    key={`edit-project-rule-${ruleEntry.providerId}`}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                    onClick={() => { void editProjectRuleFile(ruleEntry.filePath); }}
                  >
                    <FilePenLine className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t("projects:ctxEditProjectRule", { file: ruleEntry.fileName })}
                  </button>
                );
              }
            }
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

      {agentTurnCtxMenu.show && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null }))}
          onContextMenu={(event) => { event.preventDefault(); setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null })); }}
        >
          {(function renderAgentTimerMenu() {
            const tabId = String(agentTurnCtxMenu.tabId || "").trim();
            const timerState = tabId ? agentTurnTimerByTab[tabId] : undefined;
            if (!tabId || !timerState) return null;
            return (
              <div
                ref={agentTurnCtxMenuRef}
                className="absolute z-50 min-w-[160px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple shadow-apple-lg p-1.5 text-sm text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg"
                style={{ left: agentTurnCtxMenu.x, top: agentTurnCtxMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-red)] rounded-apple-sm hover:bg-[var(--cf-red-light)] transition-all duration-apple-fast"
                  onClick={() => {
                    cancelAgentTurnTimer(tabId, "context-menu");
                    setAgentTurnCtxMenu((m) => ({ ...m, show: false, tabId: null }));
                  }}
                >
                  <X className="h-4 w-4" /> {t("terminal:cancelTimer") as string}
                </button>
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
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader className="pb-2 shrink-0">
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
	              let promptCleared = false;
	              let firstReuseProjectId: string | null = null;
	              let firstReuseTabId: string | null = null;
              for (let i = 0; i < selectedChildIdsOrdered.length; i++) {
                const projectId = selectedChildIdsOrdered[i];
                const wtProject = childWorktrees.find((p) => p.id === projectId) || null;
                if (!wtProject) continue;
                const providerId = providerQueue[i] || worktreeCreateDialog.singleProviderId;
                // 用户主动选择：若该 worktree 被隐藏，则自动取消隐藏
                unhideProject(wtProject);
	                const started = await startProviderInstanceInProject({ project: wtProject, providerId, prompt, useYolo: worktreeCreateDialog.useYolo });
	                if (started.ok && started.tabId) {
	                  if (!firstReuseTabId) firstReuseTabId = started.tabId;
	                  if (!promptCleared && prompt.trim()) {
	                    promptCleared = true;
	                    clearWorktreeCreateInitialPromptRecord(repo.id);
	                  }
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
                await createWorktreesAndStartAgents({ repoProject: repo, baseBranch, instances: remainingInstances, prompt, useYolo: worktreeCreateDialog.useYolo, extraWarnings });
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
              <div className="flex min-h-0 flex-1 flex-col">
                <ScrollArea className="min-h-0 flex-1 pr-1">
                  <div className="space-y-3 py-1">
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
                        <div className="flex items-center gap-3">
                          <label
                            className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)] cursor-pointer select-none hover:text-slate-800 dark:hover:text-slate-300 transition-colors"
                            title={t("projects:worktreeYoloHint", "仅对本次操作生效，不会修改全局设置。") as string}
                          >
                            <input
                              type="checkbox"
                              className="h-3 w-3 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]"
                              checked={worktreeCreateDialog.useYolo}
                              onChange={(e) => setDialog({ useYolo: e.target.checked })}
                              disabled={worktreeCreateDialog.creating}
                            />
                            {t("projects:worktreeUseYolo", "yolo（推荐）")}
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
                    {t("projects:worktreeInitialPrompt", "初始提示词") as string}
                  </div>
                  <div className="relative w-full">
                    <PathChipsInput
                      placeholder={t("terminal:inputPlaceholder") as string}
                      multiline
                      onKeyDown={(e: any) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          void submit();
                          e.preventDefault();
                        }
                      }}
                      chips={worktreeCreateDialog.promptChips}
                      onChipsChange={(next) => setDialog({ promptChips: next })}
                      draft={worktreeCreateDialog.promptDraft}
                      onDraftChange={(v) => setDialog({ promptDraft: v })}
                      winRoot={repo.winPath}
                      projectWslRoot={repo.wslPath}
                      projectName={repo.name}
                      projectPathStyle={projectPathStyle}
                      warnOutsideProjectDrop={dragDropWarnOutsideProject}
                      onWarnOutsideProjectDropChange={updateWarnOutsideProjectDrop}
                      className="min-h-[3rem] text-xs"
                    />
                    <div className="absolute right-2 bottom-2 flex flex-row gap-2">
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label={t("terminal:expandInput") as string}
                        title={t("terminal:expandInput") as string}
                        onClick={() => setWorktreeCreatePromptFullscreenOpen(true)}
                        className="h-8 w-8 rounded-full shadow-sm"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                  </div>
                </ScrollArea>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/50 mt-2 shrink-0">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeWorktreeCreateDialog} disabled={worktreeCreateDialog.creating}>
                    {t("common:cancel", "取消") as string}
                  </Button>
                  <Button variant="secondary" size="sm" className="h-8 text-xs min-w-[4rem]" onClick={() => void submit()} disabled={!canSubmit}>
                    {worktreeCreateDialog.creating ? primaryActionWorkingLabel : primaryActionLabel}
                  </Button>
                </div>

                {/* worktree 创建：初始提示词（展开编辑） */}
                <Dialog
                  open={worktreeCreatePromptFullscreenOpen}
                  onOpenChange={(open) => {
                    if (open) return;
                    setWorktreeCreatePromptFullscreenOpen(false);
                  }}
                >
                  <DialogContent
                    className="max-w-none overflow-hidden"
                    style={{
                      width: "calc(100vw - 48px)",
                      maxWidth: 1080,
                      height: "calc(100vh - 48px)",
                      maxHeight: 820,
                      padding: 0,
                    }}
                  >
                    <div className="flex h-full w-full flex-col">
                      <div className="px-6 pt-5 pb-4 border-b border-slate-100/80 dark:border-slate-800/60">
                        <div className="text-sm font-semibold text-slate-800 dark:text-[var(--cf-text-primary)]">
                          {t("projects:worktreeInitialPrompt", "初始提示词") as string}
                        </div>
                      </div>

                      <div className="flex flex-1 min-h-0 p-4">
                        <div className="relative flex flex-1 min-h-0">
                          <PathChipsInput
                            placeholder={t("terminal:inputPlaceholder") as string}
                            multiline
                            onKeyDown={(e: any) => {
                              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                void submit();
                                e.preventDefault();
                              }
                            }}
                            chips={worktreeCreateDialog.promptChips}
                            onChipsChange={(next) => setDialog({ promptChips: next })}
                            draft={worktreeCreateDialog.promptDraft}
                            onDraftChange={(v) => setDialog({ promptDraft: v })}
                            winRoot={repo.winPath}
                            projectWslRoot={repo.wslPath}
                            projectName={repo.name}
                            projectPathStyle={projectPathStyle}
                            warnOutsideProjectDrop={dragDropWarnOutsideProject}
                            onWarnOutsideProjectDropChange={updateWarnOutsideProjectDrop}
                            className="flex flex-1 flex-col min-h-0 overflow-auto h-full text-sm"
                            balancedScrollbarGutter
                            draftInputClassName="flex-1 min-h-0"
                          />
                          <div className="pointer-events-auto absolute right-2 bottom-2 flex flex-row gap-2">
                            <Button
                              variant="secondary"
                              size="icon"
                              aria-label={t("terminal:collapseInput") as string}
                              title={t("terminal:collapseInput") as string}
                              onClick={() => setWorktreeCreatePromptFullscreenOpen(false)}
                              className="h-8 w-8 rounded-full shadow-sm"
                            >
                              <Minimize2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
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
        <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader className="pb-2 shrink-0">
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
                : status === "canceling"
                ? (t("projects:worktreeCreateCanceling", "取消中…") as string)
                : status === "canceled"
                ? (t("projects:worktreeCreateCanceled", "已取消") as string)
                : status === "success"
                ? (t("common:done", "完成") as string)
                : (t("common:failed", "失败") as string);
            const statusIcon =
              status === "running" || status === "canceling" ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
              ) : status === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : status === "canceled" ? (
                <X className="h-4 w-4 text-slate-500" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-red-600" />
              );
            const totalCount = Math.max(0, Math.floor(Number(worktreeCreateProgress.totalCount) || 0));
            const completedCount = Math.max(0, Math.floor(Number(worktreeCreateProgress.completedCount) || 0));
            const successCount = Math.max(0, Math.floor(Number(worktreeCreateProgress.successCount) || 0));
            const failedCount = Math.max(0, Math.floor(Number(worktreeCreateProgress.failedCount) || 0));
            const runningCount = Math.max(0, totalCount - completedCount);
            const worktreeStates = Array.isArray(worktreeCreateProgress.worktreeStates) ? worktreeCreateProgress.worktreeStates : [];
            const sortedStates = [...worktreeStates].sort((left, right) => {
              const byIndex = Math.max(0, Math.floor(Number(left?.index) || 0)) - Math.max(0, Math.floor(Number(right?.index) || 0));
              if (byIndex !== 0) return byIndex;
              return String(left?.providerId || "").localeCompare(String(right?.providerId || ""));
            });

            /**
             * 中文说明：将“创建状态”映射为可视化文案。
             */
            const toCreateStatusLabel = (createStatus: WorktreeCreateTaskItemStatus): string => {
              if (createStatus === "creating") return t("projects:worktreeCreating", "创建中…") as string;
              if (createStatus === "success") return t("common:done", "完成") as string;
              if (createStatus === "canceled") return t("projects:worktreeCreateCanceled", "已取消") as string;
              return t("common:failed", "失败") as string;
            };

            /**
             * 中文说明：将“后续流程状态”映射为可视化文案。
             */
            const toPostStatusLabel = (postStatus: "idle" | "running" | "success" | "error"): string => {
              if (postStatus === "running") return t("projects:worktreeCreatePostStarting", "后续处理中…") as string;
              if (postStatus === "success") return t("projects:worktreeCreatePostStarted", "后续已启动") as string;
              if (postStatus === "error") return t("projects:worktreeCreatePostFailed", "后续失败") as string;
              return t("projects:worktreeCreatePostPending", "等待后续处理") as string;
            };

            /**
             * 中文说明：按状态返回对应样式类名，便于在并发列表中快速定位异常。
             */
            const toStatusClassName = (value: "creating" | "success" | "error" | "canceled" | "idle" | "running"): string => {
              if (value === "success") return "text-emerald-700 bg-emerald-50 border-emerald-200";
              if (value === "error") return "text-red-700 bg-red-50 border-red-200";
              if (value === "canceled") return "text-slate-700 bg-slate-100 border-slate-200";
              return "text-slate-700 bg-slate-50 border-slate-200";
            };

            return (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
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
                  <span className="text-[10px] text-slate-400">
                    {worktreeCreateProgress.allCompleted
                      ? (t("projects:worktreeCreateAllCompleted", "全部创建流程已结束") as string)
                      : (t("projects:worktreeCreateInProgressSummary", "已完成 {done}/{total}") as any)
                          .replace("{done}", String(completedCount))
                          .replace("{total}", String(totalCount))}
                  </span>
                  {worktreeCreateProgress.updatedAt ? (
                    <span className="text-[10px] text-slate-400">
                      {new Date(worktreeCreateProgress.updatedAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                    <div className="text-slate-400">{t("projects:worktreeCreateSummaryTotal", "总数") as string}</div>
                    <div className="font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">{totalCount}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                    <div className="text-slate-400">{t("projects:worktreeCreateSummaryCompleted", "已完成") as string}</div>
                    <div className="font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">{completedCount}</div>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1">
                    <div className="text-emerald-500">{t("projects:worktreeCreateSummarySuccess", "成功") as string}</div>
                    <div className="font-semibold text-emerald-700">{successCount}</div>
                  </div>
                  <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-1">
                    <div className="text-red-500">{t("projects:worktreeCreateSummaryFailed", "失败") as string}</div>
                    <div className="font-semibold text-red-700">{failedCount}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                    <div className="text-slate-400">{t("projects:worktreeCreateSummaryRunning", "进行中") as string}</div>
                    <div className="font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">{runningCount}</div>
                  </div>
                </div>

                {sortedStates.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] overflow-hidden">
                    <ScrollArea className="h-[min(15rem,30vh)]">
                      <div className="p-2 space-y-2">
                        {sortedStates.map((state) => {
                          const worktreeKey = String(state?.key || "").trim();
                          const postState = worktreeCreateProgress.postStateByKey?.[worktreeKey] || { status: "idle" as const };
                          const createStatus = (state?.status || "creating") as WorktreeCreateTaskItemStatus;
                          const postStatus = (postState.status || "idle") as "idle" | "running" | "success" | "error";
                          return (
                            <div key={worktreeKey || `${state.providerId}-${state.index}`} className="rounded-md border border-slate-200 bg-white p-2 dark:border-[var(--cf-border)] dark:bg-[var(--cf-bg)] space-y-1">
                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                <div className="font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
                                  {String(state.providerId || "").toUpperCase()} · wt{Math.max(0, Math.floor(Number(state.index) || 0))}
                                </div>
                                <div className="flex items-center gap-1">
                                  <span className={`rounded border px-1.5 py-0.5 ${toStatusClassName(createStatus)}`}>
                                    {(t("projects:worktreeCreateItemStatusCreate", "创建") as string)}：{toCreateStatusLabel(createStatus)}
                                  </span>
                                  <span className={`rounded border px-1.5 py-0.5 ${toStatusClassName(postStatus === "running" ? "running" : postStatus)}`}>
                                    {(t("projects:worktreeCreateItemStatusPost", "后续") as string)}：{toPostStatusLabel(postStatus)}
                                  </span>
                                </div>
                              </div>
                              <div className="text-[11px] text-slate-500 break-all font-mono">{state.worktreePath}</div>
                              <div className="text-[11px] text-slate-500 break-all font-mono">{state.wtBranch}</div>
                              {state.error ? (
                                <div className="text-[11px] text-red-700 whitespace-pre-wrap break-words">{state.error}</div>
                              ) : null}
                              {postState.error ? (
                                <div className="text-[11px] text-red-700 whitespace-pre-wrap break-words">{postState.error}</div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                ) : null}

                {worktreeCreateProgress.error ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 whitespace-pre-wrap break-words">
                    {worktreeCreateProgress.error}
                  </div>
                ) : null}

                <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] overflow-hidden">
                  <ScrollArea className="h-[min(11rem,24vh)]">
                    <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words p-3 text-slate-700 dark:text-[var(--cf-text-secondary)]">
                      {worktreeCreateProgress.log || ""}
                    </pre>
                  </ScrollArea>
                </div>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-1 shrink-0">
                  {status === "running" || status === "canceling" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={status !== "running"}
                      onClick={async () => {
                        const taskId = String(worktreeCreateProgress.taskId || "").trim();
                        if (!taskId) return;
                        // 乐观更新，避免用户感觉“点了没反应”
                        setWorktreeCreateProgress((prev) => (prev.taskId === taskId ? { ...prev, status: "canceling" } : prev));
                        try { await (window as any).host?.gitWorktree?.createTaskCancel?.({ taskId }); } catch {}
                      }}
                    >
                      {status === "canceling"
                        ? (t("projects:worktreeCreateCanceling", "取消中…") as string)
                        : (t("projects:worktreeCreateCancelAction", "取消创建") as string)}
                    </Button>
                  ) : null}
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
            const alreadyAligned = worktreeDeleteDialog.alignedToMain === true;
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

                  {alreadyAligned ? (
                    <div className="rounded-md border border-slate-200/60 bg-slate-50/50 px-2.5 py-2 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                      <div className="text-[10px] text-slate-600 dark:text-[var(--cf-text-secondary)] leading-snug">
                        {t("projects:worktreeDeleteResetHintAligned", "检测到当前已与主 worktree 对齐，已隐藏对齐选项。") as string}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border border-slate-200/60 bg-white/60 px-2.5 py-2 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)]">
                      <label className="flex gap-2 items-start cursor-pointer">
	                      <input
	                        type="checkbox"
	                        className="mt-0.5"
	                        checked={worktreeDeleteDialog.action === "reset"}
	                        disabled={worktreeDeleteDialog.running}
	                        onChange={(e) => {
	                          const preferResetToMain = e.target.checked === true;
	                          const prefsKey = String(worktreeDeleteDialog.prefsKey || "").trim();
	                          if (prefsKey) saveWorktreeDeletePrefs(prefsKey, { preferResetToMain });
	                          setWorktreeDeleteDialog((prev) => ({
                            ...prev,
                            action: preferResetToMain ? "reset" : "delete",
                            needsForceRemoveWorktree: false,
                            needsForceDeleteBranch: false,
                            needsForceResetWorktree: false,
                            error: undefined,
                          }));
                        }}
                      />
			                      <div className="space-y-0.5">
			                        <div className="text-[11px] font-semibold text-slate-700 dark:text-[var(--cf-text-primary)]">
			                          {t("projects:worktreeDeleteResetOption", "保留并重置该目录（不移除worktree）") as string}
			                        </div>
			                        <div className="text-[10px] text-slate-500 dark:text-[var(--cf-text-secondary)] leading-snug">
			                          {isReset
			                            ? (t("projects:worktreeDeleteResetHintChecked", "将对齐到主 worktree 当前签出版本并清理；不会执行“移除worktree”。") as string)
			                            : (t(
			                                "projects:worktreeDeleteResetHint",
			                                "仅重置到与主 worktree 当前签出的修订版一致并清理；不会执行“移除worktree”。"
			                              ) as string)}
			                        </div>
		                      </div>
                      </label>
                    </div>
                  )}
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
        open={worktreeRecycleTerminalAgentsDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          resolveWorktreeRecycleTerminalAgentsConfirm(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("projects:worktreeRecycleTerminalAgentsTitle", "终端代理仍在运行") as string}</DialogTitle>
            <DialogDescription>
              {t(
                "projects:worktreeRecycleTerminalAgentsDesc",
                "检测到当前项目存在 {count} 个终端代理仍在运行。继续合并可能影响正在运行的任务/进程。是否继续？",
                { count: worktreeRecycleTerminalAgentsDialog.count }
              ) as string}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => resolveWorktreeRecycleTerminalAgentsConfirm(false)}>
              {t("common:cancel", "取消") as string}
            </Button>
            <Button variant="secondary" onClick={() => resolveWorktreeRecycleTerminalAgentsConfirm(true)}>
              {t("common:continue", "继续") as string}
            </Button>
          </div>
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
                "当前项目存在 {count} 个终端代理，删除/重置 worktree 功能不可用。请关闭所有终端代理再尝试。",
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
            <DialogDescription>
              {String(gitActionErrorDialog.hint || "").trim() ||
                (t("projects:gitActionFailedHint", "请在外部工具中处理冲突/中断/hook 等问题后再重试。") as string)}
            </DialogDescription>
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
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button variant="outline" onClick={closeGitActionErrorDialog}>
                {t("common:close", "关闭") as string}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  try { if (gitActionErrorDialog.dir) await (window as any).host?.utils?.openPath?.(gitActionErrorDialog.dir); } catch {}
                  closeGitActionErrorDialog();
                }}
                disabled={!gitActionErrorDialog.dir}
              >
                {t("projects:gitOpenFolder", "打开文件夹") as string}
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

function ContentRenderer({ items, kprefix }: { items: MessageContent[]; kprefix?: string }) {
  if (!Array.isArray(items) || items.length === 0) return null;
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
            </div>
          );
        }
        if (ty === 'code') {
          return (
            <div key={`${kprefix || 'itm'}-code-${i}`} className="relative">
              <HistoryCopyButton text={text} variant="secondary" className="absolute right-2 top-2" />
              <pre className="overflow-x-auto rounded-apple bg-[var(--cf-surface-muted)] border border-[var(--cf-border)] p-3 text-xs text-[var(--cf-text-primary)] font-mono shadow-apple-inner">
                <code data-history-search-scope>{text}</code>
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
            </div>
          );
        }
        if (ty === 'summary') {
          return (
            <div key={`${kprefix || 'itm'}-sum-${i}`} className="relative rounded-apple border border-[var(--cf-border)] bg-[var(--cf-purple-light)] p-2 text-xs text-[var(--cf-text-primary)] font-apple-regular">
              <HistoryCopyButton text={text} className="absolute right-2 top-2" />
              <HistoryMarkdown text={text} />
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
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
              <HistoryMarkdown text={text} />
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
              <HistoryMarkdown text={text} />
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
                <code data-history-search-scope>{text}</code>
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
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-apple-regular">
                <code data-history-search-scope>{text}</code>
              </pre>
            </div>
          );
        }
        // default: treat as plain text, including input_text/output_text etc.
        return (
          <div key={`${kprefix || 'itm'}-txt-${i}`} className="relative">
            <HistoryCopyButton text={text} className="absolute right-0 -top-1" />
            <HistoryMarkdown text={text} />
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

type HistoryMessageView = {
  /** 稳定的 messageKey：用于 React key、DOM 查找与命中归属。 */
  messageKey: string;
  /** 原始消息序号（基于 session.messages 的索引）。 */
  originalIndex: number;
  /** 过滤后的消息内容（会按 typeFilter 裁剪 content）。 */
  message: HistoryMessage;
};

type HistoryFilterResult = {
  messages: HistoryMessageView[];
  matches: SearchMatch[];
  fieldMatches: FieldMatchMap;
};

type HistoryRenderOptions = {
  activeMessageKey?: string;
  registerMessageRef?: (key: string, node: HTMLDivElement | null) => void;
};

/**
 * 中文说明：构造历史详情每条消息的稳定 messageKey。
 * 设计：使用 “sessionId + 原始消息序号” 来避免筛选/搜索导致的索引漂移，从而防止 React 复用错误节点。
 */
function buildHistoryMessageKey(sessionId: string, originalIndex: number): string {
  return `${sessionId}-${originalIndex}`;
}

/**
 * 中文说明：渲染历史详情的消息块列表。
 * 关键点：必须使用稳定 messageKey 作为 React key，避免“筛选/搜索导致索引漂移”触发错误节点复用。
 */
function renderHistoryBlocks(session: HistorySession, messages: HistoryMessageView[], options?: HistoryRenderOptions) {
  if (!session) return null;
  return (
    <div>
      {/* 详情标题：显示本地时间（优先 rawDate -> date -> 文件名推断），tooltip 同时展示本地与原始信息 */}
      <h3 className="mb-1.5 max-w-full truncate text-sm font-apple-medium text-[var(--cf-text-secondary)]" title={`${toLocalDisplayTime(session)} ${session.rawDate ? '• ' + session.rawDate : (session.date ? '• ' + session.date : '')}`}>
        {toLocalDisplayTime(session)}
      </h3>
      <div className="space-y-2">
        {messages.map((view) => {
          const m = view.message;
          const messageKey = view.messageKey;
          const isActive = options?.activeMessageKey === messageKey;
          return (
            <div
              key={messageKey}
              ref={(node) => options?.registerMessageRef?.(messageKey, node)}
              data-history-message-key={messageKey}
              className={`rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-2 shadow-apple-sm text-[var(--cf-text-primary)] transition-all duration-apple hover:shadow-apple dark:shadow-apple-dark-sm dark:hover:shadow-apple-dark ${isActive ? 'ring-1 ring-[var(--cf-accent)]/70 shadow-apple dark:ring-[var(--cf-accent)]/40' : ''}`}
            >
              <div data-history-search-scope className="mb-1 text-xs uppercase tracking-wider font-apple-semibold text-[var(--cf-text-secondary)]">{m.role}</div>
              <ContentRenderer items={m.content} kprefix={messageKey} />
            </div>
          );
        })}
      </div>
    </div>
  );
}


/**
 * 中文说明：按类型筛选与关键字过滤历史消息，并生成“命中索引”。
 * - messages：返回带稳定 messageKey 的消息视图（基于原始序号），用于渲染与 DOM 查找；
 * - matches：用于“上一个/下一个”跳转的命中列表（文本命中会被后续 DOM 高亮替代，仅保留元信息命中）；
 * - fieldMatches：旧版文本字段命中（用于区分 meta/text 命中来源）。
 */
function filterHistoryMessages(session: HistorySession, typeFilter: Record<string, boolean>, normalizedSearch: string): HistoryFilterResult {
  const allowItem = (item: any) => {
    if (!typeFilter) return true;
    const keys = keysOfItemCanonical(item);
    // developer 标签需要显式启用：避免 developer 内容被 input_text 等类型“顺带展示”
    if (keys.includes('developer') && Object.prototype.hasOwnProperty.call(typeFilter, 'developer') && !(typeFilter as any)['developer']) return false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(typeFilter, key) && !!(typeFilter as any)[key]) return true;
    }
    return !!(typeFilter as any)["other"];
  };

  const candidateMessages = (session.messages || []).map((m) => ({
    ...m,
    content: (m.content || []).filter((item) => allowItem(item)),
  }));

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

  const filteredMessages: HistoryMessageView[] = [];
  const searchActive = normalizedSearch.length > 0;
  for (let originalIndex = 0; originalIndex < candidateMessages.length; originalIndex += 1) {
    const message = candidateMessages[originalIndex];
    const hasContent =
      Array.isArray(message.content) && message.content.some((item) => String((item as any)?.text ?? "").trim().length > 0);
    if (!hasContent) continue;

    const messageKey = buildHistoryMessageKey(session.id, originalIndex);
    if (!searchActive) {
      filteredMessages.push({ messageKey, originalIndex, message });
      continue;
    }
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
      filteredMessages.push({ messageKey, originalIndex, message });
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
  const indexedMatches = filteredHistory.matches;
  const indexedFieldMatches = filteredHistory.fieldMatches;
  const showNoMatch = detailSearchActive && filteredMessages.length === 0;

  // DOM 级高亮（用于适配 Markdown 渲染后文本结构变化），并保持与现有“过滤/跳转”能力兼容
  const historyFindRootRef = useRef<HTMLDivElement | null>(null);
  const [domTextMatches, setDomTextMatches] = useState<SearchMatch[]>([]);

  // 仅保留“元信息命中”（type/tag），文本命中改由 DOM 高亮结果驱动
  const metaMatches = useMemo(() => {
    if (!detailSearchActive) return [];
    const textIds = new Set<string>();
    try {
      for (const list of Object.values(indexedFieldMatches)) {
        for (const m of list) textIds.add(m.matchId);
      }
    } catch {}
    return indexedMatches.filter((m) => !textIds.has(m.id));
  }, [detailSearchActive, indexedMatches, indexedFieldMatches]);

  const matches = useMemo(() => {
    if (!detailSearchActive || !detailSession) return [];
    const byMessageText = new Map<string, SearchMatch[]>();
    for (const m of domTextMatches) {
      const k = String(m.messageKey || "");
      if (!k) continue;
      const list = byMessageText.get(k) || [];
      list.push(m);
      byMessageText.set(k, list);
    }
    const byMessageMeta = new Map<string, SearchMatch[]>();
    for (const m of metaMatches) {
      const k = String(m.messageKey || "");
      if (!k) continue;
      const list = byMessageMeta.get(k) || [];
      list.push(m);
      byMessageMeta.set(k, list);
    }

    // 说明：按消息顺序合并，先文本命中后元信息命中（保持跳转逻辑直观且稳定）
    const out: SearchMatch[] = [];
    for (const view of filteredMessages) {
      const messageKey = String(view?.messageKey || "");
      if (!messageKey) continue;
      const textHits = byMessageText.get(messageKey);
      if (textHits && textHits.length) out.push(...textHits);
      const metaHits = byMessageMeta.get(messageKey);
      if (metaHits && metaHits.length) out.push(...metaHits);
    }

    // 兜底：若存在异常 messageKey（理论不应发生），仍合并到末尾避免丢失匹配数
    for (const [, list] of byMessageText) for (const m of list) if (!out.includes(m)) out.push(m);
    for (const [, list] of byMessageMeta) for (const m of list) if (!out.includes(m)) out.push(m);

    return out;
  }, [detailSearchActive, detailSession, filteredMessages.length, domTextMatches, metaMatches]);

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
    const root = historyFindRootRef.current;
    if (!root) return;

    // 搜索关闭：清理高亮与命中列表
    if (!detailSearchActive) {
      try {
        clearHistoryFindHighlights(root);
      } catch {}
      setDomTextMatches([]);
      return;
    }

    let raf = 0;
    let disposed = false;
    const observer = new MutationObserver(() => {
      if (disposed) return;
      try {
        if (raf) cancelAnimationFrame(raf);
      } catch {}
      raf = requestAnimationFrame(apply);
    });

    const apply = () => {
      if (disposed) return;
      try { observer.disconnect(); } catch {}
      try {
        const domMatches = applyHistoryFindHighlights({ root, query: normalizedDetailSearch });
        setDomTextMatches(domMatches.map((m) => ({ id: m.id, messageKey: m.messageKey })));
      } catch {
        setDomTextMatches([]);
      }
      try {
        if (!disposed) observer.observe(root, { subtree: true, childList: true, characterData: true });
      } catch {}
    };

    try {
      observer.observe(root, { subtree: true, childList: true, characterData: true });
    } catch {}
    raf = requestAnimationFrame(apply);

    return () => {
      disposed = true;
      try { observer.disconnect(); } catch {}
      try {
        if (raf) cancelAnimationFrame(raf);
      } catch {}
    };
  }, [detailSearchActive, normalizedDetailSearch, detailSession, filteredMessages.length]);

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
    const root = historyFindRootRef.current;
    if (!root) return;
    if (!detailSearchActive) {
      try { setActiveHistoryFindMatch(root, null); } catch {}
      return;
    }
    try { setActiveHistoryFindMatch(root, activeMatch?.id); } catch {}
  }, [detailSearchActive, activeMatch?.id]);

  useEffect(() => {
    if (!detailSearchActive || !activeMatch) return;
    requestAnimationFrame(() => {
      const root = historyFindRootRef.current;
      if (!root) return;
      let target: HTMLElement | null = null;
      try {
        const candidates = Array.from(root.querySelectorAll("[data-match-id]")) as HTMLElement[];
        target = candidates.find((n) => String(n.getAttribute("data-match-id") || "") === activeMatch.id) || null;
      } catch {}
      if (target) {
        try {
          target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        } catch {}
        return;
      }
      const node = messageRefs.current[activeMatch.messageKey];
      if (node) {
        try {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
      }
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
      // developer 标签需要显式启用：避免 developer 内容被 input_text 等类型“顺带展示”
      if (keys.includes('developer') && Object.prototype.hasOwnProperty.call(typeFilter, 'developer') && !typeFilter['developer']) return false;
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
            <div ref={historyFindRootRef} data-history-find-root className="space-y-2">
              {detailSession
                ? renderHistoryBlocks(detailSession, filteredMessages, {
                    activeMessageKey: detailSearchActive ? activeMatch?.messageKey : undefined,
                    registerMessageRef,
                  })
                : (selectedSession
                    ? renderHistoryBlocks(selectedSession, filteredMessages, {
                        activeMessageKey: detailSearchActive ? activeMatch?.messageKey : undefined,
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
