// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCodexConfigTomlPath,
  getGlobalRuleFilePath,
  getProviderRuleFileName,
  normalizeEngineRootPaths,
  type BuiltInRuleProviderId,
} from "@/lib/engine-rules";
import { cn, formatBytes } from "@/lib/utils";
import { listAvailableLanguages, changeAppLanguage } from "@/i18n/setup";
import { CodexAccountInline } from "@/components/topbar/codex-status";
import { CodexAuthSwitch } from "./codex-auth-switch";
import {
  Trash2,
  Power,
  ChevronUp,
  ChevronDown,
  Plus,
  Image as ImageIcon,
  Star,
  Settings2,
  Cpu,
  Terminal as TerminalIcon,
  GitBranch,
  Bell,
  Globe,
  Database,
  Info,
  Check,
  CheckCircle2,
  TerminalSquare,
  ExternalLink,
  GitMerge,
} from "lucide-react";
import { getBuiltInProviders, isBuiltInProviderId } from "@/lib/providers/builtins";
import { resolveProvider } from "@/lib/providers/resolve";
import { getYoloPresetStartupCmd, isYoloPresetEnabled, isYoloSupportedProviderId } from "@/lib/providers/yolo";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  normalizeTerminalFontFamily,
  buildTerminalFontStack,
  getTerminalTheme,
  normalizeTerminalTheme,
  TERMINAL_THEME_OPTIONS,
} from "@/lib/terminal-appearance";
import { resolveFirstAvailableFont, parseFontFamilyList } from "@/lib/font-utils";
import { resolveSystemTheme, subscribeSystemTheme, type ThemeMode, type ThemeSetting } from "@/lib/theme";
import type { TerminalThemeId } from "@/types/terminal-theme";
import type { AppSettings, ProviderEnv, ProviderItem } from "@/types/host";

type TerminalMode = NonNullable<AppSettings["terminal"]>;
type SendMode = "write_only" | "write_and_enter";
type PathStyle = "absolute" | "relative";
type NotificationPrefs = {
  badge: boolean;
  system: boolean;
  sound: boolean;
};
type ExternalGitToolId = "rider" | "sourcetree" | "fork" | "gitkraken" | "custom";
type GitWorktreePrefs = {
  gitPath: string;
  externalGitToolId: ExternalGitToolId;
  externalGitToolCustomCommand: string;
  terminalCommand: string;
  autoCommitEnabled: boolean;
  copyRulesOnCreate: boolean;
};
type NetworkPrefs = {
  proxyEnabled: boolean;
  proxyMode: "system" | "custom";
  proxyUrl: string;
  noProxy: string;
};
type CodexAccountPrefs = {
  recordEnabled: boolean;
};
type BuiltinIdeId = "vscode" | "cursor" | "windsurf" | "rider";
type IdeOpenPrefs = {
  mode: "auto" | "builtin" | "custom";
  builtinId: BuiltinIdeId;
  customName: string;
  customCommand: string;
};

const normalizeThemeSetting = (value: any): ThemeSetting => {
  if (value === "light" || value === "dark") return value;
  return "system";
};

/**
 * 归一化内置 IDE 标识，非法时回退到 Cursor。
 */
function normalizeBuiltinIdeId(value: unknown): BuiltinIdeId {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "vscode" || raw === "cursor" || raw === "windsurf" || raw === "rider") return raw as BuiltinIdeId;
  return "cursor";
}

/**
 * 归一化默认 IDE 配置，保证设置面板状态结构稳定。
 */
function normalizeIdeOpenPrefs(value: unknown): IdeOpenPrefs {
  const raw = value && typeof value === "object" ? (value as any) : {};
  const modeRaw = String(raw.mode || "").trim().toLowerCase();
  const mode: IdeOpenPrefs["mode"] =
    modeRaw === "builtin" ? "builtin" : modeRaw === "custom" ? "custom" : "auto";
  return {
    mode,
    builtinId: normalizeBuiltinIdeId(raw.builtinId),
    customName: String(raw.customName || ""),
    customCommand: String(raw.customCommand || ""),
  };
}

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  values: {
    providers: {
      activeId: string;
      items: Array<{ id: string; displayName?: string; iconDataUrl?: string; iconDataUrlDark?: string; startupCmd?: string }>;
      env: Record<string, { terminal?: TerminalMode; distro?: string }>;
    };
    sendMode: SendMode;
    locale: string;
    projectPathStyle: PathStyle;
    dragDropWarnOutsideProject: boolean;
    theme: ThemeSetting;
    notifications: NotificationPrefs;
    network?: NetworkPrefs;
    codexAccount: CodexAccountPrefs;
    defaultIde: IdeOpenPrefs;
    terminalFontFamily: string;
    terminalTheme: TerminalThemeId;
    claudeCodeReadAgentHistory: boolean;
    multiInstanceEnabled: boolean;
    gitWorktree: GitWorktreePrefs;
  };
  onSave: (v: {
    providers: {
      activeId: string;
      items: Array<{ id: string; displayName?: string; iconDataUrl?: string; iconDataUrlDark?: string; startupCmd?: string }>;
      env: Record<string, { terminal?: TerminalMode; distro?: string }>;
    };
    sendMode: SendMode;
    locale: string;
    projectPathStyle: PathStyle;
    dragDropWarnOutsideProject: boolean;
    theme: ThemeSetting;
    notifications: NotificationPrefs;
    network: NetworkPrefs;
    codexAccount: CodexAccountPrefs;
    defaultIde: IdeOpenPrefs;
    terminalFontFamily: string;
    terminalTheme: TerminalThemeId;
    claudeCodeReadAgentHistory: boolean;
    multiInstanceEnabled: boolean;
    gitWorktree: GitWorktreePrefs;
  }) => void;
};

type CleanupCandidate = {
  id: string;
  title: string;
  rawDate?: string;
  date: number;
  filePath: string;
  sizeKB?: number;
};

type CleanupResult = {
  ok: number;
  notFound: number;
  failed: number;
};

type AppDataInfo = {
  path: string;
  totalBytes: number;
  dirCount: number;
  fileCount: number;
  collectedAt: number;
};

type AutoProfileDirInfo = {
  profileId: string;
  dirName: string;
  path: string;
  totalBytes: number;
  dirCount: number;
  fileCount: number;
  collectedAt: number;
  isCurrent: boolean;
};

type AutoProfilesInfo = {
  baseUserData: string;
  currentUserData: string;
  count: number;
  totalBytes: number;
  items: AutoProfileDirInfo[];
};

type WorktreeProfileDirInfo = AutoProfileDirInfo;
type WorktreeProfilesInfo = AutoProfilesInfo;

type SectionKey = "basic" | "providers" | "gitWorktree" | "notifications" | "terminal" | "networkAccount" | "data";

const NAV_ORDER: SectionKey[] = ["basic", "providers", "gitWorktree", "terminal", "notifications", "networkAccount", "data"];

const DEFAULT_LANGS = ["zh", "en"];
// 移除推荐逻辑：仅保留纯字母序

type ProviderEnvMap = Record<string, { terminal: TerminalMode; distro: string }>;

/**
 * 将 Provider 环境表归一化：补齐 terminal/distro，并确保内置 Provider 至少存在默认条目。
 */
function normalizeProviderEnvMap(
  input: Record<string, { terminal?: TerminalMode; distro?: string }> | undefined,
  fallback: { terminal: TerminalMode; distro: string },
): ProviderEnvMap {
  const env: ProviderEnvMap = {};
  const src = input && typeof input === "object" ? input : {};
  for (const [id, v] of Object.entries(src)) {
    const key = String(id || "").trim();
    if (!key) continue;
    const terminal: TerminalMode =
      v?.terminal === "wsl" || v?.terminal === "windows" || v?.terminal === "pwsh"
        ? v.terminal
        : fallback.terminal;
    const distro = String(v?.distro || fallback.distro).trim() || fallback.distro;
    env[key] = { terminal, distro };
  }

  for (const builtIn of getBuiltInProviders()) {
    if (env[builtIn.id]) continue;
    env[builtIn.id] = { terminal: fallback.terminal, distro: fallback.distro };
  }

  return env;
}

/**
 * 将主进程返回的 Profile 目录统计结果归一化为设置面板可直接渲染的结构。
 */
function normalizeProfileDirsInfo(res: any): AutoProfilesInfo {
  const itemsRaw = Array.isArray(res?.items) ? (res.items as any[]) : [];
  const items: AutoProfileDirInfo[] = itemsRaw.map((item) => ({
    profileId: typeof item?.profileId === "string" ? item.profileId : String(item?.profileId || ""),
    dirName: typeof item?.dirName === "string" ? item.dirName : String(item?.dirName || ""),
    path: typeof item?.path === "string" ? item.path : String(item?.path || ""),
    totalBytes: typeof item?.totalBytes === "number" ? item.totalBytes : Number(item?.totalBytes || 0),
    dirCount: typeof item?.dirCount === "number" ? item.dirCount : Number(item?.dirCount || 0),
    fileCount: typeof item?.fileCount === "number" ? item.fileCount : Number(item?.fileCount || 0),
    collectedAt: typeof item?.collectedAt === "number" ? item.collectedAt : Date.now(),
    isCurrent: !!item?.isCurrent,
  }));
  return {
    baseUserData: typeof res?.baseUserData === "string" ? res.baseUserData : String(res?.baseUserData || ""),
    currentUserData: typeof res?.currentUserData === "string" ? res.currentUserData : String(res?.currentUserData || ""),
    count: typeof res?.count === "number" ? res.count : items.length,
    totalBytes: typeof res?.totalBytes === "number" ? res.totalBytes : Number(res?.totalBytes || 0),
    items,
  };
}

/**
 * 生成一个新的自定义 Provider id（保证尽量可读且不与现有 id 冲突）。
 */
function createCustomProviderId(name: string, existingIds: Set<string>): string {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = base && !existingIds.has(base) ? base : "custom";
  if (!existingIds.has(prefix)) return prefix;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${prefix}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `custom-${Date.now()}`;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
  values,
  onSave,
}) => {
  const { t } = useTranslation(["settings", "common", "providers"]);
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");
  const [availableLangs, setAvailableLangs] = useState<string[]>(DEFAULT_LANGS);
  const [pwshAvailable, setPwshAvailable] = useState<boolean | null>(null);
  const [pwshPath, setPwshPath] = useState<string>("");

  const [providersActiveId, setProvidersActiveId] = useState<string>(values.providers?.activeId || "codex");
  const [providerEditingId, setProviderEditingId] = useState<string>(values.providers?.activeId || "codex");
  const iconFileInputRefLight = useRef<HTMLInputElement | null>(null);
  const iconFileInputRefDark = useRef<HTMLInputElement | null>(null);
  const [showDarkIconOverride, setShowDarkIconOverride] = useState<boolean>(false);
  const [providerItems, setProviderItems] = useState<ProviderItem[]>(
    Array.isArray(values.providers?.items) ? (values.providers.items as any) : [],
  );
  const [providerEnvMap, setProviderEnvMap] = useState<ProviderEnvMap>(() => {
    const fallback = { terminal: "wsl" as TerminalMode, distro: "Ubuntu-24.04" };
    return normalizeProviderEnvMap(values.providers?.env, fallback);
  });

  const editingEnv = useMemo(() => {
    return providerEnvMap[providerEditingId] || providerEnvMap[providersActiveId] || { terminal: "wsl" as TerminalMode, distro: "Ubuntu-24.04" };
  }, [providerEditingId, providerEnvMap, providersActiveId]);
  const editingTerminalLabel = useMemo(() => {
    if (editingEnv.terminal === "pwsh") return t("settings:terminalMode.pwsh");
    if (editingEnv.terminal === "windows") return t("settings:terminalMode.windows");
    return t("settings:terminalMode.wsl");
  }, [editingEnv.terminal, t]);
  const pwshDetectedText = useMemo(() => {
    const label = t("settings:terminalMode.pwshDetected");
    const path = pwshPath || "pwsh";
    return `${label} ${path}`;
  }, [pwshPath, t]);
  const detectPwshAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const res = await window.host.utils.detectPwsh();
      if (res && res.ok) {
        setPwshAvailable(!!res.available);
        setPwshPath(res.path || "");
        return !!res.available;
      }
    } catch (e) { console.warn("detectPwsh failed", e); }
    setPwshAvailable(false);
    setPwshPath("");
    return false;
  }, []);
  useEffect(() => {
    if (!open) return;
    if (pwshAvailable === null) {
      detectPwshAvailability();
    }
  }, [open, pwshAvailable, detectPwshAvailability]);

  /**
   * 更新指定 Provider 的运行环境（terminal/distro）。
   */
  const updateProviderEnv = useCallback((providerId: string, patch: Partial<ProviderEnv>) => {
    const id = String(providerId || "").trim();
    if (!id) return;
    setProviderEnvMap((prev) => {
      const cur = prev[id] || prev[providersActiveId] || { terminal: "wsl" as TerminalMode, distro: "Ubuntu-24.04" };
      const next: ProviderEnvMap = { ...prev };
      next[id] = {
        terminal: (patch.terminal === "wsl" || patch.terminal === "windows" || patch.terminal === "pwsh") ? patch.terminal : cur.terminal,
        distro: typeof patch.distro === "string" && patch.distro.trim().length > 0 ? patch.distro.trim() : cur.distro,
      };
      return next;
    });
  }, [providersActiveId]);

  /**
   * 更新指定 Provider 的 item 字段（启动命令、图标、展示名）。
   */
  const updateProviderItem = useCallback((providerId: string, patch: Partial<ProviderItem>) => {
    const id = String(providerId || "").trim();
    if (!id) return;
    setProviderItems((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx < 0) return [...prev, { id, ...patch }];
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch, id };
      return next;
    });
  }, []);

  /**
   * 读取指定 Provider 的 item（不存在则返回最小占位对象）。
   */
  const getProviderItem = useCallback((providerId: string): ProviderItem => {
    const id = String(providerId || "").trim();
    return providerItems.find((x) => x.id === id) || { id };
  }, [providerItems]);

  /**
   * 保存前清理 Provider items：
   * - Terminal：强制清空启动命令（始终仅打开 shell）
   * - 内置三引擎：若识别到 YOLO 预设，则规范化为固定命令字符串
   */
  const sanitizeProviderItemsForSave = useCallback((items: ProviderItem[]): ProviderItem[] => {
    const out: ProviderItem[] = [];
    for (const it of Array.isArray(items) ? items : []) {
      const id = String(it?.id || "").trim();
      if (!id) continue;
      const next: ProviderItem = { ...it, id };

      if (id === "terminal") {
        // 中文说明：Terminal 不允许配置启动命令，避免误执行或与“只开 shell”的预期冲突。
        try { delete (next as any).startupCmd; } catch { (next as any).startupCmd = undefined; }
      }

      if (isYoloSupportedProviderId(id) && isYoloPresetEnabled(id, next.startupCmd)) {
        const preset = getYoloPresetStartupCmd(id);
        if (preset) next.startupCmd = preset;
      }

      out.push(next);
    }
    return out;
  }, []);

  /**
   * 处理“终端类型”切换（对 pwsh 做可用性检测）。
   */
  const handleTerminalChange = useCallback(async (next: TerminalMode) => {
    if (next === "pwsh") {
      const ok = (pwshAvailable === true) || await detectPwshAvailability();
      if (!ok) {
        alert(t("settings:terminalMode.pwshUnavailable"));
        updateProviderEnv(providerEditingId, { terminal: "windows" });
        return;
      }
    }
    updateProviderEnv(providerEditingId, { terminal: next });
  }, [detectPwshAvailability, pwshAvailable, providerEditingId, t, updateProviderEnv]);

  /**
   * Provider 列表：内置优先，其余按字母序展示。
   */
  const orderedProviders = useMemo(() => {
    const builtInOrder = getBuiltInProviders().map((x) => x.id);
    const builtInSet = new Set(builtInOrder);
    const byId = new Map<string, ProviderItem>();
    for (const it of providerItems || []) {
      const id = String(it?.id || "").trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, it);
    }
    const builtIns = builtInOrder.map((id) => byId.get(id) || { id });
    const customs = Array.from(byId.values())
      .filter((x) => x.id && !builtInSet.has(x.id as any))
      .sort((a, b) => String(a.id).toLowerCase().localeCompare(String(b.id).toLowerCase()));
    return [...builtIns, ...customs];
  }, [providerItems]);

  /**
   * 设置某个 Provider 为默认（仅更新对话框内状态，最终由“保存”落盘）。
   */
  const setActiveProvider = useCallback((providerId: string) => {
    const id = String(providerId || "").trim();
    if (!id) return;
    setProvidersActiveId(id);
    if (!providerEditingId) setProviderEditingId(id);
  }, [providerEditingId]);

  /**
   * 新增一个自定义 Provider，并自动切换到编辑状态。
   */
  const addCustomProvider = useCallback(() => {
    const existing = new Set<string>((providerItems || []).map((x) => String(x?.id || "").trim()).filter(Boolean));
    const id = createCustomProviderId("custom", existing);
    const defaultName = String(t("settings:providers.defaultName", "自定义引擎") || "").trim() || "自定义引擎";
    setProviderItems((prev) => [...prev, { id, displayName: defaultName, startupCmd: "" }]);
    setProviderEnvMap((prev) => ({ ...prev, [id]: prev[providersActiveId] || { terminal: "wsl", distro: "Ubuntu-24.04" } }));
    setProviderEditingId(id);
  }, [providerItems, providersActiveId, t]);

  /**
   * 触发亮色图标选择器（隐藏 input 的 click），用于统一按钮风格。
   */
  const triggerLightIconPicker = useCallback(() => {
    try { iconFileInputRefLight.current?.click(); } catch { }
  }, []);

  /**
   * 触发暗色图标选择器（隐藏 input 的 click），用于统一按钮风格。
   */
  const triggerDarkIconPicker = useCallback(() => {
    try { iconFileInputRefDark.current?.click(); } catch { }
  }, []);

  /**
   * 删除自定义 Provider（内置 Provider 不允许删除）。
   */
  const removeCustomProvider = useCallback((providerId: string) => {
    const id = String(providerId || "").trim();
    if (!id || isBuiltInProviderId(id)) return;
    setProviderItems((prev) => prev.filter((x) => x.id !== id));
    setProviderEnvMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (providersActiveId === id) {
      setProvidersActiveId("codex");
      setProviderEditingId("codex");
    } else if (providerEditingId === id) {
      setProviderEditingId(providersActiveId || "codex");
    }
  }, [providerEditingId, providersActiveId]);

  /**
   * 读取文件并转为 DataURL（用于保存到 settings.json 作为 Provider 图标）。
   */
  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("read icon failed"));
        reader.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }, []);

  /**
   * 处理亮色图标选择：读取为 DataURL 并写入当前 Provider。
   */
  const handleLightIconFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateProviderItem(providerEditingId, { iconDataUrl: dataUrl });
    } catch {
    } finally {
      try { input.value = ""; } catch { }
    }
  }, [providerEditingId, readFileAsDataUrl, updateProviderItem]);

  /**
   * 处理暗色图标选择：读取为 DataURL 并写入当前 Provider。
   */
  const handleDarkIconFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      updateProviderItem(providerEditingId, { iconDataUrlDark: dataUrl });
    } catch {
    } finally {
      try { input.value = ""; } catch { }
    }
  }, [providerEditingId, readFileAsDataUrl, updateProviderItem]);

  const [sendMode, setSendMode] = useState<SendMode>(values.sendMode);
  const [pathStyle, setPathStyle] = useState<PathStyle>(values.projectPathStyle || "absolute");
  const [dragDropWarnOutsideProject, setDragDropWarnOutsideProject] = useState<boolean>(values.dragDropWarnOutsideProject ?? true);
  const [notifications, setNotifications] = useState<NotificationPrefs>(values.notifications);
  const [network, setNetwork] = useState<NetworkPrefs>({
    proxyEnabled: values.network?.proxyEnabled ?? true,
    proxyMode: values.network?.proxyMode ?? "system",
    proxyUrl: values.network?.proxyUrl ?? "",
    noProxy: values.network?.noProxy ?? "",
  });
  const [codexAccount, setCodexAccount] = useState<CodexAccountPrefs>(() => ({
    recordEnabled: !!values.codexAccount?.recordEnabled,
  }));
  const [defaultIde, setDefaultIde] = useState<IdeOpenPrefs>(() => normalizeIdeOpenPrefs(values.defaultIde));
  const [claudeCodeReadAgentHistory, setClaudeCodeReadAgentHistory] = useState<boolean>(!!values.claudeCodeReadAgentHistory);
  const [gitWorktreeGitPath, setGitWorktreeGitPath] = useState<string>(String(values.gitWorktree?.gitPath || ""));
  const [gitWorktreeExternalGitToolId, setGitWorktreeExternalGitToolId] = useState<ExternalGitToolId>(
    (values.gitWorktree?.externalGitToolId as ExternalGitToolId) || "rider",
  );
  const [gitWorktreeExternalGitToolCustomCommand, setGitWorktreeExternalGitToolCustomCommand] = useState<string>(
    String(values.gitWorktree?.externalGitToolCustomCommand || ""),
  );
  const [gitWorktreeTerminalCommand, setGitWorktreeTerminalCommand] = useState<string>(String(values.gitWorktree?.terminalCommand || ""));
  const [gitWorktreeAutoCommitEnabled, setGitWorktreeAutoCommitEnabled] = useState<boolean>(values.gitWorktree?.autoCommitEnabled !== false);
  const [gitWorktreeCopyRulesOnCreate, setGitWorktreeCopyRulesOnCreate] = useState<boolean>(values.gitWorktree?.copyRulesOnCreate !== false);
  const [gitWorktreeDetectingPaths, setGitWorktreeDetectingPaths] = useState<boolean>(false);
  const [gitWorktreeDetectedGitPath, setGitWorktreeDetectedGitPath] = useState<string>("");
  const [gitWorktreeDetectedGitBashPath, setGitWorktreeDetectedGitBashPath] = useState<string>("");
  const [codexRoots, setCodexRoots] = useState<string[]>([]);
  const [claudeRoots, setClaudeRoots] = useState<string[]>([]);
  const [geminiRoots, setGeminiRoots] = useState<string[]>([]);
  const [lang, setLang] = useState<string>(values.locale || "en");
  const [theme, setTheme] = useState<ThemeSetting>(normalizeThemeSetting(values.theme));
  const [multiInstanceEnabled, setMultiInstanceEnabled] = useState<boolean>(!!values.multiInstanceEnabled);
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>(values.terminalTheme);
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(() => resolveSystemTheme());
  const [availableDistros, setAvailableDistros] = useState<string[]>([]);
  const [terminalFontFamily, setTerminalFontFamily] = useState<string>(normalizeTerminalFontFamily(values.terminalFontFamily));
  const [installedFonts, setInstalledFonts] = useState<string[]>([]);
  const [installedLoading, setInstalledLoading] = useState<boolean>(false);
  const [monospaceFonts, setMonospaceFonts] = useState<string[]>([]);
  const [showAllFonts, setShowAllFonts] = useState<boolean>(false);
  const fontsLoadedRef = useRef<boolean>(false);
  const resolvedPreviewFont = useMemo(() => {
    return resolveFirstAvailableFont(terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY);
  }, [terminalFontFamily]);
  const currentPrimaryFont = useMemo(() => {
    const list = parseFontFamilyList(terminalFontFamily);
    return list[0] || "";
  }, [terminalFontFamily]);
  const sortedInstalledFonts = useMemo(() => {
    return installedFonts.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [installedFonts]);
  const sortedMonospaceFonts = useMemo(() => {
    return monospaceFonts.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [monospaceFonts]);
  const visibleFontList = useMemo(() => {
    return showAllFonts ? sortedInstalledFonts : sortedMonospaceFonts;
  }, [showAllFonts, sortedInstalledFonts, sortedMonospaceFonts]);
  const currentFontIndex = useMemo(() => {
    if (visibleFontList.length === 0) return -1;
    const current = (currentPrimaryFont || "").toLowerCase();
    return visibleFontList.findIndex((name) => name.toLowerCase() === current);
  }, [visibleFontList, currentPrimaryFont]);
  const previewTheme = useMemo(() => getTerminalTheme(terminalTheme), [terminalTheme]);
  const themeLabel = useCallback((mode: ThemeSetting) => {
    if (mode === "dark") return t("settings:appearance.theme.dark") as string;
    if (mode === "light") return t("settings:appearance.theme.light") as string;
    return t("settings:appearance.theme.system") as string;
  }, [t]);
  const systemThemeLabel = useMemo(() => {
    return t(`settings:appearance.theme.current.${systemTheme}`) as string;
  }, [systemTheme, t]);
  const [cleanupScanning, setCleanupScanning] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupList, setCleanupList] = useState<CleanupCandidate[]>([]);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleanupWarningOpen, setCleanupWarningOpen] = useState(false);
  const [cleanupFeedback, setCleanupFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const [storageInfo, setStorageInfo] = useState<AppDataInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageClearing, setStorageClearing] = useState(false);
  const [storagePurging, setStoragePurging] = useState(false);
  const [storageConfirmOpen, setStorageConfirmOpen] = useState(false);
  const [storagePreserveSettings, setStoragePreserveSettings] = useState(true);
  const [storagePurgeConfirmOpen, setStoragePurgeConfirmOpen] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const [storageError, setStorageError] = useState<string | null>(null);
  const [autoProfilesInfo, setAutoProfilesInfo] = useState<AutoProfilesInfo | null>(null);
  const [autoProfilesLoading, setAutoProfilesLoading] = useState(false);
  const [autoProfilesCleaning, setAutoProfilesCleaning] = useState(false);
  const [autoProfilesConfirmOpen, setAutoProfilesConfirmOpen] = useState(false);
  const [autoProfilesFeedback, setAutoProfilesFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const [autoProfilesError, setAutoProfilesError] = useState<string | null>(null);
  const [worktreeProfilesInfo, setWorktreeProfilesInfo] = useState<WorktreeProfilesInfo | null>(null);
  const [worktreeProfilesLoading, setWorktreeProfilesLoading] = useState(false);
  const [worktreeProfilesCleaning, setWorktreeProfilesCleaning] = useState(false);
  const [worktreeProfilesConfirmOpen, setWorktreeProfilesConfirmOpen] = useState(false);
  const [worktreeProfilesFeedback, setWorktreeProfilesFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const [worktreeProfilesError, setWorktreeProfilesError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const storageLoadedRef = useRef(false);
  const autoProfilesLoadedRef = useRef(false);
  const worktreeProfilesLoadedRef = useRef(false);
  const initFromValuesOnceRef = useRef(false);

  const labelOf = useCallback((lng: string) => {
    const map: Record<string, string> = { zh: "简体中文", en: "English" };
    if (map[lng]) return map[lng];
    try {
      const DisplayNames: any = (Intl as any).DisplayNames;
      if (!DisplayNames) return lng;
      const dn = new DisplayNames([lng, "en"], { type: "language" });
      const name = dn?.of?.(lng);
      return name || lng;
    } catch {
      return lng;
    }
  }, []);

  /**
   * 仅在“打开设置对话框”的瞬间用外部 values 初始化一次内部状态。
   *
   * 注意：父组件每次渲染都会创建新的 values 对象；若将 values 放进依赖数组，会导致对话框打开期间被反复重置，
   * 从而出现“新增自定义引擎后，选择图标/任意操作导致自定义引擎消失（未保存内容被覆盖）”的现象。
   */
  useEffect(() => {
    if (!open) {
      initFromValuesOnceRef.current = false;
      return;
    }
    if (initFromValuesOnceRef.current) return;
    initFromValuesOnceRef.current = true;

    const activeId = String(values.providers?.activeId || "codex").trim() || "codex";
    setProvidersActiveId(activeId);
    setProviderEditingId(activeId);
    setProviderItems(Array.isArray(values.providers?.items) ? (values.providers.items as any) : []);
    setProviderEnvMap(normalizeProviderEnvMap(values.providers?.env, { terminal: "wsl", distro: "Ubuntu-24.04" }));
    // 默认不展开“暗色图标”设置，避免用户误解必须配置两张图标
    setShowDarkIconOverride(false);

    setSendMode(values.sendMode || "write_and_enter");
    setPathStyle(values.projectPathStyle || "absolute");
    setDragDropWarnOutsideProject(values.dragDropWarnOutsideProject ?? true);
    setLang(values.locale || "en");
    setTheme(normalizeThemeSetting(values.theme));
    setMultiInstanceEnabled(!!values.multiInstanceEnabled);
    setNotifications(values.notifications);
    setNetwork({
      proxyEnabled: values.network?.proxyEnabled ?? true,
      proxyMode: values.network?.proxyMode ?? "system",
      proxyUrl: values.network?.proxyUrl ?? "",
      noProxy: values.network?.noProxy ?? "",
    });
    setCodexAccount({ recordEnabled: !!values.codexAccount?.recordEnabled });
    setDefaultIde(normalizeIdeOpenPrefs(values.defaultIde));
    setClaudeCodeReadAgentHistory(!!values.claudeCodeReadAgentHistory);
    setGitWorktreeGitPath(String(values.gitWorktree?.gitPath || ""));
    setGitWorktreeExternalGitToolId((values.gitWorktree?.externalGitToolId as ExternalGitToolId) || "rider");
    setGitWorktreeExternalGitToolCustomCommand(String(values.gitWorktree?.externalGitToolCustomCommand || ""));
    setGitWorktreeTerminalCommand(String(values.gitWorktree?.terminalCommand || ""));
    setGitWorktreeAutoCommitEnabled(values.gitWorktree?.autoCommitEnabled !== false);
    setGitWorktreeCopyRulesOnCreate(values.gitWorktree?.copyRulesOnCreate !== false);
    setTerminalFontFamily(normalizeTerminalFontFamily(values.terminalFontFamily));
    setTerminalTheme(normalizeTerminalTheme(values.terminalTheme));
  }, [open]);

  /**
   * 探测 Windows 下常见 Git / Git Bash 安装路径（仅用于设置面板展示“自动探测”的结果）。
   */
  const detectGitWorktreePaths = useCallback(async () => {
    if (!open) return;
    setGitWorktreeDetectingPaths(true);
    try {
      let userProfile = "";
      try {
        const res: any = await window.host.utils.getHomeDir();
        const raw = res && res.ok ? String(res.homeDir || "") : "";
        const winPath = raw.replace(/\//g, "\\").trim();
        if (/^[a-zA-Z]:\\/.test(winPath)) userProfile = winPath;
      } catch {}

      const gitCandidates = [
        "C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe",
        "C:\\\\Program Files\\\\Git\\\\bin\\\\git.exe",
        "C:\\\\Program Files (x86)\\\\Git\\\\cmd\\\\git.exe",
        "C:\\\\Program Files (x86)\\\\Git\\\\bin\\\\git.exe",
        userProfile ? `${userProfile}\\AppData\\Local\\Programs\\Git\\cmd\\git.exe` : "",
        userProfile ? `${userProfile}\\AppData\\Local\\Programs\\Git\\bin\\git.exe` : "",
      ].filter(Boolean);
      let detectedGit = "";
      for (const p of gitCandidates) {
        try {
          const res = await window.host.utils.pathExists(p);
          if (res && res.ok && res.exists && res.isFile) { detectedGit = p; break; }
        } catch { }
      }
      setGitWorktreeDetectedGitPath(detectedGit);

      const gitBashCandidates = [
        "C:\\\\Program Files\\\\Git\\\\git-bash.exe",
        "C:\\\\Program Files (x86)\\\\Git\\\\git-bash.exe",
        userProfile ? `${userProfile}\\AppData\\Local\\Programs\\Git\\git-bash.exe` : "",
      ].filter(Boolean);
      let detectedGitBash = "";
      for (const p of gitBashCandidates) {
        try {
          const res = await window.host.utils.pathExists(p);
          if (res && res.ok && res.exists && res.isFile) { detectedGitBash = p; break; }
        } catch { }
      }
      setGitWorktreeDetectedGitBashPath(detectedGitBash);
    } finally {
      setGitWorktreeDetectingPaths(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    detectGitWorktreePaths();
  }, [open, detectGitWorktreePaths]);

  /**
   * 拉取指定引擎的会话根路径列表，并规范为真实“引擎根路径”用于展示与操作。
   */
  const fetchSessionRoots = useCallback(async (providerId: BuiltInRuleProviderId): Promise<string[]> => {
    try {
      if (window.host.settings.sessionRoots) {
        const roots = await window.host.settings.sessionRoots({ providerId });
        return normalizeEngineRootPaths(providerId, Array.isArray(roots) ? roots : []);
      }
      if (providerId === "codex") {
        const roots = await window.host.settings.codexRoots();
        return normalizeEngineRootPaths(providerId, Array.isArray(roots) ? roots : []);
      }
    } catch { }
    return [];
  }, []);

  /**
   * 在系统文件管理器中打开给定路径（失败则给出统一提示）。
   */
  const openPathInSystem = useCallback(async (targetPath: string) => {
    const p = String(targetPath || "").trim();
    if (!p) return false;
    try {
      const res: any = await window.host.utils.openPath(p);
      if (!(res && res.ok)) throw new Error(res?.error || "failed");
      return true;
    } catch {
      alert(String(t("common:files.cannotOpenPath")));
      return false;
    }
  }, [t]);

  /**
   * 打开引擎根路径。
   */
  const openSessionRootPath = useCallback(async (root: string) => {
    await openPathInSystem(root);
  }, [openPathInSystem]);

  /**
   * 打开文本文件进行编辑（文件不存在时给出明确提示）。
   */
  const openEditableFile = useCallback(async (filePath: string, missingMessage: string) => {
    const target = String(filePath || "").trim();
    if (!target) return;
    try {
      const stat = await window.host.utils.pathExists(target);
      if (!(stat && stat.ok && stat.exists && stat.isFile)) {
        alert(missingMessage);
        return;
      }
    } catch {
      alert(missingMessage);
      return;
    }
    await openPathInSystem(target);
  }, [openPathInSystem]);

  /**
   * 编辑全局规则文件（按引擎映射 AGENTS/CLAUDE/GEMINI）。
   */
  const editGlobalRuleFile = useCallback(async (providerId: BuiltInRuleProviderId, root: string) => {
    const ruleFileName = getProviderRuleFileName(providerId);
    const target = getGlobalRuleFilePath(providerId, root);
    await openEditableFile(
      target,
      String(t("settings:engineRoots.ruleMissing", { file: ruleFileName })),
    );
  }, [openEditableFile, t]);

  /**
   * 编辑 Codex 全局配置文件 config.toml。
   */
  const editCodexConfigFile = useCallback(async (root: string) => {
    const target = getCodexConfigTomlPath(root);
    await openEditableFile(
      target,
      String(t("settings:engineRoots.configMissing", { file: "config.toml" })),
    );
  }, [openEditableFile, t]);

  /**
   * 渲染引擎根路径列表（含紧凑操作入口：编辑规则/编辑配置/打开目录）。
   */
  const renderEngineRoots = useCallback((providerId: BuiltInRuleProviderId, roots: string[], emptyTextKey: string) => {
    if (roots.length <= 0) {
      return <div className="text-xs text-slate-400">{t(emptyTextKey)}</div>;
    }
    return (
      <div className="max-h-48 overflow-auto rounded border bg-slate-50 p-2 text-xs">
        <ul className="space-y-1">
          {roots.map((root) => (
            <li key={root} className="flex items-center gap-2" title={root}>
              <span className="flex-1 min-w-0 truncate">{root}</span>
              <div className="shrink-0 flex items-center gap-1">
                {providerId === "codex" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() => { void editCodexConfigFile(root); }}
                  >
                    {t("settings:engineRoots.actions.editConfig")}
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => { void editGlobalRuleFile(providerId, root); }}
                >
                  {t("settings:engineRoots.actions.editRule")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => { void openSessionRootPath(root); }}
                >
                  {t("settings:engineRoots.actions.openRoot")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }, [editCodexConfigFile, editGlobalRuleFile, openSessionRootPath, t]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const langs = await listAvailableLanguages();
        if (Array.isArray(langs) && langs.length > 0) {
          setAvailableLangs(langs);
        }
      } catch {
        setAvailableLangs(DEFAULT_LANGS);
      }
    })();
  }, [open]);

  useEffect(() => {
    const unwatch = subscribeSystemTheme((mode) => {
      try {
        setSystemTheme(mode);
      } catch { }
    });
    return () => {
      try {
        unwatch?.();
      } catch { }
    };
  }, []);

  // 从主进程拉取详细字体并生成等宽列表（基于字体表元数据）
  // 延迟到进入“终端”分区再拉取；并在会话期缓存，避免重复阻塞
  useEffect(() => {
    if (!open) return;
    if (activeSection !== "terminal") return;
    if (fontsLoadedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        setInstalledLoading(true);
        const detailed = await (window as any).host?.utils?.listFontsDetailed?.();
        if (!cancelled && Array.isArray(detailed)) {
          const names = detailed.map((d: any) => String(d?.name || "")).filter(Boolean);
          const monos = detailed
            .filter((d: any) => !!d?.monospace)
            .map((d: any) => String(d?.name || ""))
            .filter(Boolean);
          setInstalledFonts(names);
          setMonospaceFonts(monos);
          fontsLoadedRef.current = true;
        }
      } catch {
        if (!cancelled) {
          setInstalledFonts([]);
          setMonospaceFonts([]);
        }
      } finally {
        if (!cancelled) setInstalledLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, activeSection]);

  // 默认优先选择 Cascadia Mono（存在时），否则 Cascadia Code；仅在首次打开且未自定义时应用
  const autoPickRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (autoPickRef.current) return;
    if (installedFonts.length === 0) return;
    const configured = String(values.terminalFontFamily || "").trim();
    const installedSet = new Set(installedFonts.map((n) => n.toLowerCase()));
    const cur = (currentPrimaryFont || "").toLowerCase();
    const isDefaultStack = configured === DEFAULT_TERMINAL_FONT_FAMILY;
    if (!configured || isDefaultStack || (cur && !installedSet.has(cur))) {
      const want = installedSet.has("cascadia mono") ? "Cascadia Mono" : (installedSet.has("cascadia code") ? "Cascadia Code" : "");
      if (want) setTerminalFontFamily(buildTerminalFontStack(want));
    }
    autoPickRef.current = true;
  }, [open, installedFonts, currentPrimaryFont, values.terminalFontFamily]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const [codex, claude, gemini] = await Promise.all([
          fetchSessionRoots("codex"),
          fetchSessionRoots("claude"),
          fetchSessionRoots("gemini"),
        ]);
        setCodexRoots(codex);
        setClaudeRoots(claude);
        setGeminiRoots(gemini);
      } catch {
        setCodexRoots([]);
        setClaudeRoots([]);
        setGeminiRoots([]);
      }
      try {
        const result: any = await (window.host as any).wsl?.listDistros?.();
        if (result && result.ok && Array.isArray(result.distros) && result.distros.length > 0) {
          const names = (result.distros as any[])
            .map((item) => {
              if (typeof item === "string") return item;
              if (item && typeof item.name === "string") return item.name;
              return null;
            })
            .filter((item): item is string => !!item);
          setAvailableDistros(names);
        }
      } catch {
        setAvailableDistros([]);
      }
    })();
  }, [open, fetchSessionRoots]);

  // 旧的纯名称枚举逻辑已移除（改为使用系统级元数据）

  useEffect(() => {
    if (!cleanupOpen) {
      setCleanupWarningOpen(false);
    }
  }, [cleanupOpen]);

  const handleCleanupExecute = useCallback(async () => {
    if (cleanupList.length === 0) {
      setCleanupWarningOpen(false);
      return;
    }
    setCleanupRunning(true);
    setCleanupWarningOpen(false);
    setCleanupOpen(false);
    try {
      const filePaths = cleanupList.map((item) => item.filePath);
      const res: any = await (window as any).host?.history?.trashMany?.({ filePaths });
      if (!(res && res.ok)) {
        const message = res && res.error ? String(res.error) : String(t("settings:cleanupConfirm.batchDeleteFailed"));
        setCleanupFeedback({ open: true, message, isError: true });
      } else {
        const summary: CleanupResult =
          res && res.summary
            ? (res.summary as CleanupResult)
            : { ok: 0, notFound: 0, failed: 0 };
        setCleanupResult(summary);
        setCleanupList([]);
        setCleanupFeedback({
          open: true,
          message: String(
            t("settings:historyCleanup.result", {
              ok: summary.ok,
              notFound: summary.notFound,
              failed: summary.failed,
            }),
          ),
          isError: false,
        });
      }
    } catch {
      setCleanupFeedback({
        open: true,
        message: String(t("settings:cleanupConfirm.batchDeleteFailed")),
        isError: true,
      });
    } finally {
      setCleanupRunning(false);
      setCleanupWarningOpen(false);
    }
  }, [cleanupList, t]);

  const refreshAppDataInfo = useCallback(async () => {
    const api = (window as any).host?.storage?.getAppDataInfo;
    if (!api) {
      setStorageInfo(null);
      setStorageError(t("settings:appData.notSupported") as string);
      return;
    }
    setStorageLoading(true);
    setStorageError(null);
    try {
      const res: any = await api();
      if (res && res.ok) {
        setStorageInfo({
          path: typeof res.path === "string" ? res.path : "",
          totalBytes: typeof res.totalBytes === "number" ? res.totalBytes : Number(res.totalBytes || 0),
          dirCount: typeof res.dirCount === "number" ? res.dirCount : Number(res.dirCount || 0),
          fileCount: typeof res.fileCount === "number" ? res.fileCount : Number(res.fileCount || 0),
          collectedAt: typeof res.collectedAt === "number" ? res.collectedAt : Date.now(),
        });
      } else {
        const message = res && res.error ? String(res.error) : (t("settings:appData.loadFailed") as string);
        setStorageInfo(null);
        setStorageError(message);
      }
    } catch (error: any) {
      setStorageInfo(null);
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setStorageLoading(false);
    }
  }, [t]);

  const handleClearAppData = useCallback(async () => {
    setStorageConfirmOpen(false);
    const api = (window as any).host?.storage?.clearAppData;
    if (!api) {
      setStorageFeedback({ open: true, message: t("settings:appData.cleanFailed") as string, isError: true });
      return;
    }
    setStorageClearing(true);
    try {
      const res: any = await api({ preserveSettings: storagePreserveSettings });
      if (res && res.ok) {
        const freedRaw =
          typeof res.bytesFreed === "number"
            ? res.bytesFreed
            : Math.max(
              0,
              Number(res.bytesBefore || 0) - Number(res.bytesAfter || 0),
            );
        await refreshAppDataInfo();
        const note =
          res && typeof res.note === "string" && res.note.trim().length > 0
            ? String(res.note).trim()
            : "";
        setStorageFeedback({
          open: true,
          message: [
            String(t("settings:appData.cleanSuccess", { freed: formatBytes(freedRaw) })),
            note,
          ]
            .filter(Boolean)
            .join("\n"),
          isError: false,
        });
      } else {
        const note =
          res && typeof res.note === "string" && res.note.trim().length > 0
            ? String(res.note).trim()
            : "";
        const messageBase = res && res.error ? String(res.error) : (t("settings:appData.cleanFailed") as string);
        const message = [messageBase, note].filter(Boolean).join("\n");
        setStorageFeedback({ open: true, message, isError: true });
      }
    } catch {
      setStorageFeedback({ open: true, message: t("settings:appData.cleanFailed") as string, isError: true });
    } finally {
      setStorageClearing(false);
    }
  }, [refreshAppDataInfo, storagePreserveSettings, t]);

  const handlePurgeAppData = useCallback(async () => {
    setStoragePurgeConfirmOpen(false);
    const api = (window as any).host?.storage?.purgeAppDataAndQuit;
    if (!api) {
      setStorageFeedback({ open: true, message: t("settings:appData.purgeFailed") as string, isError: true });
      return;
    }
    setStoragePurging(true);
    try {
      const res: any = await api();
      if (!(res && res.ok)) {
        const message = res && res.error ? String(res.error) : (t("settings:appData.purgeFailed") as string);
        setStorageFeedback({ open: true, message, isError: true });
      } else if (res && typeof res.note === "string" && res.note.trim().length > 0) {
        setStorageFeedback({ open: true, message: String(res.note).trim(), isError: false });
      }
    } catch {
      setStorageFeedback({ open: true, message: t("settings:appData.purgeFailed") as string, isError: true });
    } finally {
      setStoragePurging(false);
    }
  }, [t]);

  /**
   * 刷新自动实例（auto-* Profile）用户数据目录列表。
   */
  const refreshAutoProfilesInfo = useCallback(async () => {
    const api = (window as any).host?.storage?.listAutoProfiles;
    if (!api) {
      setAutoProfilesInfo(null);
      setAutoProfilesError(t("settings:autoProfiles.notSupported") as string);
      return;
    }
    setAutoProfilesLoading(true);
    setAutoProfilesError(null);
    try {
      const res: any = await api();
      if (res && res.ok) {
        setAutoProfilesInfo(normalizeProfileDirsInfo(res));
      } else {
        const message = res && res.error ? String(res.error) : (t("settings:autoProfiles.loadFailed") as string);
        setAutoProfilesInfo(null);
        setAutoProfilesError(message);
      }
    } catch (error: any) {
      setAutoProfilesInfo(null);
      setAutoProfilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoProfilesLoading(false);
    }
  }, [t]);

  /**
   * 一键回收所有自动实例（auto-* Profile）用户数据目录（默认跳过当前实例与占用目录）。
   */
  const handlePurgeAutoProfiles = useCallback(async () => {
    setAutoProfilesConfirmOpen(false);
    const api = (window as any).host?.storage?.purgeAutoProfiles;
    if (!api) {
      setAutoProfilesFeedback({ open: true, message: t("settings:autoProfiles.cleanupFailed") as string, isError: true });
      return;
    }
    setAutoProfilesCleaning(true);
    try {
      const res: any = await api({ includeCurrent: false });
      if (res && res.ok) {
        await refreshAutoProfilesInfo();
        const removed = typeof res.removed === "number" ? res.removed : Number(res.removed || 0);
        const skipped = typeof res.skipped === "number" ? res.skipped : Number(res.skipped || 0);
        const busy = typeof res.busy === "number" ? res.busy : Number(res.busy || 0);
        const notFound = typeof res.notFound === "number" ? res.notFound : Number(res.notFound || 0);
        const freedRaw = typeof res.bytesFreed === "number" ? res.bytesFreed : Number(res.bytesFreed || 0);
        setAutoProfilesFeedback({
          open: true,
          message: String(
            t("settings:autoProfiles.cleanupSuccess", {
              removed,
              skipped,
              busy,
              notFound,
              freed: formatBytes(freedRaw),
            }),
          ),
          isError: false,
        });
      } else {
        const message = res && res.error ? String(res.error) : (t("settings:autoProfiles.cleanupFailed") as string);
        setAutoProfilesFeedback({ open: true, message, isError: true });
      }
    } catch {
      setAutoProfilesFeedback({ open: true, message: t("settings:autoProfiles.cleanupFailed") as string, isError: true });
    } finally {
      setAutoProfilesCleaning(false);
    }
  }, [refreshAutoProfilesInfo, t]);

  /**
   * 刷新 worktree 实例（wt-* Profile）用户数据目录列表。
   */
  const refreshWorktreeProfilesInfo = useCallback(async () => {
    const api = (window as any).host?.storage?.listWorktreeProfiles;
    if (!api) {
      setWorktreeProfilesInfo(null);
      setWorktreeProfilesError(t("settings:worktreeProfiles.notSupported") as string);
      return;
    }
    setWorktreeProfilesLoading(true);
    setWorktreeProfilesError(null);
    try {
      const res: any = await api();
      if (res && res.ok) {
        setWorktreeProfilesInfo(normalizeProfileDirsInfo(res));
      } else {
        const message = res && res.error ? String(res.error) : (t("settings:worktreeProfiles.loadFailed") as string);
        setWorktreeProfilesInfo(null);
        setWorktreeProfilesError(message);
      }
    } catch (error: any) {
      setWorktreeProfilesInfo(null);
      setWorktreeProfilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorktreeProfilesLoading(false);
    }
  }, [t]);

  /**
   * 一键回收所有 worktree 实例（wt-* Profile）用户数据目录（默认跳过当前实例与占用目录）。
   */
  const handlePurgeWorktreeProfiles = useCallback(async () => {
    setWorktreeProfilesConfirmOpen(false);
    const api = (window as any).host?.storage?.purgeWorktreeProfiles;
    if (!api) {
      setWorktreeProfilesFeedback({ open: true, message: t("settings:worktreeProfiles.cleanupFailed") as string, isError: true });
      return;
    }
    setWorktreeProfilesCleaning(true);
    try {
      const res: any = await api({ includeCurrent: false });
      if (res && res.ok) {
        await refreshWorktreeProfilesInfo();
        const removed = typeof res.removed === "number" ? res.removed : Number(res.removed || 0);
        const skipped = typeof res.skipped === "number" ? res.skipped : Number(res.skipped || 0);
        const busy = typeof res.busy === "number" ? res.busy : Number(res.busy || 0);
        const notFound = typeof res.notFound === "number" ? res.notFound : Number(res.notFound || 0);
        const freedRaw = typeof res.bytesFreed === "number" ? res.bytesFreed : Number(res.bytesFreed || 0);
        setWorktreeProfilesFeedback({
          open: true,
          message: String(
            t("settings:worktreeProfiles.cleanupSuccess", {
              removed,
              skipped,
              busy,
              notFound,
              freed: formatBytes(freedRaw),
            }),
          ),
          isError: false,
        });
      } else {
        const message = res && res.error ? String(res.error) : (t("settings:worktreeProfiles.cleanupFailed") as string);
        setWorktreeProfilesFeedback({ open: true, message, isError: true });
      }
    } catch {
      setWorktreeProfilesFeedback({ open: true, message: t("settings:worktreeProfiles.cleanupFailed") as string, isError: true });
    } finally {
      setWorktreeProfilesCleaning(false);
    }
  }, [refreshWorktreeProfilesInfo, t]);

  useEffect(() => {
    if (!open) {
      storageLoadedRef.current = false;
      setStorageInfo(null);
      setStorageError(null);
      return;
    }
    if (!storageLoadedRef.current) {
      storageLoadedRef.current = true;
      refreshAppDataInfo();
    }
  }, [open, refreshAppDataInfo]);

  useEffect(() => {
    if (!open) {
      autoProfilesLoadedRef.current = false;
      setAutoProfilesInfo(null);
      setAutoProfilesError(null);
      return;
    }
    if (!autoProfilesLoadedRef.current) {
      autoProfilesLoadedRef.current = true;
      refreshAutoProfilesInfo();
    }
  }, [open, refreshAutoProfilesInfo]);

  useEffect(() => {
    if (!open) {
      worktreeProfilesLoadedRef.current = false;
      setWorktreeProfilesInfo(null);
      setWorktreeProfilesError(null);
      return;
    }
    if (!worktreeProfilesLoadedRef.current) {
      worktreeProfilesLoadedRef.current = true;
      refreshWorktreeProfilesInfo();
    }
  }, [open, refreshWorktreeProfilesInfo]);

  const sections = useMemo(() => {
    return NAV_ORDER.map((key) => {
      if (key === "basic") {
        return {
          key,
          title: t("settings:sections.basic.title"),
          description: t("settings:sections.basic.desc"),
          content: (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:language.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:language.help")}</p>
                  <div className="max-w-xs">
                    <Select
                      value={lang}
                      onValueChange={async (code) => {
                        try {
                          setLang(code);
                          await changeAppLanguage(code);
                        } catch {
                          setLang(code);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <span className="truncate text-left">
                          {labelOf(lang) || (t("settings:language.placeholder") as string)}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {availableLangs.map((code) => (
                          <SelectItem key={code} value={code}>
                            {labelOf(code)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:appearance.theme.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">
                    {t("settings:appearance.theme.help", { mode: systemThemeLabel })}
                  </p>
                  <div className="max-w-xs">
                    <Select value={theme} onValueChange={(value) => setTheme(normalizeThemeSetting(value))}>
                      <SelectTrigger>
                        <span className="truncate text-left">{themeLabel(theme)}</span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">{t("settings:appearance.theme.system")}</SelectItem>
                        <SelectItem value="light">{t("settings:appearance.theme.light")}</SelectItem>
                        <SelectItem value="dark">{t("settings:appearance.theme.dark")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="text-xs text-slate-500">
                    {t("settings:appearance.theme.note", { current: themeLabel(normalizeThemeSetting(theme === "system" ? systemTheme : theme)) })}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:ideOpen.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:ideOpen.help")}</p>
                  <div className="max-w-xs">
                    <Select
                      value={defaultIde.mode}
                      onValueChange={(value) => {
                        const mode = value === "builtin" ? "builtin" : value === "custom" ? "custom" : "auto";
                        setDefaultIde((prev) => ({ ...prev, mode }));
                      }}
                    >
                      <SelectTrigger>
                        <span className="truncate text-left">
                          {defaultIde.mode === "builtin"
                            ? t("settings:ideOpen.modeBuiltin")
                            : defaultIde.mode === "custom"
                              ? t("settings:ideOpen.modeCustom")
                              : t("settings:ideOpen.modeAuto")}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t("settings:ideOpen.modeAuto")}</SelectItem>
                        <SelectItem value="builtin">{t("settings:ideOpen.modeBuiltin")}</SelectItem>
                        <SelectItem value="custom">{t("settings:ideOpen.modeCustom")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {defaultIde.mode === "builtin" ? (
                    <div className="max-w-xs space-y-1.5">
                      <Label className="text-xs text-slate-600">{t("settings:ideOpen.builtinLabel")}</Label>
                      <Select
                        value={defaultIde.builtinId}
                        onValueChange={(value) => {
                          const builtinId = normalizeBuiltinIdeId(value);
                          setDefaultIde((prev) => ({ ...prev, builtinId }));
                        }}
                      >
                        <SelectTrigger>
                          <span className="truncate text-left">
                            {defaultIde.builtinId === "vscode"
                              ? t("settings:ideOpen.builtinVsCode")
                              : defaultIde.builtinId === "cursor"
                                ? t("settings:ideOpen.builtinCursor")
                                : defaultIde.builtinId === "windsurf"
                                  ? t("settings:ideOpen.builtinWindsurf")
                                  : t("settings:ideOpen.builtinRider")}
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="vscode">{t("settings:ideOpen.builtinVsCode")}</SelectItem>
                          <SelectItem value="cursor">{t("settings:ideOpen.builtinCursor")}</SelectItem>
                          <SelectItem value="windsurf">{t("settings:ideOpen.builtinWindsurf")}</SelectItem>
                          <SelectItem value="rider">{t("settings:ideOpen.builtinRider")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {defaultIde.mode === "custom" ? (
                    <div className="space-y-3">
                      <div className="max-w-xs space-y-1.5">
                        <Label className="text-xs text-slate-600">{t("settings:ideOpen.customNameLabel")}</Label>
                        <Input
                          value={defaultIde.customName}
                          onChange={(e) => setDefaultIde((prev) => ({ ...prev, customName: String(e.target.value || "") }))}
                          placeholder={t("settings:ideOpen.customNamePlaceholder") as string}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-slate-600">{t("settings:ideOpen.customCommandLabel")}</Label>
                        <Input
                          value={defaultIde.customCommand}
                          onChange={(e) => setDefaultIde((prev) => ({ ...prev, customCommand: String(e.target.value || "") }))}
                          placeholder={t("settings:ideOpen.customCommandPlaceholder") as string}
                          className="font-mono text-xs"
                        />
                        <p className="text-xs text-slate-500">{t("settings:ideOpen.customCommandHint")}</p>
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:experimental.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-slate-500 dark:text-[var(--cf-text-secondary)]">
                    {t("settings:experimental.desc")}
                  </p>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                      checked={multiInstanceEnabled}
                      onChange={(event) => setMultiInstanceEnabled(event.target.checked)}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                        {t("settings:experimental.multiInstance.label")}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:experimental.multiInstance.desc")}
                      </p>
                      <div className="mt-3">
                        <div className="text-xs font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                          {t("settings:experimental.multiInstance.howToTitle")}
                        </div>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                          <li>{t("settings:experimental.multiInstance.howTo1")}</li>
                          <li>{t("settings:experimental.multiInstance.howTo2")}</li>
                        </ul>
                      </div>
                      <div className="mt-3">
                        <div className="text-xs font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                          {t("settings:experimental.multiInstance.warningsTitle")}
                        </div>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                          <li>{t("settings:experimental.multiInstance.warning1")}</li>
                          <li>{t("settings:experimental.multiInstance.warning2")}</li>
                        </ul>
                      </div>
                    </div>
                  </label>
                </CardContent>
              </Card>
            </div>
          ),
        };
      }
      if (key === "providers") {
        const builtInMeta = new Map(getBuiltInProviders().map((x) => [x.id, x]));
        const effectiveThemeMode: ThemeMode = theme === "system" ? systemTheme : theme;
        const editingItem = getProviderItem(providerEditingId);
        const editingBuiltIn = builtInMeta.get(providerEditingId as any);
        const effectiveIcon = resolveProvider(editingItem, { themeMode: effectiveThemeMode }).iconSrc || "";
        const effectiveIconDarkPreview = resolveProvider(editingItem, { themeMode: "dark" }).iconSrc || "";
        const hasLightOverride = typeof editingItem.iconDataUrl === "string" && editingItem.iconDataUrl.trim().length > 0;
        const hasDarkOverride = typeof editingItem.iconDataUrlDark === "string" && editingItem.iconDataUrlDark.trim().length > 0;
        const darkOverrideEnabled = providerEditingId === "codex" ? true : showDarkIconOverride;
        const defaultStartupCmd = editingBuiltIn?.defaultStartupCmd || "";
        const yoloSupported = isYoloSupportedProviderId(providerEditingId);
        const yoloPresetCmd = yoloSupported ? getYoloPresetStartupCmd(providerEditingId) : null;
        const yoloEnabled = yoloSupported ? isYoloPresetEnabled(providerEditingId, editingItem.startupCmd) : false;
        const startupCmdLocked = providerEditingId === "terminal" || yoloEnabled;
        const startupCmdValue = providerEditingId === "terminal"
          ? ""
          : (yoloEnabled && yoloPresetCmd ? yoloPresetCmd : (editingItem.startupCmd || ""));
        const effectiveLabel = isBuiltInProviderId(providerEditingId)
          ? (t(`providers:items.${providerEditingId}`) as string)
          : (String(editingItem.displayName || "").trim() || String(t("settings:providers.defaultName", "自定义引擎") || "").trim() || "自定义引擎");

        return {
          key,
          title: t("settings:sections.providers.title"),
          description: t("settings:sections.providers.desc"),
          content: (
            <div className="space-y-4 animate-in fade-in duration-500">
              {/* Engine Selector Tiles */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">{t("settings:providers.listTitle")}</h3>
                  <Button variant="outline" size="sm" onClick={addCustomProvider} className="h-8 rounded-full border-dashed px-3 dark:border-white/20 dark:hover:bg-white/5">
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t("settings:providers.add")}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-3">
	                  {orderedProviders.map((p) => {
	                    const isActive = p.id === providersActiveId;
	                    const isEditing = p.id === providerEditingId;
	                    const label = isBuiltInProviderId(p.id)
	                      ? (t(`providers:items.${p.id}`) as string)
	                      : (String(p.displayName || "").trim() || (t("settings:providers.defaultName") as string));
	                    const iconSrc = resolveProvider(p, { themeMode: effectiveThemeMode }).iconSrc;

	                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setProviderEditingId(p.id)}
                        className={cn(
                          "relative group flex flex-col items-center justify-center p-2 w-[84px] h-[84px] rounded-xl border transition-all duration-200",
                          isEditing
                            ? "bg-[var(--cf-accent)]/5 border-[var(--cf-accent)] ring-1 ring-[var(--cf-accent)] dark:bg-[var(--cf-accent)]/10"
                            : "bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20"
                        )}
                      >
                        <div className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50 dark:bg-black/20 mb-1.5 transition-transform group-hover:scale-110",
                          isEditing && "bg-white shadow-sm dark:bg-white/10"
                        )}>
                          {iconSrc ? <img src={iconSrc} className="h-5 w-5 object-contain" alt="" /> : <Cpu className="h-5 w-5 text-slate-300" />}
                        </div>
                        <span className={cn(
                          "text-[10px] font-bold truncate w-full text-center px-1",
                          isEditing ? "text-[var(--cf-accent)] dark:text-white" : "text-slate-600 dark:text-slate-400"
                        )}>{label}</span>
                        {isActive && (
                          <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)] shadow-[0_0_8px_var(--cf-accent)]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Editor Area */}
              <div className="rounded-3xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/[0.02] p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-white dark:bg-white/10 flex items-center justify-center shadow-sm border border-slate-100 dark:border-white/5">
                      {effectiveIcon ? <img src={effectiveIcon} className="h-6 w-6 object-contain" alt="" /> : <Settings2 className="h-5 w-5 text-slate-400" />}
                    </div>
                    <div>
                      <h4 className="text-lg font-bold text-slate-900 dark:text-white">{effectiveLabel}</h4>
                      <p className="text-xs text-slate-400 font-mono">{providerEditingId}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={providersActiveId === providerEditingId ? "secondary" : "outline"}
                      size="sm"
                      onClick={() => setActiveProvider(providerEditingId)}
                      disabled={providersActiveId === providerEditingId}
                      className="rounded-full px-4"
                    >
                      {providersActiveId === providerEditingId ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <Star className="mr-1.5 h-3.5 w-3.5" />}
                      {t("settings:providers.setActive")}
                    </Button>
                    {!isBuiltInProviderId(providerEditingId) && (
                      <Button variant="ghost" size="icon" onClick={() => removeCustomProvider(providerEditingId)} className="rounded-full text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid gap-4">
                  {/* Basic Config */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest pl-1">
                      <Settings2 className="h-3.5 w-3.5" />
                      {t("settings:sections.basic.title")}
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-bold text-slate-500 ml-1">{t("settings:providers.fields.name")}</Label>
                        <Input
                          value={isBuiltInProviderId(providerEditingId) ? (t(`providers:items.${providerEditingId}`) as string) : (editingItem.displayName || "")}
                          disabled={isBuiltInProviderId(providerEditingId)}
                          onChange={(e: any) => updateProviderItem(providerEditingId, { displayName: String(e?.target?.value || "") })}
                          className="bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 rounded-xl"
                        />
                      </div>
	                      <div className="space-y-1.5">
	                        <Label className="text-xs font-bold text-slate-500 ml-1">{t("settings:providers.fields.startupCmd")}</Label>
	                        <Input
	                          value={startupCmdValue}
	                          disabled={startupCmdLocked}
	                          placeholder={providerEditingId === "terminal"
	                            ? (t("settings:providers.fields.startupCmdTerminalPlaceholder") as string)
	                            : (defaultStartupCmd || (t("settings:providers.fields.startupCmdPlaceholder") as string))}
	                          onChange={(e: any) => updateProviderItem(providerEditingId, { startupCmd: String(e?.target?.value || "") })}
	                          className="bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 rounded-xl font-mono text-xs"
	                        />
	                      </div>
                    </div>

                    {yoloSupported && (
                      <div className={cn(
                        "p-3 rounded-xl border transition-all",
                        yoloEnabled
                          ? "bg-[var(--cf-accent)]/5 border-[var(--cf-accent)]/30 dark:bg-[var(--cf-accent)]/10"
                          : "bg-white dark:bg-white/5 border-slate-200 dark:border-white/10"
                      )}>
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                            yoloEnabled ? "bg-[var(--cf-accent)] border-[var(--cf-accent)] text-white" : "border-slate-300 dark:border-white/20"
                          )} onClick={() => {
                            const next = !yoloEnabled;
                            if (next) {
                              const preset = getYoloPresetStartupCmd(providerEditingId);
                              if (preset) updateProviderItem(providerEditingId, { startupCmd: preset });
                            } else {
                              updateProviderItem(providerEditingId, { startupCmd: undefined });
                            }
                          }}>
                            {yoloEnabled && <Check className="h-3 w-3" />}
                          </div>
                          <div className="flex-1">
                            <span className="text-xs font-bold text-slate-800 dark:text-white leading-none">{t("settings:providers.fields.yolo")}</span>
                            <span className="ml-2 text-[10px] text-slate-500 leading-none">{t("settings:providers.fields.yoloHelp")}</span>
                          </div>
                        </div>
                        {yoloEnabled && yoloPresetCmd && (
                          <div className="mt-2 text-[10px] font-mono bg-black/5 dark:bg-white/5 px-2 py-1 rounded-md text-slate-600 dark:text-slate-400 truncate">{yoloPresetCmd}</div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Icon Customization */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest pl-1">
                      <ImageIcon className="h-3.5 w-3.5" />
                      {t("settings:providers.fields.icon")}
                    </div>
                    <div className="flex flex-wrap gap-4">
                      {/* Light/Default Icon */}
                      <div className="flex-1 min-w-[180px] p-3 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg border border-slate-100 dark:border-white/10 bg-slate-50 dark:bg-black/20 flex items-center justify-center">
                            {effectiveIcon ? <img src={effectiveIcon} className="h-6 w-6 object-contain" alt="" /> : <ImageIcon className="h-5 w-5 text-slate-300" />}
                          </div>
                          <div className="flex flex-col gap-1">
	                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">{t("settings:providers.fields.iconLight")}</span>
	                            <div className="flex gap-2">
	                              <input
	                                ref={iconFileInputRefLight}
	                                type="file"
	                                className="hidden"
	                                accept="image/*,.svg"
	                                onChange={handleLightIconFileChange}
	                              />
	                              <Button variant="outline" size="xs" onClick={triggerLightIconPicker} className="h-6 text-[9px] px-2 rounded-full dark:border-white/10 dark:hover:bg-white/5">
	                                {t("settings:providers.fields.iconUpload")}
	                              </Button>
	                              {hasLightOverride && (
	                                <Button variant="ghost" size="xs" onClick={() => updateProviderItem(providerEditingId, { iconDataUrl: "" })} className="h-6 text-[9px] px-2 rounded-full text-red-500">
                                  {t("settings:providers.fields.iconClear")}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Dark Mode Icon Option */}
                      <div className="flex-1 min-w-[180px] p-3 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg border border-white/5 bg-black/40 flex items-center justify-center">
                            {effectiveIconDarkPreview ? <img src={effectiveIconDarkPreview} className="h-6 w-6 object-contain" alt="" /> : <ImageIcon className="h-5 w-5 text-white/5" />}
                          </div>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">{t("settings:providers.fields.iconDark")}</span>
                              <div
                                onClick={() => providerEditingId !== "codex" && setShowDarkIconOverride(!showDarkIconOverride)}
                                className={cn(
                                  "h-3.5 w-6 rounded-full border border-slate-200 dark:border-white/20 relative transition-colors cursor-pointer",
                                  darkOverrideEnabled ? "bg-[var(--cf-accent)] border-[var(--cf-accent)]" : "bg-slate-200 dark:bg-white/10"
                                )}
                              >
                                <div className={cn(
                                  "absolute top-0.5 h-2 w-2 rounded-full bg-white shadow-sm transition-all",
                                  darkOverrideEnabled ? "left-3" : "left-0.5"
                                )} />
                              </div>
	                            </div>
	                            <div className="flex gap-2">
	                              <input
	                                ref={iconFileInputRefDark}
	                                type="file"
	                                className="hidden"
	                                accept="image/*,.svg"
	                                disabled={!darkOverrideEnabled}
	                                onChange={handleDarkIconFileChange}
	                              />
	                              <Button
	                                variant="outline"
	                                size="xs"
	                                onClick={triggerDarkIconPicker}
                                disabled={!darkOverrideEnabled}
                                className="h-6 text-[9px] px-2 rounded-full dark:border-white/10 dark:hover:bg-white/5"
                              >
                                {t("settings:providers.fields.iconUpload")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Runtime Env */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest pl-1">
                      <TerminalIcon className="h-3.5 w-3.5" />
                      {t("settings:providers.fields.envTerminal")}
                    </div>
                    <div className="space-y-3">
                      <div className="grid gap-4 sm:grid-cols-2 items-start">
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-xs font-bold text-slate-500 ml-1">{t("settings:providers.fields.envTerminal")}</Label>
                          <Select value={editingEnv.terminal} onValueChange={(v) => handleTerminalChange(v as TerminalMode)}>
                            <SelectTrigger className="h-9 rounded-xl bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="wsl">{t("settings:terminalMode.wsl")}</SelectItem>
                              <SelectItem value="pwsh" disabled={pwshAvailable === false}>{t("settings:terminalMode.pwsh")}</SelectItem>
                              <SelectItem value="windows">{t("settings:terminalMode.windows")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {editingEnv.terminal === "wsl" && (
                          <div className="flex flex-col gap-1.5">
                            <Label className="text-xs font-bold text-slate-500 ml-1">{t("settings:providers.fields.envDistro")}</Label>
                            <Select value={editingEnv.distro} onValueChange={(v) => updateProviderEnv(providerEditingId, { distro: v })}>
                              <SelectTrigger className="h-9 rounded-xl bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 px-4 text-xs">
                                <SelectValue placeholder={t("settings:terminalPlaceholder")} />
                              </SelectTrigger>
                              <SelectContent>
	                              {availableDistros.length > 0 ? (
	                                availableDistros.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)
	                              ) : (
	                                <SelectItem value={editingEnv.distro || ""}>{editingEnv.distro || t("settings:providers.fields.envDistroNoDistros")}</SelectItem>
	                              )}
	                            </SelectContent>
	                          </Select>
	                        </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 p-2.5 rounded-xl bg-blue-50/50 dark:bg-blue-500/5 text-[10px] text-blue-600 dark:text-blue-400">
                        <Info className="h-3 w-3 shrink-0" />
                        <span className="truncate">{pwshAvailable === null ? t("settings:terminalMode.pwshDetecting") : (pwshAvailable ? pwshDetectedText : t("settings:terminalMode.pwshUnavailable"))}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {providerEditingId === "claude" && (
                <div className="p-6 rounded-3xl border border-amber-200 dark:border-amber-500/20 bg-amber-50/30 dark:bg-amber-500/5">
                  <div className="flex items-start gap-4">
                    <div className="mt-1 h-5 w-5 shrink-0 rounded border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-black/20 flex items-center justify-center cursor-pointer" onClick={() => setClaudeCodeReadAgentHistory(!claudeCodeReadAgentHistory)}>
                      {claudeCodeReadAgentHistory && <Check className="h-3.5 w-3.5 text-amber-600" />}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-amber-900 dark:text-amber-200">{t("settings:providers.claudeCode.readAgentHistory.label")}</h4>
                      <p className="mt-1 text-xs text-amber-700/70 dark:text-amber-400/60 leading-relaxed">{t("settings:providers.claudeCode.readAgentHistory.desc")}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ),
        };
      }
      if (key === "gitWorktree") {
        /**
         * 将外部 Git 工具 id 映射为用于下拉展示的文本。
         */
        const externalToolLabel = (id: ExternalGitToolId): string => {
          if (id === "rider") return "Rider";
          if (id === "sourcetree") return "SourceTree";
          if (id === "fork") return "Fork";
          if (id === "gitkraken") return "GitKraken";
          return t("settings:gitWorktree.externalGitTool.custom", "自定义命令") as string;
        };

        const currentExternalToolLabel = externalToolLabel(gitWorktreeExternalGitToolId);

        return {
          key,
          title: t("settings:sections.gitWorktree.title"),
          description: t("settings:sections.gitWorktree.desc"),
	          content: (
	            <div className="space-y-6">
	              <div className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
	                <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-[var(--cf-text-secondary)]" />
	                <div className="min-w-0">
	                  <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
	                    {t("settings:gitWorktree.intro.title", "使用说明") as string}
	                  </div>
	                  <p className="mt-1 text-xs text-slate-500 dark:text-[var(--cf-text-secondary)] leading-relaxed whitespace-pre-line">
	                    {t(
	                      "settings:gitWorktree.intro.desc",
	                      "推荐流：根目录保持纯净，点击 分支徽标 (⎇) 为每个需求创建独立工作区，实现多任务/多 AI 并行开发，彻底避免不同模型同时修改同一份文件造成的代码冲突。\n怎么建：左键徽标唤起创建工作区面板（Ctrl+左键可极速创建），可以勾选 “并行混合模式”，让多个 AI 模型针对同一需求同时生成不同方案“赛马”。\n怎么收：项目右侧点 “工作区合并图标”（推荐 Squash）将最满意方案收回基分支，其余落选方案点 “垃圾桶” 直接删掉即可。"
	                    ) as string}
	                  </p>
	                </div>
	              </div>

	              <Card className="border-slate-200 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]">
	                <CardHeader className="pb-3">
	                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <TerminalSquare className="h-4 w-4 text-slate-500" />
                    {t("settings:gitWorktree.gitPath.title", "Git 基础") as string}
                  </CardTitle>
	                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                      {t("settings:gitWorktree.gitPath.label", "Git 可执行文件路径") as string}
                    </Label>
                    <Input
                      value={gitWorktreeGitPath}
                      onChange={(e: any) => setGitWorktreeGitPath(String(e?.target?.value || ""))}
                      placeholder={t("settings:gitWorktree.gitPath.placeholder", "留空自动探测（git）") as string}
                      className="h-9 font-mono text-xs focus-visible:ring-[var(--cf-accent)]"
                    />
                    <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:gitWorktree.gitPath.help", "为空将自动使用 PATH 中的 git；若探测失败请填写可执行文件路径。") as string}
                    </p>
                    {String(gitWorktreeGitPath || "").trim() ? null : (
                      <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {gitWorktreeDetectingPaths
                          ? (t("settings:gitWorktree.gitPath.detecting", "探测中…") as string)
                          : gitWorktreeDetectedGitPath
                            ? (t("settings:gitWorktree.gitPath.detected", "已探测：{path}", { path: gitWorktreeDetectedGitPath }) as string)
                            : (t("settings:gitWorktree.gitPath.notDetected", "未探测到：将使用 PATH 中的 git") as string)}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <ExternalLink className="h-4 w-4 text-slate-500" />
                    {t("settings:gitWorktree.tools.title", "外部工具") as string}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5 pt-0">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                      {t("settings:gitWorktree.externalGitTool.label", "默认外部 Git 工具") as string}
                    </Label>
                    <div className="w-full">
                      <Select
                        value={gitWorktreeExternalGitToolId}
                        onValueChange={(v) => setGitWorktreeExternalGitToolId(v as ExternalGitToolId)}
                      >
                        <SelectTrigger className="h-9 text-xs focus:ring-[var(--cf-accent)]">
                          <span className="truncate text-left">{currentExternalToolLabel}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="rider">Rider</SelectItem>
                          <SelectItem value="sourcetree">SourceTree</SelectItem>
                          <SelectItem value="fork">Fork</SelectItem>
                          <SelectItem value="gitkraken">GitKraken</SelectItem>
                          <SelectItem value="custom">{t("settings:gitWorktree.externalGitTool.custom", "自定义命令") as string}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {gitWorktreeExternalGitToolId === "custom" ? (
                      <Input
                        value={gitWorktreeExternalGitToolCustomCommand}
                        onChange={(e: any) => setGitWorktreeExternalGitToolCustomCommand(String(e?.target?.value || ""))}
                        placeholder={t("settings:gitWorktree.externalGitTool.customPlaceholder", "例如：\"path/to/tool\" {path}") as string}
                        className="h-9 font-mono text-xs mt-2 focus-visible:ring-[var(--cf-accent)]"
                      />
                    ) : null}
                    <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                      {t("settings:gitWorktree.externalGitTool.help", "自定义命令支持占位符 {path}。选择 Rider 时将以 Rider 打开目录。") as string}
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                      {t("settings:gitWorktree.terminalCommand.label", "终端 / Git Bash 命令") as string}
                    </Label>
                    <Input
                      value={gitWorktreeTerminalCommand}
                      onChange={(e: any) => setGitWorktreeTerminalCommand(String(e?.target?.value || ""))}
                      placeholder={t("settings:gitWorktree.terminalCommand.placeholder", "留空使用默认策略；支持 {path}") as string}
                      className="h-9 font-mono text-xs focus-visible:ring-[var(--cf-accent)]"
                    />
                    <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                      {t("settings:gitWorktree.terminalCommand.help", "Windows 默认优先 Git Bash；macOS/Linux 使用系统默认终端。") as string}
                    </p>
                    {String(gitWorktreeTerminalCommand || "").trim() ? null : (
                      <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {gitWorktreeDetectingPaths
                          ? (t("settings:gitWorktree.terminalCommand.detecting", "探测中…") as string)
                          : gitWorktreeDetectedGitBashPath
                            ? (t("settings:gitWorktree.terminalCommand.detectedGitBash", "已探测 Git Bash：{path}", { path: gitWorktreeDetectedGitBashPath }) as string)
                            : (t("settings:gitWorktree.terminalCommand.notDetectedGitBash", "未探测到 Git Bash：将回退到系统终端") as string)}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-slate-200 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                     <GitMerge className="h-4 w-4 text-slate-500" />
                    {t("settings:gitWorktree.behavior.title", "行为") as string}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <label className="flex items-start gap-3 rounded-md border border-slate-200/60 bg-slate-50/50 px-3 py-2.5 cursor-pointer transition-colors hover:bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:hover:bg-[var(--cf-surface-hover)]">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]"
                      checked={gitWorktreeAutoCommitEnabled}
                      onChange={(event) => setGitWorktreeAutoCommitEnabled(event.target.checked)}
                    />
                    <div className="min-w-0">
	                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
	                        {t("settings:gitWorktree.autoCommit.label", "worktree 自动提交") as string}
	                      </div>
	                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)] whitespace-pre-line">
	                        {t(
	                          "settings:gitWorktree.autoCommit.desc",
	                          "仅对非主 worktree 的根目录生效（主工作区不触发）。\n触发：每次引擎输出完成后（包含首次对话）；以及（兜底）从同一控制台第 2 次用户输入起的每次发送后。\n行为：检测到变更才执行 git add -A 并提交一次；无变更则跳过。提交信息格式：auto(agent)/auto(user)。"
	                        ) as string}
	                      </p>
	                    </div>
	                  </label>

                  <label className="flex items-start gap-3 rounded-md border border-slate-200/60 bg-slate-50/50 px-3 py-2.5 cursor-pointer transition-colors hover:bg-slate-50 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:hover:bg-[var(--cf-surface-hover)]">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[var(--cf-accent)] focus:ring-[var(--cf-accent)] dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)]"
                      checked={gitWorktreeCopyRulesOnCreate}
                      onChange={(event) => setGitWorktreeCopyRulesOnCreate(event.target.checked)}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 dark:text-[var(--cf-text-primary)]">
                        {t("settings:gitWorktree.copyRules.label", "创建 worktree 时复制 AI 规则文件") as string}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-[var(--cf-text-secondary)] mt-0.5">
                        {t("settings:gitWorktree.copyRules.desc", "当源目录存在 AGENTS/CLAUDE/GEMINI 且被 git ignore 时复制到新 worktree。") as string}
                      </p>
                    </div>
                  </label>
                </CardContent>
              </Card>
            </div>
          ),
        };
      }
      if (key === "notifications") {
        return {
          key,
          title: t("settings:sections.notifications.title"),
          description: t("settings:sections.notifications.desc"),
          content: (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:notifications.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-slate-500 dark:text-[var(--cf-text-secondary)]">{t("settings:notifications.help")}</p>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                      checked={notifications.badge}
                      onChange={(event) => {
                        const next = { ...notifications, badge: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                        {t("settings:notifications.badge.label")}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:notifications.badge.desc")}
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                      checked={notifications.system}
                      onChange={(event) => {
                        const next = { ...notifications, system: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                        {t("settings:notifications.system.label")}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:notifications.system.desc")}
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                      checked={notifications.sound}
                      onChange={(event) => {
                        const next = { ...notifications, sound: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                        {t("settings:notifications.sound.label")}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:notifications.sound.desc")}
                      </p>
                    </div>
                  </label>
                </CardContent>
              </Card>
            </div>
          ),
        };
      }
      if (key === "terminal") {
        return {
          key,
          title: t("settings:sections.terminal.title"),
          description: t("settings:sections.terminal.desc"),
          content: (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:sendMode.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:sendMode.help")}</p>
                  <div className="max-w-xs">
                    <Select value={sendMode} onValueChange={(v) => setSendMode(v as SendMode)}>
                      <SelectTrigger>
                        <span className="truncate text-left">
                          {sendMode === "write_and_enter"
                            ? t("settings:sendMode.write_and_enter")
                            : t("settings:sendMode.write_only")}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="write_only">{t("settings:sendMode.write_only")}</SelectItem>
                        <SelectItem value="write_and_enter">{t("settings:sendMode.write_and_enter")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:projectPathStyle.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:projectPathStyle.help")}</p>
                  <div className="max-w-xs">
                    <Select value={pathStyle} onValueChange={(v) => setPathStyle(v as PathStyle)}>
                      <SelectTrigger>
                        <span className="truncate text-left">
                          {pathStyle === "absolute"
                            ? t("settings:projectPathStyle.absolute")
                            : t("settings:projectPathStyle.relative")}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="absolute">{t("settings:projectPathStyle.absolute")}</SelectItem>
                        <SelectItem value="relative">{t("settings:projectPathStyle.relative")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:dragDrop.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                      checked={dragDropWarnOutsideProject}
                      onChange={(event) => setDragDropWarnOutsideProject(event.target.checked)}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                        {t("settings:dragDrop.warnOutsideProject.label")}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                        {t("settings:dragDrop.warnOutsideProject.desc")}
                      </p>
                    </div>
                  </label>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:terminalTheme.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-slate-500">{t("settings:terminalTheme.help")}</p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {TERMINAL_THEME_OPTIONS.map((option) => {
                      const isActive = option.id === terminalTheme;
                      const palette = option.palette;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={cn(
                            "flex flex-col gap-2 rounded-lg border px-3 py-3 text-left transition-colors",
                            isActive
                              ? "border-slate-900 bg-slate-50 shadow-sm dark:border-[var(--cf-accent)] dark:bg-[var(--cf-surface)]"
                              : "border-slate-200 bg-white hover:border-slate-300 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:hover:border-[var(--cf-border)]"
                          )}
                          onClick={() => setTerminalTheme(option.id)}
                        >
                          <div
                            className="rounded-md border border-slate-200/70 px-3 py-2 text-xs font-mono"
                            style={{
                              backgroundColor: palette.background,
                              color: palette.foreground,
                            }}
                          >
                            AaBbCc123
                          </div>
                          <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                            {t(`settings:terminalTheme.options.${option.id}`)}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">
                            {t(`settings:terminalTheme.mode.${option.tone}`)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:terminalFont.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-slate-500">{t("settings:terminalFont.help")}</p>

                  {/* 统一预览区域 */}
                  <div>
                    <div className="text-xs font-medium text-slate-600 mb-2">{t("settings:terminalFont.previewTitle")}</div>
                    <div
                      className="rounded-lg border border-slate-200 px-4 py-3 font-mono text-xs overflow-x-auto dark:border-[var(--cf-border)]"
                      style={{
                        fontFamily: terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
                        backgroundColor: previewTheme.palette.background,
                        color: previewTheme.palette.foreground,
                      }}
                    >
                      {t("settings:terminalFont.preview")}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {resolvedPreviewFont.isFallback
                        ? t("settings:terminalFont.fallback", { name: resolvedPreviewFont.name })
                        : t("settings:terminalFont.effective", { name: resolvedPreviewFont.name })}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {t("settings:terminalTheme.previewNote", { theme: t(`settings:terminalTheme.options.${terminalTheme}`) })}
                    </div>
                  </div>

                  {/* 单一选择器：仅显示“已安装”字体；推荐项置顶并标注“推荐” */}
                  <div className="max-w-xs space-y-2 text-slate-700 dark:text-slate-200">
                    <div className="text-xs font-medium text-slate-600">{t("settings:terminalFont.installedLabel")}</div>
                    {installedFonts.length > 0 ? (
                      <>
                        <div className="flex items-stretch gap-1">
                          <Select
                            value={currentPrimaryFont || ""}
                            onValueChange={(name) => {
                              const stack = buildTerminalFontStack(name);
                              setTerminalFontFamily(stack);
                            }}
                          >
                            <SelectTrigger className="flex-1">
                              <span className="truncate text-left">{currentPrimaryFont || (t("settings:terminalFont.installedPlaceholder") as string)}</span>
                            </SelectTrigger>
                            <SelectContent>
                              {visibleFontList.map((name) => (
                                <SelectItem key={name} value={name}>{name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <div className="flex flex-col flex-shrink-0 h-10 w-7 overflow-hidden rounded border border-slate-200 divide-y divide-slate-200">
                            <button
                              type="button"
                              className="inline-flex w-full flex-1 items-center justify-center bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                              title={t('settings:terminalFont.prev') as string}
                              disabled={visibleFontList.length === 0 || currentFontIndex <= 0}
                              onClick={() => {
                                try {
                                  const list = visibleFontList;
                                  if (list.length === 0) return;
                                  const curIdx = currentFontIndex >= 0 ? currentFontIndex : 0;
                                  if (curIdx <= 0) return;
                                  const next = list[curIdx - 1];
                                  if (next) setTerminalFontFamily(buildTerminalFontStack(next));
                                } catch { }
                              }}
                            >
                              <ChevronUp className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="inline-flex w-full flex-1 items-center justify-center bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                              title={t('settings:terminalFont.next') as string}
                              disabled={
                                visibleFontList.length === 0 ||
                                (currentFontIndex !== -1 && currentFontIndex >= visibleFontList.length - 1)
                              }
                              onClick={() => {
                                try {
                                  const list = visibleFontList;
                                  if (list.length === 0) return;
                                  const curIdx = currentFontIndex;
                                  if (curIdx === -1) {
                                    const first = list[0];
                                    if (first) setTerminalFontFamily(buildTerminalFontStack(first));
                                    return;
                                  }
                                  if (curIdx >= list.length - 1) return;
                                  const next = list[curIdx + 1];
                                  if (next) setTerminalFontFamily(buildTerminalFontStack(next));
                                } catch { }
                              }}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <label
                          className="flex items-center gap-2 text-xs text-slate-700"
                          title={t("settings:terminalFont.showAllHint") as string}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-slate-300 text-slate-600"
                            checked={showAllFonts}
                            onChange={(e) => setShowAllFonts(e.target.checked)}
                          />
                          <span>{t("settings:terminalFont.showAll")}</span>
                        </label>
                      </>
                    ) : (
                      <div className="text-xs text-slate-400 mt-1">{installedLoading ? t("settings:loading") : t("settings:terminalFont.installedNone")}</div>
                    )}
                  </div>
                </CardContent>
              </Card>

            </div>
          ),
        };
      }
      if (key === "networkAccount") {
        return {
          key,
          title: t("settings:sections.networkAccount.title"),
          description: t("settings:sections.networkAccount.desc"),
          content: (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:network.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500 dark:text-[var(--cf-text-secondary)]">{t("settings:network.desc")}</p>
                  <div className="flex flex-col gap-3 max-w-xl">
                    <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
                        checked={network.proxyEnabled}
                        onChange={(e) => setNetwork((v) => ({ ...v, proxyEnabled: e.target.checked }))}
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">{t("settings:network.enable")}</div>
                        <p className="text-xs text-slate-500 dark:text-[var(--cf-text-secondary)]">{t("settings:network.enableDesc")}</p>
                      </div>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-center">
                      <div className="text-sm text-slate-700 dark:text-[var(--cf-text-primary)]">{t("settings:network.mode")}</div>
                      <div className="max-w-xs">
                        <Select
                          value={network.proxyMode}
                          onValueChange={(v) => setNetwork((s) => ({ ...s, proxyMode: v as any }))}
                        >
                          <SelectTrigger disabled={!network.proxyEnabled}>
                            <span className="truncate text-left">
                              {network.proxyMode === "system"
                                ? t("settings:network.modeSystem")
                                : t("settings:network.modeCustom")}
                            </span>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="system">{t("settings:network.modeSystem")}</SelectItem>
                            <SelectItem value="custom">{t("settings:network.modeCustom")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-center">
                      <div className="text-sm text-slate-700 dark:text-[var(--cf-text-primary)]">{t("settings:network.customUrl")}</div>
                      <Input
                        disabled={!network.proxyEnabled || network.proxyMode !== "custom"}
                        value={network.proxyUrl}
                        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setNetwork((s) => ({ ...s, proxyUrl: (e.target as any).value }))}
                        placeholder="http://127.0.0.1:7890"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-center">
                      <div className="text-sm text-slate-700 dark:text-[var(--cf-text-primary)]">{t("settings:network.noProxy")}</div>
                      <Input
                        disabled={!network.proxyEnabled}
                        value={network.noProxy}
                        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setNetwork((s) => ({ ...s, noProxy: (e.target as any).value }))}
                        placeholder="localhost,127.0.0.1,.corp,.local"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:codexAccount.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:codexAccount.help")}</p>
                  <CodexAccountInline
                    className="w-full"
                    auto={open}
                    terminalMode={providerEnvMap["codex"]?.terminal || "wsl"}
                    distro={(providerEnvMap["codex"]?.terminal || "wsl") === "wsl" ? (providerEnvMap["codex"]?.distro || "Ubuntu-24.04") : undefined}
                    expanded
                  />
                  <Separator className="my-4" />
                  <CodexAuthSwitch
                    open={open}
                    recordEnabled={codexAccount.recordEnabled}
                    onRecordEnabledChange={(enabled) => setCodexAccount({ recordEnabled: enabled })}
                  />
                </CardContent>
              </Card>
            </div>
          ),
        };
      }
      return {
        key,
        title: t("settings:sections.data.title"),
        description: t("settings:sections.data.desc"),
        content: (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:codexRoots.label")}</CardTitle>
              </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:codexRoots.help")}</p>
                {renderEngineRoots("codex", codexRoots, "settings:codexRoots.empty")}
                </CardContent>
              </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:claudeRoots.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-slate-500">{t("settings:claudeRoots.help")}</p>
                {renderEngineRoots("claude", claudeRoots, "settings:claudeRoots.empty")}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:geminiRoots.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-slate-500">{t("settings:geminiRoots.help")}</p>
                {renderEngineRoots("gemini", geminiRoots, "settings:geminiRoots.empty")}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:historyCleanup.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">{t("settings:historyCleanup.desc")}</p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    className="border border-red-200 text-red-600 hover:bg-red-50 dark:border-[var(--cf-red-light)] dark:text-[var(--cf-red)] dark:hover:bg-[var(--cf-red-light)]"
                    disabled={cleanupScanning || cleanupRunning}
                    onClick={async () => {
                      try {
                        setCleanupScanning(true);
                        setCleanupResult(null);
                        const res: any = await (window as any).host?.history?.findEmptySessions?.();
                        const list = res && res.ok && Array.isArray(res.candidates)
                          ? (res.candidates as CleanupCandidate[])
                          : [];
                        setCleanupList(list);
                        setCleanupOpen(true);
                      } catch {
                        setCleanupFeedback({
                          open: true,
                          message: t("settings:historyCleanup.scanFailed") as string,
                          isError: true,
                        });
                      } finally {
                        setCleanupScanning(false);
                      }
                    }}
                  >
                    {cleanupScanning ? t("settings:historyCleanup.scanning") : t("settings:historyCleanup.scan")}
                  </Button>
                  {cleanupResult && (
                    <span className="text-xs text-slate-600">
                      {t("settings:historyCleanup.result", {
                        ok: cleanupResult.ok,
                        notFound: cleanupResult.notFound,
                        failed: cleanupResult.failed,
                      })}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:appData.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">{t("settings:appData.desc")}</p>
                <div className="space-y-3 rounded border bg-slate-50 p-3 text-xs">
                  <div>
                    <span className="text-slate-500">{t("settings:appData.pathLabel")}</span>
                    <div className="mt-1 break-words select-all font-mono text-[11px] text-slate-700">
                      {storageInfo?.path || (t("settings:appData.pathUnknown") as string)}
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <div className="text-slate-500">{t("settings:appData.sizeLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {storageLoading && !storageInfo
                          ? (t("settings:appData.loading") as string)
                          : formatBytes(storageInfo?.totalBytes ?? 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">{t("settings:appData.dirLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {storageInfo ? storageInfo.dirCount : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">{t("settings:appData.fileLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {storageInfo ? storageInfo.fileCount : "—"}
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {storageInfo
                      ? t("settings:appData.updatedAt", {
                        value: new Date(storageInfo.collectedAt).toLocaleString(),
                      })
                      : storageLoading
                        ? (t("settings:appData.loading") as string)
                        : t("settings:appData.awaitingRefresh")}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={storageLoading || storageClearing || storagePurging}
                    onClick={refreshAppDataInfo}
                  >
                    {storageLoading ? t("settings:appData.refreshing") : t("settings:appData.refresh")}
                  </Button>
                  <Button
                    variant="secondary"
                    className="border border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-[var(--cf-yellow-light)] dark:text-[var(--cf-yellow)] dark:hover:bg-[var(--cf-yellow-light)]"
                    disabled={storageLoading || storageClearing || storagePurging}
                    onClick={() => {
                      setStoragePreserveSettings(true);
                      setStorageConfirmOpen(true);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />{" "}
                    {storageClearing ? t("settings:appData.cleaning") : t("settings:appData.clean")}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={storagePurging || storageClearing}
                    onClick={() => setStoragePurgeConfirmOpen(true)}
                  >
                    <Power className="mr-2 h-4 w-4" />{" "}
                    {storagePurging ? t("settings:appData.fullPurging") : t("settings:appData.fullPurge")}
                  </Button>
                </div>
                {storageError && <div className="text-sm text-red-600 dark:text-[var(--cf-red)]">{storageError}</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:autoProfiles.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">{t("settings:autoProfiles.desc")}</p>
                <div className="space-y-3 rounded border bg-slate-50 p-3 text-xs">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-slate-500">{t("settings:autoProfiles.countLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {autoProfilesLoading && !autoProfilesInfo
                          ? (t("settings:autoProfiles.loading") as string)
                          : autoProfilesInfo ? autoProfilesInfo.count : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">{t("settings:autoProfiles.sizeLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {autoProfilesLoading && !autoProfilesInfo
                          ? (t("settings:autoProfiles.loading") as string)
                          : formatBytes(autoProfilesInfo?.totalBytes ?? 0)}
                      </div>
                    </div>
                  </div>
                  {autoProfilesInfo && autoProfilesInfo.items.length > 0 ? (
                    <div className="mt-2 max-h-48 overflow-auto rounded border bg-white p-2 text-xs">
                      <ul className="space-y-1">
                        {autoProfilesInfo.items.map((item) => (
                          <li key={item.path} className="flex items-center gap-2" title={item.path}>
                            <span className="w-20 shrink-0 font-medium text-slate-700">{item.profileId}</span>
                            <span className="flex-1 min-w-0 truncate select-all font-mono text-[11px] text-slate-700">{item.path}</span>
                            <span className="shrink-0 text-slate-500">{formatBytes(item.totalBytes)}</span>
                            {item.isCurrent && (
                              <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] text-slate-600">
                                {t("settings:autoProfiles.current")}
                              </span>
                            )}
                            <Button size="xs" variant="ghost" className="h-6 px-2" onClick={() => openSessionRootPath(item.path)}>{t("common:open")}</Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">
                      {autoProfilesLoading
                        ? (t("settings:autoProfiles.loading") as string)
                        : t("settings:autoProfiles.empty")}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={autoProfilesLoading || autoProfilesCleaning}
                    onClick={refreshAutoProfilesInfo}
                  >
                    {autoProfilesLoading ? t("settings:autoProfiles.refreshing") : t("settings:autoProfiles.refresh")}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={autoProfilesCleaning || autoProfilesLoading || !!(autoProfilesInfo && autoProfilesInfo.items.length === 0)}
                    onClick={() => setAutoProfilesConfirmOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />{" "}
                    {autoProfilesCleaning ? t("settings:autoProfiles.cleaning") : t("settings:autoProfiles.cleanup")}
                  </Button>
                </div>
                {autoProfilesError && <div className="text-sm text-red-600 dark:text-[var(--cf-red)]">{autoProfilesError}</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:worktreeProfiles.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">{t("settings:worktreeProfiles.desc")}</p>
                <div className="space-y-3 rounded border bg-slate-50 p-3 text-xs">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-slate-500">{t("settings:worktreeProfiles.countLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {worktreeProfilesLoading && !worktreeProfilesInfo
                          ? (t("settings:worktreeProfiles.loading") as string)
                          : worktreeProfilesInfo ? worktreeProfilesInfo.count : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500">{t("settings:worktreeProfiles.sizeLabel")}</div>
                      <div className="mt-1 text-sm font-medium text-slate-700">
                        {worktreeProfilesLoading && !worktreeProfilesInfo
                          ? (t("settings:worktreeProfiles.loading") as string)
                          : formatBytes(worktreeProfilesInfo?.totalBytes ?? 0)}
                      </div>
                    </div>
                  </div>
                  {worktreeProfilesInfo && worktreeProfilesInfo.items.length > 0 ? (
                    <div className="mt-2 max-h-48 overflow-auto rounded border bg-white p-2 text-xs">
                      <ul className="space-y-1">
                        {worktreeProfilesInfo.items.map((item: WorktreeProfileDirInfo) => (
                          <li key={item.path} className="flex items-center gap-2" title={item.path}>
                            <span className="w-28 shrink-0 truncate font-medium text-slate-700" title={item.profileId}>{item.profileId}</span>
                            <span className="flex-1 min-w-0 truncate select-all font-mono text-[11px] text-slate-700">{item.path}</span>
                            <span className="shrink-0 text-slate-500">{formatBytes(item.totalBytes)}</span>
                            {item.isCurrent && (
                              <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] text-slate-600">
                                {t("settings:worktreeProfiles.current")}
                              </span>
                            )}
                            <Button size="xs" variant="ghost" className="h-6 px-2" onClick={() => openSessionRootPath(item.path)}>{t("common:open")}</Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">
                      {worktreeProfilesLoading
                        ? (t("settings:worktreeProfiles.loading") as string)
                        : t("settings:worktreeProfiles.empty")}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={worktreeProfilesLoading || worktreeProfilesCleaning}
                    onClick={refreshWorktreeProfilesInfo}
                  >
                    {worktreeProfilesLoading ? t("settings:worktreeProfiles.refreshing") : t("settings:worktreeProfiles.refresh")}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={worktreeProfilesCleaning || worktreeProfilesLoading || !!(worktreeProfilesInfo && worktreeProfilesInfo.items.length === 0)}
                    onClick={() => setWorktreeProfilesConfirmOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />{" "}
                    {worktreeProfilesCleaning ? t("settings:worktreeProfiles.cleaning") : t("settings:worktreeProfiles.cleanup")}
                  </Button>
                </div>
                {worktreeProfilesError && <div className="text-sm text-red-600 dark:text-[var(--cf-red)]">{worktreeProfilesError}</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("settings:debug.label")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-500">{t("settings:debug.help")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        const res: any = await (window as any).host?.storage?.getAppDataInfo?.();
                        const dir = res && res.ok ? String(res.path || '') : '';
                        if (!dir) return;
                        const normalized = dir.replace(/[/\\]+$/, '');
                        if (!normalized) return;
                        const sep = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
                        const target = `${normalized}${sep}debug.config.jsonc`;
                        await (window as any).host?.utils?.openPath?.(target);
                      } catch { }
                    }}
                  >
                    {t("settings:debug.open")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try { await (window as any).host?.debug?.reset?.(); } catch { }
                    }}
                  >
                    {t("settings:debug.reset")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        ),
      };
    });
  }, [
    open,
    availableDistros,
    availableLangs,
    cleanupResult,
    cleanupRunning,
    cleanupScanning,
    codexRoots,
    claudeRoots,
    geminiRoots,
    renderEngineRoots,
    openSessionRootPath,
    // 字体与显示相关依赖，确保“显示所有字体”等交互即时生效
    installedFonts,
    monospaceFonts,
    installedLoading,
    showAllFonts,
    labelOf,
    lang,
    theme,
    multiInstanceEnabled,
    systemTheme,
    pathStyle,
    dragDropWarnOutsideProject,
    notifications,
    network,
    codexAccount,
    defaultIde,
    sendMode,
    showDarkIconOverride,
    storageInfo,
    storageLoading,
    storageClearing,
    storagePurging,
    storageError,
    autoProfilesInfo,
    autoProfilesLoading,
    autoProfilesCleaning,
    autoProfilesError,
    worktreeProfilesInfo,
    worktreeProfilesLoading,
    worktreeProfilesCleaning,
    worktreeProfilesError,
    refreshAppDataInfo,
    refreshAutoProfilesInfo,
    refreshWorktreeProfilesInfo,
    t,
    terminalFontFamily,
    terminalTheme,
    themeLabel,
    systemThemeLabel,
    providersActiveId,
    providerEditingId,
    providerItems,
    providerEnvMap,
    orderedProviders,
    addCustomProvider,
    removeCustomProvider,
    setActiveProvider,
    updateProviderItem,
    updateProviderEnv,
    handleTerminalChange,
    editingEnv,
    editingTerminalLabel,
	    pwshAvailable,
	    pwshDetectedText,
	    readFileAsDataUrl,
	    handleLightIconFileChange,
	    handleDarkIconFileChange,
	    triggerLightIconPicker,
	    triggerDarkIconPicker,
	    getProviderItem,
	    claudeCodeReadAgentHistory,
      gitWorktreeGitPath,
      gitWorktreeExternalGitToolId,
      gitWorktreeExternalGitToolCustomCommand,
      gitWorktreeTerminalCommand,
      gitWorktreeAutoCommitEnabled,
      gitWorktreeCopyRulesOnCreate,
	  ]);

  useEffect(() => {
    if (!open) {
      setActiveSection("basic");
      return;
    }
    if (!NAV_ORDER.includes(activeSection)) {
      setActiveSection("basic");
    }
  }, [activeSection, open]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: 0, behavior: "auto" });
  }, [activeSection]);

	  const renderNavigation = () => {
	    const sectionIcons: Record<SectionKey, React.ReactNode> = {
	      basic: <Settings2 className="h-4 w-4" />,
	      providers: <Cpu className="h-4 w-4" />,
        gitWorktree: <GitBranch className="h-4 w-4" />,
	      terminal: <TerminalIcon className="h-4 w-4" />,
	      notifications: <Bell className="h-4 w-4" />,
	      networkAccount: <Globe className="h-4 w-4" />,
	      data: <Database className="h-4 w-4" />,
	    };

    return (
      <nav className="flex shrink-0 basis-60 flex-col gap-1.5 py-2 pr-4">
        {sections.map((section) => {
          const isActive = activeSection === section.key;
          return (
            <button
              key={section.key}
              type="button"
              className={cn(
                "group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200",
                isActive
                  ? "border-slate-200 bg-white/70 text-slate-900 shadow-sm dark:border-[var(--cf-border-strong)] dark:bg-[var(--cf-surface-hover)] dark:text-[var(--cf-text-primary)]"
                  : "border-transparent hover:bg-slate-100/50 text-slate-500 hover:text-slate-700 dark:hover:bg-[var(--cf-surface)] dark:text-[var(--cf-text-secondary)] dark:hover:text-[var(--cf-text-primary)]"
              )}
              onClick={() => {
                setActiveSection(section.key);
              }}
            >
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  isActive
                    ? "bg-[var(--cf-accent)] text-white"
                    : "bg-slate-100 text-slate-400 group-hover:bg-slate-200 group-hover:text-slate-500 dark:bg-[var(--cf-surface)] dark:text-[var(--cf-text-muted)] dark:group-hover:bg-[var(--cf-surface-hover)]"
                )}
              >
                {sectionIcons[section.key as SectionKey]}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold leading-tight">{section.title}</span>
                <span className="mt-0.5 text-[11px] text-slate-400 dark:text-[var(--cf-text-muted)] line-clamp-1">
                  {section.description}
                </span>
              </div>
            </button>
          );
        })}
      </nav>
    );
  };

  const active = sections.find((section) => section.key === activeSection) ?? sections[0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1000px] w-[90vw] overflow-hidden p-0 border-none shadow-2xl bg-white dark:bg-[#121214] ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex h-[75vh] min-h-[620px] flex-col">
          {/* Header */}
          <header className="flex h-14 shrink-0 items-center justify-between border-b px-6 bg-white/50 dark:bg-white/[0.02] backdrop-blur-md dark:border-white/10">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--cf-accent)] text-white shadow-lg shadow-[var(--cf-accent)]/20">
                <Settings2 className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-base font-bold tracking-tight text-slate-900 dark:text-white">{t("settings:title")}</DialogTitle>
              </div>
            </div>
          </header>

          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar */}
            <aside className="w-64 shrink-0 border-r bg-slate-50/50 dark:bg-white/[0.01] px-4 py-4 dark:border-white/10">
              {renderNavigation()}
            </aside>

            {/* Main Content Area */}
            <main className="flex flex-1 flex-col min-w-0 bg-white/40 dark:bg-transparent">
	              <div className="flex-1 overflow-hidden">
	                <ScrollArea ref={scrollRef} className="h-full">
	                  <div className="max-w-3xl mx-auto px-6 py-4">
	                    <div className="mb-4 flex flex-col gap-1">
	                      <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-[var(--cf-text-primary)]">
	                        {active.title}
	                      </h2>
                      <p className="text-[12px] text-slate-500 dark:text-[var(--cf-text-secondary)] leading-relaxed">
                        {active.description}
                      </p>
                    </div>

                    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      {active.content}
                    </div>
                  </div>
                </ScrollArea>
              </div>

              {/* Footer */}
              <footer className="flex h-14 shrink-0 items-center justify-between border-t px-8 dark:border-white/10 bg-slate-50/30 dark:bg-black/5">
                <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-[var(--cf-text-muted)]">
                  <Info className="h-3.5 w-3.5" />
                  {t("settings:footer.note")}
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    variant="ghost"
                    className="px-5 transition-colors hover:bg-slate-100 dark:hover:bg-[var(--cf-surface)]"
                    onClick={() => onOpenChange(false)}
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button
                    className="px-6 shadow-md shadow-[var(--cf-accent)]/20 transition-all hover:scale-[1.02] active:scale-[0.98] bg-[var(--cf-accent)] hover:bg-[var(--cf-accent-hover)] text-white"
                    onClick={() => {
	                      onSave({
	                        providers: {
	                          activeId: providersActiveId,
	                          items: sanitizeProviderItemsForSave(providerItems),
	                          env: providerEnvMap,
	                        },
	                        sendMode,
	                        locale: lang,
	                        projectPathStyle: pathStyle,
	                        dragDropWarnOutsideProject,
	                        theme,
	                        multiInstanceEnabled,
	                        notifications,
	                        network,
	                        codexAccount,
                          defaultIde: {
                            mode: defaultIde.mode,
                            builtinId: defaultIde.builtinId,
                            customName: defaultIde.customName,
                            customCommand: defaultIde.customCommand,
                          },
                          gitWorktree: {
                            gitPath: gitWorktreeGitPath,
                            externalGitToolId: gitWorktreeExternalGitToolId,
                            externalGitToolCustomCommand: gitWorktreeExternalGitToolCustomCommand,
                            terminalCommand: gitWorktreeTerminalCommand,
                            autoCommitEnabled: gitWorktreeAutoCommitEnabled,
                            copyRulesOnCreate: gitWorktreeCopyRulesOnCreate,
                          },
	                        terminalFontFamily: normalizeTerminalFontFamily(terminalFontFamily),
	                        terminalTheme,
	                        claudeCodeReadAgentHistory,
	                      });
                      onOpenChange(false);
                    }}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    {t("common:save")}
                  </Button>
                </div>
              </footer>
            </main>
          </div>
        </div>
      </DialogContent>
      <Dialog open={storageConfirmOpen} onOpenChange={setStorageConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings:appData.cleanConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:appData.cleanConfirmDesc", { path: storageInfo?.path || "" })}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {t("settings:appData.cleanConfirmNote")}
          </p>
          <label className="mt-3 flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface-muted)] dark:text-[var(--cf-text-primary)]">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-[var(--cf-border)] dark:bg-[var(--cf-surface)] dark:checked:bg-[var(--cf-accent)] dark:focus-visible:ring-[var(--cf-accent)]/40"
              checked={storagePreserveSettings}
              onChange={(event) => setStoragePreserveSettings(event.target.checked)}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-800 dark:text-[var(--cf-text-primary)]">
                {t("settings:appData.preserveSettings.label")}
              </div>
              <p className={cn("text-xs dark:text-[var(--cf-text-secondary)]", storagePreserveSettings ? "text-slate-500" : "text-red-600 dark:text-[var(--cf-red)]")}>
                {t("settings:appData.preserveSettings.desc")}
              </p>
            </div>
          </label>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setStorageConfirmOpen(false)} disabled={storageClearing}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="secondary"
              className="border border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-[var(--cf-yellow-light)] dark:text-[var(--cf-yellow)] dark:hover:bg-[var(--cf-yellow-light)]"
              disabled={storageClearing}
              onClick={handleClearAppData}
            >
              <Trash2 className="mr-2 h-4 w-4" />{" "}
              {storageClearing ? t("settings:appData.cleaning") : t("settings:appData.cleanConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={storagePurgeConfirmOpen} onOpenChange={setStoragePurgeConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings:appData.fullConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:appData.fullConfirmDesc", { path: storageInfo?.path || "" })}
          </p>
          <p className="mt-3 text-xs text-red-600">
            {t("settings:appData.fullConfirmNote")}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setStoragePurgeConfirmOpen(false)} disabled={storagePurging}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={storagePurging}
              onClick={handlePurgeAppData}
            >
              <Power className="mr-2 h-4 w-4" />{" "}
              {storagePurging ? t("settings:appData.fullPurging") : t("settings:appData.fullConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={storageFeedback.open} onOpenChange={(openState) => setStorageFeedback((prev) => ({ ...prev, open: openState }))}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {storageFeedback.isError
                ? t("settings:appData.feedbackErrorTitle")
                : t("settings:appData.feedbackSuccessTitle")}
            </DialogTitle>
          </DialogHeader>
          {storageFeedback.message && (
            <p className={cn("text-sm", storageFeedback.isError ? "text-red-600" : "text-slate-600")}>
              {storageFeedback.message}
            </p>
          )}
          <div className="flex justify-end pt-4">
            <Button onClick={() => setStorageFeedback((prev) => ({ ...prev, open: false }))}>
              {t("common:ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={autoProfilesConfirmOpen} onOpenChange={setAutoProfilesConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings:autoProfiles.cleanupConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:autoProfiles.cleanupConfirmDesc")}
          </p>
          <p className="mt-3 text-xs text-red-600">
            {t("settings:autoProfiles.cleanupConfirmNote")}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setAutoProfilesConfirmOpen(false)} disabled={autoProfilesCleaning}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={autoProfilesCleaning}
              onClick={handlePurgeAutoProfiles}
            >
              <Trash2 className="mr-2 h-4 w-4" />{" "}
              {autoProfilesCleaning ? t("settings:autoProfiles.cleaning") : t("settings:autoProfiles.cleanupConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={autoProfilesFeedback.open} onOpenChange={(openState) => setAutoProfilesFeedback((prev) => ({ ...prev, open: openState }))}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {autoProfilesFeedback.isError
                ? t("settings:autoProfiles.feedbackErrorTitle")
                : t("settings:autoProfiles.feedbackSuccessTitle")}
            </DialogTitle>
          </DialogHeader>
          {autoProfilesFeedback.message && (
            <p className={cn("text-sm", autoProfilesFeedback.isError ? "text-red-600" : "text-slate-600")}>
              {autoProfilesFeedback.message}
            </p>
          )}
          <div className="flex justify-end pt-4">
            <Button onClick={() => setAutoProfilesFeedback((prev) => ({ ...prev, open: false }))}>
              {t("common:ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={worktreeProfilesConfirmOpen} onOpenChange={setWorktreeProfilesConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings:worktreeProfiles.cleanupConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:worktreeProfiles.cleanupConfirmDesc")}
          </p>
          <p className="mt-3 text-xs text-red-600">
            {t("settings:worktreeProfiles.cleanupConfirmNote")}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setWorktreeProfilesConfirmOpen(false)} disabled={worktreeProfilesCleaning}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={worktreeProfilesCleaning}
              onClick={handlePurgeWorktreeProfiles}
            >
              <Trash2 className="mr-2 h-4 w-4" />{" "}
              {worktreeProfilesCleaning ? t("settings:worktreeProfiles.cleaning") : t("settings:worktreeProfiles.cleanupConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={worktreeProfilesFeedback.open} onOpenChange={(openState) => setWorktreeProfilesFeedback((prev) => ({ ...prev, open: openState }))}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {worktreeProfilesFeedback.isError
                ? t("settings:worktreeProfiles.feedbackErrorTitle")
                : t("settings:worktreeProfiles.feedbackSuccessTitle")}
            </DialogTitle>
          </DialogHeader>
          {worktreeProfilesFeedback.message && (
            <p className={cn("text-sm", worktreeProfilesFeedback.isError ? "text-red-600" : "text-slate-600")}>
              {worktreeProfilesFeedback.message}
            </p>
          )}
          <div className="flex justify-end pt-4">
            <Button onClick={() => setWorktreeProfilesFeedback((prev) => ({ ...prev, open: false }))}>
              {t("common:ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogContent className="max-w-4xl w-[80vw]">
          <DialogHeader>
            <DialogTitle>{t("settings:cleanupConfirm.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:cleanupConfirm.desc", { count: cleanupList.length })}
          </p>
          <div className="max-h-[60vh] overflow-auto rounded border bg-slate-50 text-xs">
            {cleanupList.length > 0 ? (
              <div className="w-full py-2">
                <div className="mb-2 text-[12px] text-slate-600">
                  {t("settings:cleanupConfirm.showFirst", { count: 200 })}
                </div>
                <div className="w-full">
                  {cleanupList.map((item) => (
                    <div key={item.filePath} className="flex items-start gap-3 border-b py-1 last:border-b-0">
                      <div className="flex w-12 flex-shrink-0 items-center justify-center text-[12px] text-slate-600">
                        {typeof item.sizeKB === "number" ? `${item.sizeKB} KB` : "—"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm" title={item.rawDate || item.title}>
                          {item.rawDate || item.title}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-slate-500" title={item.filePath}>
                          {item.filePath}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-4 text-slate-500">{t("settings:cleanupConfirm.empty")}</div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={cleanupRunning}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="secondary"
              className="border border-red-200 text-red-600 hover:bg-red-50 dark:border-[var(--cf-red-light)] dark:text-[var(--cf-red)] dark:hover:bg-[var(--cf-red-light)]"
              disabled={cleanupList.length === 0 || cleanupRunning}
              onClick={() => {
                if (cleanupList.length === 0 || cleanupRunning) return;
                setCleanupWarningOpen(true);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" /> {t("settings:cleanupConfirm.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={cleanupWarningOpen} onOpenChange={setCleanupWarningOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings:cleanupConfirm.warningTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            {t("settings:cleanupConfirm.warningDesc", { count: cleanupList.length })}
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setCleanupWarningOpen(false)} disabled={cleanupRunning}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="secondary"
              className="border border-red-200 text-red-600 hover:bg-red-50 dark:border-[var(--cf-red-light)] dark:text-[var(--cf-red)] dark:hover:bg-[var(--cf-red-light)]"
              disabled={cleanupRunning}
              onClick={handleCleanupExecute}
            >
              <Trash2 className="mr-2 h-4 w-4" /> {t("settings:cleanupConfirm.warningConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={cleanupFeedback.open} onOpenChange={(openState) => setCleanupFeedback((prev) => ({ ...prev, open: openState }))}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {cleanupFeedback.isError
                ? t("settings:cleanupConfirm.batchDeleteFailed")
                : t("settings:historyCleanup.resultTitle")}
            </DialogTitle>
          </DialogHeader>
          {cleanupFeedback.message && (
            <p className={cn("text-sm", cleanupFeedback.isError ? "text-red-600" : "text-slate-600")}>
              {cleanupFeedback.message}
            </p>
          )}
          <div className="flex justify-end pt-4">
            <Button onClick={() => setCleanupFeedback((prev) => ({ ...prev, open: false }))}>
              {t("common:ok")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

export default SettingsDialog;
