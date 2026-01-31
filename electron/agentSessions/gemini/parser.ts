// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { detectRuntimeShell } from "../../history";
import type { Message, RuntimeShell } from "../../history";
import { sha256Hex } from "../shared/crypto";
import { dirKeyFromCwd, dirKeyOfFilePath, tidyPathCandidate } from "../shared/path";
import { filterHistoryPreviewText } from "../shared/preview";

export type GeminiParseOptions = {
  /** 索引阶段仅提取 cwd/preview 等轻量信息，避免完整展开。 */
  summaryOnly?: boolean;
  /** 最大读取字节数（用于保护极端大文件）。 */
  maxBytes?: number;
};

export type GeminiSessionDetails = {
  providerId: "gemini";
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
  projectHash?: string;
  /** Gemini CLI 的 sessionId（用于 `gemini --resume <id>`）。 */
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};

/**
 * 将路径规范化为更接近 Windows 侧 projectHash 计算的输入：
 * - 分隔符统一为反斜杠
 * - 折叠重复分隔符（保留 UNC 起始双反斜杠）
 * - 去除尾部分隔符
 */
function normalizeGeminiWinPathForHash(p: string): string {
  try {
    let s = tidyPathCandidate(p).replace(/\//g, "\\");
    if (!s) return "";
    if (s.startsWith("\\\\")) {
      s = "\\\\" + s.slice(2).replace(/\\{2,}/g, "\\");
    } else {
      s = s.replace(/\\{2,}/g, "\\");
    }
    s = s.replace(/\\+$/, "");
    return s;
  } catch {
    return tidyPathCandidate(p);
  }
}

/**
 * 根据“项目绝对路径字符串”推导 Gemini 的 projectHash 候选集合（SHA-256 hex）。
 *
 * 兼容点：
 * - Windows：盘符大小写差异、`/` 与 `\\` 分隔符差异
 * - UNC：`\\\\server\\share\\...`（仅做轻量归一）
 * - POSIX：仅做 `/` 规范化（不强行转成 Windows 形态，避免误匹配）
 */
export function deriveGeminiProjectHashCandidatesFromPath(pathCandidate: string): string[] {
  try {
    const raw = typeof pathCandidate === "string" ? pathCandidate.trim() : "";
    if (!raw) return [];

    const base = tidyPathCandidate(raw);
    if (!base) return [];

    const forms = new Set<string>();
    const add = (v: string) => {
      const t = tidyPathCandidate(v);
      if (!t) return;
      forms.add(t);
    };

    add(base);

    const baseSlash = base.replace(/\\/g, "/");
    const isDrive = /^[a-zA-Z]:\//.test(baseSlash);
    const isUNC = base.startsWith("\\\\") || baseSlash.startsWith("//");
    const isPosix = base.startsWith("/");

    if (isPosix) {
      add(normalizeGeminiPathForHash(base));
    } else if (isDrive || isUNC) {
      add(normalizeGeminiPathForHash(base));
      add(normalizeGeminiWinPathForHash(base));
    } else {
      // 未知形态：保守处理；仅当明显包含 Windows 特征时才生成 Windows 形态
      add(normalizeGeminiPathForHash(base));
      if (base.includes("\\") || /^[a-zA-Z]:/.test(base)) add(normalizeGeminiWinPathForHash(base));
    }

    // 盘符大小写兼容（仅对盘符，不对整串做 lower/upper，避免 POSIX 误匹配）
    for (const v of Array.from(forms)) {
      const m = v.match(/^([a-zA-Z]):([\\/].*)$/);
      if (!m) continue;
      const rest = m[2];
      add(`${m[1].toUpperCase()}:${rest}`);
      add(`${m[1].toLowerCase()}:${rest}`);
    }

    const hashes = new Set<string>();
    for (const v of forms) hashes.add(sha256Hex(v));
    return Array.from(hashes);
  } catch {
    return [];
  }
}

/**
 * Gemini CLI 会话 JSON 解析（支持索引阶段 summaryOnly）。
 */
export async function parseGeminiSessionFile(filePath: string, stat: Stats, opts?: GeminiParseOptions): Promise<GeminiSessionDetails> {
  const summaryOnly = !!opts?.summaryOnly;
  const maxBytes = Math.max(64 * 1024, Math.min(64 * 1024 * 1024, Number(opts?.maxBytes ?? (summaryOnly ? 2 * 1024 * 1024 : 32 * 1024 * 1024))));

  const date = Number(stat?.mtimeMs || 0);
  const sizeBytes = Number((stat as any)?.size ?? 0);
  let runtimeShell: RuntimeShell = detectRuntimeShell(filePath);
  const id = `gemini:${sha256Hex(filePath)}`;
  const projectHash = extractGeminiProjectHashFromPath(filePath) || undefined;

  let rawDate: string | undefined = undefined;
  let cwd: string | undefined = undefined;
  let preview: string | undefined = undefined;
  let resumeId: string | undefined = undefined;
  const messages: Message[] = [];

  const pushMessage = (msg: Message) => {
    if (summaryOnly) return;
    if (!msg) return;
    if (!Array.isArray(msg.content) || msg.content.length === 0) return;
    messages.push(msg);
  };

  if (sizeBytes > maxBytes) {
    // 文件过大时不做完整 JSON.parse；但索引列表仍需要 preview/title。
    try {
      const prefixBytes = Math.max(64 * 1024, Math.min(maxBytes, 512 * 1024));
      const extracted = await extractGeminiSummaryFromJsonPrefix(filePath, prefixBytes);
      if (extracted.rawDate) rawDate = extracted.rawDate;
      if (extracted.resumeId) resumeId = extracted.resumeId;
      if (extracted.cwd) cwd = extracted.cwd;
      if (extracted.preview) preview = extracted.preview;
    } catch {}

    // hash 校验（避免把别的项目路径误归到当前会话）
    if (cwd && projectHash) {
      try {
        const want = projectHash.toLowerCase();
        const cands = deriveGeminiProjectHashCandidatesFromPath(cwd);
        if (!cands.includes(want)) cwd = undefined;
      } catch {
        cwd = undefined;
      }
    }

    // 兜底：若文件路径无法推断 shell，则尝试用会话内记录的 cwd 再推断一次。
    if (runtimeShell === "unknown" && cwd) {
      try {
        const hint = detectRuntimeShell(cwd);
        if (hint !== "unknown") runtimeShell = hint;
      } catch {}
    }

    const dirKey = cwd ? dirKeyFromCwd(cwd) : dirKeyOfFilePath(filePath);
    const title = preview ? preview : path.basename(filePath);
    return {
      providerId: "gemini",
      id,
      title,
      date,
      filePath,
      messages,
      skippedLines: 0,
      rawDate,
      cwd,
      dirKey,
      preview,
      projectHash,
      resumeId,
      runtimeShell,
    };
  }

  let any: any = null;
  try {
    const buf = await fs.readFile(filePath, { encoding: "utf8" });
    any = JSON.parse(String(buf || ""));
  } catch {
    const dirKey = cwd ? dirKeyFromCwd(cwd) : dirKeyOfFilePath(filePath);
    return {
      providerId: "gemini",
      id,
      title: path.basename(filePath),
      date,
      filePath,
      messages,
      skippedLines: 0,
      rawDate,
      cwd,
      dirKey,
      preview,
      projectHash,
      resumeId,
      runtimeShell,
    };
  }

  const { items, meta } = extractGeminiItemsAndMeta(any);
  rawDate = pickFirstStringOrNumberAsString(meta.lastUpdated ?? meta.startTime ?? meta.firstTS ?? meta.lastTS);
  if (typeof any?.sessionId === "string" && any.sessionId.trim()) resumeId = any.sessionId.trim();

  // 先尝试从元信息与对象字段提取 cwd，再做 hash 校验
  cwd = tryExtractGeminiCwdFromAny(any, items) || undefined;
  if (cwd && projectHash) {
    const want = projectHash.toLowerCase();
    const cands = deriveGeminiProjectHashCandidatesFromPath(cwd);
    const ok = cands.includes(want);
    if (!ok) cwd = undefined;
  }

  // 兜底：若文件路径无法推断 shell，则尝试用会话内记录的 cwd 再推断一次（提升跨平台/分隔符兼容性）。
  if (runtimeShell === "unknown" && cwd) {
    try {
      const hint = detectRuntimeShell(cwd);
      if (hint !== "unknown") runtimeShell = hint;
    } catch {}
  }

  // 生成消息与预览
  if (Array.isArray(items)) {
    for (const it of items) {
      const role = normalizeGeminiRole(String(it?.role ?? it?.type ?? it?.actor ?? ""));
      const text = extractGeminiText(it);
      if (role === "user") {
        if (!preview && text) {
          const filtered = filterHistoryPreviewText(text);
          if (filtered) preview = clampPreview(filtered);
        }
        if (text) pushMessage({ role: "user", content: [{ type: "input_text", text }] });
      } else if (role === "assistant") {
        if (text) pushMessage({ role: "assistant", content: [{ type: "output_text", text }] });
      } else if (role === "system") {
        if (text) pushMessage({ role: "system", content: [{ type: "meta", text }] });
      } else if (role === "tool") {
        if (text) pushMessage({ role: "tool", content: [{ type: "tool_result", text }] });
      } else {
        if (text) pushMessage({ role: role || "assistant", content: [{ type: "text", text }] });
      }
      if (summaryOnly && preview && cwd) break;
    }
  }

  const dirKey = cwd ? dirKeyFromCwd(cwd) : dirKeyOfFilePath(filePath);
  const title = preview ? preview : path.basename(filePath);
  return {
    providerId: "gemini",
    id,
    title,
    date,
    filePath,
    messages,
    skippedLines: 0,
    rawDate,
    cwd,
    dirKey,
    preview,
    projectHash,
    resumeId,
    runtimeShell,
  };
}

type GeminiExtractedMeta = { startTime?: unknown; lastUpdated?: unknown; firstTS?: unknown; lastTS?: unknown };
type GeminiPrefixExtracted = { rawDate?: string; cwd?: string; preview?: string; resumeId?: string };

/**
 * 在不读取完整文件的情况下，从 Gemini 会话 JSON 的“前缀内容”中提取摘要信息：
 * - sessionId（用于 continue/resume）
 * - startTime/lastUpdated（用于 rawDate 展示）
 * - messages 中首条 user 文本（用于 preview/title）
 *
 * 说明：
 * - 这是索引阶段的性能兜底：Gemini 会话 JSON 可能很大（包含大量 toolCalls/result），但预览通常出现在文件头部。
 * - 该方法只读取 prefixBytes 的前缀，解析失败时返回空对象，不影响主流程。
 *
 * @param filePath 会话文件路径
 * @param prefixBytes 需要读取的前缀字节数（会被限制在合理范围内）
 * @returns 提取到的摘要信息（尽力而为）
 */
async function extractGeminiSummaryFromJsonPrefix(filePath: string, prefixBytes: number): Promise<GeminiPrefixExtracted> {
  try {
    const safeBytes = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, Number(prefixBytes || 0)));
    const prefix = await readUtf8Prefix(filePath, safeBytes);
    if (!prefix) return {};

    // 优先在 messages 之前的头部提取 top-level 字段，避免误匹配到 toolCalls 里的同名键。
    const messagesIdx = prefix.indexOf("\"messages\"");
    const head = messagesIdx > 0 ? prefix.slice(0, messagesIdx) : prefix;

    const resumeId = extractJsonStringFieldFromPrefix(head, "sessionId");
    const rawDate = extractJsonStringFieldFromPrefix(head, "lastUpdated") || extractJsonStringFieldFromPrefix(head, "startTime");

    // 预览：尽量从 messages 数组中解析出前几条 item，找到首条 user 文本。
    const preview = tryExtractGeminiPreviewFromMessagesPrefix(prefix);

    // cwd：Gemini CLI 通常不直接写入，但保留轻量兜底（若头部恰好有该字段）。
    const cwd = extractJsonStringFieldFromPrefix(head, "cwd")
      || extractJsonStringFieldFromPrefix(head, "projectDir")
      || extractJsonStringFieldFromPrefix(head, "project_dir")
      || extractJsonStringFieldFromPrefix(head, "workingDirectory")
      || extractJsonStringFieldFromPrefix(head, "working_dir");

    return {
      rawDate: rawDate ? pickFirstStringOrNumberAsString(rawDate) : undefined,
      resumeId: resumeId ? String(resumeId).trim() : undefined,
      cwd: cwd ? tidyPathCandidate(cwd) : undefined,
      preview,
    };
  } catch {
    return {};
  }
}

/**
 * 读取文件 UTF-8 前缀（最大 prefixBytes），用于大文件的轻量摘要提取。
 *
 * @param filePath 文件路径
 * @param prefixBytes 需要读取的字节数
 * @returns UTF-8 字符串（读取失败返回空串）
 */
async function readUtf8Prefix(filePath: string, prefixBytes: number): Promise<string> {
  try {
    const bytes = Math.max(1, Number(prefixBytes || 0));
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      try { await fh.close(); } catch {}
    }
  } catch {
    return "";
  }
}

/**
 * 从 JSON 前缀中提取形如 `"key": "..."` 的字符串字段，并解码转义字符。
 *
 * 注意：仅用于索引阶段的“尽力而为”，不保证对所有非法/截断 JSON 都能成功。
 *
 * @param prefix JSON 前缀字符串
 * @param key 需要提取的字段名
 * @returns 解码后的字符串（未命中返回 undefined）
 */
function extractJsonStringFieldFromPrefix(prefix: string, key: string): string | undefined {
  try {
    const k = String(key || "").trim();
    if (!k) return undefined;

    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\"${escaped}\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"`);
    const m = re.exec(String(prefix || ""));
    if (!m?.[1]) return undefined;
    try {
      return JSON.parse(`\"${m[1]}\"`);
    } catch {
      return m[1];
    }
  } catch {
    return undefined;
  }
}

/**
 * 从 messages 数组的 JSON 前缀中抽取首条 user 文本，并进行预览过滤与裁剪。
 *
 * @param prefix 包含 messages 的 JSON 前缀
 * @returns 预览文本（未命中返回 undefined）
 */
function tryExtractGeminiPreviewFromMessagesPrefix(prefix: string): string | undefined {
  try {
    const src = String(prefix || "");
    if (!src) return undefined;

    const keyIdx = src.indexOf("\"messages\"");
    if (keyIdx < 0) return undefined;
    const arrIdx = src.indexOf("[", keyIdx);
    if (arrIdx < 0) return undefined;

    let i = arrIdx + 1;
    for (let n = 0; n < 12 && i < src.length; n += 1) {
      i = skipWsComma(src, i);
      if (i >= src.length) break;
      const ch = src[i];
      if (ch === "]") break;
      if (ch !== "{") break;

      const picked = pickCompleteJsonObject(src, i);
      if (!picked) break;
      i = picked.end;

      let obj: any = null;
      try { obj = JSON.parse(picked.text); } catch { obj = null; }
      if (!obj) continue;

      const role = normalizeGeminiRole(String(obj?.role ?? obj?.type ?? obj?.actor ?? ""));
      const text = extractGeminiText(obj);
      if (role === "user" && text) {
        const filtered = filterHistoryPreviewText(text);
        if (filtered) {
          const clamped = clampPreview(filtered);
          if (clamped) return clamped;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 跳过空白与逗号，返回下一个可能的 JSON token 起始位置。
 *
 * @param src 源字符串
 * @param start 起始下标
 * @returns 跳过后的位置
 */
function skipWsComma(src: string, start: number): number {
  let i = Math.max(0, Number(start || 0));
  while (i < src.length) {
    const c = src[i];
    if (c === "," || c === " " || c === "\n" || c === "\r" || c === "\t") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * 从给定位置（应为 `{`）开始，提取一个完整的 JSON 对象文本。
 *
 * 说明：
 * - 采用括号计数 + 字符串状态机，容错处理嵌套对象/数组与转义字符。
 * - 若前缀被截断导致对象不完整，返回 null。
 *
 * @param src 源字符串
 * @param start JSON 对象起始下标（应指向 `{`）
 * @returns 对象文本与结束下标（失败返回 null）
 */
function pickCompleteJsonObject(src: string, start: number): { text: string; end: number } | null {
  try {
    const s = String(src || "");
    const begin = Math.max(0, Number(start || 0));
    if (s[begin] !== "{") return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = begin; i < s.length; i += 1) {
      const c = s[i];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === "\"") {
          inString = false;
        }
        continue;
      }

      if (c === "\"") {
        inString = true;
        continue;
      }
      if (c === "{") {
        depth += 1;
        continue;
      }
      if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          const end = i + 1;
          return { text: s.slice(begin, end), end };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 兼容多种 Gemini session JSON 结构，统一抽取 items 与 meta。
 */
function extractGeminiItemsAndMeta(any: any): { items: any[] | null; meta: GeminiExtractedMeta } {
  const meta: GeminiExtractedMeta = {};
  try {
    if (Array.isArray(any)) {
      meta.firstTS = any[0]?.timestamp ?? any[0]?.ts;
      meta.lastTS = any[any.length - 1]?.timestamp ?? any[any.length - 1]?.ts;
      return { items: any, meta };
    }
    if (any && typeof any === "object") {
      meta.startTime = any.startTime ?? any.startedAt ?? any.start_time;
      meta.lastUpdated = any.lastUpdated ?? any.updatedAt ?? any.last_updated;
      const items = Array.isArray(any.messages)
        ? any.messages
        : (Array.isArray(any.history) ? any.history : (Array.isArray(any.items) ? any.items : null));
      if (Array.isArray(items) && items.length > 0) {
        meta.firstTS = items[0]?.timestamp ?? items[0]?.ts;
        meta.lastTS = items[items.length - 1]?.timestamp ?? items[items.length - 1]?.ts;
      }
      return { items, meta };
    }
  } catch {}
  return { items: null, meta };
}

/**
 * 归一 Gemini 角色为 user/assistant/system/tool。
 */
function normalizeGeminiRole(raw: string): "user" | "assistant" | "system" | "tool" | "" {
  const r = String(raw || "").toLowerCase().trim();
  if (r === "user" || r === "human" || r === "input") return "user";
  if (r === "assistant" || r === "model" || r === "gemini" || r === "output") return "assistant";
  if (r === "system") return "system";
  if (r === "tool" || r === "tool_use" || r === "tool_call" || r === "tool_result") return "tool";
  return "";
}

/**
 * 从单条 item 中提取可展示文本（尽量容错）。
 */
function extractGeminiText(item: any): string {
  try {
    if (!item) return "";
    if (typeof item === "string") return item.trim();
    const direct = item.text ?? item.content ?? item.message ?? item.input_text ?? item.output_text;
    if (typeof direct === "string") return direct.trim();
    if (Array.isArray(item.content)) {
      const parts: string[] = [];
      for (const c of item.content) {
        if (!c) continue;
        if (typeof c === "string") { if (c.trim()) parts.push(c.trim()); continue; }
        if (typeof c.text === "string" && c.text.trim()) parts.push(c.text.trim());
        else if (typeof c.output_text === "string" && c.output_text.trim()) parts.push(c.output_text.trim());
        else if (typeof c.input_text === "string" && c.input_text.trim()) parts.push(c.input_text.trim());
      }
      return parts.join("\n").trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 尝试从整体对象或 items 中推断工作目录（Gemini 会使用 projectHash，因此这里返回的路径需要后续 hash 校验）。
 */
function tryExtractGeminiCwdFromAny(root: any, items: any[] | null): string | null {
  try {
    const direct = root?.cwd ?? root?.projectDir ?? root?.project_dir ?? root?.workingDirectory ?? root?.working_dir;
    if (typeof direct === "string" && direct.trim()) return tidyPathCandidate(direct);
  } catch {}
  if (Array.isArray(items)) {
    for (const it of items.slice(0, 30)) {
      try {
        const v = it?.cwd ?? it?.projectDir ?? it?.project_dir ?? it?.workingDirectory ?? it?.working_dir;
        if (typeof v === "string" && v.trim()) return tidyPathCandidate(v);
      } catch {}
      try {
        const text = extractGeminiText(it);
        const cand = extractPathFromText(text);
        if (cand) return cand;
      } catch {}
    }
  }
  return null;
}

/**
 * 从文本中提取可能的绝对路径（Windows 盘符 / UNC / /mnt/<drive> / POSIX）。
 */
function extractPathFromText(text: string): string | null {
  try {
    const s = String(text || "");
    const mM = s.match(/(\/mnt\/[a-zA-Z]\/[^\s"'<>]+)/);
    if (mM?.[1]) return tidyPathCandidate(mM[1]);
    const mW = s.match(/([a-zA-Z]:\\[^\r\n\t"'<>\{\}|?*]+)/);
    if (mW?.[1]) return tidyPathCandidate(mW[1]);
    const mP = s.match(/(\/(?:home|Users|root)\/[^\s"'<>]+)/);
    if (mP?.[1]) return tidyPathCandidate(mP[1]);
    return null;
  } catch {
    return null;
  }
}

/**
 * 提取 Gemini 会话文件路径中的 projectHash（匹配 ~/.gemini/tmp/<hash>/...）。
 */
export function extractGeminiProjectHashFromPath(filePath: string): string | null {
  try {
    const s = String(filePath || "").replace(/\\/g, "/");
    const m = s.match(/\/\.gemini\/tmp\/([0-9a-fA-F]{32,64})(?:\/|$)/);
    if (m?.[1]) return m[1].toLowerCase();
    return null;
  } catch {
    return null;
  }
}

/**
 * Gemini projectHash 的计算通常基于“绝对路径字符串（无尾部斜杠）”，因此需先做规范化。
 */
export function normalizeGeminiPathForHash(p: string): string {
  const s = tidyPathCandidate(p).replace(/\\/g, "/");
  return s.replace(/\/+/g, "/").replace(/\/+$/, "");
}

/**
 * 将 preview 文本裁剪为单行短句，便于历史列表展示。
 */
function clampPreview(text: string, max = 96): string {
  try {
    const s = String(text || "").replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!s) return "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return String(text || "").trim();
  }
}

/**
 * 将可能的时间字段转成 string（保持 rawDate 的“原始字符串”语义）。
 */
function pickFirstStringOrNumberAsString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && isFinite(value)) return String(value);
  return undefined;
}
