// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { BrowserWindow } from "electron";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getGrokRootCandidatesFastAsync } from "../agentSessions/grok/discovery";
import { requestHistoryFastRefresh } from "../indexer";
import { perfLogger } from "../log";
import { uncToWsl, type SessionsRootCandidate } from "../wsl";

const GROK_HOOK_CONFIG_FILENAME = "codexflow-notifications.json";
const GROK_WINDOWS_HOOK_FILENAME = "codexflow-notify.ps1";
const GROK_WSL_HOOK_FILENAME = "codexflow-notify.sh";
const GROK_NOTIFY_DIRNAME = "codexflow";
const GROK_NOTIFY_FILENAME = "after-agent-notify.jsonl";
const GROK_NOTIFY_POLL_INTERVAL_MS = 1000;
const GROK_NOTIFY_READ_LIMIT_BYTES = 256 * 1024;

const GROK_WINDOWS_HOOK_SCRIPT = [
  "# SPDX-License-Identifier: Apache-2.0",
  '$ErrorActionPreference = "SilentlyContinue"',
  '$tabId = [string]$env:GROK_CODEXFLOW_TAB_ID',
  'if ([string]::IsNullOrWhiteSpace($tabId)) { exit 0 }',
  '$notifyPath = Join-Path (Split-Path -Parent $PSScriptRoot) "codexflow\\after-agent-notify.jsonl"',
  "$notifyDir = Split-Path -Parent $notifyPath",
  "[IO.Directory]::CreateDirectory($notifyDir) | Out-Null",
  "$utf8 = New-Object Text.UTF8Encoding($false)",
  '$inputJson = ""',
  "$inputStream = [Console]::OpenStandardInput()",
  "$inputBuffer = New-Object IO.MemoryStream",
  "try {",
  "  $inputStream.CopyTo($inputBuffer)",
  "  $inputJson = $utf8.GetString($inputBuffer.ToArray())",
  "} finally {",
  "  $inputBuffer.Dispose()",
  "}",
  "function Encode-Text([string]$value) {",
  '  if ($null -eq $value) { $value = "" }',
  "  return [Convert]::ToBase64String($utf8.GetBytes($value))",
  "}",
  "try {",
  "  if ((Test-Path -LiteralPath $notifyPath) -and (Get-Item -LiteralPath $notifyPath).Length -gt 1048576) {",
  '    [IO.File]::WriteAllText($notifyPath, "", $utf8)',
  "  }",
  "} catch {}",
  '$line = "v1`t" + (Encode-Text $tabId) + "`t" + (Encode-Text $env:GROK_CODEXFLOW_ENV_LABEL) + "`t" + (Encode-Text $env:GROK_CODEXFLOW_PROVIDER_ID) + "`t" + (Encode-Text $inputJson) + "`n"',
  "try { [IO.File]::AppendAllText($notifyPath, $line, $utf8) } catch {}",
  "exit 0",
  "",
].join("\n");

const GROK_WSL_HOOK_SCRIPT = String.raw`#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
case "$GROK_CODEXFLOW_TAB_ID" in *[![:space:]]*) ;; *) exit 0 ;; esac
notify_path="$(dirname "$(dirname "$0")")/codexflow/after-agent-notify.jsonl"
mkdir -p "$(dirname "$notify_path")" 2>/dev/null || true
input_json=$(cat)
encode_text() {
  printf '%s' "$1" | base64 | tr -d '\r\n'
}
if [ -f "$notify_path" ]; then
  size=$(wc -c < "$notify_path" 2>/dev/null || printf '0')
  if [ "$size" -gt 1048576 ] 2>/dev/null; then : > "$notify_path"; fi
fi
printf 'v1\t%s\t%s\t%s\t%s\n' \
  "$(encode_text "$GROK_CODEXFLOW_TAB_ID")" \
  "$(encode_text "$GROK_CODEXFLOW_ENV_LABEL")" \
  "$(encode_text "$GROK_CODEXFLOW_PROVIDER_ID")" \
  "$(encode_text "$input_json")" >> "$notify_path" 2>/dev/null || true
exit 0
`;

type GrokNotifySource = {
  filePath: string;
  offset: number;
  remainder: string;
};

type GrokHookEvent = {
  hookEventName?: string;
  sessionId?: string;
  cwd?: string;
  workspaceRoot?: string;
  timestamp?: string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  reason?: string;
  subagentId?: string;
  agentId?: string;
  subagentType?: string;
  agentType?: string;
};

type ParsedGrokHookEvent = {
  event: GrokHookEvent;
  usedFallback: boolean;
};

const GROK_EVENT_STRING_FIELDS: ReadonlyArray<keyof GrokHookEvent> = [
  "hookEventName",
  "sessionId",
  "cwd",
  "workspaceRoot",
  "timestamp",
  "transcriptPath",
  "lastAssistantMessage",
  "reason",
  "subagentId",
  "agentId",
  "subagentType",
  "agentType",
];

let ensureInflight: Promise<void> | null = null;
let notifyTimer: NodeJS.Timeout | null = null;
let notifyPolling = false;
let notifyWindowGetter: (() => BrowserWindow | null) | null = null;
let notifyGeneration = 0;
const notifySources = new Map<string, GrokNotifySource>();

/**
 * 写入 Grok 通知诊断日志。
 */
function logGrokNotification(message: string): void {
  try { perfLogger.log(`[grok.notify] ${message}`); } catch {}
}

/**
 * 获取候选根对应的 `.grok` 目录。
 */
function getGrokHomeFromCandidate(candidate: SessionsRootCandidate): string {
  return path.dirname(String(candidate.path || ""));
}

/**
 * 判断通知 Hook 是否应使用 POSIX shell 脚本。
 */
function shouldUsePosixHook(candidate: SessionsRootCandidate, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" || candidate.source === "wsl" || candidate.kind === "unc";
}

/**
 * 将命令参数转义为 Windows 命令行双引号参数。
 */
function quoteWindowsArgument(value: string): string {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

/**
 * 将命令参数转义为 POSIX shell 单引号字面量。
 */
function quotePosix(value: string): string {
  return `'${String(value || "").replace(/'/g, `'"'"'`)}'`;
}

/**
 * 仅在内容变化时写入 UTF-8 文本文件。
 */
async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const previous = await fsp.readFile(filePath, "utf8").catch(() => "");
    if (previous.replace(/^\uFEFF/, "") === content) return;
    await fsp.writeFile(filePath, content, "utf8");
  } catch (error) {
    logGrokNotification(`write failed path=${JSON.stringify(filePath)} error=${String(error)}`);
  }
}

/**
 * 构造单个 Grok 根目录使用的 Hook 配置。
 */
function buildHookConfig(command: string): string {
  const handler = { type: "command", command, timeout: 5 };
  return `${JSON.stringify({
    hooks: {
      Stop: [{ hooks: [handler] }],
      SubagentStop: [{ hooks: [handler] }],
    },
  }, null, 2)}\n`;
}

/**
 * 确保单个 Grok 根目录安装 CodexFlow 通知 Hook。
 */
async function ensureGrokNotificationForCandidate(candidate: SessionsRootCandidate): Promise<void> {
  const grokHome = getGrokHomeFromCandidate(candidate);
  if (!grokHome) return;
  const hooksDir = path.join(grokHome, "hooks");
  const notifyDir = path.join(grokHome, GROK_NOTIFY_DIRNAME);
  await fsp.mkdir(hooksDir, { recursive: true });
  await fsp.mkdir(notifyDir, { recursive: true });

  let command = "";
  if (shouldUsePosixHook(candidate)) {
    const scriptPath = path.join(hooksDir, GROK_WSL_HOOK_FILENAME);
    await writeFileIfChanged(scriptPath, GROK_WSL_HOOK_SCRIPT);
    const wslPath = uncToWsl(scriptPath)?.wslPath || scriptPath.replace(/\\/g, "/");
    command = `sh ${quotePosix(wslPath)}`;
  } else {
    const scriptPath = path.join(hooksDir, GROK_WINDOWS_HOOK_FILENAME);
    await writeFileIfChanged(scriptPath, GROK_WINDOWS_HOOK_SCRIPT);
    command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoteWindowsArgument(scriptPath)}`;
  }

  await writeFileIfChanged(path.join(hooksDir, GROK_HOOK_CONFIG_FILENAME), buildHookConfig(command));
}

/**
 * 确保 Windows 与 WSL 的所有 Grok 根均安装通知 Hook。
 */
export async function ensureAllGrokNotifications(): Promise<void> {
  if (ensureInflight) return ensureInflight;
  ensureInflight = (async () => {
    const candidates = await getGrokRootCandidatesFastAsync().catch((error) => {
      logGrokNotification(`discover failed error=${String(error)}`);
      return [] as SessionsRootCandidate[];
    });
    await Promise.all(candidates.map(async (candidate) => {
      try { await ensureGrokNotificationForCandidate(candidate); } catch (error) {
        logGrokNotification(`ensure failed root=${JSON.stringify(candidate.path)} error=${String(error)}`);
      }
    }));
  })().finally(() => { ensureInflight = null; });
  return ensureInflight;
}

/**
 * 列出所有 Grok 通知 JSONL 文件。
 */
async function listGrokNotifyFiles(): Promise<string[]> {
  const candidates = await getGrokRootCandidatesFastAsync().catch((error) => {
    logGrokNotification(`discover notify sources failed error=${String(error)}`);
    return [] as SessionsRootCandidate[];
  });
  const output: string[] = [];
  for (const candidate of candidates) {
    const grokHome = getGrokHomeFromCandidate(candidate);
    if (!grokHome) continue;
    const filePath = path.join(grokHome, GROK_NOTIFY_DIRNAME, GROK_NOTIFY_FILENAME);
    if (!output.includes(filePath)) output.push(filePath);
  }
  return output;
}

/**
 * 同步通知源列表，并从文件末尾开始监听，避免重复弹出旧通知。
 */
async function syncNotifySources(paths: string[], generation: number): Promise<void> {
  if (generation !== notifyGeneration) return;
  const nextKeys = new Set(paths.map((item) => path.normalize(item).toLowerCase()));
  for (const [key] of notifySources) {
    if (!nextKeys.has(key)) notifySources.delete(key);
  }
  for (const filePath of paths) {
    const key = path.normalize(filePath).toLowerCase();
    if (notifySources.has(key)) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    notifySources.set(key, { filePath, offset: Number(stat?.size || 0), remainder: "" });
  }
}

/**
 * 解码 Hook 行中的 Base64 UTF-8 字段。
 */
function decodeBase64(value: string): string {
  try { return Buffer.from(String(value || ""), "base64").toString("utf8"); } catch { return ""; }
}

/**
 * 将未知的 JSON 值限制为通知所需的字符串字段。
 */
function toGrokHookEvent(value: unknown): GrokHookEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const event: GrokHookEvent = {};
  for (const field of GROK_EVENT_STRING_FIELDS) {
    const fieldValue = source[field];
    if (typeof fieldValue === "string") event[field] = fieldValue;
  }
  return event;
}

/**
 * 判断事件是否代表可发送系统通知的 Grok 完成状态。
 */
function resolveGrokCompletionKind(event: GrokHookEvent): "agent" | "subagent" | null {
  const hookEventName = String(event.hookEventName || "").trim().toLowerCase();
  if (hookEventName === "subagent_stop" || hookEventName === "subagentstop") return "subagent";
  if (hookEventName !== "stop") return null;
  return String(event.reason || "").trim().toLowerCase() === "end_turn" ? "agent" : null;
}

/**
 * 在回复正文损坏时，仅恢复正文之前可严格解析的完成元数据。
 */
function recoverMalformedGrokHookEvent(rawEvent: string): GrokHookEvent | null {
  const messageFieldIndex = rawEvent.indexOf("\"lastAssistantMessage\"");
  if (messageFieldIndex < 0) return null;
  const metadataPrefix = rawEvent.slice(0, messageFieldIndex).replace(/,\s*$/, "");
  if (!metadataPrefix.trim()) return null;
  try {
    const event = toGrokHookEvent(JSON.parse(`${metadataPrefix}}`));
    return event && resolveGrokCompletionKind(event) ? event : null;
  } catch {
    return null;
  }
}

/**
 * 优先严格解析 Grok 事件，并在仅回复正文损坏时执行受限降级恢复。
 */
function parseGrokHookEvent(rawEvent: string): ParsedGrokHookEvent | null {
  try {
    const event = toGrokHookEvent(JSON.parse(rawEvent));
    return event ? { event, usedFallback: false } : null;
  } catch {
    const event = recoverMalformedGrokHookEvent(rawEvent);
    return event ? { event, usedFallback: true } : null;
  }
}

/**
 * 解析 Hook 写入的一行通知记录。
 */
function parseNotifyLine(line: string): { tabId: string; envLabel: string; providerId: string; event: GrokHookEvent } | null {
  const parts = String(line || "").split("\t");
  if (parts.length < 5 || parts[0] !== "v1") return null;
  const rawEvent = decodeBase64(parts.slice(4).join("\t")).replace(/^\uFEFF/, "");
  const parsedEvent = parseGrokHookEvent(rawEvent);
  if (!parsedEvent) {
    logGrokNotification(`event parse rejected rawLength=${Buffer.byteLength(rawEvent, "utf8")}`);
    return null;
  }
  if (parsedEvent.usedFallback) {
    const completionKind = resolveGrokCompletionKind(parsedEvent.event) || "unknown";
    logGrokNotification(`event parse fallback completion=${completionKind} rawLength=${Buffer.byteLength(rawEvent, "utf8")}`);
  }
  return {
    tabId: decodeBase64(parts[1]),
    envLabel: decodeBase64(parts[2]),
    providerId: decodeBase64(parts[3]) || "grok",
    event: parsedEvent.event,
  };
}

/**
 * 清理通知预览中的不可见控制字符并限制长度。
 */
function normalizePreview(value: unknown): string {
  const text = String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ").trim();
  const chars = Array.from(text);
  return chars.length <= 1200 ? text : `${chars.slice(0, 1200).join("")}...`;
}

/**
 * 解析 Grok 子代理类型，优先使用官方字段并兼容旧版字段。
 */
function resolveGrokAgentType(event: GrokHookEvent): string {
  return String(event.subagentType || event.agentType || "");
}

/**
 * 判断通知是否来自由 CodexFlow 启动并注入标签页标记的 Grok 会话。
 */
function hasGrokCodexFlowTabId(record: ReturnType<typeof parseNotifyLine>): boolean {
  return Boolean(String(record?.tabId || "").trim());
}

/**
 * 将 Grok Hook 事件转发给渲染进程。
 */
function emitNotifyRecord(record: ReturnType<typeof parseNotifyLine>, sourcePath: string, generation: number): void {
  if (!record || generation !== notifyGeneration) return;
  if (!hasGrokCodexFlowTabId(record)) {
    logGrokNotification("event dropped reason=missing-codexflow-tab-id");
    return;
  }
  const providerId = String(record.providerId || "grok").trim().toLowerCase();
  if (providerId !== "grok") return;
  const hookEventName = String(record.event.hookEventName || "").trim().toLowerCase();
  const completionKind = resolveGrokCompletionKind(record.event);
  if (!completionKind) return;

  const win = notifyWindowGetter?.() || null;
  if (!win || win.isDestroyed()) return;
  const timestamp = String(record.event.timestamp || new Date().toISOString());
  const sessionId = String(record.event.sessionId || "");
  const payload = {
    providerId: "grok" as const,
    tabId: String(record.tabId || ""),
    envLabel: String(record.envLabel || ""),
    preview: normalizePreview(record.event.lastAssistantMessage),
    timestamp,
    eventId: `${sessionId || "grok"}-${hookEventName}-${timestamp}`,
    hookEventName,
    completionKind,
    agentType: resolveGrokAgentType(record.event),
    agentId: String(record.event.subagentId || record.event.agentId || ""),
  };
  try {
    win.webContents.send("notifications:externalAgentComplete", payload);
    requestHistoryFastRefresh({ providerId: "grok", sourcePath });
  } catch (error) {
    logGrokNotification(`emit failed error=${String(error)}`);
  }
}

/**
 * 读取单个通知文件自上次 offset 之后的新增内容。
 */
async function pollNotifySource(source: GrokNotifySource, generation: number): Promise<void> {
  const stat = await fsp.stat(source.filePath).catch(() => null);
  if (!stat?.isFile()) return;
  if (stat.size < source.offset) {
    source.offset = 0;
    source.remainder = "";
  }
  if (stat.size <= source.offset) return;
  const end = Math.min(stat.size, source.offset + GROK_NOTIFY_READ_LIMIT_BYTES);
  const handle = await fsp.open(source.filePath, "r");
  try {
    const length = Math.max(0, end - source.offset);
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, source.offset);
    source.offset += read.bytesRead;
    const text = source.remainder + buffer.subarray(0, read.bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    source.remainder = lines.pop() || "";
    for (const line of lines) emitNotifyRecord(parseNotifyLine(line), source.filePath, generation);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 轮询所有 Grok 通知源。
 */
async function pollNotifyFiles(): Promise<void> {
  if (notifyPolling) return;
  const generation = notifyGeneration;
  notifyPolling = true;
  try {
    for (const source of notifySources.values()) {
      if (generation !== notifyGeneration) return;
      await pollNotifySource(source, generation).catch(() => {});
    }
  } finally {
    if (generation === notifyGeneration) notifyPolling = false;
  }
}

/**
 * 启动 Grok 通知桥接；重复调用时仅刷新通知源。
 */
export async function startGrokNotificationBridge(getWindow: () => BrowserWindow | null): Promise<void> {
  const generation = notifyGeneration;
  notifyWindowGetter = getWindow;
  try {
    await ensureAllGrokNotifications();
    const paths = await listGrokNotifyFiles();
    if (generation !== notifyGeneration) return;
    await syncNotifySources(paths, generation);
    if (notifyTimer) return;
    notifyTimer = setInterval(() => { void pollNotifyFiles(); }, GROK_NOTIFY_POLL_INTERVAL_MS);
    logGrokNotification(`bridge started sources=${notifySources.size} paths=${paths.length}`);
  } catch (error) {
    logGrokNotification(`bridge start failed error=${String(error)}`);
    throw error;
  }
}

/**
 * 停止 Grok 通知桥接并清理轮询状态。
 */
export function stopGrokNotificationBridge(): void {
  notifyGeneration += 1;
  if (notifyTimer) clearInterval(notifyTimer);
  notifyTimer = null;
  notifyPolling = false;
  notifyWindowGetter = null;
  notifySources.clear();
}

export const __testing = {
  parseNotifyLine,
  resolveGrokCompletionKind,
  resolveGrokAgentType,
  hasGrokCodexFlowTabId,
  shouldUsePosixHook,
};
