// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownHooks, type ExtraProps, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { rehypePrettyCode } from "rehype-pretty-code";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type HistoryMarkdownProps = {
  /** 原始文本（通常为 history item 的 text）。 */
  text: string;
  /** 额外 className（会合并到容器上）。 */
  className?: string;
  /** 当前历史详情所属项目根目录（Windows 路径）。 */
  projectRootPath?: string;
};

type ResolvedHistoryLocalLink = {
  /** 原始可读路径（保留 `:line` 等信息，供右键复制）。 */
  rawPath: string;
  /** 实际用于系统打开的路径（去掉行号等后缀）。 */
  openPath: string;
  /** 行号（可选，1-based）。 */
  line?: number;
  /** 列号（可选，1-based）。 */
  column?: number;
};

type HistoryMarkdownLocalPathMenuState = {
  open: boolean;
  x: number;
  y: number;
  link: ResolvedHistoryLocalLink | null;
};

type HistoryMarkdownLinkMenuContextValue = {
  /** 打开本地路径右键菜单。 */
  openLocalPathMenu: (e: React.MouseEvent<HTMLAnchorElement>, link: ResolvedHistoryLocalLink) => void;
  /** 当前历史详情所属项目根目录（可选）。 */
  projectRootPath?: string;
};

const HistoryMarkdownLinkMenuContext = React.createContext<HistoryMarkdownLinkMenuContextValue | null>(null);

type HistoryBuiltinIdeId = "vscode" | "cursor" | "windsurf" | "rider";

type HistoryProjectIdeConfig = {
  mode: "builtin" | "custom";
  builtinId?: HistoryBuiltinIdeId;
  customName?: string;
  customCommand?: string;
};

type HistoryGlobalIdeConfig = {
  mode: "auto" | "builtin" | "custom";
  builtinId?: HistoryBuiltinIdeId;
  customName?: string;
  customCommand?: string;
};

const CODE_BLOCK_CLASS_NAME =
  "overflow-x-auto rounded-apple bg-[var(--cf-surface-muted)] border border-[var(--cf-border)] p-3 text-xs text-[var(--cf-text-primary)] font-mono shadow-apple-inner";

const INLINE_CODE_CLASS_NAME =
  "rounded-apple-sm bg-[var(--cf-surface-muted)] px-1.5 py-0.5 text-[0.85em] text-[var(--cf-text-primary)] font-mono break-all [overflow-wrap:anywhere]";

/**
 * 中文说明：判断当前行是否为 fenced code block 的起止行（``` 或 ~~~）。
 */
function parseFenceLine(line: string): { marker: "`" | "~"; size: number } | null {
  const m = line.match(/^(\s*)(`{3,}|~{3,})/);
  if (!m) return null;
  const fence = m[2] || "";
  const marker = fence[0] === "~" ? "~" : "`";
  return { marker, size: fence.length };
}

/**
 * 中文说明：修复 LLM 常见的“1) xxx”有序列表写法，转换为 Markdown 可识别的“1. xxx”。
 */
function fixBrokenOrderedListLine(line: string): string {
  return line.replace(/^(\s*)(\d+)\)\s+/, "$1$2. ");
}

/**
 * 中文说明：对普通文本片段做 Windows 路径反斜杠转义，避免出现 `\_` 被解析为转义从而丢失路径分隔符。
 */
function escapeWindowsPathsInTextSegment(segment: string): string {
  if (!segment.includes("\\")) return segment;
  // 规则：对可能是 Windows 路径/UNC 路径的片段，将 `\` 转为 `\\`（让 Markdown 最终渲染为单个反斜杠）。
  const re = /(?:[A-Za-z]:\\|\\\\)[^\s]+/g;
  return segment.replace(re, (m) => m.replace(/\\/g, "\\\\"));
}

/**
 * 中文说明：仅在非行内代码区域中转义 Windows 路径，避免影响 `inline code` 的原始内容。
 */
function escapeWindowsPathsOutsideInlineCode(line: string): string {
  if (!line.includes("\\")) return line;
  if (!line.includes("`")) return escapeWindowsPathsInTextSegment(line);

  let out = "";
  let cursor = 0;
  let inInlineCode = false;
  let inlineFenceSize = 0;

  while (cursor < line.length) {
    const bt = line.indexOf("`", cursor);
    if (bt === -1) {
      const tail = line.slice(cursor);
      out += inInlineCode ? tail : escapeWindowsPathsInTextSegment(tail);
      break;
    }

    const before = line.slice(cursor, bt);
    out += inInlineCode ? before : escapeWindowsPathsInTextSegment(before);

    let j = bt;
    while (j < line.length && line[j] === "`") j += 1;
    const run = line.slice(bt, j);
    out += run;

    if (!inInlineCode) {
      inInlineCode = true;
      inlineFenceSize = run.length;
    } else if (run.length === inlineFenceSize) {
      inInlineCode = false;
      inlineFenceSize = 0;
    }

    cursor = j;
  }

  return out;
}

/**
 * 中文说明：对历史详情中的文本做 Markdown 渲染前的轻量修复：
 * - 修复“1) ”有序列表写法为“1. ”，避免解析失败；
 * - 对非代码区域中的 Windows 路径做反斜杠转义，避免 `\_` 导致路径分隔符丢失。
 */
export function preprocessHistoryMarkdown(text: string): string {
  const src = String(text ?? "");
  if (!src) return "";

  const normalized = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const out: string[] = [];
  let inFence = false;
  let fenceMarker: "`" | "~" = "`";
  let fenceSize = 3;

  for (const rawLine of lines) {
    const line = String(rawLine ?? "");
    const fence = parseFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence.marker;
        fenceSize = fence.size;
        out.push(line);
        continue;
      }
      if (inFence && fence.marker === fenceMarker && fence.size >= fenceSize) {
        inFence = false;
        out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const fixedList = fixBrokenOrderedListLine(line);
    const escapedPaths = escapeWindowsPathsOutsideInlineCode(fixedList);
    out.push(escapedPaths);
  }

  return out.join("\n");
}

type MarkdownAnchorProps = React.ComponentPropsWithoutRef<"a"> & ExtraProps;
type MarkdownPreProps = React.ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownCodeProps = React.ComponentPropsWithoutRef<"code"> & ExtraProps;
type MarkdownTableProps = React.ComponentPropsWithoutRef<"table"> & ExtraProps;

/**
 * 中文说明：安全解码 href（仅解码一次；解码失败时返回原值）。
 */
function decodeHrefSafely(href: string): string {
  const raw = String(href || "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 中文说明：将 file:// URI 规范化为系统路径字符串（Windows 盘符/UNC/POSIX）。
 */
function normalizeFileUriToPath(uri: string): string {
  const raw = String(uri || "").trim();
  if (!/^file:/i.test(raw)) return raw;

  try {
    const normalized = raw.replace(/\\/g, "/");
    const u = new URL(normalized);
    if (u.protocol !== "file:") return raw;

    const host = decodeURIComponent(u.host || "");
    const pathname = decodeURIComponent(u.pathname || "");
    const hash = String(u.hash || "");
    const driveMatch = pathname.match(/^\/([a-zA-Z]):\/(.*)$/);
    if (driveMatch) {
      const drive = driveMatch[1].toUpperCase();
      const rest = (driveMatch[2] || "").replace(/\//g, "\\");
      return `${drive}:\\${rest}${hash}`;
    }
    if (host) {
      const body = pathname.replace(/^\/+/, "").replace(/\//g, "\\");
      return `\\\\${host}${body ? `\\${body}` : ""}${hash}`;
    }
    return `${pathname || raw}${hash}`;
  } catch {
    const fallback = raw.slice(5).replace(/^[\\/]+/, "");
    if (/^[a-zA-Z]:/.test(fallback)) return fallback.replace(/\//g, "\\");
    return fallback ? fallback.replace(/\//g, "\\") : raw;
  }
}

/**
 * 中文说明：判断字符串是否为本地绝对路径（Windows/UNC/POSIX）。
 */
function isLocalAbsolutePath(value: string): boolean {
  const s = String(value || "").trim();
  if (!s) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^\\\\[^\\]+\\[^\\]+/.test(s)) return true;
  if (s.startsWith("/")) return true;
  return false;
}

/**
 * 中文说明：去掉路径中的 query 参数，保留 hash（因为 hash 可能承载行号信息）。
 */
function stripPathQuery(value: string): string {
  const s = String(value || "").trim();
  if (!s) return "";
  const qIdx = s.indexOf("?");
  if (qIdx < 0) return s;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0 && hashIdx > qIdx) return `${s.slice(0, qIdx)}${s.slice(hashIdx)}`;
  return s.slice(0, qIdx);
}

/**
 * 中文说明：将文本中的数字串安全转换为正整数。
 */
function toPositiveInt(value: string | undefined): number | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * 中文说明：从路径后缀中解析行列信息（支持 `:line:column` 与 `#Lxx`），并返回可打开路径。
 */
function parseLocalPathPosition(value: string): { openPath: string; line?: number; column?: number } {
  const s = String(value || "").trim();
  if (!s) return { openPath: "" };

  const hashLineMatch = s.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (hashLineMatch) {
    const openPath = String(hashLineMatch[1] || "");
    if (!isLocalAbsolutePath(openPath)) return { openPath: s };
    return {
      openPath,
      line: toPositiveInt(hashLineMatch[2]),
      column: toPositiveInt(hashLineMatch[3]),
    };
  }

  const hashNumericMatch = s.match(/^(.*)#(\d+)(?::(\d+))?$/);
  if (hashNumericMatch) {
    const openPath = String(hashNumericMatch[1] || "");
    if (!isLocalAbsolutePath(openPath)) return { openPath: s };
    return {
      openPath,
      line: toPositiveInt(hashNumericMatch[2]),
      column: toPositiveInt(hashNumericMatch[3]),
    };
  }

  const suffixMatch = s.match(/:(\d+)(?::(\d+))?$/);
  if (suffixMatch) {
    const idx = typeof suffixMatch.index === "number" ? suffixMatch.index : -1;
    const openPath = idx >= 0 ? s.slice(0, idx) : "";
    if (!isLocalAbsolutePath(openPath)) return { openPath: s };
    return {
      openPath,
      line: toPositiveInt(suffixMatch[1]),
      column: toPositiveInt(suffixMatch[2]),
    };
  }

  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    const noHash = s.slice(0, hashIdx);
    if (isLocalAbsolutePath(noHash)) return { openPath: noHash };
  }

  return { openPath: s };
}

/**
 * 中文说明：解析历史 Markdown 链接为“可复制路径 + 可打开路径”；非本地路径返回 null。
 */
export function resolveHistoryLocalPathLink(href: string | null | undefined): ResolvedHistoryLocalLink | null {
  const rawHref = String(href || "").trim();
  if (!rawHref) return null;
  if (rawHref.startsWith("#")) return null;

  const decoded = decodeHrefSafely(rawHref);
  const candidate = /^file:/i.test(decoded) ? normalizeFileUriToPath(decoded) : decoded;
  const rawPath = stripPathQuery(candidate);
  const parsed = parseLocalPathPosition(rawPath);
  const openPath = String(parsed.openPath || "").trim();
  if (!isLocalAbsolutePath(openPath)) return null;
  return { rawPath, openPath, line: parsed.line, column: parsed.column };
}

/**
 * 中文说明：归一化内置 IDE 标识，非法时返回 null。
 */
function normalizeHistoryBuiltinIdeId(raw: unknown): HistoryBuiltinIdeId | null {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "vscode" || value === "cursor" || value === "windsurf" || value === "rider") {
    return value as HistoryBuiltinIdeId;
  }
  return null;
}

/**
 * 中文说明：归一化项目级 IDE 配置（兼容旧版仅 ideId 的返回结构）。
 */
function normalizeHistoryProjectIdeConfig(raw: unknown): HistoryProjectIdeConfig | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const builtinId = normalizeHistoryBuiltinIdeId(raw);
    return builtinId ? { mode: "builtin", builtinId } : null;
  }
  const obj = raw && typeof raw === "object" ? (raw as any) : null;
  if (!obj) return null;
  const modeRaw = String(obj.mode || "").trim().toLowerCase();
  const builtinId = normalizeHistoryBuiltinIdeId(obj.builtinId ?? obj.ideId);
  const customName = String(obj.customName || "").trim();
  const customCommand = String(obj.customCommand || "").trim();
  if (modeRaw === "builtin") return builtinId ? { mode: "builtin", builtinId } : null;
  if (modeRaw === "custom") return customCommand ? { mode: "custom", customName: customName || undefined, customCommand } : null;
  if (builtinId) return { mode: "builtin", builtinId };
  if (customCommand) return { mode: "custom", customName: customName || undefined, customCommand };
  return null;
}

/**
 * 中文说明：归一化全局默认 IDE 配置（只用于界面展示提示，不参与主流程判定）。
 */
function normalizeHistoryGlobalIdeConfig(raw: unknown): HistoryGlobalIdeConfig {
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  const modeRaw = String(obj.mode || "").trim().toLowerCase();
  const builtinId = normalizeHistoryBuiltinIdeId(obj.builtinId);
  const customName = String(obj.customName || "").trim();
  const customCommand = String(obj.customCommand || "").trim();
  if (modeRaw === "builtin") return { mode: "builtin", builtinId: builtinId || "cursor" };
  if (modeRaw === "custom") {
    if (!customCommand) return { mode: "auto" };
    return {
      mode: "custom",
      customName: customName || undefined,
      customCommand,
    };
  }
  return { mode: "auto" };
}

/**
 * 中文说明：跨平台复制文本（优先 Host API，失败回退浏览器剪贴板）。
 */
async function copyTextForHistoryLocalPath(text: string): Promise<boolean> {
  const value = String(text || "").trim();
  if (!value) return false;
  try {
    const res: any = await (window as any)?.host?.utils?.copyText?.(value);
    if (res && res.ok) return true;
  } catch {}
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {}
  return false;
}

/**
 * 中文说明：将路径转换为当前系统可直接粘贴使用的格式（Windows 下优先盘符路径）。
 */
async function normalizePathForHistoryCopy(pathText: string): Promise<string> {
  const raw = String(pathText || "").trim();
  if (!raw) return "";
  try {
    const res: any = await (window as any)?.host?.utils?.normalizePathForClipboard?.(raw);
    const next = res && res.ok ? String(res.path || "").trim() : "";
    if (next) return next;
  } catch {}
  if (typeof navigator !== "undefined" && /^win/i.test(String(navigator.platform || ""))) {
    const m = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (m) return `${m[1].toUpperCase()}:\\${String(m[2] || "").replace(/\//g, "\\")}`;
    const d = raw.match(/^([a-zA-Z]):\/(.*)$/);
    if (d) return `${d[1].toUpperCase()}:\\${String(d[2] || "").replace(/\//g, "\\")}`;
  }
  return raw;
}

/**
 * 中文说明：按“路径+行列”打开本地文件（优先定位打开，失败后回退普通打开）。
 */
async function openHistoryLocalPath(link: ResolvedHistoryLocalLink, projectRootPath?: string): Promise<boolean> {
  const p = String(link?.openPath || "").trim();
  if (!p) return false;
  const line = typeof link?.line === "number" && link.line > 0 ? Math.floor(link.line) : undefined;
  const column = typeof link?.column === "number" && link.column > 0 ? Math.floor(link.column) : undefined;
  const projectPath = String(projectRootPath || "").trim();
  if (line) {
    try {
      const res: any = await (window as any)?.host?.utils?.openPathAtPosition?.(p, { line, column, projectPath });
      if (res && res.ok) return true;
    } catch {}
  }
  try {
    const res: any = await (window as any)?.host?.utils?.openPath?.(p);
    if (res && res.ok) return true;
  } catch {}
  try {
    const res: any = await (window as any)?.host?.utils?.showInFolder?.(p);
    if (res && res.ok) return true;
  } catch {}
  return false;
}

/**
 * 中文说明：Markdown 链接渲染，默认走 Host API 打开外部链接，避免在 Electron 内部直接跳转。
 */
function MarkdownLink(props: MarkdownAnchorProps) {
  const { href, onClick, onContextMenu, ...rest } = props;
  const { t } = useTranslation(["history"]);
  const localLink = useMemo(() => resolveHistoryLocalPathLink(String(href || "")), [href]);
  const menuCtx = useContext(HistoryMarkdownLinkMenuContext);
  return (
    <a
      {...rest}
      href={href}
      onContextMenu={async (e) => {
        try {
          if (onContextMenu) onContextMenu(e);
          if (e.defaultPrevented) return;
          if (!localLink) return;
          e.preventDefault();
          menuCtx?.openLocalPathMenu(e, localLink);
        } catch {}
      }}
      onClick={async (e) => {
        try {
          if (onClick) onClick(e);
          if (e.defaultPrevented) return;
          const url = String(href || "");
          if (!url) return;
          // 允许页面内锚点默认行为
          if (url.startsWith("#")) return;
          if (localLink) {
            e.preventDefault();
            const opened = await openHistoryLocalPath(localLink, menuCtx?.projectRootPath);
            if (!opened) {
              try { alert(String(t("history:cannotOpenDefault"))); } catch {}
            }
            return;
          }
          e.preventDefault();
          try {
            await window.host.utils.openExternalUrl(url);
          } catch {
            try {
              window.open(url, "_blank", "noopener,noreferrer");
            } catch {}
          }
        } catch {}
      }}
    />
  );
}

/**
 * 中文说明：Markdown 代码块容器渲染（统一应用滚动、背景、边框与字体样式）。
 */
function MarkdownPre(props: MarkdownPreProps) {
  const { className, ...rest } = props;
  return <pre {...rest} className={cn(CODE_BLOCK_CLASS_NAME, className)} />;
}

/**
 * 中文说明：Markdown code 渲染：尽量只对行内 code 追加样式，避免影响代码块的高亮结构。
 */
function MarkdownCode(props: MarkdownCodeProps) {
  const { className, ...rest } = props;
  // 经验规则：block code 通常带 className（language-xxx / shiki 等），行内 code 多数没有。
  const shouldStyleInline = !className;
  return <code {...rest} className={cn(shouldStyleInline ? INLINE_CODE_CLASS_NAME : "", className)} />;
}

/**
 * 中文说明：表格渲染时外层包一层横向滚动容器，避免撑破历史详情宽度。
 */
function MarkdownTable(props: MarkdownTableProps) {
  const { className, ...rest } = props;
  return (
    <div className="overflow-x-auto">
      <table {...rest} className={cn("w-full", className)} />
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
};

/**
 * 中文说明：历史详情专用 Markdown 渲染器。
 * - 采用 react-markdown 的 Hooks 版本以支持 async rehype（rehype-pretty-code）；
 * - 内置轻量预处理修复，尽量贴近 Cursor 插件的展示细节；
 * - 默认使用 prose 排版，并通过 data-history-search-scope 标记可搜索内容区域。
 */
export function HistoryMarkdown(props: HistoryMarkdownProps) {
  const { text, className, projectRootPath } = props;
  const { t } = useTranslation(["history"]);
  const [localPathMenu, setLocalPathMenu] = useState<HistoryMarkdownLocalPathMenuState>({
    open: false,
    x: 0,
    y: 0,
    link: null,
  });
  const [projectIdeDialogOpen, setProjectIdeDialogOpen] = useState(false);
  const [projectIdeLoading, setProjectIdeLoading] = useState(false);
  const [projectIdeMode, setProjectIdeMode] = useState<"builtin" | "custom">("builtin");
  const [projectIdeBuiltinId, setProjectIdeBuiltinId] = useState<HistoryBuiltinIdeId>("cursor");
  const [projectIdeCustomName, setProjectIdeCustomName] = useState("");
  const [projectIdeCustomCommand, setProjectIdeCustomCommand] = useState("");
  const [globalIdeConfig, setGlobalIdeConfig] = useState<HistoryGlobalIdeConfig>({ mode: "auto" });

  const processed = useMemo(() => preprocessHistoryMarkdown(text), [text]);
  const closeLocalPathMenu = useCallback(() => {
    setLocalPathMenu({ open: false, x: 0, y: 0, link: null });
  }, []);

  /**
   * 中文说明：打开本地路径右键菜单，并限制坐标在可视区域内，避免菜单溢出窗口。
   */
  const openLocalPathMenu = useCallback((e: React.MouseEvent<HTMLAnchorElement>, link: ResolvedHistoryLocalLink) => {
    const margin = 6;
    const menuWidth = 200;
    const menuHeight = String(projectRootPath || "").trim() ? 92 : 46;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
    const vh = typeof window !== "undefined" ? window.innerHeight : 1080;
    const x = Math.max(margin, Math.min(Math.round(e.clientX), Math.max(margin, vw - menuWidth - margin)));
    const y = Math.max(margin, Math.min(Math.round(e.clientY), Math.max(margin, vh - menuHeight - margin)));
    setLocalPathMenu({ open: true, x, y, link });
  }, [projectRootPath]);

  useEffect(() => {
    if (!localPathMenu.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLocalPathMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [localPathMenu.open, closeLocalPathMenu]);

  /**
   * 中文说明：复制菜单中的本地路径文本。
   */
  const copyLocalPathFromMenu = useCallback(async () => {
    const openPath = String(localPathMenu.link?.openPath || "").trim();
    const fallbackRaw = String(localPathMenu.link?.rawPath || "").trim();
    const sourcePath = openPath || fallbackRaw;
    if (!sourcePath) {
      closeLocalPathMenu();
      return;
    }
    const normalized = await normalizePathForHistoryCopy(sourcePath);
    await copyTextForHistoryLocalPath(normalized || sourcePath);
    closeLocalPathMenu();
  }, [localPathMenu.link?.openPath, localPathMenu.link?.rawPath, closeLocalPathMenu]);

  /**
   * 中文说明：打开“当前项目 IDE 设置”窗口，并加载项目绑定与全局默认配置。
   */
  const openProjectIdeDialogFromMenu = useCallback(async () => {
    const projectPath = String(projectRootPath || "").trim();
    closeLocalPathMenu();
    if (!projectPath) return;
    setProjectIdeDialogOpen(true);
    setProjectIdeLoading(true);
    try {
      const [projectRes, settingsRes] = await Promise.all([
        (window as any)?.host?.utils?.getProjectPreferredIde?.(projectPath),
        (window as any)?.host?.settings?.get?.(),
      ]);
      const projectConfig = normalizeHistoryProjectIdeConfig(projectRes?.config ?? projectRes?.ideId);
      if (projectConfig?.mode === "custom") {
        setProjectIdeMode("custom");
        setProjectIdeBuiltinId(normalizeHistoryBuiltinIdeId(projectConfig.builtinId) || "cursor");
        setProjectIdeCustomName(String(projectConfig.customName || ""));
        setProjectIdeCustomCommand(String(projectConfig.customCommand || ""));
      } else {
        setProjectIdeMode("builtin");
        setProjectIdeBuiltinId(normalizeHistoryBuiltinIdeId(projectConfig?.builtinId) || "cursor");
        setProjectIdeCustomName("");
        setProjectIdeCustomCommand("");
      }
      setGlobalIdeConfig(normalizeHistoryGlobalIdeConfig((settingsRes as any)?.ideOpen));
    } catch {
      setProjectIdeMode("builtin");
      setProjectIdeBuiltinId("cursor");
      setProjectIdeCustomName("");
      setProjectIdeCustomCommand("");
      setGlobalIdeConfig({ mode: "auto" });
      try { alert(String(t("history:projectIdeDialogLoadFailed"))); } catch {}
    } finally {
      setProjectIdeLoading(false);
    }
  }, [projectRootPath, closeLocalPathMenu, t]);

  /**
   * 中文说明：关闭“当前项目 IDE 设置”窗口，并清理加载状态。
   */
  const closeProjectIdeDialog = useCallback(() => {
    setProjectIdeDialogOpen(false);
    setProjectIdeLoading(false);
  }, []);

  /**
   * 中文说明：保存当前项目 IDE 绑定（内置或自定义）。
   */
  const saveProjectIdeFromDialog = useCallback(async () => {
    const projectPath = String(projectRootPath || "").trim();
    if (!projectPath) {
      closeProjectIdeDialog();
      return;
    }
    const config: HistoryProjectIdeConfig =
      projectIdeMode === "custom"
        ? {
            mode: "custom",
            customName: String(projectIdeCustomName || "").trim() || undefined,
            customCommand: String(projectIdeCustomCommand || "").trim(),
          }
        : {
            mode: "builtin",
            builtinId: projectIdeBuiltinId,
          };
    if (config.mode === "custom" && !String(config.customCommand || "").trim()) {
      try { alert(String(t("history:projectIdeDialogCommandRequired"))); } catch {}
      return;
    }
    try {
      const res: any = await (window as any)?.host?.utils?.setProjectPreferredIde?.(projectPath, config);
      if (!(res && res.ok)) throw new Error(res?.error || "setProjectPreferredIde failed");
      closeProjectIdeDialog();
    } catch {
      try { alert(String(t("history:projectIdeDialogSaveFailed"))); } catch {}
    }
  }, [
    projectRootPath,
    projectIdeMode,
    projectIdeBuiltinId,
    projectIdeCustomName,
    projectIdeCustomCommand,
    closeProjectIdeDialog,
    t,
  ]);

  /**
   * 中文说明：清除项目绑定，回退到全局默认 IDE 策略。
   */
  const clearProjectIdeBindingFromDialog = useCallback(async () => {
    const projectPath = String(projectRootPath || "").trim();
    if (!projectPath) {
      closeProjectIdeDialog();
      return;
    }
    try {
      const res: any = await (window as any)?.host?.utils?.setProjectPreferredIde?.(projectPath, null);
      if (!(res && res.ok)) throw new Error(res?.error || "clear project ide failed");
      closeProjectIdeDialog();
    } catch {
      try { alert(String(t("history:projectIdeDialogSaveFailed"))); } catch {}
    }
  }, [projectRootPath, closeProjectIdeDialog, t]);

  /**
   * 中文说明：将全局默认 IDE 配置转为可读提示文本。
   */
  const globalIdeSummaryText = useMemo(() => {
    if (globalIdeConfig.mode === "builtin") {
      const ide = globalIdeConfig.builtinId || "cursor";
      const label = ide === "vscode"
        ? t("history:linkMenuUseVsCode")
        : ide === "cursor"
          ? t("history:linkMenuUseCursor")
          : ide === "windsurf"
            ? t("history:linkMenuUseWindsurf")
            : t("history:linkMenuUseRider");
      return String(t("history:projectIdeDialogGlobalDefaultBuiltin", { ide: String(label) }));
    }
    if (globalIdeConfig.mode === "custom") {
      const name = String(globalIdeConfig.customName || "").trim() || String(t("history:projectIdeDialogModeCustom"));
      return String(t("history:projectIdeDialogGlobalDefaultCustom", { name }));
    }
    return String(t("history:projectIdeDialogGlobalDefaultAuto"));
  }, [globalIdeConfig, t]);

  const contextValue = useMemo<HistoryMarkdownLinkMenuContextValue>(
    () => ({ openLocalPathMenu, projectRootPath: String(projectRootPath || "").trim() || undefined }),
    [openLocalPathMenu, projectRootPath],
  );

  return (
    <>
      <HistoryMarkdownLinkMenuContext.Provider value={contextValue}>
        <div
          data-history-search-scope
          className={cn("prose prose-sm max-w-none dark:prose-invert cf-history-markdown", className)}
        >
          <MarkdownHooks
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[
              [
                rehypePrettyCode,
                {
                  // 说明：同时提供亮/暗主题，暗色模式通过 CSS 选择 --shiki-dark 覆盖 token 颜色。
                  theme: { light: "github-light", dark: "github-dark" },
                  keepBackground: false,
                  // 说明：默认按纯文本处理未标注语言的代码块，避免加载失败产生噪音日志
                  defaultLang: "plaintext",
                  // 说明：行内 code 通常更偏“强调/片段”，不做语法高亮可显著降低处理开销
                  bypassInlineCode: true,
                },
              ],
            ]}
            components={MARKDOWN_COMPONENTS}
            fallback={
              // 说明：异步高亮尚未完成时的兜底展示，尽量维持旧版“按换行展示”的直观效果。
              <div className="whitespace-pre-wrap break-words text-[var(--cf-text-primary)]">{text}</div>
            }
          >
            {processed}
          </MarkdownHooks>
        </div>
      </HistoryMarkdownLinkMenuContext.Provider>

      {localPathMenu.open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[1400]"
              onClick={closeLocalPathMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeLocalPathMenu();
              }}
            >
              <div
                className="absolute min-w-[160px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple shadow-apple-lg p-1.5 text-sm text-[var(--cf-text-primary)] dark:shadow-apple-dark-lg"
                style={{ left: localPathMenu.x, top: localPathMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={copyLocalPathFromMenu}
                >
                  {t("history:copyPath")}
                </button>
                {String(projectRootPath || "").trim() ? (
                  <>
                    <div className="my-1 h-px bg-[var(--cf-border)]" />
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                      onClick={() => { void openProjectIdeDialogFromMenu(); }}
                    >
                      {t("history:linkMenuSetProjectIde")}
                    </button>
                  </>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      {projectIdeDialogOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[1450] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-3"
              onClick={closeProjectIdeDialog}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div
                className="w-full max-w-[560px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] text-[var(--cf-text-primary)] shadow-apple-lg dark:shadow-apple-dark-lg"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-4 py-3 border-b border-[var(--cf-border)]">
                  <div className="text-sm font-semibold">{t("history:projectIdeDialogTitle")}</div>
                  <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">
                    {t("history:projectIdeDialogDesc")}
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{globalIdeSummaryText}</div>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <div className="text-xs text-[var(--cf-text-secondary)] mb-1.5">{t("history:projectIdeDialogModeLabel")}</div>
                    <div className="flex items-center gap-2">
                      <button
                        className={cn(
                          "px-3 py-1.5 rounded-apple-sm border text-xs transition-all duration-apple-fast",
                          projectIdeMode === "builtin"
                            ? "border-[var(--cf-accent)] bg-[var(--cf-accent)]/10 text-[var(--cf-accent)]"
                            : "border-[var(--cf-border)] hover:bg-[var(--cf-surface-hover)]",
                        )}
                        disabled={projectIdeLoading}
                        onClick={() => setProjectIdeMode("builtin")}
                      >
                        {t("history:projectIdeDialogModeBuiltin")}
                      </button>
                      <button
                        className={cn(
                          "px-3 py-1.5 rounded-apple-sm border text-xs transition-all duration-apple-fast",
                          projectIdeMode === "custom"
                            ? "border-[var(--cf-accent)] bg-[var(--cf-accent)]/10 text-[var(--cf-accent)]"
                            : "border-[var(--cf-border)] hover:bg-[var(--cf-surface-hover)]",
                        )}
                        disabled={projectIdeLoading}
                        onClick={() => setProjectIdeMode("custom")}
                      >
                        {t("history:projectIdeDialogModeCustom")}
                      </button>
                    </div>
                  </div>

                  {projectIdeMode === "builtin" ? (
                    <div>
                      <div className="text-xs text-[var(--cf-text-secondary)] mb-1.5">{t("history:projectIdeDialogBuiltinLabel")}</div>
                      <select
                        className="w-full h-9 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm outline-none focus:border-[var(--cf-accent)]"
                        value={projectIdeBuiltinId}
                        disabled={projectIdeLoading}
                        onChange={(e) => {
                          const next = normalizeHistoryBuiltinIdeId(e.target.value) || "cursor";
                          setProjectIdeBuiltinId(next);
                        }}
                      >
                        <option value="vscode">{t("history:linkMenuUseVsCode")}</option>
                        <option value="cursor">{t("history:linkMenuUseCursor")}</option>
                        <option value="windsurf">{t("history:linkMenuUseWindsurf")}</option>
                        <option value="rider">{t("history:linkMenuUseRider")}</option>
                      </select>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <div className="text-xs text-[var(--cf-text-secondary)] mb-1.5">{t("history:projectIdeDialogCustomNameLabel")}</div>
                        <input
                          className="w-full h-9 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm outline-none focus:border-[var(--cf-accent)]"
                          value={projectIdeCustomName}
                          disabled={projectIdeLoading}
                          placeholder={String(t("history:projectIdeDialogCustomNamePlaceholder"))}
                          onChange={(e) => setProjectIdeCustomName(e.target.value)}
                        />
                      </div>
                      <div>
                        <div className="text-xs text-[var(--cf-text-secondary)] mb-1.5">{t("history:projectIdeDialogCustomCommandLabel")}</div>
                        <input
                          className="w-full h-9 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm font-mono outline-none focus:border-[var(--cf-accent)]"
                          value={projectIdeCustomCommand}
                          disabled={projectIdeLoading}
                          placeholder={String(t("history:projectIdeDialogCustomCommandPlaceholder"))}
                          onChange={(e) => setProjectIdeCustomCommand(e.target.value)}
                        />
                        <div className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                          {t("history:projectIdeDialogCustomCommandHint")}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="px-4 py-3 border-t border-[var(--cf-border)] flex items-center justify-end gap-2">
                  <button
                    className="px-3 py-1.5 text-xs rounded-apple-sm border border-[var(--cf-border)] hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                    disabled={projectIdeLoading}
                    onClick={closeProjectIdeDialog}
                  >
                    {t("history:projectIdeDialogCancel")}
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs rounded-apple-sm border border-[var(--cf-border)] hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                    disabled={projectIdeLoading}
                    onClick={() => { void clearProjectIdeBindingFromDialog(); }}
                  >
                    {t("history:projectIdeDialogUseGlobal")}
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs rounded-apple-sm bg-[var(--cf-accent)] text-white hover:bg-[var(--cf-accent-hover)] transition-all duration-apple-fast disabled:opacity-60"
                    disabled={projectIdeLoading}
                    onClick={() => { void saveProjectIdeFromDialog(); }}
                  >
                    {t("history:projectIdeDialogSave")}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
