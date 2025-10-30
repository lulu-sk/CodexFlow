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
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatBytes } from "@/lib/utils";
import { listAvailableLanguages, changeAppLanguage } from "@/i18n/setup";
import { CodexAccountInline } from "@/components/topbar/codex-status";
import { Trash2, Power, ChevronUp, ChevronDown } from "lucide-react";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  normalizeTerminalFontFamily,
  buildTerminalFontStack,
} from "@/lib/terminal-appearance";
import { resolveFirstAvailableFont, parseFontFamilyList } from "@/lib/font-utils";

type TerminalMode = "wsl" | "windows";
type SendMode = "write_only" | "write_and_enter";
type PathStyle = "absolute" | "relative";
type NotificationPrefs = {
  badge: boolean;
  system: boolean;
  sound: boolean;
};
type NetworkPrefs = {
  proxyEnabled: boolean;
  proxyMode: "system" | "custom";
  proxyUrl: string;
  noProxy: string;
};

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  values: {
    terminal: TerminalMode;
    distro: string;
    codexCmd: string;
    sendMode: SendMode;
    locale: string;
    projectPathStyle: PathStyle;
    notifications: NotificationPrefs;
    network?: NetworkPrefs;
    terminalFontFamily: string;
  };
  onSave: (v: {
    terminal: TerminalMode;
    distro: string;
    codexCmd: string;
    sendMode: SendMode;
    locale: string;
    projectPathStyle: PathStyle;
    notifications: NotificationPrefs;
    network: NetworkPrefs;
    terminalFontFamily: string;
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

type SectionKey = "basic" | "notifications" | "terminal" | "networkAccount" | "data";

const NAV_ORDER: SectionKey[] = ["basic", "notifications", "terminal", "networkAccount", "data"];

const DEFAULT_LANGS = ["zh", "en"];
// 移除推荐逻辑：仅保留纯字母序

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
  values,
  onSave,
}) => {
  const { t } = useTranslation(["settings", "common"]);
  const [activeSection, setActiveSection] = useState<SectionKey>("basic");
  const [availableLangs, setAvailableLangs] = useState<string[]>(DEFAULT_LANGS);
  const [terminal, setTerminal] = useState<TerminalMode>(values.terminal || "wsl");
  const [distro, setDistro] = useState<string>("");
  const [codexCmd, setCodexCmd] = useState(values.codexCmd);
  
  const [sendMode, setSendMode] = useState<SendMode>(values.sendMode);
  const [pathStyle, setPathStyle] = useState<PathStyle>(values.projectPathStyle || "absolute");
  const [notifications, setNotifications] = useState<NotificationPrefs>(values.notifications);
  const [network, setNetwork] = useState<NetworkPrefs>({
    proxyEnabled: values.network?.proxyEnabled ?? true,
    proxyMode: values.network?.proxyMode ?? "system",
    proxyUrl: values.network?.proxyUrl ?? "",
    noProxy: values.network?.noProxy ?? "",
  });
  const [codexRoots, setCodexRoots] = useState<string[]>([]);
  const [lang, setLang] = useState<string>(values.locale || "en");
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
  const [storagePurgeConfirmOpen, setStoragePurgeConfirmOpen] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const [storageError, setStorageError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const storageLoadedRef = useRef(false);

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

  useEffect(() => {
    setCodexCmd(values.codexCmd);
    setTerminal(values.terminal || "wsl");
    if (open) {
      setDistro(values.distro || "");
      setSendMode(values.sendMode || "write_and_enter");
      setPathStyle(values.projectPathStyle || "absolute");
      setLang(values.locale || "en");
      setNotifications(values.notifications);
      setNetwork({
        proxyEnabled: values.network?.proxyEnabled ?? true,
        proxyMode: values.network?.proxyMode ?? "system",
        proxyUrl: values.network?.proxyUrl ?? "",
        noProxy: values.network?.noProxy ?? "",
      });
      setTerminalFontFamily(normalizeTerminalFontFamily(values.terminalFontFamily));
    }
  }, [open, values.codexCmd, values.distro, values.locale, values.notifications, values.projectPathStyle, values.sendMode, values.terminal, values.terminalFontFamily]);

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
        const roots = await (window.host.settings as any).codexRoots?.();
        if (Array.isArray(roots)) {
          setCodexRoots(roots);
        }
      } catch {
        setCodexRoots([]);
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
          const preferred = values.distro && names.includes(values.distro) ? values.distro : names[names.length - 1] || "";
          if (!distro && preferred) {
            setDistro(preferred);
          }
        }
      } catch {
        setAvailableDistros([]);
      }
    })();
  }, [open, distro, values.distro]);

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
      const res: any = await api({ preserveSettings: true });
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
  }, [refreshAppDataInfo, t]);

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
                  <p className="text-sm text-slate-500">{t("settings:notifications.help")}</p>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                      checked={notifications.badge}
                      onChange={(event) => {
                        const next = { ...notifications, badge: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800">
                        {t("settings:notifications.badge.label")}
                      </div>
                      <p className="text-xs text-slate-500">
                        {t("settings:notifications.badge.desc")}
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                      checked={notifications.system}
                      onChange={(event) => {
                        const next = { ...notifications, system: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800">
                        {t("settings:notifications.system.label")}
                      </div>
                      <p className="text-xs text-slate-500">
                        {t("settings:notifications.system.desc")}
                      </p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                      checked={notifications.sound}
                      onChange={(event) => {
                        const next = { ...notifications, sound: event.target.checked };
                        setNotifications(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium text-slate-800">
                        {t("settings:notifications.sound.label")}
                      </div>
                      <p className="text-xs text-slate-500">
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
                  <CardTitle>{t("settings:terminalMode.label")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:terminalMode.help")}</p>
                  <div className="max-w-xs">
                    <Select value={terminal} onValueChange={(v) => setTerminal(v as TerminalMode)}>
                      <SelectTrigger>
                        <span className="truncate text-left">
                          {terminal === "windows"
                            ? t("settings:terminalMode.windows")
                            : t("settings:terminalMode.wsl")}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wsl">{t("settings:terminalMode.wsl")}</SelectItem>
                        <SelectItem value="windows">{t("settings:terminalMode.windows")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
              {terminal === "wsl" && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t("settings:wslDistro")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-slate-500">{t("settings:wslDistroHelp")}</p>
                    <div className="max-w-xs">
                      <Select value={distro} onValueChange={setDistro}>
                        <SelectTrigger>
                          <SelectValue placeholder={t("settings:terminalPlaceholder") as string} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableDistros.length > 0 ? (
                            availableDistros.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="">{t("settings:noTerminalDetected")}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardHeader>
                  <CardTitle>{t("settings:codexCmd")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-slate-500">{t("settings:codexCmdHelp")}</p>
                  <Input value={codexCmd} onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setCodexCmd((event.target as any).value)} />
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
                      className="rounded-lg bg-slate-900 px-4 py-3 font-mono text-xs text-slate-100 overflow-x-auto"
                      style={{ fontFamily: terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY }}
                    >
                      {t("settings:terminalFont.preview")}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {resolvedPreviewFont.isFallback
                        ? t("settings:terminalFont.fallback", { name: resolvedPreviewFont.name })
                        : t("settings:terminalFont.effective", { name: resolvedPreviewFont.name })}
                    </div>
                  </div>
                  
                  {/* 单一选择器：仅显示“已安装”字体；推荐项置顶并标注“推荐” */}
                  <div className="max-w-xs space-y-2">
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
                              className="inline-flex w-full flex-1 items-center justify-center bg-white text-slate-700 hover:bg-slate-50"
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
                                } catch {}
                              }}
                            >
                              <ChevronUp className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              className="inline-flex w-full flex-1 items-center justify-center bg-white text-slate-700 hover:bg-slate-50"
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
                                } catch {}
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
                  <p className="text-sm text-slate-500">{t("settings:network.desc")}</p>
                  <div className="flex flex-col gap-3 max-w-xl">
                    <label className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-3 shadow-sm">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                        checked={network.proxyEnabled}
                        onChange={(e) => setNetwork((v) => ({ ...v, proxyEnabled: e.target.checked }))}
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-800">{t("settings:network.enable")}</div>
                        <p className="text-xs text-slate-500">{t("settings:network.enableDesc")}</p>
                      </div>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-center">
                      <div className="text-sm text-slate-700">{t("settings:network.mode")}</div>
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
                      <div className="text-sm text-slate-700">{t("settings:network.customUrl")}</div>
                      <Input
                        disabled={!network.proxyEnabled || network.proxyMode !== "custom"}
                        value={network.proxyUrl}
                        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setNetwork((s) => ({ ...s, proxyUrl: (e.target as any).value }))}
                        placeholder="http://127.0.0.1:7890"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[180px_1fr] items-center">
                      <div className="text-sm text-slate-700">{t("settings:network.noProxy")}</div>
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
                    terminalMode={terminal}
                    distro={terminal === "wsl" ? distro : undefined}
                    expanded
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
                {codexRoots.length > 0 ? (
                  <div className="max-h-48 overflow-auto rounded border bg-slate-50 p-2 text-xs">
                    <ul className="space-y-1">
                      {codexRoots.map((root) => (
                        <li key={root} className="truncate" title={root}>
                          {root}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400">{t("settings:codexRoots.empty")}</div>
                )}
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
                    className="border border-red-200 text-red-600 hover:bg-red-50"
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
                    className="border border-amber-200 text-amber-600 hover:bg-amber-50"
                    disabled={storageLoading || storageClearing || storagePurging}
                    onClick={() => setStorageConfirmOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />{" "}
                    {storageClearing ? t("settings:appData.cleaning") : t("settings:appData.clean")}
                  </Button>
                  <Button
                    variant="default"
                    className="bg-red-600 hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500"
                    disabled={storagePurging || storageClearing}
                    onClick={() => setStoragePurgeConfirmOpen(true)}
                  >
                    <Power className="mr-2 h-4 w-4" />{" "}
                    {storagePurging ? t("settings:appData.fullPurging") : t("settings:appData.fullPurge")}
                  </Button>
                </div>
                {storageError && <div className="text-sm text-red-600">{storageError}</div>}
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
                      } catch {}
                    }}
                  >
                    {t("settings:debug.open")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try { await (window as any).host?.debug?.reset?.(); } catch {}
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
    availableDistros,
    availableLangs,
    cleanupResult,
    cleanupRunning,
    cleanupScanning,
    codexCmd,
    codexRoots,
    // 字体与显示相关依赖，确保“显示所有字体”等交互即时生效
    installedFonts,
    monospaceFonts,
    installedLoading,
    showAllFonts,
    distro,
    labelOf,
    lang,
    pathStyle,
    notifications,
    network,
    sendMode,
    storageInfo,
    storageLoading,
    storageClearing,
    storagePurging,
    storageError,
    refreshAppDataInfo,
    t,
    terminal,
    terminalFontFamily,
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

  const renderNavigation = () => (
    <nav className="flex shrink-0 basis-56 flex-col gap-1 py-2 pr-4">
      {sections.map((section) => (
        <button
          key={section.key}
          type="button"
          className={cn(
            "flex flex-col items-start rounded-lg border border-transparent px-3 py-2 text-left transition-colors",
            activeSection === section.key
              ? "border-slate-300 bg-slate-100 text-slate-900 shadow-sm"
              : "hover:bg-slate-50 text-slate-600"
          )}
          onClick={() => {
            setActiveSection(section.key);
          }}
        >
          <span className="text-sm font-medium">{section.title}</span>
          <span className="mt-0.5 text-xs text-slate-500 line-clamp-2">
            {section.description}
          </span>
        </button>
      ))}
    </nav>
  );

  const active = sections.find((section) => section.key === activeSection) ?? sections[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[90vw] overflow-hidden">
        <DialogHeader className="pb-4">
          <DialogTitle>{t("settings:title")}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[520px] max-h-[70vh] gap-6">
          {renderNavigation()}
          <Separator orientation="vertical" />
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-col gap-1 pb-4">
              <h2 className="text-lg font-semibold text-slate-900">{active.title}</h2>
              <p className="text-sm text-slate-500">{active.description}</p>
            </div>
            <ScrollArea className="flex-1">
              <div ref={scrollRef} className="pr-4">
                <div className="pb-6">
                  {active.content}
                </div>
              </div>
            </ScrollArea>
            <div className="flex items-center justify-between border-t pt-4">
              <div className="text-xs text-slate-400">
                {t("settings:footer.note")}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t("common:cancel")}
                </Button>
                <Button
                  onClick={() => {
                    onSave({
                      terminal,
                      distro: distro || values.distro || "",
                      codexCmd,
                      sendMode,
                      locale: lang,
                      projectPathStyle: pathStyle,
                      notifications,
                      network,
                      terminalFontFamily: normalizeTerminalFontFamily(terminalFontFamily),
                    });
                    onOpenChange(false);
                  }}
                >
                  {t("common:save")}
                </Button>
              </div>
            </div>
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
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setStorageConfirmOpen(false)} disabled={storageClearing}>
              {t("common:cancel")}
            </Button>
            <Button
              variant="secondary"
              className="border border-amber-200 text-amber-600 hover:bg-amber-50"
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
              className="bg-red-500 text-white hover:bg-red-600"
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
              className="border border-red-200 text-red-600 hover:bg-red-50"
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
              className="border border-red-200 text-red-600 hover:bg-red-50"
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
