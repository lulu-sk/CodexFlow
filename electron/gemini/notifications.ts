// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import { perfLogger } from "../log";
import { uncToWsl, type SessionsRootCandidate } from "../wsl";
import { getGeminiRootCandidatesFastAsync } from "../agentSessions/gemini/discovery";

const GEMINI_HOOK_FILENAME = "codexflow_after_agent_notify.js";
const GEMINI_NOTIFY_FILENAME = "codexflow_after_agent_notify.jsonl";
const GEMINI_HOOK_TIMEOUT_MS = 8000;
const GEMINI_NOTIFY_POLL_INTERVAL_MS = 1200;
const GEMINI_NOTIFY_READ_LIMIT_BYTES = 128 * 1024;

const GEMINI_HOOK_SCRIPT = String.raw`#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * CodexFlow: Gemini CLI AfterAgent hook -> OSC 9; agent-turn-complete
 *
 * 重要说明：
 * - Gemini CLI 会捕获 hook 的 stdout/stderr（用于 JSON 解析与遥测记录），默认不会把它们透传到终端。
 * - 因此这里不能依赖 stdout/stderr 来触发 CodexFlow 的 PTY 捕获：
 *   - 主通道：写入 JSONL 通知文件，供 CodexFlow 主进程轮询读取。
 *   - 兜底：尝试写入“控制台/TTY”（Windows: CONOUT$ / WSL: /dev/tty）。
 * - stdout 仍输出 JSON（suppressOutput=true），保证 hooks 行为稳定且不污染 transcript。
 */

const fs = require("node:fs");
const path = require("node:path");

// 中文说明：诊断日志路径（用于排查 hook 是否执行与写入路径）。
const LOG_PATH = path.join(__dirname, "codexflow_after_agent_notify.log");
const LOG_MAX_BYTES = 256 * 1024;
const NOTIFY_PATH = path.join(__dirname, "codexflow_after_agent_notify.jsonl");
const NOTIFY_MAX_BYTES = 512 * 1024;
const ENV_TAB_ID = "GEMINI_CLI_CODEXFLOW_TAB_ID";
const ENV_ENV_LABEL = "GEMINI_CLI_CODEXFLOW_ENV_LABEL";
const ENV_PROVIDER_ID = "GEMINI_CLI_CODEXFLOW_PROVIDER_ID";

/**
 * 中文说明：将多行压缩成单行，便于通知展示。
 */
function collapseWs(input) {
  const s = String(input || "");
  return s.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 中文说明：按 Unicode code point 截断，避免截断 surrogate pair 造成末尾乱码。
 */
function clip(input, limit) {
  const s = collapseWs(input);
  if (!s) return "";
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
 * 中文说明：追加诊断日志（带简单截断，避免无限增长）。
 */
function appendLog(message) {
  try {
    const line = "[" + new Date().toISOString() + "] " + String(message || "") + "\n";
    try {
      const st = fs.statSync(LOG_PATH);
      if (st && typeof st.size === "number" && st.size > LOG_MAX_BYTES) {
        fs.writeFileSync(LOG_PATH, "", "utf8");
      }
    } catch {}
    fs.appendFileSync(LOG_PATH, line, "utf8");
  } catch {}
}

/**
 * 中文说明：记录关键流程日志，便于排查 hook 是否执行。
 */
function logInfo(message) {
  appendLog(message);
}

/**
 * 中文说明：追加 CodexFlow 通知 JSONL（供主进程轮询）。
 */
function appendNotifyLine(payload) {
  try {
    const line = JSON.stringify(payload || {}) + "\n";
    try {
      const st = fs.statSync(NOTIFY_PATH);
      if (st && typeof st.size === "number" && st.size > NOTIFY_MAX_BYTES) {
        fs.writeFileSync(NOTIFY_PATH, "", "utf8");
      }
    } catch {}
    fs.appendFileSync(NOTIFY_PATH, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 中文说明：构造 JSONL 事件负载（包含 tabId/环境标签等元数据）。
 */
function buildNotifyPayload(input) {
  const tabId = String(process.env[ENV_TAB_ID] || "").trim();
  const envLabel = String(process.env[ENV_ENV_LABEL] || "").trim();
  const providerId = String(process.env[ENV_PROVIDER_ID] || "gemini").trim() || "gemini";
  const payload = {
    v: 1,
    eventId: String(process.pid) + "-" + String(Date.now()),
    providerId,
    tabId: tabId || "",
    envLabel: envLabel || "",
    preview: String(input?.preview || ""),
    timestamp: new Date().toISOString(),
    sessionId: typeof input?.sessionId === "string" ? input.sessionId : "",
    cwd: typeof input?.cwd === "string" ? input.cwd : "",
    transcriptPath: typeof input?.transcriptPath === "string" ? input.transcriptPath : "",
  };
  return payload;
}

const startTime = Date.now();
logInfo(
  "start pid=" + process.pid +
  " ppid=" + process.ppid +
  " platform=" + process.platform +
  " stdoutTTY=" + (process.stdout && process.stdout.isTTY ? "1" : "0") +
  " stderrTTY=" + (process.stderr && process.stderr.isTTY ? "1" : "0")
);

/**
 * 中文说明：读取 stdin（Gemini CLI 会向 hook 的 stdin 写入 JSON）。
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
 * 中文说明：安全解析 JSON；失败则返回 null。
 */
function safeParseJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

/**
 * 中文说明：移除可能破坏终端状态的控制字符。
 */
function stripControlChars(input) {
  const s = String(input || "");
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * 中文说明：从 PartListUnion 中提取可读文本（兼容 string / array）。
 */
function extractTextFromPartList(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (typeof p === "string") { parts.push(p); continue; }
    if (p && typeof p === "object") {
      if (typeof p.text === "string") { parts.push(p.text); continue; }
      if (typeof p.output_text === "string") { parts.push(p.output_text); continue; }
      if (typeof p.input_text === "string") { parts.push(p.input_text); continue; }
      if (typeof p.content === "string") { parts.push(p.content); continue; }
    }
  }
  return parts.join("\n");
}

/**
 * 中文说明：归一 Gemini 角色为 user/assistant/system/tool。
 */
function normalizeGeminiRole(raw) {
  const r = String(raw || "").toLowerCase().trim();
  if (r === "user" || r === "human" || r === "input") return "user";
  if (r === "assistant" || r === "model" || r === "gemini" || r === "output") return "assistant";
  if (r === "system") return "system";
  if (r === "tool" || r === "tool_use" || r === "tool_call" || r === "tool_result") return "tool";
  return "";
}

/**
 * 中文说明：从单条 item 中提取可展示文本（尽量容错）。
 */
function extractGeminiText(item) {
  try {
    if (!item) return "";
    if (typeof item === "string") return item.trim();
    const direct = item.text ?? item.content ?? item.message ?? item.input_text ?? item.output_text;
    if (typeof direct === "string") return direct.trim();
    if (Array.isArray(item.content)) return extractTextFromPartList(item.content).trim();
    if (item.content && typeof item.content === "object") {
      const nested = extractTextFromPartList([item.content]);
      if (nested && nested.trim()) return nested.trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 中文说明：兼容多种 Gemini session JSON 结构，统一抽取 items。
 */
function extractGeminiItems(root) {
  try {
    if (Array.isArray(root)) return root;
    if (root && typeof root === "object") {
      if (Array.isArray(root.messages)) return root.messages;
      if (Array.isArray(root.history)) return root.history;
      if (Array.isArray(root.items)) return root.items;
    }
  } catch {}
  return [];
}

/**
 * 中文说明：优先从 transcript_path 读取最后一条 Gemini 消息，确保与 CLI 展示一致。
 */
function extractPreviewFromTranscript(transcriptPath) {
  const p = typeof transcriptPath === "string" ? transcriptPath.trim() : "";
  if (!p) return "";
  let st;
  try { st = fs.statSync(p); } catch { return ""; }
  if (!st || !st.isFile || !st.isFile()) return "";
  if (typeof st.size === "number" && st.size > 5 * 1024 * 1024) return "";
  let raw = "";
  try { raw = fs.readFileSync(p, "utf8"); } catch { return ""; }
  if (!raw) return "";
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  const items = extractGeminiItems(obj);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const role = normalizeGeminiRole(String(it?.role ?? it?.type ?? it?.actor ?? ""));
    if (role !== "assistant") continue;
    const text = extractGeminiText(it);
    if (text && String(text).trim()) return String(text);
  }
  return "";
}

/**
 * 中文说明：尝试向已有 FD 写入 OSC 内容。
 */
function tryWriteFd(fd, text) {
  try {
    if (typeof fd !== "number") return false;
    fs.writeSync(fd, Buffer.from(String(text || ""), "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 中文说明：尝试向指定路径写入 OSC 内容，并记录失败原因。
 */
function tryWritePath(targetPath, mode, text, errors) {
  try {
    const fd = fs.openSync(targetPath, mode);
    try { fs.writeSync(fd, Buffer.from(String(text || ""), "utf8")); } finally { try { fs.closeSync(fd); } catch {} }
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : String(err || "");
    errors.push(targetPath + ":" + mode + ":" + code);
    return false;
  }
}

/**
 * 中文说明：尝试将 OSC 序列写入真正的终端（而非 stdout/stderr 管道）。
 */
function writeOscToControllingTty(oscText) {
  const text = String(oscText || "");
  if (!text) return { ok: false, reason: "empty", errors: [] };

  if (process.stdout && process.stdout.isTTY && tryWriteFd(process.stdout.fd, text)) {
    return { ok: true, reason: "stdout", errors: [] };
  }
  if (process.stderr && process.stderr.isTTY && tryWriteFd(process.stderr.fd, text)) {
    return { ok: true, reason: "stderr", errors: [] };
  }

  const errors = [];
  if (process.platform === "win32") {
    const targets = ["\\\\.\\CONOUT$", "CONOUT$"];
    const modes = ["w", "r+"];
    for (const p of targets) {
      for (const mode of modes) {
        if (tryWritePath(p, mode, text, errors)) return { ok: true, reason: "conout", errors };
      }
    }
    return { ok: false, reason: "conout-failed", errors };
  }

  const targets = ["/dev/tty"];
  const modes = ["w", "r+"];
  for (const p of targets) {
    for (const mode of modes) {
      if (tryWritePath(p, mode, text, errors)) return { ok: true, reason: "tty", errors };
    }
  }
  return { ok: false, reason: "tty-failed", errors };
}

const raw = safeReadStdin();
const data = safeParseJson(raw) || {};
const response = typeof data.prompt_response === "string" ? data.prompt_response : "";
const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
logInfo("input bytes=" + raw.length + " responseLen=" + response.length + " transcript=" + (transcriptPath ? "1" : "0"));
const fromTranscript = extractPreviewFromTranscript(transcriptPath);
const previewSource = fromTranscript || response;
const preview = clip(stripControlChars(previewSource), 240);

const ESC = "\u001b";
const BEL = "\u0007";
const payload = preview ? preview : "agent-turn-complete";
const osc = ESC + "]9;" + payload + BEL;

const notifyPayload = buildNotifyPayload({
  preview,
  sessionId: typeof data.session_id === "string" ? data.session_id : "",
  cwd: typeof data.cwd === "string" ? data.cwd : "",
  transcriptPath,
});
const notifyOk = appendNotifyLine(notifyPayload);
const hasCodexFlowEnv = !!(String(process.env[ENV_TAB_ID] || "").trim() || String(process.env[ENV_ENV_LABEL] || "").trim() || String(process.env[ENV_PROVIDER_ID] || "").trim());
const writeResult = notifyOk && hasCodexFlowEnv
  ? { ok: true, reason: "jsonl-only", errors: [] }
  : writeOscToControllingTty(osc);
logInfo(
  "write ok=" + (writeResult.ok ? "1" : "0") +
  " reason=" + writeResult.reason +
  " errors=" + (writeResult.errors || []).join("|") +
  " previewLen=" + String(preview || "").length +
  " notify=" + (notifyOk ? "1" : "0") +
  " durMs=" + (Date.now() - startTime)
);

try { process.stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
process.exit(0);
`;

type HookItem = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookItem[] };

/**
 * 中文说明：记录 Gemini 通知配置的调试日志。
 */
function logGeminiNotification(message: string) {
  try { perfLogger.log(`[gemini.notify] ${message}`); } catch {}
}

/**
 * 中文说明：确保目录存在。
 */
function ensureDir(dirPath: string) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch {}
}

/**
 * 中文说明：仅在内容变化时写入文件，避免无意义覆盖。
 */
function writeFileIfChanged(filePath: string, content: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, "utf8");
      if (current === content) return false;
    }
  } catch {}
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  } catch (error) {
    logGeminiNotification(`write script failed path=${filePath} error=${String(error)}`);
    return false;
  }
}

/**
 * 中文说明：安全读取 JSON 配置；解析失败则返回 null。
 */
function readJsonFile(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    logGeminiNotification(`read settings failed path=${filePath} error=${String(error)}`);
    return null;
  }
}

/**
 * 中文说明：将对象写回 JSON 文件（统一 2 空格缩进）。
 */
function writeJsonFile(filePath: string, data: any): boolean {
  try {
    ensureDir(path.dirname(filePath));
    const body = JSON.stringify(data ?? {}, null, 2) + "\n";
    fs.writeFileSync(filePath, body, "utf8");
    return true;
  } catch (error) {
    logGeminiNotification(`write settings failed path=${filePath} error=${String(error)}`);
    return false;
  }
}

/**
 * 中文说明：判断 hook 是否已指向 CodexFlow 的 Gemini 通知脚本。
 */
function isGeminiHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.toLowerCase().includes(GEMINI_HOOK_FILENAME);
}

/**
 * 中文说明：构造 Gemini AfterAgent hook 的执行命令（区分 Windows/WSL）。
 */
function buildGeminiHookCommand(rootPath: string, candidate: SessionsRootCandidate): string | null {
  const isWsl = candidate.source === "wsl" || candidate.kind === "unc";
  if (isWsl) {
    const wsl = uncToWsl(rootPath);
    if (!wsl?.wslPath) return null;
    const posixPath = path.posix.join(wsl.wslPath, "hooks", GEMINI_HOOK_FILENAME);
    return `node "${posixPath}"`;
  }
  const winPath = path.join(rootPath, "hooks", GEMINI_HOOK_FILENAME);
  return `node "${winPath}"`;
}

/**
 * 中文说明：在 AfterAgent hook 列表中注入/更新 CodexFlow 的通知 hook。
 */
function ensureGeminiAfterAgentHooks(groups: HookGroup[], command: string): { groups: HookGroup[]; changed: boolean } {
  const nextGroups: HookGroup[] = [];
  let changed = false;
  let found = false;

  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== "object") {
      nextGroups.push(rawGroup as HookGroup);
      continue;
    }
    const group: HookGroup = { ...rawGroup };
    const rawHooks = Array.isArray(group.hooks) ? group.hooks : [];
    const nextHooks: HookItem[] = [];

    for (const rawHook of rawHooks) {
      if (rawHook && typeof rawHook === "object" && isGeminiHookCommand(rawHook.command)) {
        if (!found) {
          const needsUpdate = rawHook.type !== "command" || rawHook.command !== command || rawHook.timeout !== GEMINI_HOOK_TIMEOUT_MS;
          const updated: HookItem = { ...rawHook, type: "command", command, timeout: GEMINI_HOOK_TIMEOUT_MS };
          nextHooks.push(updated);
          if (needsUpdate) changed = true;
          found = true;
        } else {
          changed = true;
        }
        continue;
      }
      nextHooks.push(rawHook);
    }

    if (!Array.isArray(group.hooks)) {
      changed = true;
      group.hooks = nextHooks;
    } else if (nextHooks.length !== rawHooks.length) {
      changed = true;
      group.hooks = nextHooks;
    } else if (nextHooks !== rawHooks) {
      group.hooks = nextHooks;
    }
    nextGroups.push(group);
  }

  if (!found) {
    nextGroups.push({
      matcher: "*",
      hooks: [{ type: "command", command, timeout: GEMINI_HOOK_TIMEOUT_MS }],
    });
    changed = true;
  }

  return { groups: nextGroups, changed };
}

/**
 * 中文说明：确保 Gemini settings.json 含有 CodexFlow 的 AfterAgent hook 配置。
 */
function ensureGeminiSettings(raw: any, command: string): { next: any; changed: boolean } {
  const base = raw && typeof raw === "object" ? { ...raw } : {};
  const tools = base.tools && typeof base.tools === "object" ? { ...(base.tools as any) } : {};
  const hooks = base.hooks && typeof base.hooks === "object" ? { ...(base.hooks as any) } : {};
  let changed = false;

  if (tools.enableHooks !== true) {
    tools.enableHooks = true;
    changed = true;
  }

  if (hooks.enabled !== true) {
    hooks.enabled = true;
    changed = true;
  }

  const afterGroups = Array.isArray(hooks.AfterAgent) ? hooks.AfterAgent as HookGroup[] : [];
  const { groups: nextGroups, changed: hooksChanged } = ensureGeminiAfterAgentHooks(afterGroups, command);

  if (!Array.isArray(hooks.AfterAgent)) changed = true;
  hooks.AfterAgent = nextGroups;
  base.tools = tools;
  base.hooks = hooks;

  return { next: base, changed: changed || hooksChanged };
}

/**
 * 中文说明：将 session 根路径转换为 Gemini 配置根路径（去掉 tmp 目录）。
 */
function toGeminiRootCandidate(candidate: SessionsRootCandidate): SessionsRootCandidate | null {
  const rawPath = String(candidate.path || "").trim();
  if (!rawPath) return null;
  const rootPath = path.dirname(rawPath);
  if (!rootPath || rootPath === "." || rootPath === path.sep) return null;
  return { ...candidate, path: rootPath };
}

/**
 * 中文说明：去重 Gemini 配置根路径候选（大小写不敏感）。
 */
function dedupeGeminiRoots(list: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const seen = new Map<string, SessionsRootCandidate>();
  for (const item of list) {
    const key = String(item.path || "").replace(/\\/g, "/").toLowerCase();
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    if (!prev.exists && item.exists) seen.set(key, item);
  }
  return Array.from(seen.values());
}

/**
 * 中文说明：对单个 Gemini 根目录写入通知 hook 与脚本。
 */
async function ensureGeminiNotificationsAtRoot(candidate: SessionsRootCandidate): Promise<void> {
  const rootPath = String(candidate.path || "").trim();
  if (!rootPath) return;

  const scriptPath = path.join(rootPath, "hooks", GEMINI_HOOK_FILENAME);
  const settingsPath = path.join(rootPath, "settings.json");
  const command = buildGeminiHookCommand(rootPath, candidate);
  if (!command) return;

  const scriptChanged = writeFileIfChanged(scriptPath, GEMINI_HOOK_SCRIPT);
  const current = readJsonFile(settingsPath);
  if (current == null) return;

  const { next, changed } = ensureGeminiSettings(current, command);
  const settingsChanged = changed ? writeJsonFile(settingsPath, next) : false;

  if (scriptChanged || settingsChanged) {
    logGeminiNotification(`ensure notifications root=${rootPath} script=${scriptChanged ? "1" : "0"} settings=${settingsChanged ? "1" : "0"}`);
  }
}

let inflight: Promise<void> | null = null;

/**
 * 中文说明：确保所有 Gemini CLI 根目录都配置完成通知 hook。
 */
export async function ensureAllGeminiNotifications(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    let roots: SessionsRootCandidate[] = [];
    try {
      const tmpRoots = await getGeminiRootCandidatesFastAsync();
      const rootCandidates: SessionsRootCandidate[] = [];
      for (const item of tmpRoots) {
        const root = toGeminiRootCandidate(item);
        if (root) rootCandidates.push(root);
      }
      roots = dedupeGeminiRoots(rootCandidates);
    } catch (error) {
      logGeminiNotification(`list roots failed: ${String(error)}`);
      return;
    }

    for (const root of roots) {
      try { await ensureGeminiNotificationsAtRoot(root); } catch {}
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

type GeminiNotifyEntry = {
  v?: number;
  eventId?: string;
  providerId?: string;
  tabId?: string;
  envLabel?: string;
  preview?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  transcriptPath?: string;
};

type GeminiNotifySource = {
  filePath: string;
  offset: number;
  remainder: string;
};

const geminiNotifySources = new Map<string, GeminiNotifySource>();
let geminiNotifyTimer: NodeJS.Timeout | null = null;
let geminiNotifyPolling = false;
let geminiNotifyWindowGetter: (() => BrowserWindow | null) | null = null;

/**
 * 中文说明：列出需要监听的 Gemini 通知文件路径（Windows/UNC）。
 */
async function listGeminiNotifyFiles(): Promise<string[]> {
  try {
    const tmpRoots = await getGeminiRootCandidatesFastAsync();
    const rootCandidates: SessionsRootCandidate[] = [];
    for (const item of tmpRoots) {
      const root = toGeminiRootCandidate(item);
      if (root) rootCandidates.push(root);
    }
    const roots = dedupeGeminiRoots(rootCandidates);
    return roots.map((root) => path.join(root.path, "hooks", GEMINI_NOTIFY_FILENAME));
  } catch (error) {
    logGeminiNotification(`list notify files failed: ${String(error)}`);
    return [];
  }
}

/**
 * 中文说明：同步通知源列表，保留已有读取偏移。
 */
function syncGeminiNotifySources(paths: string[]): void {
  const normalized = new Set<string>();
  for (const p of paths) {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (key) normalized.add(key);
  }
  for (const [key, source] of Array.from(geminiNotifySources.entries())) {
    if (!normalized.has(key)) {
      geminiNotifySources.delete(key);
      try { logGeminiNotification(`notify source removed path=${source.filePath}`); } catch {}
    }
  }
  for (const p of paths) {
    const key = String(p || "").replace(/\\/g, "/").toLowerCase();
    if (!key || geminiNotifySources.has(key)) continue;
    let offset = 0;
    try {
      const st = fs.statSync(p);
      if (st && st.isFile && st.isFile()) offset = typeof st.size === "number" ? st.size : 0;
    } catch {}
    geminiNotifySources.set(key, { filePath: p, offset, remainder: "" });
    try { logGeminiNotification(`notify source added path=${p} offset=${offset}`); } catch {}
  }
}

/**
 * 中文说明：解析单行 JSONL，失败则返回 null。
 */
function parseGeminiNotifyLine(line: string): GeminiNotifyEntry | null {
  const raw = String(line || "").trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj as GeminiNotifyEntry;
  } catch {
    return null;
  }
}

/**
 * 中文说明：从通知文件中读取新增内容并解析为事件列表。
 */
function readGeminiNotifyEntries(source: GeminiNotifySource): GeminiNotifyEntry[] {
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
    if (length > GEMINI_NOTIFY_READ_LIMIT_BYTES) {
      start = Math.max(0, size - GEMINI_NOTIFY_READ_LIMIT_BYTES);
      length = size - start;
      source.remainder = "";
      logGeminiNotification(`notify tail read: path=${source.filePath} len=${length}`);
    }

    const fd = fs.openSync(source.filePath, "r");
    const buf = Buffer.alloc(length);
    try { fs.readSync(fd, buf, 0, length, start); } finally { try { fs.closeSync(fd); } catch {} }
    source.offset = start + length;

    const text = source.remainder + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    source.remainder = lines.pop() || "";
    const out: GeminiNotifyEntry[] = [];
    for (const line of lines) {
      const entry = parseGeminiNotifyLine(line);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 中文说明：将 Gemini 通知事件转发给渲染进程。
 */
function emitGeminiNotify(entry: GeminiNotifyEntry): void {
  const win = geminiNotifyWindowGetter ? geminiNotifyWindowGetter() : null;
  if (!win) return;
  const providerId = String(entry.providerId || "gemini").toLowerCase();
  if (providerId && providerId !== "gemini") return;
  const payload = {
    providerId: "gemini" as const,
    tabId: entry.tabId ? String(entry.tabId) : "",
    envLabel: entry.envLabel ? String(entry.envLabel) : "",
    preview: entry.preview ? String(entry.preview) : "",
    timestamp: entry.timestamp ? String(entry.timestamp) : "",
    eventId: entry.eventId ? String(entry.eventId) : "",
  };
  try {
    win.webContents.send("notifications:externalAgentComplete", payload);
    logGeminiNotification(`notify event tab=${payload.tabId || "n/a"} previewLen=${payload.preview.length}`);
  } catch (error) {
    logGeminiNotification(`emit notify failed: ${String(error)}`);
  }
}

/**
 * 中文说明：轮询读取 Gemini 通知文件，避免依赖不稳定的 CONOUT$。
 */
async function pollGeminiNotifyFiles(): Promise<void> {
  if (geminiNotifyPolling) return;
  geminiNotifyPolling = true;
  try {
    for (const source of Array.from(geminiNotifySources.values())) {
      const entries = readGeminiNotifyEntries(source);
      if (!entries.length) continue;
      for (const entry of entries) emitGeminiNotify(entry);
    }
  } finally {
    geminiNotifyPolling = false;
  }
}

/**
 * 中文说明：启动 Gemini 通知桥接（重复调用只刷新源列表）。
 */
export async function startGeminiNotificationBridge(getWindow: () => BrowserWindow | null): Promise<void> {
  geminiNotifyWindowGetter = getWindow;
  const paths = await listGeminiNotifyFiles();
  syncGeminiNotifySources(paths);
  try {
    const watchList = paths.map((p) => {
      const exists = fs.existsSync(p);
      return `${p}${exists ? "" : " (missing)"}`;
    });
    logGeminiNotification(`notify bridge watch=${watchList.join(" | ") || "none"}`);
  } catch {}
  if (geminiNotifyTimer) return;
  geminiNotifyTimer = setInterval(() => {
    void pollGeminiNotifyFiles();
  }, GEMINI_NOTIFY_POLL_INTERVAL_MS);
  try { logGeminiNotification(`notify bridge started sources=${geminiNotifySources.size}`); } catch {}
}

/**
 * 中文说明：停止 Gemini 通知桥接。
 */
export function stopGeminiNotificationBridge(): void {
  if (geminiNotifyTimer) {
    try { clearInterval(geminiNotifyTimer); } catch {}
  }
  geminiNotifyTimer = null;
  geminiNotifyPolling = false;
  geminiNotifyWindowGetter = null;
  geminiNotifySources.clear();
}
