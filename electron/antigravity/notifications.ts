// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "../log";
import type { SessionsRootCandidate } from "../wsl";
import { getAntigravityRootCandidatesFastAsync } from "../agentSessions/antigravity/discovery";
import { parseAntigravitySessionFile } from "../agentSessions/antigravity/parser";
import { requestHistoryFastRefresh } from "../indexer";

const ANTIGRAVITY_HOOK_FILENAME = "codexflow_stop_notify.js";
const ANTIGRAVITY_NAMED_HOOK_ID = "codexflow-notify";
const ANTIGRAVITY_NOTIFY_FILENAME = "codexflow_after_agent_notify.jsonl";
const ANTIGRAVITY_HOOK_TIMEOUT_SECONDS = 8;
const ANTIGRAVITY_NOTIFY_POLL_INTERVAL_MS = 1200;
const ANTIGRAVITY_NOTIFY_READ_LIMIT_BYTES = 128 * 1024;
const ANTIGRAVITY_NOTIFY_PREVIEW_LIMIT_CHARS = 240;

const ANTIGRAVITY_HOOK_SCRIPT = String.raw`#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const fs = require("node:fs");
const path = require("node:path");

const LOG_PATH = path.join(__dirname, "codexflow_stop_notify.log");
const NOTIFY_PATH = path.join(__dirname, "codexflow_after_agent_notify.jsonl");
const LOG_MAX_BYTES = 256 * 1024;
const NOTIFY_MAX_BYTES = 512 * 1024;
const ENV_TAB_ID = "ANTIGRAVITY_CODEXFLOW_TAB_ID";
const ENV_ENV_LABEL = "ANTIGRAVITY_CODEXFLOW_ENV_LABEL";
const ENV_PROVIDER_ID = "ANTIGRAVITY_CODEXFLOW_PROVIDER_ID";

/**
 * 追加 hook 诊断日志，便于确认 Antigravity 是否真正执行了 hook。
 */
function appendLog(message) {
  try {
    const line = "[" + new Date().toISOString() + "] " + String(message || "") + "\n";
    try {
      const st = fs.statSync(LOG_PATH);
      if (st && typeof st.size === "number" && st.size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, "", "utf8");
    } catch {}
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch {}
}

/**
 * 追加 CodexFlow 通知事件 JSONL，并在文件过大时截断。
 */
function appendNotifyLine(payload) {
  try {
    const line = JSON.stringify(payload || {}) + "\n";
    try {
      const st = fs.statSync(NOTIFY_PATH);
      if (st && typeof st.size === "number" && st.size > NOTIFY_MAX_BYTES) fs.writeFileSync(NOTIFY_PATH, "", "utf8");
    } catch {}
    fs.appendFileSync(NOTIFY_PATH, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 hook 标准输入；Antigravity/Gemini 类 hook 会传入 JSON。
 */
function safeReadStdin() {
  try {
    const buf = fs.readFileSync(0);
    return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  } catch {
    return "";
  }
}

/**
 * 安全解析 JSON，解析失败时返回 null。
 */
function safeParseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

/**
 * 按字符裁剪通知预览，避免通知正文过长。
 */
function clip(input, limit) {
  const s = String(input || "");
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count >= limit) return out + "...";
    out += ch;
    count++;
  }
  return out;
}

/**
 * 清理会破坏 JSONL 或通知展示的控制字符，保留普通空白。
 */
function stripControlChars(input) {
  return String(input || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

/**
 * 兼容不同 hook 字段命名，提取第一段可读文本。
 */
function pickString() {
  for (const item of arguments) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (!item || typeof item !== "object") continue;
    const direct = item.text ?? item.content ?? item.message ?? item.displayContent ?? item.output_text ?? item.response;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const parts = item.parts ?? item.content ?? item.message?.content;
    if (!Array.isArray(parts)) continue;
    const out = [];
    for (const part of parts) {
      if (typeof part === "string") { out.push(part); continue; }
      if (!part || typeof part !== "object") continue;
      const text = part.text ?? part.content ?? part.message ?? part.output_text ?? part.input_text;
      if (typeof text === "string" && text.trim()) out.push(text);
    }
    const joined = out.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

/**
 * 从 hook 输入中提取明确标注的助手回复正文。
 *
 * Antigravity Stop hook 官方输入主要是结束元数据；不要递归猜字段，
 * 避免把 terminationReason=NO_TOOL_CALL 这类状态值当作正文。
 */
function pickHookResponse(data) {
  const direct = pickString(
    data.prompt_response,
    data.promptResponse,
    data.assistant_response,
    data.assistantResponse,
    data.final_response,
    data.finalResponse,
  );
  if (direct) return { text: direct, source: "direct" };
  return { text: "", source: "" };
}

/**
 * 输出 hook 输入的字段概况，不写入正文内容。
 */
function summarizeInputKeys(data) {
  try {
    if (!data || typeof data !== "object") return "";
    const top = Object.keys(data).slice(0, 24);
    const nested = [];
    for (const key of top) {
      const value = data[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const childKeys = Object.keys(value).slice(0, 12);
      if (childKeys.length) nested.push(key + "{" + childKeys.join(",") + "}");
    }
    return top.join(",") + (nested.length ? " nested=" + nested.join(";") : "");
  } catch {
    return "";
  }
}

/**
 * 构造主进程轮询读取的通知负载。
 */
function buildNotifyPayload(input) {
  const tabId = String(process.env[ENV_TAB_ID] || "").trim();
  const envLabel = String(process.env[ENV_ENV_LABEL] || "").trim();
  const providerId = String(process.env[ENV_PROVIDER_ID] || "antigravity").trim() || "antigravity";
  return {
    v: 1,
    eventId: String(process.pid) + "-" + String(Date.now()),
    providerId,
    tabId,
    envLabel,
    preview: String(input.preview || ""),
    previewEscapedWhitespace: false,
    timestamp: new Date().toISOString(),
    sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
    cwd: typeof input.cwd === "string" ? input.cwd : "",
    transcriptPath: typeof input.transcriptPath === "string" ? input.transcriptPath : "",
  };
}

const raw = safeReadStdin();
const data = safeParseJson(raw) || {};
const transcriptPath = pickString(data.transcript_path, data.transcriptPath);
const cwd = pickString(data.cwd, Array.isArray(data.workspacePaths) ? data.workspacePaths[0] : "");
const sessionId = pickString(data.session_id, data.sessionId, data.conversation_id, data.conversationId, data.conversation?.id);
const responseHit = pickHookResponse(data);
const directResponse = responseHit.text;
const preview = clip(stripControlChars(directResponse), 240);
const notifyOk = appendNotifyLine(buildNotifyPayload({ preview, sessionId, cwd, transcriptPath }));
appendLog("notify=" + (notifyOk ? "1" : "0") + " previewLen=" + String(preview || "").length + " inputBytes=" + raw.length + " session=" + (sessionId ? "1" : "0") + " transcript=" + (transcriptPath ? "1" : "0") + " responseSource=" + (responseHit.source || "none") + " keys=" + summarizeInputKeys(data));
try { process.stdout.write(JSON.stringify({ decision: "" })); } catch {}
process.exit(0);
`;

type HookItem = { type?: string; command?: string; timeout?: number };

type AntigravityNotifyEntry = {
  v?: number;
  eventId?: string;
  providerId?: string;
  tabId?: string;
  envLabel?: string;
  preview?: string;
  previewEscapedWhitespace?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  transcriptPath?: string;
};

type AntigravityNotifySource = {
  filePath: string;
  offset: number;
  remainder: string;
};
type WriteFileResult = { ok: boolean; changed: boolean };

const antigravityNotifySources = new Map<string, AntigravityNotifySource>();
let antigravityNotifyTimer: NodeJS.Timeout | null = null;
let antigravityNotifyPolling = false;
let antigravityNotifyWindowGetter: (() => BrowserWindow | null) | null = null;
let antigravityNotifyBridgeGeneration = 0;
let inflight: Promise<void> | null = null;

/**
 * 记录 Antigravity 通知配置和桥接日志。
 */
function logAntigravityNotification(message: string): void {
  try { perfLogger.log(`[antigravity.notify] ${message}`); } catch {}
}

/**
 * 确保目录存在。
 */
async function ensureDir(dirPath: string): Promise<void> {
  try { await fsp.mkdir(dirPath, { recursive: true }); } catch {}
}

/**
 * 仅在内容变化时写入文件，避免频繁刷新 hook 脚本修改时间。
 */
async function writeFileIfChanged(filePath: string, content: string): Promise<WriteFileResult> {
  try {
    const current = await fsp.readFile(filePath, "utf8");
    if (current === content) return { ok: true, changed: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { ok: false, changed: false };
  }
  try {
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(filePath, content, "utf8");
    return { ok: true, changed: true };
  } catch (error) {
    logAntigravityNotification(`write script failed path=${filePath} error=${String(error)}`);
    return { ok: false, changed: false };
  }
}

/**
 * 安全读取 JSON 配置文件，空文件按空对象处理。
 */
async function readJsonFile(filePath: string): Promise<any | null> {
  try {
    let raw = "";
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    logAntigravityNotification(`read hooks failed path=${filePath} error=${String(error)}`);
    return null;
  }
}

/**
 * 将 JSON 配置按 2 空格缩进写回。
 */
async function writeJsonFile(filePath: string, data: any): Promise<boolean> {
  try {
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(filePath, JSON.stringify(data ?? {}, null, 2) + "\n", "utf8");
    return true;
  } catch (error) {
    logAntigravityNotification(`write hooks failed path=${filePath} error=${String(error)}`);
    return false;
  }
}

/**
 * 判断命令是否是 CodexFlow 的 Antigravity 通知 hook。
 */
function isAntigravityHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const text = command.toLowerCase();
  return text.includes("codexflow_stop_notify") || text.includes("codexflow_after_agent_notify");
}

/**
 * 解析 Antigravity 全局 hooks.json 路径。
 */
function resolveAntigravityHooksJsonPath(rootPath: string): string {
  const root = String(rootPath || "").trim();
  const base = path.basename(root).toLowerCase();
  const geminiRoot = base === "antigravity-cli" || base === "antigravity"
    ? path.dirname(root)
    : root;
  return path.join(geminiRoot, "config", "hooks.json");
}

/**
 * 构造 Antigravity Stop hook 执行命令。
 *
 * Antigravity 的 JSON hook 当前不会按 shell 规则剥离引号；使用相对路径可避免
 * `config\"C:\...\script.js"` 这类路径拼接错误。
 */
function buildAntigravityHookCommand(scriptPath: string, hooksJsonPath: string): string {
  const configDir = path.dirname(hooksJsonPath);
  let commandPath = "";
  try {
    commandPath = path.relative(configDir, scriptPath);
  } catch {
    commandPath = scriptPath;
  }
  if (!commandPath) commandPath = scriptPath;
  commandPath = commandPath.replace(/\\/g, "/");
  return `node ${commandPath}`;
}

/**
 * 在 Antigravity Stop hook 列表中注入或更新 CodexFlow 通知 hook。
 */
function ensureAntigravityStopHooks(rawHooks: unknown, command: string): { hooks: HookItem[]; changed: boolean } {
  const hooks = Array.isArray(rawHooks) ? rawHooks : [];
  const nextHooks: HookItem[] = [];
  let changed = false;
  let found = false;

  if (!Array.isArray(rawHooks)) changed = true;

  for (const rawHook of hooks) {
    if (rawHook && typeof rawHook === "object" && isAntigravityHookCommand((rawHook as HookItem).command)) {
      if (!found) {
        const item = rawHook as HookItem;
        const needsUpdate = item.type !== "command" || item.command !== command || item.timeout !== ANTIGRAVITY_HOOK_TIMEOUT_SECONDS;
        nextHooks.push({ ...item, type: "command", command, timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS });
        if (needsUpdate) changed = true;
        found = true;
      } else {
        changed = true;
      }
      continue;
    }
    nextHooks.push(rawHook as HookItem);
  }

  if (!found) {
    nextHooks.push({ type: "command", command, timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS });
    changed = true;
  }

  return { hooks: nextHooks, changed };
}

/**
 * 清理非 Stop 事件中的历史 CodexFlow hook，避免同一轮完成重复触发旧脚本。
 */
function removeLegacyAntigravityHookItems(rawHooks: unknown): { hooks: HookItem[]; changed: boolean } {
  if (!Array.isArray(rawHooks)) return { hooks: [], changed: false };
  const next = rawHooks.filter((hook) => !(hook && typeof hook === "object" && isAntigravityHookCommand((hook as HookItem).command))) as HookItem[];
  return { hooks: next, changed: next.length !== rawHooks.length };
}

/**
 * 确保 Antigravity hooks.json 含有 CodexFlow 的 Stop 通知 hook。
 */
function ensureAntigravityHooksFile(raw: any, command: string): { next: any; changed: boolean } {
  const base = raw && typeof raw === "object" ? { ...raw } : {};
  const rawEntry = base[ANTIGRAVITY_NAMED_HOOK_ID];
  const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) ? { ...(rawEntry as any) } : {};
  let changed = false;

  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) changed = true;
  if (entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }

  for (const key of Object.keys(entry)) {
    if (key === "enabled" || key === "Stop") continue;
    const { hooks, changed: cleaned } = removeLegacyAntigravityHookItems(entry[key]);
    if (!cleaned) continue;
    changed = true;
    if (hooks.length > 0) entry[key] = hooks;
    else delete entry[key];
  }

  const { hooks: stopHooks, changed: stopChanged } = ensureAntigravityStopHooks(entry.Stop, command);
  entry.Stop = stopHooks;
  if (stopChanged) changed = true;

  base[ANTIGRAVITY_NAMED_HOOK_ID] = entry;

  return { next: base, changed };
}

/**
 * 将 conversations 根目录候选转换为 Antigravity 配置根目录。
 */
function toAntigravityConfigRootCandidate(candidate: SessionsRootCandidate): SessionsRootCandidate | null {
  const rawPath = String(candidate.path || "").trim();
  if (!rawPath) return null;
  const rootPath = path.basename(rawPath).toLowerCase() === "conversations" ? path.dirname(rawPath) : rawPath;
  if (!rootPath || rootPath === "." || rootPath === path.sep) return null;
  return { ...candidate, path: rootPath };
}

/**
 * 对 Antigravity 配置根目录候选去重，优先保留存在的路径。
 */
function dedupeAntigravityRoots(list: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const seen = new Map<string, SessionsRootCandidate>();
  for (const item of list) {
    const key = String(item.path || "").replace(/\\/g, "/").toLowerCase();
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || (!prev.exists && item.exists)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

/**
 * 读取 Antigravity 配置根目录候选。
 */
async function listAntigravityConfigRoots(): Promise<SessionsRootCandidate[]> {
  const conversationRoots = await getAntigravityRootCandidatesFastAsync();
  const roots: SessionsRootCandidate[] = [];
  for (const item of conversationRoots) {
    const root = toAntigravityConfigRootCandidate(item);
    if (root) roots.push(root);
  }
  return dedupeAntigravityRoots(roots);
}

/**
 * 对单个 Antigravity 根目录写入 hook 脚本和全局 hooks.json 配置。
 */
async function ensureAntigravityNotificationsAtRoot(candidate: SessionsRootCandidate): Promise<void> {
  const rootPath = String(candidate.path || "").trim();
  if (!rootPath) return;
  const scriptPath = path.join(rootPath, "hooks", ANTIGRAVITY_HOOK_FILENAME);
  const hooksJsonPath = resolveAntigravityHooksJsonPath(rootPath);
  const command = buildAntigravityHookCommand(scriptPath, hooksJsonPath);
  const scriptResult = await writeFileIfChanged(scriptPath, ANTIGRAVITY_HOOK_SCRIPT);
  if (!scriptResult.ok) return;
  const scriptChanged = scriptResult.changed;
  const current = await readJsonFile(hooksJsonPath);
  if (current == null) return;
  const { next, changed } = ensureAntigravityHooksFile(current, command);
  const hooksChanged = changed ? await writeJsonFile(hooksJsonPath, next) : false;
  if (scriptChanged || hooksChanged)
    logAntigravityNotification(`ensure notifications root=${rootPath} script=${scriptChanged ? "1" : "0"} hooks=${hooksChanged ? "1" : "0"}`);
}

/**
 * 确保所有 Antigravity CLI 根目录都配置完成通知 hook。
 */
export async function ensureAllAntigravityNotifications(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    let roots: SessionsRootCandidate[] = [];
    try {
      roots = await listAntigravityConfigRoots();
    } catch (error) {
      logAntigravityNotification(`list roots failed: ${String(error)}`);
      return;
    }
    for (const root of roots) {
      try { await ensureAntigravityNotificationsAtRoot(root); } catch {}
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * 列出需要轮询读取的 Antigravity 通知 JSONL 文件。
 */
async function listAntigravityNotifyFiles(): Promise<string[]> {
  try {
    const roots = await listAntigravityConfigRoots();
    return roots.map((root) => path.join(root.path, "hooks", ANTIGRAVITY_NOTIFY_FILENAME));
  } catch (error) {
    logAntigravityNotification(`list notify files failed: ${String(error)}`);
    return [];
  }
}

/**
 * 同步通知源列表，并保留已有读取偏移。
 */
async function syncAntigravityNotifySources(paths: string[], generation = antigravityNotifyBridgeGeneration): Promise<void> {
  if (generation !== antigravityNotifyBridgeGeneration) return;
  const normalized = new Set<string>();
  for (const p of paths) {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (key) normalized.add(key);
  }
  for (const [key, source] of Array.from(antigravityNotifySources.entries())) {
    if (!normalized.has(key)) {
      antigravityNotifySources.delete(key);
      logAntigravityNotification(`notify source removed path=${source.filePath}`);
    }
  }
  await Promise.all(paths.map(async (p) => {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (!key || antigravityNotifySources.has(key)) return;
    let offset = 0;
    try {
      const st = await fsp.stat(p);
      if (st && st.isFile && st.isFile()) offset = typeof st.size === "number" ? st.size : 0;
    } catch {}
    if (generation !== antigravityNotifyBridgeGeneration) return;
    antigravityNotifySources.set(key, { filePath: p, offset, remainder: "" });
    logAntigravityNotification(`notify source added path=${p} offset=${offset}`);
  }));
}

/**
 * 解析单行 Antigravity 通知 JSON。
 */
function parseAntigravityNotifyLine(line: string): AntigravityNotifyEntry | null {
  const raw = String(line || "").trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj as AntigravityNotifyEntry;
  } catch {
    return null;
  }
}

/**
 * 清理通知正文里不适合直接展示的控制字符。
 */
function stripPreviewControlChars(input: string): string {
  return String(input || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/**
 * 按字符数裁剪通知正文，避免单条通知过长。
 */
function clipPreview(input: string, limit = ANTIGRAVITY_NOTIFY_PREVIEW_LIMIT_CHARS): string {
  const text = stripPreviewControlChars(input);
  if (!text) return "";
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= limit) return `${out}...`;
    out += ch;
    count++;
  }
  return out;
}

/**
 * 判断 hook 传入的 preview 是否只是 Antigravity 结束状态，而不是助手正文。
 */
function isAntigravityStatusPreview(input?: string): boolean {
  const value = String(input || "").trim();
  if (!value) return false;
  return /^(NO_TOOL_CALL|ERROR|CANCELLED|INTERRUPTED|SUCCESS|FAILURE|TIMEOUT)$/i.test(value);
}

/**
 * 清理 Antigravity 会话 ID，确保只用于拼接会话 DB 文件名。
 */
function sanitizeAntigravitySessionId(input?: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const base = path.basename(raw).replace(/\.db$/i, "").trim();
  if (!base || base === "." || base === "..") return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(base)) return "";
  return base;
}

/**
 * 从 hook 通知文件路径反推 Antigravity CLI 根目录。
 */
function resolveAntigravityRootFromNotifyPath(sourcePath?: string): string {
  const raw = String(sourcePath || "").trim();
  if (!raw) return "";
  const normalized = path.normalize(raw);
  const dir = path.dirname(normalized);
  return path.basename(dir).toLowerCase() === "hooks" ? path.dirname(dir) : "";
}

/**
 * 从 transcriptPath 反推 Antigravity CLI 根目录。
 */
function resolveAntigravityRootFromTranscriptPath(transcriptPath?: string): string {
  const raw = String(transcriptPath || "").trim();
  if (!raw) return "";
  const normalized = path.normalize(raw);
  const marker = `${path.sep}brain${path.sep}`;
  const idx = normalized.toLowerCase().indexOf(marker);
  if (idx > 0) return normalized.slice(0, idx);
  return "";
}

/**
 * 定位 Antigravity 会话 SQLite DB；hook 只给 sessionId 时，用本地 conversations 目录补足。
 */
function listAntigravityConversationDbCandidates(entry: AntigravityNotifyEntry, sourcePath?: string): string[] {
  const sessionId = sanitizeAntigravitySessionId(entry.sessionId);
  if (!sessionId) return [];
  const roots = [
    resolveAntigravityRootFromNotifyPath(sourcePath),
    resolveAntigravityRootFromTranscriptPath(entry.transcriptPath),
  ].filter(Boolean);
  return roots.map((root) => path.join(root, "conversations", `${sessionId}.db`));
}

/**
 * 根据通知内容返回一个会话 DB 候选路径；仅做字符串处理，不访问 WSL 文件系统。
 */
function resolveAntigravityConversationDbPath(entry: AntigravityNotifyEntry, sourcePath?: string): string {
  return listAntigravityConversationDbCandidates(entry, sourcePath)[0] || "";
}

/**
 * 异步选择实际存在的 Antigravity 会话 DB，避免主进程同步访问 UNC 路径。
 */
async function resolveAntigravityConversationDbPathAsync(entry: AntigravityNotifyEntry, sourcePath?: string): Promise<string> {
  const candidates = listAntigravityConversationDbCandidates(entry, sourcePath);
  for (const candidate of candidates) {
    try {
      const st = await fsp.stat(candidate);
      if (st.isFile()) return candidate;
    } catch {}
  }
  return candidates[0] || "";
}

/**
 * 判断一段助手消息是否适合作为通知正文。
 */
function isAssistantPreviewContent(contentType?: string, tags?: string[]): boolean {
  const type = String(contentType || "").toLowerCase();
  if (type === "tool_call") return false;
  const tagText = (tags || []).join(" ").toLowerCase();
  if (tagText.includes("internal_tool")) return false;
  if (tagText.includes("raw")) return false;
  return true;
}

/**
 * 从完整 Antigravity 会话详情中提取最后一条助手回复正文。
 */
function extractLastAssistantPreview(details: Awaited<ReturnType<typeof parseAntigravitySessionFile>>): string {
  const messages = Array.isArray(details?.messages) ? details.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const parts: string[] = [];
    for (const item of msg.content || []) {
      if (!item || !isAssistantPreviewContent(item.type, item.tags)) continue;
      const text = stripPreviewControlChars(item.text || "");
      if (text) parts.push(text);
    }
    const joined = parts.join("\n").trim();
    if (joined) return clipPreview(joined);
  }
  return "";
}

/**
 * hook 未提供正文时，从 Antigravity 本地会话 DB 兜底补齐通知正文。
 */
async function hydrateAntigravityNotifyPreview(entry: AntigravityNotifyEntry, sourcePath?: string): Promise<AntigravityNotifyEntry> {
  const currentPreview = String(entry.preview || "").trim();
  if (currentPreview && !isAntigravityStatusPreview(currentPreview)) return entry;
  const dbPath = await resolveAntigravityConversationDbPathAsync(entry, sourcePath);
  if (!dbPath) return entry;
  try {
    const stat = await fsp.stat(dbPath);
    if (!stat || !stat.isFile()) return entry;
    const details = await parseAntigravitySessionFile(dbPath, stat, { summaryOnly: false });
    const preview = extractLastAssistantPreview(details);
    if (!preview) return currentPreview && isAntigravityStatusPreview(currentPreview) ? { ...entry, preview: "" } : entry;
    logAntigravityNotification(`hydrated preview session=${entry.sessionId || "n/a"} len=${preview.length}`);
    return { ...entry, preview, previewEscapedWhitespace: false, transcriptPath: entry.transcriptPath || dbPath };
  } catch (error) {
    logAntigravityNotification(`hydrate preview failed session=${entry.sessionId || "n/a"} error=${String(error)}`);
    return currentPreview && isAntigravityStatusPreview(currentPreview) ? { ...entry, preview: "" } : entry;
  }
}

/**
 * 从通知文件读取新增 JSONL 内容。
 */
async function readAntigravityNotifyEntries(source: AntigravityNotifySource): Promise<AntigravityNotifyEntry[]> {
  try {
    const st = await fsp.stat(source.filePath);
    if (!st || !st.isFile || !st.isFile()) return [];
    const size = typeof st.size === "number" ? st.size : 0;
    if (size < source.offset) {
      source.offset = 0;
      source.remainder = "";
    }
    if (size === source.offset) return [];

    let start = source.offset;
    let length = size - start;
    if (length > ANTIGRAVITY_NOTIFY_READ_LIMIT_BYTES) {
      start = Math.max(0, size - ANTIGRAVITY_NOTIFY_READ_LIMIT_BYTES);
      length = size - start;
      source.remainder = "";
      logAntigravityNotification(`notify tail read: path=${source.filePath} len=${length}`);
    }

    const fd = await fsp.open(source.filePath, "r");
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      const result = await fd.read(buf, 0, length, start);
      bytesRead = result.bytesRead;
    } finally { try { await fd.close(); } catch {} }
    source.offset = start + bytesRead;

    const text = source.remainder + buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/);
    source.remainder = lines.pop() || "";
    const out: AntigravityNotifyEntry[] = [];
    for (const line of lines) {
      const entry = parseAntigravityNotifyLine(line);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 将 Antigravity hook 通知转发给渲染进程，并触发历史快速刷新。
 */
async function emitAntigravityNotify(entry: AntigravityNotifyEntry, sourcePath?: string, generation = antigravityNotifyBridgeGeneration): Promise<void> {
  if (generation !== antigravityNotifyBridgeGeneration) return;
  entry = await hydrateAntigravityNotifyPreview(entry, sourcePath);
  if (generation !== antigravityNotifyBridgeGeneration) return;
  const win = antigravityNotifyWindowGetter ? antigravityNotifyWindowGetter() : null;
  try {
    requestHistoryFastRefresh({
      providerId: "antigravity",
      filePath: entry.transcriptPath,
      sourcePath,
    });
  } catch {}
  if (!win) return;
  const providerId = String(entry.providerId || "antigravity").toLowerCase();
  if (providerId && providerId !== "antigravity") return;
  const payload: {
    providerId: "antigravity";
    tabId: string;
    envLabel: string;
    preview: string;
    previewEscapedWhitespace?: boolean;
    timestamp: string;
    eventId: string;
  } = {
    providerId: "antigravity",
    tabId: entry.tabId ? String(entry.tabId) : "",
    envLabel: entry.envLabel ? String(entry.envLabel) : "",
    preview: entry.preview ? String(entry.preview) : "",
    timestamp: entry.timestamp ? String(entry.timestamp) : "",
    eventId: entry.eventId ? String(entry.eventId) : "",
  };
  if (typeof entry.previewEscapedWhitespace === "boolean")
    payload.previewEscapedWhitespace = entry.previewEscapedWhitespace;
  try {
    win.webContents.send("notifications:externalAgentComplete", payload);
    logAntigravityNotification(`notify event tab=${payload.tabId || "n/a"} previewLen=${payload.preview.length}`);
  } catch (error) {
    logAntigravityNotification(`emit notify failed: ${String(error)}`);
  }
}

/**
 * 轮询 Antigravity 通知 JSONL 文件。
 */
async function pollAntigravityNotifyFiles(): Promise<void> {
  if (antigravityNotifyPolling) return;
  const generation = antigravityNotifyBridgeGeneration;
  antigravityNotifyPolling = true;
  try {
    for (const source of Array.from(antigravityNotifySources.values())) {
      if (generation !== antigravityNotifyBridgeGeneration) return;
      const entries = await readAntigravityNotifyEntries(source);
      if (generation !== antigravityNotifyBridgeGeneration) return;
      if (!entries.length) continue;
      for (const entry of entries) {
        if (generation !== antigravityNotifyBridgeGeneration) return;
        await emitAntigravityNotify(entry, source.filePath, generation);
      }
    }
  } finally {
    if (generation === antigravityNotifyBridgeGeneration) antigravityNotifyPolling = false;
  }
}

/**
 * 启动 Antigravity 通知桥接，重复调用只刷新源列表。
 */
export async function startAntigravityNotificationBridge(getWindow: () => BrowserWindow | null): Promise<void> {
  const generation = antigravityNotifyBridgeGeneration;
  antigravityNotifyWindowGetter = getWindow;
  const paths = await listAntigravityNotifyFiles();
  if (generation !== antigravityNotifyBridgeGeneration) return;
  await syncAntigravityNotifySources(paths, generation);
  if (generation !== antigravityNotifyBridgeGeneration) return;
  try {
    const watchList = await Promise.all(paths.map(async (p) => {
      try {
        const st = await fsp.stat(p);
        return `${p}${st.isFile() ? "" : " (missing)"}`;
      } catch {
        return `${p} (missing)`;
      }
    }));
    if (generation !== antigravityNotifyBridgeGeneration) return;
    logAntigravityNotification(`notify bridge watch=${watchList.join(" | ") || "none"}`);
  } catch {}
  if (antigravityNotifyTimer) return;
  antigravityNotifyTimer = setInterval(() => {
    void pollAntigravityNotifyFiles();
  }, ANTIGRAVITY_NOTIFY_POLL_INTERVAL_MS);
  logAntigravityNotification(`notify bridge started sources=${antigravityNotifySources.size}`);
}

/**
 * 停止 Antigravity 通知桥接。
 */
export function stopAntigravityNotificationBridge(): void {
  antigravityNotifyBridgeGeneration += 1;
  if (antigravityNotifyTimer) {
    try { clearInterval(antigravityNotifyTimer); } catch {}
  }
  antigravityNotifyTimer = null;
  antigravityNotifyPolling = false;
  antigravityNotifyWindowGetter = null;
  antigravityNotifySources.clear();
}

export const __testing = {
  clipPreview,
  extractLastAssistantPreview,
  hydrateAntigravityNotifyPreview,
  isAntigravityStatusPreview,
  resolveAntigravityConversationDbPath,
  sanitizeAntigravitySessionId,
  stripPreviewControlChars,
};
