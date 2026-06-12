// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "../log";
import { getCodexRootsFastAsync } from "../wsl";
import { requestHistoryFastRefresh } from "../indexer";
import { getCodexNotifyStateDecision, type CodexNotifyStateDecision, type CodexNotifyStateEntry } from "./notifyState";

const CODEX_NOTIFY_FILENAME = "codexflow_after_agent_notify.jsonl";
const CODEX_NOTIFY_POLL_INTERVAL_MS = 250;
const CODEX_NOTIFY_READ_LIMIT_BYTES = 128 * 1024;
const CODEX_SUBAGENT_DUPLICATE_WINDOW_MS = 8_000;
const CODEX_RECENT_SUBAGENT_MAX = 32;

type CodexNotifyEntry = {
  v?: number;
  eventId?: string;
  providerId?: string;
  tabId?: string;
  envLabel?: string;
  preview?: string;
  previewEscapedWhitespace?: boolean;
  timestamp?: string;
  hookEventName?: string;
  completionKind?: string;
  agentType?: string;
  agentId?: string;
  threadId?: string;
  turnId?: string;
  cwd?: string;
  sqliteHome?: string;
};

type CodexNotifySource = {
  filePath: string;
  offset: number;
  remainder: string;
};

type CodexNotifyPayload = {
  providerId: "codex";
  tabId: string;
  envLabel: string;
  preview: string;
  previewEscapedWhitespace?: boolean;
  timestamp: string;
  eventId: string;
  hookEventName?: string;
  completionKind?: "agent" | "subagent";
  agentType?: string;
  agentId?: string;
  threadId?: string;
  turnId?: string;
  cwd?: string;
  sqliteHome?: string;
};

type RecentCodexSubagentNotify = {
  tabId: string;
  envLabel: string;
  preview: string;
  previewKey: string;
  at: number;
};

const codexNotifySources = new Map<string, CodexNotifySource>();
const recentCodexSubagentNotifies: RecentCodexSubagentNotify[] = [];
let codexNotifyTimer: NodeJS.Timeout | null = null;
let codexNotifyPolling = false;
let codexNotifyWindowGetter: (() => BrowserWindow | null) | null = null;
let codexNotifyStateDecisionReader: (entry: CodexNotifyStateEntry, sourcePath?: string) => CodexNotifyStateDecision = getCodexNotifyStateDecision;

/**
 * 中文说明：记录 Codex 通知桥接调试日志。
 */
function logCodexNotification(message: string): void {
  try { perfLogger.log(`[codex.notify] ${message}`); } catch {}
}

/**
 * 中文说明：去重通知文件路径（大小写不敏感）。
 */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const p = String(raw || "").trim();
    if (!p) continue;
    const key = p.replace(/\\/g, "/").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 中文说明：列出需要监听的 Codex notify 文件路径（Windows + WSL UNC）。
 */
async function listCodexNotifyFiles(): Promise<string[]> {
  try {
    const roots = await getCodexRootsFastAsync();
    const candidates: string[] = [];
    if (roots?.windowsCodex) {
      candidates.push(path.join(roots.windowsCodex, CODEX_NOTIFY_FILENAME));
    }
    for (const item of roots?.wsl || []) {
      if (!item?.codexUNC) continue;
      candidates.push(path.join(item.codexUNC, CODEX_NOTIFY_FILENAME));
    }
    return dedupePaths(candidates);
  } catch (error) {
    logCodexNotification(`list notify files failed: ${String(error)}`);
    return [];
  }
}

/**
 * 中文说明：同步通知源列表，保留已有读取偏移。
 */
function syncCodexNotifySources(paths: string[]): void {
  const normalized = new Set<string>();
  for (const p of paths) {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (key) normalized.add(key);
  }

  for (const [key, source] of Array.from(codexNotifySources.entries())) {
    if (!normalized.has(key)) {
      codexNotifySources.delete(key);
      try { logCodexNotification(`notify source removed path=${source.filePath}`); } catch {}
    }
  }

  for (const p of paths) {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (!key || codexNotifySources.has(key)) continue;
    let offset = 0;
    try {
      const st = fs.statSync(p);
      if (st && st.isFile && st.isFile()) offset = typeof st.size === "number" ? st.size : 0;
    } catch {}
    codexNotifySources.set(key, { filePath: p, offset, remainder: "" });
    try { logCodexNotification(`notify source added path=${p} offset=${offset}`); } catch {}
  }
}

/**
 * 中文说明：解析单行 JSONL，失败返回 null。
 */
function parseCodexNotifyLine(line: string): CodexNotifyEntry | null {
  const raw = String(line || "").trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj as CodexNotifyEntry;
  } catch {
    return null;
  }
}

/**
 * 中文说明：把 legacy notify 与 lifecycle hook 的预览规整为可比较文本。
 */
function normalizeCodexNotifyPreviewForDedupe(preview: string): string {
  return String(preview || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 中文说明：判断两条 Codex notify 预览是否可视作同一次完成事件。
 */
function areCodexNotifyPreviewsEquivalent(leftRaw: string, rightRaw: string): boolean {
  const left = normalizeCodexNotifyPreviewForDedupe(leftRaw);
  const right = normalizeCodexNotifyPreviewForDedupe(rightRaw);
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length < 24) return false;
  return longer.includes(shorter) || longer.startsWith(shorter);
}

/**
 * 中文说明：识别没有 completionKind 的旧 notify 中明显属于子代理完成的文案。
 */
function isLegacySubagentCompletionPreview(preview: string): boolean {
  const text = String(preview || "").trim();
  if (!text) return false;
  const normalized = normalizeCodexNotifyPreviewForDedupe(text);
  if (normalized.startsWith("<subagent_notification")) return true;
  if (/^子代理\s+\S{1,48}\s+(已|已经|完成|结束|通过|修复|检查|验收)/u.test(text)) return true;
  if (/^子代理完成/u.test(text)) return true;
  if (/^subagent\s+\S{1,64}\s+(completed|finished|done|passed|fixed|checked)\b/i.test(text)) return true;
  if (/^subagent\s+(turn\s+)?complete(?:d)?\b/i.test(text)) return true;
  return false;
}

/**
 * 中文说明：清理过期的近期子代理完成记录，避免内存无界增长。
 */
function pruneRecentCodexSubagentNotifies(now: number): void {
  for (let i = recentCodexSubagentNotifies.length - 1; i >= 0; i -= 1) {
    const item = recentCodexSubagentNotifies[i];
    if (!item || now - item.at > CODEX_SUBAGENT_DUPLICATE_WINDOW_MS)
      recentCodexSubagentNotifies.splice(i, 1);
  }
  while (recentCodexSubagentNotifies.length > CODEX_RECENT_SUBAGENT_MAX)
    recentCodexSubagentNotifies.shift();
}

/**
 * 中文说明：记录已转发的子代理完成事件，用于吞掉紧随其后的 legacy notify 回放。
 */
function rememberCodexSubagentNotify(payload: CodexNotifyPayload, now: number): void {
  const preview = String(payload.preview || "");
  const previewKey = normalizeCodexNotifyPreviewForDedupe(preview);
  recentCodexSubagentNotifies.push({
    tabId: String(payload.tabId || ""),
    envLabel: String(payload.envLabel || ""),
    preview,
    previewKey,
    at: now,
  });
  pruneRecentCodexSubagentNotifies(now);
}

/**
 * 中文说明：判断当前事件是否为刚刚已通过 SubagentStop 转发过的 legacy 重复回放。
 */
function isDuplicateRecentCodexSubagentNotify(payload: CodexNotifyPayload, now: number): boolean {
  pruneRecentCodexSubagentNotifies(now);
  const tabId = String(payload.tabId || "");
  const envLabel = String(payload.envLabel || "");
  const preview = String(payload.preview || "");
  const previewKey = normalizeCodexNotifyPreviewForDedupe(preview);
  for (const item of recentCodexSubagentNotifies) {
    if (!item) continue;
    if (tabId && item.tabId && tabId !== item.tabId) continue;
    if (envLabel && item.envLabel && envLabel !== item.envLabel) continue;
    if (previewKey && item.previewKey && (previewKey === item.previewKey || areCodexNotifyPreviewsEquivalent(preview, item.preview))) return true;
  }
  return false;
}

/**
 * 中文说明：从 Codex notify entry 构造发送给渲染进程的 payload，并处理旧 notify 的状态兜底与子代理归类。
 */
function buildCodexNotifyDispatch(entry: CodexNotifyEntry, now = Date.now(), sourcePath?: string): { payload: CodexNotifyPayload; dropReason?: string } {
  const payload: CodexNotifyPayload = {
    providerId: "codex" as const,
    tabId: entry.tabId ? String(entry.tabId) : "",
    envLabel: entry.envLabel ? String(entry.envLabel) : "",
    preview: entry.preview ? String(entry.preview) : "",
    timestamp: entry.timestamp ? String(entry.timestamp) : "",
    eventId: entry.eventId ? String(entry.eventId) : "",
  };
  if (typeof entry.previewEscapedWhitespace === "boolean")
    payload.previewEscapedWhitespace = entry.previewEscapedWhitespace;
  const hookEventName = String(entry.hookEventName || "").trim();
  const completionKind = String(entry.completionKind || "").trim().toLowerCase();
  const agentType = String(entry.agentType || "").trim();
  const agentId = String(entry.agentId || "").trim();
  const threadId = String(entry.threadId || "").trim();
  const turnId = String(entry.turnId || "").trim();
  const cwd = String(entry.cwd || "").trim();
  const sqliteHome = String(entry.sqliteHome || "").trim();
  const explicitSubagent = completionKind === "subagent" || hookEventName === "SubagentStop";
  const explicitAgent = completionKind === "agent" || hookEventName === "Stop";
  const isLegacyNotify = !hookEventName && !completionKind;
  const legacySubagentPreview = isLegacySubagentCompletionPreview(payload.preview);
  const stateDecision = threadId
    ? codexNotifyStateDecisionReader({ threadId, cwd, sqliteHome }, sourcePath)
    : {};

  if (hookEventName) payload.hookEventName = hookEventName;
  if (explicitSubagent || stateDecision.completionKind === "subagent" || legacySubagentPreview)
    payload.completionKind = "subagent";
  else if (explicitAgent)
    payload.completionKind = "agent";
  if (agentType) payload.agentType = agentType;
  if (agentId || stateDecision.agentId) payload.agentId = agentId || stateDecision.agentId;
  if (threadId) payload.threadId = threadId;
  if (turnId) payload.turnId = turnId;
  if (cwd) payload.cwd = cwd;
  if (sqliteHome) payload.sqliteHome = sqliteHome;

  if (stateDecision.dropReason)
    return { payload, dropReason: stateDecision.dropReason };

  if (isLegacyNotify && isDuplicateRecentCodexSubagentNotify(payload, now))
    return { payload, dropReason: "duplicate-subagent-legacy" };

  if (payload.completionKind === "subagent")
    rememberCodexSubagentNotify(payload, now);

  return { payload };
}

/**
 * 中文说明：从通知文件读取新增内容并解析为事件列表。
 */
function readCodexNotifyEntries(source: CodexNotifySource): CodexNotifyEntry[] {
  try {
    const st = fs.statSync(source.filePath);
    if (!st || !st.isFile || !st.isFile()) return [];
    const size = typeof st.size === "number" ? st.size : 0;
    if (size < source.offset) {
      source.offset = 0;
      source.remainder = "";
    }
    if (size === source.offset) return [];

    let start = source.offset;
    let length = size - start;
    if (length > CODEX_NOTIFY_READ_LIMIT_BYTES) {
      start = Math.max(0, size - CODEX_NOTIFY_READ_LIMIT_BYTES);
      length = size - start;
      source.remainder = "";
      logCodexNotification(`notify tail read: path=${source.filePath} len=${length}`);
    }

    const fd = fs.openSync(source.filePath, "r");
    const buf = Buffer.alloc(length);
    try { fs.readSync(fd, buf, 0, length, start); } finally { try { fs.closeSync(fd); } catch {} }
    source.offset = start + length;

    const text = source.remainder + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    source.remainder = lines.pop() || "";
    const out: CodexNotifyEntry[] = [];
    for (const line of lines) {
      const entry = parseCodexNotifyLine(line);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 中文说明：将 Codex 通知事件转发给渲染进程，并提示索引器抢先刷新最近历史。
 */
function emitCodexNotify(entry: CodexNotifyEntry, sourcePath?: string): void {
  const win = codexNotifyWindowGetter ? codexNotifyWindowGetter() : null;
  try {
    requestHistoryFastRefresh({
      providerId: "codex",
      sourcePath,
    });
  } catch {}
  if (!win) return;
  const providerId = String(entry.providerId || "codex").toLowerCase();
  if (providerId && providerId !== "codex") return;
  const { payload, dropReason } = buildCodexNotifyDispatch(entry, Date.now(), sourcePath);
  if (dropReason) {
    logCodexNotification(`notify event dropped reason=${dropReason} tab=${payload.tabId || "n/a"} kind=${payload.completionKind || "agent"} previewLen=${payload.preview.length}`);
    return;
  }
  try {
    win.webContents.send("notifications:externalAgentComplete", payload);
    logCodexNotification(`notify event tab=${payload.tabId || "n/a"} kind=${payload.completionKind || "agent"} agentType=${payload.agentType || "n/a"} agentId=${payload.agentId || "n/a"} previewLen=${payload.preview.length}`);
  } catch (error) {
    logCodexNotification(`emit notify failed: ${String(error)}`);
  }
}

/**
 * 中文说明：轮询读取 Codex notify 文件，避免依赖终端焦点与 OSC 触发条件。
 */
async function pollCodexNotifyFiles(): Promise<void> {
  if (codexNotifyPolling) return;
  codexNotifyPolling = true;
  try {
    for (const source of Array.from(codexNotifySources.values())) {
      const entries = readCodexNotifyEntries(source);
      if (!entries.length) continue;
      for (const entry of entries) emitCodexNotify(entry, source.filePath);
    }
  } finally {
    codexNotifyPolling = false;
  }
}

/**
 * 中文说明：启动 Codex 通知桥接（重复调用只刷新源列表）。
 */
export async function startCodexNotificationBridge(getWindow: () => BrowserWindow | null): Promise<void> {
  codexNotifyWindowGetter = getWindow;
  const paths = await listCodexNotifyFiles();
  syncCodexNotifySources(paths);
  try {
    const watchList = paths.map((p) => `${p}${fs.existsSync(p) ? "" : " (missing)"}`);
    logCodexNotification(`notify bridge watch=${watchList.join(" | ") || "none"}`);
  } catch {}
  if (codexNotifyTimer) return;
  codexNotifyTimer = setInterval(() => {
    void pollCodexNotifyFiles();
  }, CODEX_NOTIFY_POLL_INTERVAL_MS);
  try { logCodexNotification(`notify bridge started sources=${codexNotifySources.size}`); } catch {}
}

/**
 * 中文说明：停止 Codex 通知桥接。
 */
export function stopCodexNotificationBridge(): void {
  if (codexNotifyTimer) {
    try { clearInterval(codexNotifyTimer); } catch {}
  }
  codexNotifyTimer = null;
  codexNotifyPolling = false;
  codexNotifyWindowGetter = null;
  codexNotifySources.clear();
  recentCodexSubagentNotifies.length = 0;
}

export const __testing = {
  areCodexNotifyPreviewsEquivalent,
  buildCodexNotifyDispatch,
  isLegacySubagentCompletionPreview,
  normalizeCodexNotifyPreviewForDedupe,
  /**
   * 中文说明：重置 Codex notify 去重状态，避免测试用例之间互相污染。
   */
  resetCodexNotifyDedupeState() {
    recentCodexSubagentNotifies.length = 0;
  },
  /**
   * 中文说明：替换 legacy notify 状态判断读取器，便于测试覆盖不同 Codex SQLite 状态。
   */
  setCodexNotifyStateDecisionReader(reader?: (entry: CodexNotifyStateEntry, sourcePath?: string) => CodexNotifyStateDecision) {
    codexNotifyStateDecisionReader = reader || getCodexNotifyStateDecision;
  },
};

