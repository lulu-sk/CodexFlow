// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PathChipsInput, { type PathChip } from "@/components/ui/path-chips-input";
import { retainPreviewUrl, releasePreviewUrl } from "@/lib/previewUrlRegistry";
import { retainPastedImage, releasePastedImage, requestTrashWinPath } from "@/lib/imageResourceRegistry";

// 发送命令后延迟清理粘贴图片 3 分钟，避免命令执行期间文件提前被删除
const CHIP_COMMIT_RELEASE_DELAY_MS = 180_000;
import { setActiveFileIndexRoot } from "@/lib/atSearch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
} from "lucide-react";
import AboutSupport from "@/components/about-support";
import CodexUsageSummary from "@/components/topbar/codex-status";
import { emitCodexRateRefresh } from "@/lib/codex-status";
import { checkForUpdate, type UpdateCheckErrorType } from "@/lib/about";
import TerminalManager from "@/lib/TerminalManager";
import { oscBufferDefaults, trimOscBuffer } from "@/lib/oscNotificationBuffer";
import HistoryCopyButton from "@/components/history/history-copy-button";
import { toWSLForInsert } from "@/lib/wsl";
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
import { getCachedThemeSetting, useThemeController, writeThemeSettingCache, type ThemeSetting } from "@/lib/theme";
import type { AppSettings, Project } from "@/types/host";
import type { TerminalThemeId } from "@/types/terminal-theme";

// ---------- Types ----------

type TerminalMode = NonNullable<AppSettings["terminal"]>;
type ConsoleTab = {
  id: string;
  name: string;
  logs: string[]; // kept for visual compatibility; no longer used once terminal mounts
  createdAt: number;
};

// 渲染端消息内容，支持可选 tags（用于嵌套类型筛选，如 message.input_text）
type MessageContent = { type: string; text: string; tags?: string[] };
type HistoryMessage = { role: string; content: MessageContent[] };
type HistorySession = {
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
  startupCmd: string;
  session?: HistorySession;
  resumePath: string;
  sessionId: string | null;
  strategy: ResumeStrategy;
  resumeHint: 'modern' | 'legacy';
  forceLegacyCli: boolean;
};
type InputFullscreenCloseOptions = { immediate?: boolean };

// 项目排序设置在本地存储中的键（命名空间化）
const PROJECT_SORT_STORAGE_KEY = "codexflow.projectSort";
// 全屏输入层动画时长（毫秒），需与 CSS 关键帧保持一致
const INPUT_FULLSCREEN_TRANSITION_MS = 260;
type ProjectSortKey = "recent" | "name";

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
  sound: false,
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

const mockProjects: Project[] = [
  {
    id: uid(),
    name: "web-admin",
    winPath: "C:\\\\Users\\you\\code\\web-admin",
    wslPath: "/mnt/c/Users/you/code/web-admin",
    hasDotCodex: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 30,
    lastOpenedAt: Date.now() - 1000 * 60 * 60 * 2,
  },
  {
    id: uid(),
    name: "ml-pipeline",
    winPath: "D:\\\\work\\ml-pipeline",
    wslPath: "/mnt/d/work/ml-pipeline",
    hasDotCodex: true,
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    lastOpenedAt: Date.now() - 1000 * 60 * 30,
  },
  {
    id: uid(),
    name: "notes",
    winPath: "C:\\\\Users\\you\\notes",
    wslPath: "/mnt/c/Users/you/notes",
    hasDotCodex: false,
    createdAt: Date.now() - 1000 * 60 * 60 * 10,
    lastOpenedAt: Date.now() - 1000 * 60 * 10,
  },
];

const mockHistory: Record<string, HistorySession[]> = {
  // keyed by projectId
};

// Seed some history per project
for (const p of mockProjects) {
  mockHistory[p.id] = [
    {
      id: uid(),
      title: `Refactor ${p.name} auth flow`,
      date: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      messages: [
        { role: "user", content: [{ type: 'text', text: "帮我把登录后的重定向逻辑抽出来，做成中间件。" }] },
        {
          role: "assistant",
          content: [
            { type: 'text', text: "可以抽象为 `ensureAuthed` 中间件，在路由进入前检查 token 并统一处理 302...（示例仅展示，UI 只读）" }
          ],
        },
        { role: "user", content: [{ type: 'text', text: "给我一个 react-router 的实现示例。" }] },
        { role: "assistant", content: [{ type: 'text', text: "示例代码略（这里仅做历史 UI 展示）。" }] },
      ],
    },
    {
      id: uid(),
      title: `Optimize ${p.name} build size`,
      date: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
      messages: [
        { role: "user", content: [{ type: 'text', text: "如何去掉 moment 的多语言包？" }] },
        { role: "assistant", content: [{ type: 'text', text: "使用 webpack IgnorePlugin 或 dayjs 替代。" }] },
      ],
    },
  ];
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const visibleProjects = useMemo(
    () => projects.filter((p) => !hiddenProjectIds.includes(p.id)),
    [projects, hiddenProjectIds]
  );
  const selectedProject = useMemo(
    () => visibleProjects.find((p) => p.id === selectedProjectId) || null,
    [visibleProjects, selectedProjectId]
  );
  const [projectSort, setProjectSort] = useState<ProjectSortKey>(() => {
    if (typeof window === "undefined") return "recent";
    try {
      const saved = window.localStorage?.getItem(PROJECT_SORT_STORAGE_KEY);
      if (saved === "recent" || saved === "name") return saved;
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
    list.sort((a, b) => {
      if (projectSort === "name") return compareByName(a, b);
      const recentDiff = getRecentTimestamp(b) - getRecentTimestamp(a);
      if (recentDiff !== 0) return recentDiff;
      return compareByName(a, b);
    });
    return list;
  }, [visibleProjects, projectSort]);
  const handleProjectSortChange = useCallback((value: string) => {
    if (value === "recent" || value === "name") {
      setProjectSort(value);
    }
  }, []);
  const projectSortLabel = useMemo(() => {
    if (projectSort === "name") return t("projects:sortName") as string;
    return t("projects:sortRecent") as string;
  }, [projectSort, t]);

  useEffect(() => {
    if (hiddenProjectIds.length === 0) return;
    setProjects((prev) => prev.filter((p) => !hiddenProjectIds.includes(p.id)));
  }, [hiddenProjectIds]);

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
  const [tabsByProject, setTabsByProject] = useState<Record<string, ConsoleTab[]>>({});
  const tabs = tabsByProject[selectedProjectId] || [];
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  // 记录每个项目的活跃 tab，切换项目时恢复对应的活跃 tab，避免切换关闭控制台
  const [activeTabByProject, setActiveTabByProject] = useState<Record<string, string | null>>({});
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
  const ptyByTabRef = useRef<Record<string, string>>({});
  const [ptyByTab, setPtyByTab] = useState<Record<string, string>>({});
  const ptyAliveRef = useRef<Record<string, boolean>>({});
  const [ptyAlive, setPtyAlive] = useState<Record<string, boolean>>({});
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
  const ptyNotificationBuffersRef = useRef<Record<string, string>>({});
  const ptyListenersRef = useRef<Record<string, () => void>>({});
  const ptyToTabRef = useRef<Record<string, string>>({});
  const tabProjectRef = useRef<Record<string, string>>({});
  const tabsByProjectRef = useRef<Record<string, ConsoleTab[]>>(tabsByProject);
  const projectsRef = useRef<Project[]>(projects);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => { editingTabIdRef.current = editingTabId; }, [editingTabId]);
  useEffect(() => { notificationPrefsRef.current = notificationPrefs; }, [notificationPrefs]);
  useEffect(() => { tabsByProjectRef.current = tabsByProject; }, [tabsByProject]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => {
    if (!terminalManagerRef.current) return;
    try { terminalManagerRef.current.setAppearance({ fontFamily: terminalFontFamily, theme: terminalTheme }); } catch {}
  }, [terminalFontFamily, terminalTheme]);

  const injectTraceEnv = React.useCallback((cmd: string | null | undefined) => {
    const raw = String(cmd || "").trim();
    const base = raw.length > 0 ? raw : "codex";
    if (!codexTraceEnabled) return base;
    if (isWindowsLike(terminalMode)) {
      if (/RUST_LOG\s*=/.test(base) || base.includes("$env:RUST_LOG")) {
        return base;
      }
      return `$env:RUST_LOG='codex_tui=trace'; ${base}`;
    }
    if (/RUST_LOG\s*=/.test(base) || (base.startsWith("export ") && base.includes("RUST_LOG="))) {
      return base;
    }
    return `export RUST_LOG=codex_tui=trace; ${base}`;
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

  function showCompletionNotification(tabId: string, preview: string) {
    if (!notificationPrefsRef.current.system) {
      notifyLog(`showCompletionNotification skipped tab=${tabId} reason=systemDisabled`);
      return;
    }
    let tabName = '';
    let projectName: string | undefined;
    const currentTabs = tabsByProjectRef.current;
    for (const [pid, list] of Object.entries(currentTabs)) {
      const found = (list || []).find((tab) => tab.id === tabId);
      if (found) {
        tabName = found.name;
        const project = projectsRef.current.find((p) => p.id === pid);
        if (project) projectName = project.name;
        break;
      }
    }
    if (!tabName) tabName = t('common:notifications.untitledTab', 'Agent');
    const appTitle = t('common:app.name', 'CodexFlow') as string;
    const header = [appTitle, tabName].filter(Boolean).join(' · ') || appTitle;
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
    const foreground = isAppForeground();
    const activeMatch = activeTabIdRef.current === tabId;
    notifyLog(`handleAgentCompletion tab=${tabId} previewLength=${preview.length} sound=${notificationPrefsRef.current.sound} foreground=${foreground ? '1' : '0'} activeMatch=${activeMatch ? '1' : '0'}`);
    const current = pendingCompletionsRef.current;
    if (foreground && activeMatch) {
      notifyLog(`handleAgentCompletion auto-clear tab=${tabId}`);
      autoClearActiveTabIfForeground('agent-complete');
    } else {
      const next = { ...current, [tabId]: (current[tabId] ?? 0) + 1 };
      applyPending(next);
    }
    showCompletionNotification(tabId, preview);
    void playCompletionChime();
    // 无论通知开关如何，均请求刷新 Codex 用量（由顶部栏组件自行做 1 分钟冷却）
    try { emitCodexRateRefresh('agent-complete'); } catch {}
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedHistoryDir, setSelectedHistoryDir] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  // 用于在点击项目时抑制自动选中历史的标志
  const suppressAutoSelectRef = useRef(false);

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
  const [projectCtxMenu, setProjectCtxMenu] = useState<{ show: boolean; x: number; y: number; project: Project | null }>({ show: false, x: 0, y: 0, project: null });
  const [hideProjectConfirm, setHideProjectConfirm] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const projectCtxMenuRef = useRef<HTMLDivElement | null>(null);
  // Simple in-memory cache to show previous results instantly when switching projects
  const historyCacheRef = useRef<Record<string, HistorySession[]>>({});
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
  const [wslDistro, setWslDistro] = useState("Ubuntu-24.04");
  // 基础命令（默认 'codex'），不做 tmux 包装，直接在 WSL 中执行。
  const [codexCmd, setCodexCmd] = useState("codex");
  // 网络代理设置（用于设置对话框初始值与回显）
  const [networkPrefs, setNetworkPrefs] = useState<NetworkPrefs>({ proxyEnabled: true, proxyMode: "system", proxyUrl: "", noProxy: "" });
  const [sendMode, setSendMode] = useState<'write_only' | 'write_and_enter'>("write_and_enter");
  // 项目内路径样式：absolute=全路径；relative=相对路径（默认全路径）
  const [projectPathStyle, setProjectPathStyle] = useState<'absolute' | 'relative'>('absolute');
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
          setTerminalMode(normalizeTerminalMode((s as any).terminal));
          setWslDistro(s.distro || wslDistro);
          setCodexCmd(s.codexCmd || codexCmd);
          setSendMode(s.sendMode || 'write_and_enter');
          setProjectPathStyle((s as any).projectPathStyle || 'absolute');
          const nextThemeSetting = normalizeThemeSetting((s as any).theme);
          setThemeSetting(nextThemeSetting);
          writeThemeSettingCache(nextThemeSetting);
          setNotificationPrefs(normalizeCompletionPrefs((s as any).notifications));
          setTerminalFontFamily(normalizeTerminalFontFamily((s as any).terminalFontFamily));
          setTerminalTheme(normalizeTerminalTheme((s as any).terminalTheme));
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

  // Basic smoke tests (non-blocking)
  useEffect(() => {
    try {
      console.assert(mockProjects.length > 0, "[SMOKE] mockProjects should not be empty");
      console.assert(Array.isArray(historySessions), "[SMOKE] historySessions must be an array");
    } catch (e) {
      console.warn("Smoke tests warning:", e);
    }
  }, [historySessions]);

  // Alignment test for tabs list (ensure left-justified)
  useEffect(() => {
    if (tabsListRef.current) {
      const cls = tabsListRef.current.className;
      console.assert(cls.includes('justify-start'), '[TEST] TabsList should be left-justified (has justify-start)');
      console.assert(!cls.includes('justify-center'), '[TEST] TabsList should not be center-justified');
    }
  }, []);

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

  const filtered = useMemo(() => {
    if (!query.trim()) return sortedProjects;
    const q = query.toLowerCase();
    return sortedProjects.filter((p) => `${p.name} ${p.winPath}`.toLowerCase().includes(q));
  }, [sortedProjects, query]);

  const tabsForProject = tabsByProject[selectedProjectId] || [];
  const activeTab = useMemo(() => tabsForProject.find((tab) => tab.id === activeTabId) || null, [tabsForProject, activeTabId]);

  // ---------- Actions ----------

  const hideProjectTemporarily = useCallback((project: Project | null) => {
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
    setHiddenProjectIds((prev) => (prev.includes(project.id) ? prev : [...prev, project.id]));
    setSelectedProjectId((prev) => (prev === project.id ? "" : prev));
    try { suppressAutoSelectRef.current = true; } catch {}
    setSelectedHistoryDir(null);
    setSelectedHistoryId(null);
    setCenterMode('console');
    setHideProjectConfirm({ open: false, project: null });
    setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
  }, [activeTabId, setActiveTab, tabsByProject, tm]);

  function markProjectUsed(projectId: string | null | undefined) {
    try { suppressAutoSelectRef.current = true; } catch {}
    if (!projectId) return;
    try {
      const now = Date.now();
      setProjects((prev) => prev.map((x) => (x.id === projectId ? { ...x, lastOpenedAt: now } : x)));
    } catch {}
  }

  // 新增项目并选中，随后自动为该项目打开一个控制台（无 tmux 包装）

  async function openConsoleForProject(project: Project) {
    if (!project) return;
    const tabName = isWindowsLike(terminalMode)
      ? toShellLabel(terminalMode)
      : (wslDistro || `Console ${((tabsByProject[project.id] || []).length + 1).toString()}`);
    const tab: ConsoleTab = {
      id: uid(),
      name: String(tabName),
      logs: [],
      createdAt: Date.now(),
    };
    let ptyId: string | undefined;
    try {
      const startupCmd = injectTraceEnv(codexCmd);
      const { id } = await window.host.pty.openWSLConsole({ distro: wslDistro, wslPath: project.wslPath, winPath: project.winPath, cols: 80, rows: 24, startupCmd });
      ptyId = id;
    } catch (e) {
      console.error('Failed to open PTY for project', e);
      alert(String(t('terminal:openFailed', { error: String((e as any)?.message || e) })));
      return;
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
        if (hiddenProjectIds.includes(exists.id)) {
          alert(String(t('projects:hiddenProjectBlocked')));
          return;
        }
        try { suppressAutoSelectRef.current = true; } catch {}
        setSelectedProjectId(exists.id);
        try { await openConsoleForProject(exists); } catch {}
        return;
      }
      const added: any = await window.host.projects.add({ winPath });
      if (added && added.ok && added.project) {
        const p = added.project as Project;
        if (hiddenProjectIds.includes(p.id)) {
          alert(String(t('projects:hiddenProjectBlocked')));
          return;
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
      logs: [],
      createdAt: Date.now(),
    };
    let ptyId: string | undefined;
    // Open PTY in main (WSL)
    try {
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole start project=${selectedProject?.name}`); } catch {}
      const startupCmd = injectTraceEnv(codexCmd);
      const { id } = await window.host.pty.openWSLConsole({
        distro: wslDistro,
        wslPath: selectedProject.wslPath,
        winPath: selectedProject.winPath,
        cols: 80,
        rows: 24,
        startupCmd,
      });
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole pty=${id}`); } catch {}
      ptyId = id;
    } catch (e) {
      console.error('Failed to open PTY', e);
      try { await (window as any).host?.utils?.perfLog?.(`[ui] openNewConsole error ${String((e as any)?.stack || e)}`); } catch {}
      alert(String(t('terminal:openFailed', { error: String((e as any)?.message || e) })));
      return;
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
  }, [selectedProject]);

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
    return () => { try { unsubAdd(); } catch {}; try { unsubUpd(); } catch {}; try { unsubRem(); } catch {}; };
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
      if (sendMode === 'write_and_enter') tm.sendTextAndEnter(activeTab.id, text);
      else tm.sendText(activeTab.id, text);
    } catch {
      // 兜底：直接写入 PTY（不走 paste），并在需要时单独补 CR
      try { window.host.pty.write(pid, text); } catch {}
      if (sendMode === 'write_and_enter') { try { window.host.pty.write(pid, '\r'); } catch {} }
    }
    if (chipsSnapshot.length > 0) {
      for (const chip of chipsSnapshot) {
        scheduleCommittedChipRelease(chip);
      }
    }
    setChipsByTab((m) => ({ ...m, [activeTab.id]: [] }));
    setDraftByTab((m) => ({ ...m, [activeTab.id]: "" }));
    setInputFullscreenState(activeTab.id, false);
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
    setInputFullscreenByTab((m) => {
      if (!m[id]) return m;
      const next = { ...m } as Record<string, boolean>;
      delete next[id];
      return next;
    });
    if (activeTabId === id) setActiveTab(null);
  }

  // ---------- Renderers ----------

  const Sidebar = (
    <div className="flex h-full min-w-[240px] flex-col border-r bg-white/50 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex items-center gap-2 px-3 py-3">
        <Badge variant="secondary" className="gap-2">
          <PlugZap className="h-4 w-4" /> {toShellLabel(terminalMode)} <StatusDot ok={true} />
        </Badge>
        {terminalMode === 'wsl' && (
          <span className="text-xs text-slate-500">{wslDistro}</span>
        )}
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2">
          <Input
            placeholder={t('projects:searchPlaceholder') as string}
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setQuery((e.target as any).value)}
            className="h-9"
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
      <ScrollArea className="flex-1 min-h-0 px-2 pb-6">
        <div className="space-y-1 pr-1">
          {filtered.map((p) => {
            const tabsInProject = tabsByProject[p.id] || [];
            const liveCount = tabsInProject.filter((tab) => !!ptyAlive[tab.id]).length;
            const pendingCount = pendingByProject[p.id] ?? 0;
            return (
              <div
                key={p.id}
                className={`group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
                  p.id === selectedProjectId ? 'bg-slate-100 dark:bg-slate-800/80 dark:text-slate-100' : ''
                }`}
                onClick={() => {
                  // 点击项目时默认进入控制台，并清除历史选择（避免自动跳到历史详情）
                  suppressAutoSelectRef.current = true;
                  setSelectedProjectId(p.id);
                  setCenterMode('console');
                  setSelectedHistoryDir(null);
                  setSelectedHistoryId(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectCtxMenu({ show: true, x: e.clientX, y: e.clientY, project: p });
                }}
              >
                {/* 左侧内容区域：可水平滚动以查看长路径；右侧计数固定不滚动，避免遮挡 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 font-medium dark:text-[var(--cf-text-primary)]">
                    <FolderOpen className="h-4 w-4 text-slate-500 dark:text-[var(--cf-text-secondary)]" />
                    <span className="truncate max-w-[16rem]" title={p.name}>{p.name}</span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-[var(--cf-text-muted)] overflow-x-auto no-scrollbar whitespace-nowrap pr-1" title={p.winPath}>{p.winPath}</div>
                </div>
                <div className="ml-2 shrink-0 flex items-center gap-2">
                  {pendingCount > 0 ? (
                    <span
                      className="inline-flex h-2 w-2 rounded-full bg-red-500 dark:bg-[var(--cf-red)] dark:shadow-sm"
                      title={t('common:notifications.openTabHint', '点击查看详情') as string}
                    ></span>
                  ) : null}
                  {liveCount > 0 ? (
                    <span className="inline-flex items-center justify-center rounded-full bg-[var(--cf-accent)] text-white text-[10px] font-apple-semibold h-5 min-w-[20px] px-1 shadow-apple-xs ring-1 ring-[var(--cf-accent)]/20">
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
        <CodexUsageSummary className="min-w-0" terminalMode={terminalMode} distro={terminalMode === "wsl" ? wslDistro : undefined} />
      </div>
      <div className="flex items-center gap-2">
        {/* 目录缺失提示：若选中项目的 Windows 路径不存在则提示 */}
        {selectedProject?.winPath && (
          <span className="hidden" data-proj-path={selectedProject.winPath}></span>
        )}
        <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setShowHistoryPanel((v) => !v)}>
          <HistoryIcon className="mr-2 h-4 w-4" /> {showHistoryPanel ? t('history:hidePanel') : t('history:showPanel')}
        </Button>
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
                    <TerminalSquare className="mr-1.5 h-3.5 w-3.5 text-[var(--cf-text-secondary)] group-data-[state=active]/tab:text-[var(--cf-text-primary)]" />
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

  const buildResumeStartup = (filePath: string, mode: TerminalMode, options?: { forceLegacyCli?: boolean }): ResumeStartup => {
    const session = findSessionForFile(filePath);
    const preferredId = typeof session?.resumeId === 'string' ? session.resumeId : null;
    const guessedId = inferSessionUuid(session, filePath);
    const resumeSessionId = [preferredId, guessedId].find((v) => isUuidLike(v)) || null;
    const resumeModeHintRaw: 'modern' | 'legacy' | 'unknown' = session?.resumeMode || 'unknown';
    const resumeModeHint: 'modern' | 'legacy' = resumeModeHintRaw === 'modern' ? 'modern' : 'legacy';
    const forceLegacyCli = !!options?.forceLegacyCli;
    const preferLegacyOnly = forceLegacyCli || resumeModeHint === 'legacy';
    const cmdRaw = String(codexCmd || 'codex').trim();
    const baseCmd = cmdRaw.length > 0 ? cmdRaw : 'codex';
    if (isWindowsLike(mode)) {
      const resumePath = toWindowsResumePath(filePath);
      if (forceLegacyCli) {
        const escapedResume = resumePath.replace(/"/g, '\"');
        const startupCmd = `npx --yes @openai/codex@0.31.0 -c experimental_resume="${escapedResume}"`;
        return { startupCmd, session, resumePath, sessionId: resumeSessionId, strategy: 'force-legacy-cli', resumeHint: 'legacy', forceLegacyCli: true };
      }
      const escapedCmd = baseCmd.replace(/'/g, "''");
      const resumeArg = `experimental_resume="${resumePath}"`;
      const escapedArg = resumeArg.replace(/'/g, "''");
      if (!preferLegacyOnly && resumeSessionId) {
        const escapedSession = resumeSessionId.replace(/'/g, "''");
        const psLines = [
          `$__codex = '${escapedCmd}'`,
          `$__resumeArg = '${escapedArg}'`,
          `$__session = '${escapedSession}'`,
          `if ($__session -and ($__session -match '${UUID_REGEX_TEXT}')) {`,
          `  & $__codex resume $__session`,
          `  if ($LASTEXITCODE -ne 0) { & $__codex -c $__resumeArg }`,
          `} else {`,
          `  & $__codex -c $__resumeArg`,
          `}`,
        ];
        return { startupCmd: psLines.join('; '), session, resumePath, sessionId: resumeSessionId, strategy: 'resume+fallback', resumeHint: resumeModeHint, forceLegacyCli: false };
      }
      const psLines = [
        `$__codex = '${escapedCmd}'`,
        `$__resumeArg = '${escapedArg}'`,
        `& $__codex -c $__resumeArg`,
      ];
      const strategy = preferLegacyOnly ? 'legacy-only' : 'experimental_resume';
      return { startupCmd: psLines.join('; '), session, resumePath, sessionId: resumeSessionId, strategy, resumeHint: resumeModeHint, forceLegacyCli: false };
    }
    const resumePath = toWSLForInsert(filePath);
    if (forceLegacyCli) {
      const escapedResume = resumePath.replace(/"/g, '\"');
      const startupCmd = injectTraceEnv(`npx --yes @openai/codex@0.31.0 -c experimental_resume=\"${escapedResume}\"`);
      return { startupCmd, session, resumePath, sessionId: resumeSessionId, strategy: 'force-legacy-cli', resumeHint: 'legacy', forceLegacyCli: true };
    }
    const fallbackCmd = injectTraceEnv(`${baseCmd} -c experimental_resume="${resumePath}"`);
    if (!preferLegacyOnly && resumeSessionId) {
      const resumeCmd = injectTraceEnv(`${baseCmd} resume ${resumeSessionId}`);
      const startupCmd = `if ${resumeCmd}; then :; else ${fallbackCmd}; fi`;
      return { startupCmd, session, resumePath, sessionId: resumeSessionId, strategy: 'resume+fallback', resumeHint: resumeModeHint, forceLegacyCli: false };
    }
    const strategy = preferLegacyOnly ? 'legacy-only' : 'experimental_resume';
    return { startupCmd: fallbackCmd, session, resumePath, sessionId: resumeSessionId, strategy, resumeHint: resumeModeHint, forceLegacyCli: false };
  };

  const isLegacyHistory = (filePath?: string): boolean => {
    if (!filePath) return false;
    const session = findSessionForFile(filePath);
    return (session?.resumeMode || 'unknown') === 'legacy';
  };

  const executeResume = async (filePath: string, mode: ResumeExecutionMode, forceLegacyCli: boolean): Promise<boolean> => {
    try {
      if (!filePath || !selectedProject) return false;
      const { startupCmd, session, sessionId, resumePath, strategy, resumeHint, forceLegacyCli: finalForceLegacy } = buildResumeStartup(filePath, terminalMode, { forceLegacyCli });
      try {
        await (window as any).host?.utils?.perfLog?.(`[ui] history.resume ${mode} mode=${terminalMode} strategy=${strategy} resumeHint=${resumeHint} forceLegacy=${finalForceLegacy ? '1' : '0'} sessionId=${sessionId || 'none'} sessionRaw=${session?.id || 'n/a'} path=${resumePath}`);
      } catch {}
      if (mode === 'internal') {
        const tabName = isWindowsLike(terminalMode)
          ? toShellLabel(terminalMode)
          : (wslDistro || `Console ${((tabsByProject[selectedProject.id] || []).length + 1).toString()}`);
        const tab: ConsoleTab = {
          id: uid(),
          name: String(tabName),
          logs: [],
          createdAt: Date.now(),
        };
        let ptyId: string | undefined;
        try {
          await (window as any).host?.utils?.perfLog?.(`[ui] history.resume openWSLConsole start tab=${tab.id}`);
        } catch {}
        try {
          const { id } = await window.host.pty.openWSLConsole({
          distro: wslDistro,
          wslPath: selectedProject.wslPath,
          winPath: selectedProject.winPath,
          cols: 80,
          rows: 24,
          startupCmd,
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
        wslPath: selectedProject.wslPath,
        winPath: selectedProject.winPath,
        distro: wslDistro,
        startupCmd,
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
    const session = findSessionForFile(filePath);
    const sessionMode = session?.resumeMode || 'unknown';
    const enforceShell = sessionMode !== 'legacy' && !options?.forceLegacyCli;
    if (enforceShell) {
      const sessionShell = session?.runtimeShell === 'windows' ? 'windows' : (session?.runtimeShell === 'wsl' ? 'wsl' : null);
      if (sessionShell) {
        const mismatch = sessionShell === 'wsl' ? terminalMode !== 'wsl' : !isWindowsLike(terminalMode);
        if (mismatch) {
          const expected = toShellLabel(sessionShell === 'wsl' ? 'wsl' : 'windows');
          const current = toShellLabel(terminalMode);
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
    const ok = await executeResume(filePath, mode, useLegacy);
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
          const env = toShellLabel(terminalMode);
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
      <div className="flex items-center justify-between px-3 py-3 border-b border-slate-100 dark:border-slate-700/50">
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
                          onClick={() => { setSelectedHistoryDir(g.key); setSelectedHistoryId(s.id); setCenterMode('history'); }}
                          onContextMenu={(e) => { e.preventDefault(); setHistoryCtxMenu({ show: true, x: e.clientX, y: e.clientY, item: s, groupKey: g.key }); }}
                          className={itemClass}
                          title={tooltip}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm leading-5 truncate ${active ? 'text-slate-900 dark:text-slate-50 font-medium' : 'text-slate-800 dark:text-slate-200'}`}>{previewSource || absoluteLabel || '--'}</span>
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
            <DialogDescription>{t('history:confirmPermanentDelete')}</DialogDescription>
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
      <div className={`grid h-screen overflow-hidden ${showHistoryPanel ? 'grid-cols-[240px_1fr_240px]' : 'grid-cols-[240px_1fr]'}`}>
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
                }} onResume={(fp) => requestResume(fp, 'internal')} terminalMode={terminalMode} onResumeExternal={async (filePath?: string) => {
                  try {
                    if (!filePath || !selectedProject) return;
                    const status = await requestResume(filePath, 'external');
                    if (status === 'error') {
                      const env = toShellLabel(terminalMode);
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
                    const env = toShellLabel(terminalMode);
                    setBlockingNotice({ type: 'external-console', env });
                  }
                } catch (e) {
                  console.warn('resume external failed', e);
                }
                setHistoryCtxMenu((m) => ({ ...m, show: false }));
              }}
            >
              <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('history:continueExternalWith', { env: toShellLabel(terminalMode) })}
            </button>
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
              onClick={async () => {
                const it = historyCtxMenu.item; const key = historyCtxMenu.groupKey || (it ? historyTimelineGroupKey(it, new Date()) : HISTORY_UNKNOWN_GROUP_KEY);
                if (!it?.filePath) { setHistoryCtxMenu((m) => ({ ...m, show: false })); return; }
                setConfirmDelete({ open: true, item: it, groupKey: key });
                setHistoryCtxMenu((m) => ({ ...m, show: false }));
              }}
            >
              <Trash2 className="h-4 w-4" /> {t('history:deleteToTrash')}
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
            menuItems.push(
              <button
                key="show-in-explorer"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                onClick={async () => {
                  const proj = projectCtxMenu.project;
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
                key="open-external"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                onClick={async () => {
                  const proj = projectCtxMenu.project;
                  if (proj) {
                    try {
                      const res: any = await (window.host.utils as any).openExternalConsole({ wslPath: proj.wslPath, winPath: proj.winPath, distro: wslDistro, startupCmd: injectTraceEnv(codexCmd) });
                      if (!(res && res.ok)) throw new Error(res?.error || 'failed');
                    } catch (e) {
                      const env = toShellLabel(terminalMode);
                      setBlockingNotice({ type: 'external-console', env });
                    }
                  }
                  setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                }}
              >
                <ExternalLink className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxOpenExternalConsoleWith', { env: toShellLabel(terminalMode) })}
              </button>
            );
            if (isDevEnvironment) {
              menuItems.push(
                <button
                  key="hide-temporary"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--cf-text-primary)] rounded-apple-sm hover:bg-[var(--cf-surface-hover)] transition-all duration-apple-fast"
                  onClick={() => {
                    const proj = projectCtxMenu.project;
                    if (proj) setHideProjectConfirm({ open: true, project: proj });
                    setProjectCtxMenu((m) => ({ ...m, show: false, project: null }));
                  }}
                >
                  <EyeOff className="h-4 w-4 text-[var(--cf-text-muted)]" /> {t('projects:ctxHideTemporarily')}
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
              {hideProjectConfirm.project?.name
                ? t('projects:hideTemporaryDescriptionNamed', { name: hideProjectConfirm.project.name })
                : t('projects:hideTemporaryDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setHideProjectConfirm({ open: false, project: null })}>{t('common:cancel')}</Button>
            <Button
              variant="secondary"
              onClick={() => hideProjectTemporarily(hideProjectConfirm.project)}
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
        values={{ terminal: terminalMode, distro: wslDistro, codexCmd, sendMode, locale, projectPathStyle, theme: themeSetting, notifications: notificationPrefs, network: networkPrefs, terminalFontFamily, terminalTheme }}
        onSave={async (v) => {
          const nextTerminal = v.terminal;
          const nextDistro = v.distro;
          const nextCmd = v.codexCmd;
          const nextSend = v.sendMode;
          const nextStyle = v.projectPathStyle || 'absolute';
          const nextLocale = v.locale;
          const nextNotifications = normalizeCompletionPrefs(v.notifications);
          const nextFontFamily = normalizeTerminalFontFamily(v.terminalFontFamily);
          const nextTerminalTheme = normalizeTerminalTheme(v.terminalTheme);
          const nextTheme = normalizeThemeSetting(v.theme);
          // 先切换语言（内部会写入 settings 并广播），再持久化其它字段
          try { await (window as any).host?.i18n?.setLocale?.(nextLocale); setLocale(nextLocale); } catch {}
          try {
            await window.host.settings.update({
              terminal: nextTerminal,
              distro: nextDistro,
              codexCmd: nextCmd,
              sendMode: nextSend,
              projectPathStyle: nextStyle,
              theme: nextTheme,
              notifications: nextNotifications,
              network: v.network,
              terminalFontFamily: nextFontFamily,
              terminalTheme: nextTerminalTheme,
            });
          } catch (e) { console.warn('settings.update failed', e); }
          setTerminalMode(nextTerminal);
          setWslDistro(nextDistro);
          setCodexCmd(nextCmd);
          setSendMode(nextSend);
          setProjectPathStyle(nextStyle);
          setThemeSetting(nextTheme);
          writeThemeSettingCache(nextTheme);
          setNotificationPrefs(nextNotifications);
          setNetworkPrefs(v.network);
          setTerminalFontFamily(nextFontFamily);
          setTerminalTheme(nextTerminalTheme);
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
                ? t('history:legacyResumeExternalHint', { env: toShellLabel(terminalMode) })
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

function HistoryDetail({ sessions, selectedHistoryId, onBack, onResume, onResumeExternal, terminalMode }: { sessions: HistorySession[]; selectedHistoryId: string | null; onBack?: () => void; onResume?: (filePath?: string) => void; onResumeExternal?: (filePath?: string) => void; terminalMode: TerminalMode }) {
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
        const res: any = await window.host.history.read({ filePath: String(selectedSession.filePath || '') });
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
          }}>{t('history:continueExternalWith', { env: toShellLabel(terminalMode) })}</Button>
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
