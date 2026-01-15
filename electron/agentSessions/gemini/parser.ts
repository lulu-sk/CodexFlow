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
    const normSlash = normalizeGeminiPathForHash(cwd);
    const normRaw = tidyPathCandidate(cwd);
    const ok = sha256Hex(normSlash) === want || sha256Hex(normRaw) === want;
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
