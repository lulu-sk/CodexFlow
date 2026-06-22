// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { detectRuntimeShell } from "../../history";
import type { Message, RuntimeShell } from "../../history";
import { dirKeyFromCwd, dirKeyOfFilePath, tidyPathCandidate } from "../shared/path";
import { filterHistoryPreviewText } from "../shared/preview";

export type AntigravityParseOptions = {
  /** 索引阶段仅提取 cwd/preview 等轻量信息，避免完整展开。 */
  summaryOnly?: boolean;
  /** 详情阶段最多解析多少条 step；0 或缺失表示不限。 */
  maxSteps?: number;
};

export type AntigravitySessionDetails = {
  providerId: "antigravity";
  id: string;
  title: string;
  date: number;
  filePath: string;
  messages: Message[];
  skippedLines: number;
  rawDate?: string;
  cwd?: string;
  dirKey: string;
  preview?: string;
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};

type WireField = { field: number; wireType: number; value?: number; raw?: Buffer };
type SqliteDatabaseConstructor = new (filePath: string, options?: Record<string, unknown>) => any;
type StepRow = {
  idx: number;
  step_type: number;
  status: number;
  step_payload: Buffer | null;
  metadata?: Buffer | null;
  permissions?: Buffer | null;
  task_details?: Buffer | null;
};

type CwdCandidate = {
  path: string;
  score: number;
};

type AntigravityHistoryWorkspaceEntry = {
  workspace: string;
  score: number;
};

const STEP_TYPE_NAMES: Record<number, string> = {
  5: "CODE_ACTION",
  7: "GREP_SEARCH",
  8: "VIEW_FILE",
  9: "LIST_DIRECTORY",
  14: "USER_INPUT",
  15: "PLANNER_RESPONSE",
  17: "ERROR_MESSAGE",
  21: "RUN_COMMAND",
  23: "CHECKPOINT",
  98: "CONVERSATION_HISTORY",
  101: "SYSTEM_MESSAGE",
};

const STEP_CONTENT_FIELD: Record<number, number> = {
  5: 10,
  7: 13,
  8: 14,
  9: 15,
  14: 19,
  15: 20,
  17: 24,
  21: 28,
  23: 30,
  98: 111,
  101: 114,
};

/**
 * 读取 SQLite 构造器；测试可通过 global 注入，生产路径延迟加载 better-sqlite3。
 */
function getSqliteDatabaseConstructor(): SqliteDatabaseConstructor {
  const injected = (global as any).__antigravityDatabaseCtorForTest;
  if (typeof injected === "function") return injected as SqliteDatabaseConstructor;
  const mod = require("better-sqlite3");
  return (mod.default || mod) as SqliteDatabaseConstructor;
}

/**
 * 对 buffer 做 SHA-256 哈希，并输出小写 hex。
 */
function sha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 从 Antigravity DB 文件名提取 conversation id。
 */
function conversationIdFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.db$/i, "");
  return base || sha256Buffer(Buffer.from(filePath)).slice(0, 32);
}

/**
 * 读取 protobuf varint。
 */
function readVarint(buf: Buffer, start: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let index = start;
  while (index < buf.length && shift < 53) {
    const byte = buf[index++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return { value: result, next: index };
    shift += 7;
  }
  return null;
}

/**
 * 轻量解析 protobuf wire 字段。
 */
function parseWireFields(input: Buffer | Uint8Array | null | undefined, maxFields = 512): WireField[] {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const out: WireField[] = [];
  let index = 0;
  while (index < buf.length && out.length < maxFields) {
    const tag = readVarint(buf, index);
    if (!tag || tag.value <= 0) break;
    index = tag.next;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    const entry: WireField = { field, wireType };

    if (wireType === 0) {
      const value = readVarint(buf, index);
      if (!value) break;
      entry.value = value.value;
      index = value.next;
    } else if (wireType === 1) {
      index += 8;
      if (index > buf.length) break;
    } else if (wireType === 2) {
      const len = readVarint(buf, index);
      if (!len) break;
      const start = len.next;
      const end = start + Math.max(0, len.value);
      if (end > buf.length) break;
      entry.raw = buf.subarray(start, end);
      index = end;
    } else if (wireType === 5) {
      index += 4;
      if (index > buf.length) break;
    } else {
      break;
    }
    out.push(entry);
  }
  return out;
}

/**
 * 获取指定 length-delimited 字段的最后一个值。
 */
function getLastBytes(fields: WireField[], fieldNumber: number): Buffer | null {
  let hit: Buffer | null = null;
  for (const field of fields) {
    if (field.field === fieldNumber && field.wireType === 2 && field.raw) hit = field.raw;
  }
  return hit;
}

/**
 * 尝试将二进制字段按 UTF-8 文本读取。
 */
function decodeText(buf: Buffer | null | undefined): string {
  if (!buf || buf.length === 0) return "";
  try {
    const text = buf.toString("utf8").replace(/\u0000/g, "").trim();
    if (!text) return "";
    const printable = Array.from(text).filter((ch) => ch === "\n" || ch === "\r" || ch === "\t" || ch >= " ").length;
    if (printable / Math.max(1, text.length) < 0.82) return "";
    return text;
  } catch {
    return "";
  }
}

/**
 * 递归收集 protobuf 中可读字符串，按出现顺序去重。
 */
function collectTextLeaves(buf: Buffer | null | undefined, depth = 0, out: string[] = [], seen = new Set<string>()): string[] {
  if (!buf || buf.length === 0 || depth > 6 || out.length >= 80) return out;
  for (const field of parseWireFields(buf, 256)) {
    if (field.wireType !== 2 || !field.raw || field.raw.length === 0) continue;
    const text = decodeText(field.raw);
    if (text && !seen.has(text) && text.length <= 500_000) {
      seen.add(text);
      out.push(text);
      if (out.length >= 80) break;
    }
    if (field.raw.length >= 2) collectTextLeaves(field.raw, depth + 1, out, seen);
  }
  return out;
}

/**
 * 收集指定 protobuf 子字段的可读文本，用于跳过外层 envelope 中混杂的元数据。
 */
function collectTextLeavesFromFieldPath(buf: Buffer | null | undefined, fieldPath: number[]): string[] {
  if (!buf || fieldPath.length === 0) return [];
  let current: Buffer[] = [Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])];
  for (const fieldNumber of fieldPath) {
    const next: Buffer[] = [];
    for (const item of current) {
      for (const field of parseWireFields(item, 256)) {
        if (field.field === fieldNumber && field.wireType === 2 && field.raw && field.raw.length > 0)
          next.push(field.raw);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of current) {
    const text = decodeText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
    for (const nested of collectTextLeaves(item)) {
      if (!nested || seen.has(nested)) continue;
      seen.add(nested);
      out.push(nested);
    }
  }
  return out;
}

/**
 * 判断文本是否包含明显的二进制残留或 UTF-8 解码损伤。
 */
function hasBinaryTextDamage(text: string): boolean {
  const value = String(text || "");
  if (!value) return false;
  const chars = Array.from(value);
  const replacementCount = chars.filter((ch) => ch === "\uFFFD").length;
  const controlCount = chars.filter((ch) => /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(ch)).length;
  return replacementCount > 0 || controlCount / Math.max(1, chars.length) > 0.01;
}

/**
 * 判断文本是否是 Antigravity 内部状态标识，而不是用户应看到的正文。
 */
function isInternalAntigravityText(text: string): boolean {
  const value = String(text || "").trim();
  return /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 判断文本是否像 Antigravity 工具参数或结构化载荷，而不是自然语言回复。
 */
function looksLikeToolPayloadText(text: string): boolean {
  const value = String(text || "");
  return /"?(DirectoryPath|toolAction|toolSummary|toolInput|workspaceRoot|currentDirectory)"?\s*:/.test(value)
    || /\b(list_dir|grep_search|view_file|run_command)\b/i.test(value);
}

/**
 * 判断文本是否适合直接显示在历史详情里。
 */
function isDisplayTextCandidate(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (isInternalAntigravityText(value)) return false;
  if (hasBinaryTextDamage(value)) return false;
  if (looksLikeToolPayloadText(value) && (/^\s*[{[]/.test(value) || /^\s*(list_dir|grep_search|view_file|run_command)\b/i.test(value) || /"?(DirectoryPath|toolAction|toolSummary|toolInput)"?\s*:/.test(value))) return false;
  return true;
}

/**
 * 粗略判断文本是否包含自然语言句子特征。
 */
function hasNaturalLanguageSignal(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
    || /[.!?。！？]\s*$/.test(text.trim())
    || /\b(the|you|your|hello|please|workspace|project|done|success)\b/i.test(text);
}

/**
 * 给候选正文打分，优先自然语言，降低工具参数和结构化片段优先级。
 */
function scorePrimaryTextCandidate(text: string, index: number): number {
  let score = Math.min(80, text.length / 8) - index;
  if (hasNaturalLanguageSignal(text)) score += 80;
  if (looksLikeToolPayloadText(text)) score -= 120;
  if (/^\s*[{[]/.test(text)) score -= 60;
  return score;
}

/**
 * 从近似 JSON 的工具载荷中提取指定字段。
 */
function extractJsonishToolField(text: string, fieldName: string): string {
  const pattern = new RegExp(`"?${fieldName}"?\\s*:\\s*"([^"\\r\\n]*)"`, "i");
  const match = String(text || "").match(pattern);
  if (!match) return "";
  return match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
}

/**
 * 将混有 protobuf 残留的工具载荷整理成可读摘要。
 */
function sanitizeToolPayloadText(texts: string[]): string {
  for (const text of texts) {
    if (!looksLikeToolPayloadText(text)) continue;
    const lines: string[] = [];
    const toolName = text.match(/\b(list_dir|grep_search|view_file|run_command)\b/i)?.[1];
    const pathCandidate = selectBestCwdCandidate(collectCwdCandidatesFromText(text));
    const toolAction = extractJsonishToolField(text, "toolAction");
    const toolSummary = extractJsonishToolField(text, "toolSummary");
    if (toolName) lines.push(toolName);
    if (pathCandidate?.path) lines.push(`DirectoryPath: ${pathCandidate.path}`);
    if (toolAction) lines.push(`toolAction: ${toolAction}`);
    if (toolSummary) lines.push(`toolSummary: ${toolSummary}`);
    const cleaned = lines.filter(Boolean).join("\n").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * 按 Antigravity step 类型挑选最适合作为正文的文本。
 */
function selectPrimaryText(stepType: number, texts: string[]): string {
  const list = texts.map((text) => text.trim()).filter(isDisplayTextCandidate);
  if (list.length === 0) return "";
  const longEnough = list.filter((text) => text.length >= 2);
  const source = longEnough.length > 0 ? longEnough : list;
  if (stepType === 14) return source[0] || "";
  if (stepType === 15) {
    let best = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    source.forEach((text, index) => {
      const score = scorePrimaryTextCandidate(text, index);
      if (score > bestScore) {
        best = text;
        bestScore = score;
      }
    });
    return best;
  }
  return source.slice(0, 8).join("\n").trim();
}

/**
 * 从 planner 响应 payload 中优先提取纯助手正文，避开外层 protobuf 元数据。
 */
function selectPlannerResponseText(content: Buffer): string {
  const directTexts = [
    ...collectTextLeavesFromFieldPath(content, [1]),
    ...collectTextLeavesFromFieldPath(content, [8]),
  ];
  const direct = selectPrimaryText(15, directTexts);
  if (direct) return direct;
  return selectPrimaryText(15, collectTextLeaves(content));
}

/**
 * 构造 raw fallback 文本，避免丢失未知 step 的可追踪信息。
 */
function rawFallbackText(args: { idx: number; stepType: number; status: number; payload: Buffer | null | undefined; reason?: string }): string {
  const payload = args.payload && Buffer.isBuffer(args.payload) ? args.payload : Buffer.from(args.payload || []);
  const hash = payload.length > 0 ? sha256Buffer(payload) : "";
  return [
    `idx: ${args.idx}`,
    `step_type: ${args.stepType} (${STEP_TYPE_NAMES[args.stepType] || "UNKNOWN"})`,
    `status: ${args.status}`,
    args.reason ? `reason: ${args.reason}` : "",
    `payload_bytes: ${payload.length}`,
    hash ? `payload_sha256: ${hash}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 将 Antigravity step 转成 CodexFlow 历史消息。
 */
function convertStepToMessages(row: StepRow): Message[] {
  const payload = row.step_payload && Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(row.step_payload || []);
  const envelope = parseWireFields(payload);
  const contentField = STEP_CONTENT_FIELD[row.step_type];
  const content = contentField ? getLastBytes(envelope, contentField) : null;
  if (!content || content.length === 0) {
    if (row.step_type === 98) return [];
    return [{ role: "meta", content: [{ type: "raw_protobuf", text: rawFallbackText({ idx: row.idx, stepType: row.step_type, status: row.status, payload, reason: "missing_content" }), tags: ["antigravity.raw"] }] }];
  }

  const texts = collectTextLeaves(content);
  const primary = row.step_type === 15 ? selectPlannerResponseText(content) : selectPrimaryText(row.step_type, texts);
  const sanitizedToolText = sanitizeToolPayloadText(texts);
  const metaText = rawFallbackText({ idx: row.idx, stepType: row.step_type, status: row.status, payload: content });
  const stepName = STEP_TYPE_NAMES[row.step_type] || `TYPE_${row.step_type}`;

  if (row.step_type === 14) {
    return primary
      ? [{ role: "user", content: [{ type: "input_text", text: primary, tags: ["antigravity.user_input"] }] }]
      : [{ role: "meta", content: [{ type: "raw_protobuf", text: metaText, tags: ["antigravity.raw", "antigravity.user_input"] }] }];
  }

  if (row.step_type === 15) {
    if (!primary && sanitizedToolText)
      return [{ role: "tool", content: [{ type: "tool_result", text: sanitizedToolText, tags: ["antigravity.internal_tool"] }] }];
    if (!primary) return [];
    const contentItems = primary
      ? [{ type: "output_text", text: primary, tags: ["antigravity.planner_response"] }]
      : [];
    return [{ role: "assistant", content: contentItems }];
  }

  if (row.step_type === 17) {
    return [{ role: "tool", content: [{ type: "tool_result", text: primary || metaText, tags: ["antigravity.error_message"] }] }];
  }

  if (row.step_type === 101) {
    return [{ role: "system", content: [{ type: "meta", text: primary || metaText, tags: ["antigravity.system_message"] }] }];
  }

  if (row.step_type === 23) {
    return [{ role: "state", content: [{ type: "state", text: primary || metaText, tags: ["antigravity.checkpoint"] }] }];
  }

  if (row.step_type === 5 || row.step_type === 7 || row.step_type === 8 || row.step_type === 9 || row.step_type === 21) {
    const body = primary || sanitizedToolText || metaText;
    return [
      { role: "assistant", content: [{ type: "tool_call", text: stepName, tags: [`antigravity.${stepName.toLowerCase()}`] }] },
      { role: "tool", content: [{ type: "tool_result", text: body, tags: [`antigravity.${stepName.toLowerCase()}`] }] },
    ];
  }

  return [{ role: "meta", content: [{ type: "raw_protobuf", text: primary || metaText, tags: ["antigravity.raw"] }] }];
}

/**
 * 清理 cwd 候选中的 JSON/日志尾巴。
 */
function cleanCwdPathCandidate(value: string): string {
  let cleaned = tidyPathCandidate(value)
    .replace(/^file:\/\/\//i, "")
    .replace(/[),}\]]+$/g, "")
    .replace(/["']+$/g, "")
    .trim();
  cleaned = cleaned.replace(/^[a-zA-Z]:\/{2,}([a-zA-Z]:\/.*)$/i, "$1");
  try {
    if (/%[0-9a-fA-F]{2}/.test(cleaned)) cleaned = decodeURI(cleaned);
  } catch {}
  cleaned = tidyPathCandidate(cleaned);
  return cleaned;
}

/**
 * 计算路径深度，用于选择更具体的项目目录。
 */
function cwdPathDepth(value: string): number {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return 0;
  return normalized.split("/").filter(Boolean).length;
}

/**
 * 判断路径是否只是用户主目录本身。
 */
function isLikelyUserHomeRoot(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/g, "");
  return /^[a-zA-Z]:\/Users\/[^/]+$/i.test(normalized)
    || /^\/mnt\/[a-zA-Z]\/Users\/[^/]+$/i.test(normalized)
    || /^\/home\/[^/]+$/i.test(normalized)
    || /^\/Users\/[^/]+$/i.test(normalized);
}

/**
 * 判断路径是否明显指向 Antigravity 历史存储目录，而不是项目工作区。
 */
function isLikelyHistoryStoragePath(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/.gemini/antigravity-cli/")
    || normalized.includes("/.gemini/skills")
    || normalized.includes("/antigravity-cli/conversations")
    || normalized.includes("/appdata/roaming/")
    || normalized.includes("/appdata/local/");
}

/**
 * 给 cwd 候选打分，优先工具参数里的工作区目录和更具体的项目路径。
 */
function scoreCwdCandidate(pathValue: string, sourceText: string, explicitScore: number): number {
  const depth = cwdPathDepth(pathValue);
  let score = explicitScore + Math.min(90, depth * 12) + Math.min(60, pathValue.length / 3);
  const source = String(sourceText || "");
  if (/DirectoryPath/i.test(source)) score += 80;
  if (/(workspace|workspaceRoot|currentDirectory|cwd|project)/i.test(source)) score += 45;
  if (/Listing workspace directory/i.test(source)) score += 35;
  if (isLikelyUserHomeRoot(pathValue)) score -= 160;
  if (isLikelyHistoryStoragePath(pathValue)) score -= 140;
  if (depth <= 2) score -= 50;
  return score;
}

/**
 * 从一段文本中收集 cwd 候选。
 */
function collectCwdCandidatesFromText(text: string): CwdCandidate[] {
  const value = String(text || "");
  if (!value) return [];
  const out: CwdCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, explicitScore: number) => {
    const cleaned = cleanCwdPathCandidate(raw || "");
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push({ path: cleaned, score: scoreCwdCandidate(cleaned, value, explicitScore) });
  };

  const fileUriPattern = /file:\/\/\/([a-zA-Z]:\/[^"'\r\n\t<>|?*\s]+)/g;
  for (const match of value.matchAll(fileUriPattern))
    add(match[1], 105);

  const keyedPattern = /(?:DirectoryPath|directoryPath|workspaceRoot|workspace|currentDirectory|current_directory|cwd|projectPath|project_path|root)\s*["']?\s*[:=]\s*["']?([a-zA-Z]:(?:\\\\|\\|\/)[^"'\r\n\t<>|?*]+)/g;
  for (const match of value.matchAll(keyedPattern))
    add(match[1], 120);

  const keyedPosixPattern = /(?:DirectoryPath|directoryPath|workspaceRoot|workspace|currentDirectory|current_directory|cwd|projectPath|project_path|root)\s*["']?\s*[:=]\s*["']?(\/(?:mnt\/[a-zA-Z]|home|Users|root)\/[^"'\r\n\t<>]+)/g;
  for (const match of value.matchAll(keyedPosixPattern))
    add(match[1], 110);

  const windowsPattern = /[a-zA-Z]:(?:\\\\|\\|\/)[^\s"'<>\u0000-\u001F|?*]+/g;
  for (const match of value.matchAll(windowsPattern))
    add(match[0], 20);

  const posixPattern = /\/(?:mnt\/[a-zA-Z]|home|Users|root)\/[^\s"'<>\u0000-\u001F]+/g;
  for (const match of value.matchAll(posixPattern))
    add(match[0], 15);

  return out;
}

/**
 * 从多个 cwd 候选中选择最高分路径。
 */
function selectBestCwdCandidate(candidates: CwdCandidate[]): CwdCandidate | undefined {
  let best: CwdCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

/**
 * 判断 cwd 候选是否已经足够可靠，可用于 summaryOnly 提前结束扫描。
 */
function isStrongCwdCandidate(candidate: CwdCandidate | undefined): boolean {
  if (!candidate) return false;
  if (isLikelyUserHomeRoot(candidate.path)) return false;
  if (isLikelyHistoryStoragePath(candidate.path)) return false;
  return candidate.score >= 120;
}

/**
 * 读取 Antigravity 命令历史中记录的工作区，作为 SQLite 内部字段变化时的 cwd 兜底。
 */
async function readAntigravityHistoryWorkspaceCandidate(filePath: string, conversationId: string, date: number, preview: string | undefined): Promise<CwdCandidate | undefined> {
  try {
    const historyPath = path.join(path.dirname(path.dirname(filePath)), "history.jsonl");
    const raw = await fsp.readFile(historyPath, "utf8").catch(() => "");
    if (!raw) return undefined;
    const best = selectBestHistoryWorkspaceEntry(raw, conversationId, date, preview);
    if (!best?.workspace) return undefined;
    const cleaned = cleanCwdPathCandidate(best.workspace);
    if (!cleaned) return undefined;
    return { path: cleaned, score: best.score + scoreCwdCandidate(cleaned, raw, 0) };
  } catch {
    return undefined;
  }
}

/**
 * 从 Antigravity history.jsonl 中选择最可能属于当前会话的 workspace。
 */
function selectBestHistoryWorkspaceEntry(raw: string, conversationId: string, date: number, preview: string | undefined): AntigravityHistoryWorkspaceEntry | undefined {
  const targetConversationId = String(conversationId || "").trim();
  const targetPreview = String(preview || "").trim();
  let best: AntigravityHistoryWorkspaceEntry | undefined;
  const lines = String(raw || "").split(/\r?\n/).filter(Boolean).slice(-500);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const workspace = typeof obj?.workspace === "string" ? obj.workspace.trim() : "";
      if (!workspace) continue;
      const entryConversationId = typeof obj?.conversationId === "string" ? obj.conversationId.trim() : "";
      const display = typeof obj?.display === "string" ? obj.display.trim() : "";
      const timestamp = Number(obj?.timestamp || 0);
      const deltaMs = Number.isFinite(timestamp) && timestamp > 0 && date > 0 ? Math.abs(timestamp - date) : Number.POSITIVE_INFINITY;
      let score = 0;
      if (targetConversationId && entryConversationId && entryConversationId === targetConversationId) score += 260;
      if (targetPreview && display && display === targetPreview) score += 210;
      if (Number.isFinite(deltaMs)) {
        if (deltaMs <= 10 * 60 * 1000) score += Math.max(20, 180 - Math.floor(deltaMs / 5000));
        else if (deltaMs <= 24 * 60 * 60 * 1000 && targetPreview && display === targetPreview) score += 60;
      }
      if (score <= 0) continue;
      if (!best || score > best.score) best = { workspace, score };
    } catch {}
  }
  return best;
}

/**
 * 从完整 step 二进制字段中收集 cwd 候选文本，覆盖 metadata/task_details 等非正文位置。
 */
function extractCwdCandidateFromStepRow(row: StepRow): CwdCandidate | undefined {
  const candidates: string[] = [];
  const pushLeaves = (buf: Buffer | null | undefined) => {
    for (const text of collectTextLeaves(buf))
      candidates.push(text);
  };
  pushLeaves(row.metadata);
  pushLeaves(row.permissions);
  pushLeaves(row.task_details);
  pushLeaves(row.step_payload);
  return selectBestCwdCandidate(candidates.flatMap((text) => collectCwdCandidatesFromText(text)));
}

/**
 * 判断 SQLite 表是否包含指定列。
 */
function tableHasColumn(db: any, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`pragma table_info(${tableName})`).all() as any[];
    return rows.some((row) => String(row?.name || "").toLowerCase() === columnName.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 从 DB 轻量读取 step 行。
 */
function readStepRows(filePath: string, limit?: number): { rows: StepRow[]; trajectoryId?: string; cascadeId?: string } {
  const Database = getSqliteDatabaseConstructor();
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    try { db.pragma("query_only = ON"); } catch {}
    try { db.pragma("busy_timeout = 1000"); } catch {}
    const tables = new Set<string>(db.prepare("select name from sqlite_master where type='table'").all().map((row: any) => String(row.name || "")));
    if (!tables.has("steps")) return { rows: [] };
    let trajectoryId = "";
    let cascadeId = "";
    if (tables.has("trajectory_meta")) {
      const meta = db.prepare("select trajectory_id, cascade_id from trajectory_meta limit 1").get() as any;
      trajectoryId = String(meta?.trajectory_id || "").trim();
      cascadeId = String(meta?.cascade_id || "").trim();
    }
    const max = Math.max(0, Math.floor(Number(limit) || 0));
    const optionalColumns = ["metadata", "permissions", "task_details"].filter((column) => tableHasColumn(db, "steps", column));
    const selectColumns = ["idx", "step_type", "status", "step_payload", ...optionalColumns].join(", ");
    const sql = max > 0
      ? `select ${selectColumns} from steps order by idx limit ?`
      : `select ${selectColumns} from steps order by idx`;
    const rows = (max > 0 ? db.prepare(sql).all(max) : db.prepare(sql).all()) as any[];
    return {
      rows: rows.map((row) => ({
        idx: Number(row.idx || 0),
        step_type: Number(row.step_type || 0),
        status: Number(row.status || 0),
        step_payload: Buffer.isBuffer(row.step_payload) ? row.step_payload : Buffer.from(row.step_payload || []),
        metadata: Buffer.isBuffer(row.metadata) ? row.metadata : row.metadata ? Buffer.from(row.metadata || []) : null,
        permissions: Buffer.isBuffer(row.permissions) ? row.permissions : row.permissions ? Buffer.from(row.permissions || []) : null,
        task_details: Buffer.isBuffer(row.task_details) ? row.task_details : row.task_details ? Buffer.from(row.task_details || []) : null,
      })),
      trajectoryId,
      cascadeId,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * 从消息列表生成预览文本。
 */
function previewFromMessages(messages: Message[]): string | undefined {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const item of msg.content || []) {
      const filtered = filterHistoryPreviewText(item.text || "");
      if (filtered) return clampPreview(filtered);
    }
  }
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const item of msg.content || []) {
      const filtered = filterHistoryPreviewText(item.text || "");
      if (filtered) return clampPreview(filtered);
    }
  }
  return undefined;
}

/**
 * 将 preview 裁剪为单行短句。
 */
function clampPreview(text: string, max = 96): string {
  const s = String(text || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 解析 Antigravity CLI SQLite 会话 DB。
 */
export async function parseAntigravitySessionFile(filePath: string, stat: Stats, opts?: AntigravityParseOptions): Promise<AntigravitySessionDetails> {
  const summaryOnly = !!opts?.summaryOnly;
  const maxSteps = summaryOnly ? 80 : Math.max(0, Math.floor(Number(opts?.maxSteps || 0)));
  const date = Number(stat?.mtimeMs || 0);
  const conversationId = conversationIdFromPath(filePath);
  const id = `antigravity:${conversationId}`;
  let runtimeShell: RuntimeShell = detectRuntimeShell(filePath);
  let skippedLines = 0;
  let preview: string | undefined = undefined;
  let cwd: string | undefined = undefined;
  let cwdCandidate: CwdCandidate | undefined = undefined;
  const messages: Message[] = [];

  const updateCwdCandidate = (candidate: CwdCandidate | undefined) => {
    if (!candidate) return;
    if (!cwdCandidate || candidate.score > cwdCandidate.score) {
      cwdCandidate = candidate;
      cwd = candidate.path;
    }
  };

  try {
    const { rows, trajectoryId, cascadeId } = readStepRows(filePath, maxSteps);
    const metaItems: string[] = [];
    if (trajectoryId) metaItems.push(`trajectory_id: ${trajectoryId}`);
    if (cascadeId) metaItems.push(`cascade_id: ${cascadeId}`);
    if (!summaryOnly && metaItems.length > 0)
      messages.push({ role: "meta", content: [{ type: "session_meta", text: metaItems.join("\n"), tags: ["antigravity.session_meta"] }] });

    for (const row of rows) {
      try {
        updateCwdCandidate(extractCwdCandidateFromStepRow(row));
        const converted = convertStepToMessages(row);
        for (const msg of converted) {
          if (!summaryOnly) messages.push(msg);
          if (!preview && (msg.role === "user" || msg.role === "assistant")) {
            const text = msg.content?.map((item) => item.text).filter(Boolean).join("\n") || "";
            const filtered = filterHistoryPreviewText(text);
            if (filtered) preview = clampPreview(filtered);
          }
          const textCandidates = msg.content?.map((item) => item.text || "").filter(Boolean) || [];
          updateCwdCandidate(selectBestCwdCandidate(textCandidates.flatMap((text) => collectCwdCandidatesFromText(text))));
        }
        if (summaryOnly && preview && isStrongCwdCandidate(cwdCandidate)) break;
      } catch {
        skippedLines += 1;
      }
    }

    if (summaryOnly && messages.length === 0 && rows.length > 0) {
      // summaryOnly 不保留正文，但 preview/cwd 已在上面提取。
    }
  } catch {
    skippedLines += 1;
  }

  if (!isStrongCwdCandidate(cwdCandidate))
    updateCwdCandidate(await readAntigravityHistoryWorkspaceCandidate(filePath, conversationId, date, preview));

  if (runtimeShell === "unknown" && cwd) {
    const hint = detectRuntimeShell(cwd);
    if (hint !== "unknown") runtimeShell = hint;
  }

  const dirKey = cwd ? dirKeyFromCwd(cwd) : dirKeyOfFilePath(filePath);
  const title = preview || path.basename(filePath, ".db");
  return {
    providerId: "antigravity",
    id,
    title,
    date,
    filePath,
    messages,
    skippedLines,
    cwd,
    dirKey,
    preview,
    resumeId: conversationId,
    runtimeShell,
  };
}
