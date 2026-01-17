// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { perfLogger } from "../log";
import { uncToWsl, type SessionsRootCandidate } from "../wsl";
import { getClaudeRootCandidatesFastAsync } from "../agentSessions/claude/discovery";

const CLAUDE_HOOK_FILENAME = "codexflow_stop_notify.js";
const CLAUDE_HOOK_TIMEOUT_MS = 5000;

const CLAUDE_HOOK_SCRIPT = String.raw`#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * CodexFlow: Claude Code Stop hook -> OSC 9; agent-turn-complete
 *
 * 说明：
 * - Claude Code hook 的 stdout/stderr 会参与 CLI 的 hook 输出流程。
 * - 为避免污染 transcript，OSC 序列直接写入控制台（/dev/tty 或 CONOUT$）。
 */
const fs = require("node:fs");

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
 * 中文说明：读取 stdin（Claude Code 会向 hook 的 stdin 写入 JSON）。
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
 * 中文说明：从 content 中提取可读文本（兼容 string / array / object）。
 */
function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") { parts.push(p); continue; }
      if (p && typeof p === "object") {
        if (typeof p.text === "string") { parts.push(p.text); continue; }
        if (typeof p.content === "string") { parts.push(p.content); continue; }
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content.content)) return extractTextFromContent(content.content);
  }
  return "";
}

/**
 * 中文说明：判断是否为 Claude/assistant 角色。
 */
function isAssistantRole(role) {
  const v = String(role || "").toLowerCase();
  return v === "assistant" || v === "claude" || v === "ai";
}

/**
 * 中文说明：从单条 JSONL 记录中提取 Claude 回复文本。
 */
function extractPreviewFromEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
  const role = msg.role ?? entry.role ?? msg.sender ?? entry.sender ?? msg.type ?? entry.type;
  if (!isAssistantRole(role)) return "";
  const content = msg.content ?? entry.content ?? msg.message ?? "";
  return extractTextFromContent(content);
}

/**
 * 中文说明：从 transcript 的尾部读取最近的 Claude 回复。
 */
function extractPreviewFromTranscript(transcriptPath) {
  const p = typeof transcriptPath === "string" ? transcriptPath.trim() : "";
  if (!p) return "";
  let st;
  try { st = fs.statSync(p); } catch { return ""; }
  if (!st || !st.isFile || !st.isFile()) return "";
  const size = typeof st.size === "number" ? st.size : 0;
  if (size <= 0) return "";
  const maxBytes = 512 * 1024;
  const readSize = Math.min(size, maxBytes);
  let buffer = Buffer.alloc(readSize);
  let fd;
  try { fd = fs.openSync(p, "r"); } catch { return ""; }
  try {
    fs.readSync(fd, buffer, 0, readSize, size - readSize);
  } catch {}
  try { fs.closeSync(fd); } catch {}
  let text = "";
  try { text = buffer.toString("utf8"); } catch { return ""; }
  const lines = text.split(/\r?\n/);
  if (size > readSize && lines.length > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    const obj = safeParseJson(line);
    if (!obj) continue;
    const preview = extractPreviewFromEntry(obj);
    if (preview && String(preview).trim()) return String(preview);
  }
  return "";
}

/**
 * 中文说明：尝试将 OSC 序列写入真实终端（而非 stdout/stderr）。
 */
function writeOscToControllingTty(oscText) {
  const text = String(oscText || "");
  if (!text) return false;

  if (process.platform === "win32") {
    const targets = ["\\\\.\\CONOUT$", "CONOUT$"];
    for (const p of targets) {
      try {
        const fd = fs.openSync(p, "w");
        try { fs.writeSync(fd, text); } finally { try { fs.closeSync(fd); } catch {} }
        return true;
      } catch {}
    }
    return false;
  }

  try {
    const fd = fs.openSync("/dev/tty", "w");
    try { fs.writeSync(fd, text); } finally { try { fs.closeSync(fd); } catch {} }
    return true;
  } catch {
    return false;
  }
}

const raw = safeReadStdin();
const data = safeParseJson(raw) || {};
const directResponse =
  (typeof data.assistant_response === "string" ? data.assistant_response : "") ||
  (typeof data.response === "string" ? data.response : "") ||
  (typeof data.output === "string" ? data.output : "");
const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
const fromTranscript = directResponse ? "" : extractPreviewFromTranscript(transcriptPath);
const previewSource = directResponse || fromTranscript;
const preview = clip(stripControlChars(previewSource), 240);

const ESC = "\u001b";
const BEL = "\u0007";
const payload = preview ? preview : "agent-turn-complete";
const osc = ESC + "]9;" + payload + BEL;

writeOscToControllingTty(osc);

try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true })); } catch {}
process.exit(0);
`;

type HookItem = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookItem[] };

/**
 * 中文说明：记录 Claude 通知配置的调试日志。
 */
function logClaudeNotification(message: string) {
  try { perfLogger.log(`[claude.notify] ${message}`); } catch {}
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
    logClaudeNotification(`write script failed path=${filePath} error=${String(error)}`);
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
    logClaudeNotification(`read settings failed path=${filePath} error=${String(error)}`);
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
    logClaudeNotification(`write settings failed path=${filePath} error=${String(error)}`);
    return false;
  }
}

/**
 * 中文说明：判断 hook 是否已指向 CodexFlow 的 Claude 通知脚本。
 */
function isClaudeHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.toLowerCase().includes(CLAUDE_HOOK_FILENAME);
}

/**
 * 中文说明：构造 Claude Stop hook 的执行命令（区分 Windows/WSL）。
 */
function buildClaudeHookCommand(rootPath: string, candidate: SessionsRootCandidate): string | null {
  const isWsl = candidate.source === "wsl" || candidate.kind === "unc";
  if (isWsl) {
    const wsl = uncToWsl(rootPath);
    if (!wsl?.wslPath) return null;
    const posixPath = path.posix.join(wsl.wslPath, "hooks", CLAUDE_HOOK_FILENAME);
    return `node "${posixPath}"`;
  }
  const winPath = path.join(rootPath, "hooks", CLAUDE_HOOK_FILENAME);
  return `node "${winPath}"`;
}

/**
 * 中文说明：在 Stop hook 列表中注入/更新 CodexFlow 的通知 hook。
 */
function ensureClaudeStopHooks(groups: HookGroup[], command: string): { groups: HookGroup[]; changed: boolean } {
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
      if (rawHook && typeof rawHook === "object" && isClaudeHookCommand(rawHook.command)) {
        if (!found) {
          const needsUpdate = rawHook.type !== "command" || rawHook.command !== command || rawHook.timeout !== CLAUDE_HOOK_TIMEOUT_MS;
          const updated: HookItem = { ...rawHook, type: "command", command, timeout: CLAUDE_HOOK_TIMEOUT_MS };
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
      matcher: "",
      hooks: [{ type: "command", command, timeout: CLAUDE_HOOK_TIMEOUT_MS }],
    });
    changed = true;
  }

  return { groups: nextGroups, changed };
}

/**
 * 中文说明：确保 Claude settings.json 含有 CodexFlow 的 Stop hook 配置。
 */
function ensureClaudeSettings(raw: any, command: string): { next: any; changed: boolean } {
  const base = raw && typeof raw === "object" ? { ...raw } : {};
  const hooks = base.hooks && typeof base.hooks === "object" ? { ...(base.hooks as any) } : {};
  const stopGroups = Array.isArray(hooks.Stop) ? hooks.Stop as HookGroup[] : [];
  const { groups: nextGroups, changed: hooksChanged } = ensureClaudeStopHooks(stopGroups, command);

  if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
  hooks.Stop = nextGroups;
  base.hooks = hooks;

  return { next: base, changed: hooksChanged || !Array.isArray(raw?.hooks?.Stop) };
}

/**
 * 中文说明：对单个 Claude 根目录写入通知 hook 与脚本。
 */
async function ensureClaudeNotificationsAtRoot(candidate: SessionsRootCandidate): Promise<void> {
  const rootPath = String(candidate.path || "").trim();
  if (!rootPath) return;

  const scriptPath = path.join(rootPath, "hooks", CLAUDE_HOOK_FILENAME);
  const settingsPath = path.join(rootPath, "settings.json");
  const command = buildClaudeHookCommand(rootPath, candidate);
  if (!command) return;

  const scriptChanged = writeFileIfChanged(scriptPath, CLAUDE_HOOK_SCRIPT);
  const current = readJsonFile(settingsPath);
  if (current == null) return;

  const { next, changed } = ensureClaudeSettings(current, command);
  const settingsChanged = changed ? writeJsonFile(settingsPath, next) : false;

  if (scriptChanged || settingsChanged) {
    logClaudeNotification(`ensure notifications root=${rootPath} script=${scriptChanged ? "1" : "0"} settings=${settingsChanged ? "1" : "0"}`);
  }
}

let inflight: Promise<void> | null = null;

/**
 * 中文说明：确保所有 Claude Code 根目录都配置完成通知 hook。
 */
export async function ensureAllClaudeNotifications(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    let roots: SessionsRootCandidate[] = [];
    try {
      roots = await getClaudeRootCandidatesFastAsync();
    } catch (error) {
      logClaudeNotification(`list roots failed: ${String(error)}`);
      return;
    }

    for (const root of roots) {
      try { await ensureClaudeNotificationsAtRoot(root); } catch {}
    }
  })().finally(() => { inflight = null; });
  return inflight;
}
