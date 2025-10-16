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
import { cn } from "@/lib/utils";
import { listAvailableLanguages, changeAppLanguage } from "@/i18n/setup";
import { CodexAccountInline } from "@/components/topbar/codex-status";
import { Trash2 } from "lucide-react";

type TerminalMode = "wsl" | "windows";
type SendMode = "write_only" | "write_and_enter";
type PathStyle = "absolute" | "relative";

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
  };
  onSave: (v: {
    terminal: TerminalMode;
    distro: string;
    codexCmd: string;
    sendMode: SendMode;
    locale: string;
    projectPathStyle: PathStyle;
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

type SectionKey = "basic" | "terminal" | "account" | "data";

const NAV_ORDER: SectionKey[] = ["basic", "terminal", "account", "data"];

const DEFAULT_LANGS = ["zh", "en"];

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
  const [codexRoots, setCodexRoots] = useState<string[]>([]);
  const [lang, setLang] = useState<string>(values.locale || "en");
  const [availableDistros, setAvailableDistros] = useState<string[]>([]);
  const [cleanupScanning, setCleanupScanning] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupList, setCleanupList] = useState<CleanupCandidate[]>([]);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleanupWarningOpen, setCleanupWarningOpen] = useState(false);
  const [cleanupFeedback, setCleanupFeedback] = useState<{ open: boolean; message: string; isError: boolean }>({ open: false, message: "", isError: false });
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    }
  }, [open, values.codexCmd, values.distro, values.locale, values.projectPathStyle, values.sendMode, values.terminal]);

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
                  <Input value={codexCmd} onChange={(event) => setCodexCmd(event.target.value)} />
                </CardContent>
              </Card>
            </div>
          ),
        };
      }
      if (key === "account") {
        return {
          key,
          title: t("settings:sections.account.title"),
          description: t("settings:sections.account.desc"),
          content: (
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
          </div>
        ),
      };
    });
  }, [availableDistros, availableLangs, cleanupResult, cleanupRunning, cleanupScanning, codexCmd, codexRoots, distro, labelOf, lang, pathStyle, sendMode, t, terminal]);

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
              {t("common:common.ok", "OK")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

export default SettingsDialog;
