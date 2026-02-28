// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "../log";
import { getCodexRootsFastAsync } from "../wsl";

const CODEX_NOTIFY_FILENAME = "codexflow_after_agent_notify.jsonl";
const CODEX_NOTIFY_POLL_INTERVAL_MS = 1200;
const CODEX_NOTIFY_READ_LIMIT_BYTES = 128 * 1024;

type CodexNotifyEntry = {
  v?: number;
  eventId?: string;
  providerId?: string;
  tabId?: string;
  envLabel?: string;
  preview?: string;
  timestamp?: string;
};

type CodexNotifySource = {
  filePath: string;
  offset: number;
  remainder: string;
};

const codexNotifySources = new Map<string, CodexNotifySource>();
let codexNotifyTimer: NodeJS.Timeout | null = null;
let codexNotifyPolling = false;
let codexNotifyWindowGetter: (() => BrowserWindow | null) | null = null;

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
 * 中文说明：将 Codex 通知事件转发给渲染进程。
 */
function emitCodexNotify(entry: CodexNotifyEntry): void {
  const win = codexNotifyWindowGetter ? codexNotifyWindowGetter() : null;
  if (!win) return;
  const providerId = String(entry.providerId || "codex").toLowerCase();
  if (providerId && providerId !== "codex") return;
  const payload = {
    providerId: "codex" as const,
    tabId: entry.tabId ? String(entry.tabId) : "",
    envLabel: entry.envLabel ? String(entry.envLabel) : "",
    preview: entry.preview ? String(entry.preview) : "",
    timestamp: entry.timestamp ? String(entry.timestamp) : "",
    eventId: entry.eventId ? String(entry.eventId) : "",
  };
  try {
    win.webContents.send("notifications:externalAgentComplete", payload);
    logCodexNotification(`notify event tab=${payload.tabId || "n/a"} previewLen=${payload.preview.length}`);
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
      for (const entry of entries) emitCodexNotify(entry);
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
}

