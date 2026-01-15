// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";
import { detectRuntimeShell } from "../../history";
import type { Message, RuntimeShell } from "../../history";
import { sha256Hex } from "../shared/crypto";
import { dirKeyFromCwd, dirKeyOfFilePath, tidyPathCandidate } from "../shared/path";
import { isWinOrWslPathLineForPreview } from "../shared/preview";

export type ClaudeParseOptions = {
  /** 索引阶段仅提取 cwd/preview 等轻量信息，避免完整解析。 */
  summaryOnly?: boolean;
  /** 最大解析行数（防止超大文件导致内存/CPU 激增）。 */
  maxLines?: number;
};

export type ClaudeSessionDetails = {
  providerId: "claude";
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
  /** Claude Code 的 sessionId（用于 `claude --resume <id>`）。 */
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};

/**
 * Claude Code 会话 JSONL/NDJSON 解析（支持索引阶段 summaryOnly）。
 */
export async function parseClaudeSessionFile(filePath: string, stat: Stats, opts?: ClaudeParseOptions): Promise<ClaudeSessionDetails> {
  const summaryOnly = !!opts?.summaryOnly;
  const maxLines = Math.max(1, Math.min(200_000, Number(opts?.maxLines ?? (summaryOnly ? 400 : 20_000))));

  const id = `claude:${sha256Hex(filePath)}`;
  const date = Number(stat?.mtimeMs || 0);
  let rawDate: string | undefined = undefined;
  let cwd: string | undefined = undefined;
  let preview: string | undefined = undefined;
  let resumeId: string | undefined = undefined;
  let runtimeShell: RuntimeShell = "unknown";
  const messages: Message[] = [];

  const pushMessage = (msg: Message) => {
    if (summaryOnly) return;
    if (!msg) return;
    if (!Array.isArray(msg.content) || msg.content.length === 0) return;
    messages.push(msg);
  };

  const updatePreviewFromUserText = (text?: string) => {
    if (preview) return;
    const cleaned = cleanClaudeUserPrompt(text);
    if (cleaned) preview = cleaned;
  };

  const trySetCwd = (value?: unknown) => {
    if (cwd) return;
    if (typeof value !== "string") return;
    const candidate = tidyPathCandidate(value);
    if (!candidate) return;
    cwd = candidate;
  };

  const trySetRawDate = (value?: unknown) => {
    if (rawDate) return;
    if (typeof value === "string" && value.trim()) rawDate = value.trim();
    else if (typeof value === "number" && isFinite(value)) rawDate = String(value);
  };

  const trySetResumeId = (value?: unknown) => {
    if (resumeId) return;
    if (typeof value !== "string") return;
    const v = value.trim();
    if (!v) return;
    resumeId = v;
  };

  // 优先从文件名提取（常见：<sessionId>.jsonl / .ndjson）
  try {
    const base = path.basename(filePath).replace(/\.(jsonl|ndjson)$/i, "");
    const m = base.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (m?.[0]) resumeId = m[0];
  } catch {}

  let skippedLines = 0;
  try {
    runtimeShell = detectRuntimeShell(filePath);
  } catch {
    runtimeShell = "unknown";
  }

  await new Promise<void>((resolve) => {
    try {
      const rs = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 256 * 1024 });
      let buf = "";
      let lineCount = 0;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        try {
          rs.close();
        } catch {}
        resolve();
      };

      const handleLine = (line: string) => {
        if (done) return;
        if (lineCount >= maxLines) {
          skippedLines++;
          return;
        }
        const trimmed = line.trim();
        if (!trimmed) return;
        lineCount++;
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return;
        }

        trySetRawDate(obj?.timestamp ?? obj?.ts ?? obj?.time);
        trySetCwd(obj?.cwd ?? obj?.project ?? obj?.workingDirectory ?? obj?.working_dir);
        trySetResumeId(obj?.sessionId ?? obj?.session_id ?? obj?.session);
        trySetResumeId(obj?.message?.sessionId ?? obj?.message?.session_id);

        // 兼容 Claude JSONL 常见结构：{ message: { role, content } }
        const messageObj = (obj && typeof obj === "object" && obj.message && typeof obj.message === "object") ? obj.message : null;
        const roleRaw = String(messageObj?.role ?? obj?.role ?? obj?.sender ?? obj?.type ?? "").toLowerCase();
        const role = normalizeClaudeRole(roleRaw);

        const { primaryText, toolBlocks, thinkingText } = extractClaudeContent(messageObj ?? obj);
        if (role === "user") updatePreviewFromUserText(primaryText);

        if (primaryText) {
          const type = role === "user" ? "input_text" : (role === "assistant" ? "output_text" : "text");
          pushMessage({ role, content: [{ type, text: primaryText }] });
        }
        if (thinkingText) {
          pushMessage({ role: "assistant", content: [{ type: "meta", text: thinkingText }] });
        }
        for (const tb of toolBlocks) {
          if (tb.kind === "tool_call") pushMessage({ role: "assistant", content: [{ type: "tool_call", text: tb.text }] });
          else if (tb.kind === "tool_result") pushMessage({ role: "tool", content: [{ type: "tool_result", text: tb.text }] });
        }

        if (summaryOnly && preview && cwd) {
          finish();
        }
      };

      rs.on("data", (chunk) => {
        if (done) return;
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
          if (done) return;
        }
      });
      rs.on("end", () => {
        if (done) return;
        if (buf) handleLine(buf);
        finish();
      });
      rs.on("error", () => finish());
    } catch {
      resolve();
    }
  });

  // 兜底：若文件路径无法推断 shell，则尝试用会话内记录的 cwd 再推断一次（提升跨平台/分隔符兼容性）。
  if (runtimeShell === "unknown" && cwd) {
    try {
      const hint = detectRuntimeShell(cwd);
      if (hint !== "unknown") runtimeShell = hint;
    } catch {}
  }

  const dirKey = cwd ? dirKeyFromCwd(cwd) : dirKeyOfFilePath(filePath);
  const title = preview ? preview : path.basename(filePath);
  return {
    providerId: "claude",
    id,
    title,
    date,
    filePath,
    messages,
    skippedLines,
    rawDate,
    cwd,
    dirKey,
    preview,
    resumeId,
    runtimeShell,
  };
}

type ClaudeToolBlock = { kind: "tool_call" | "tool_result"; text: string };

/**
 * 尝试从 Claude 消息结构中抽取可展示的文本与工具块。
 */
function extractClaudeContent(source: any): { primaryText: string; toolBlocks: ClaudeToolBlock[]; thinkingText: string } {
  try {
    // Claude 常见：message.content = [{type:"text", text:"..."}, {type:"tool_use", ...}, ...]
    const content = source?.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      const toolBlocks: ClaudeToolBlock[] = [];
      const thinkingParts: string[] = [];
      for (const block of content) {
        const type = String(block?.type || "").toLowerCase();
        if (type === "text") {
          const t = typeof block?.text === "string" ? block.text : "";
          if (t.trim()) textParts.push(t);
          continue;
        }
        if (type === "thinking") {
          const t = typeof block?.thinking === "string" ? block.thinking : "";
          if (t.trim()) thinkingParts.push(t);
          continue;
        }
        if (type === "tool_use" || type === "tool-use" || type === "tool_call" || type === "tool-call") {
          const name = typeof block?.name === "string" ? block.name : (typeof block?.tool === "string" ? block.tool : "");
          const input = block && Object.prototype.hasOwnProperty.call(block, "input") ? safeJsonStringify(block.input) : "";
          const text = name ? `${name}${input ? `\n${input}` : ""}` : input;
          if (text.trim()) toolBlocks.push({ kind: "tool_call", text });
          continue;
        }
        if (type === "tool_result" || type === "tool-result") {
          const output = block && Object.prototype.hasOwnProperty.call(block, "output") ? safeJsonStringify(block.output) : "";
          if (output.trim()) toolBlocks.push({ kind: "tool_result", text: output });
          continue;
        }
      }
      return { primaryText: textParts.join("\n").trim(), toolBlocks, thinkingText: thinkingParts.join("\n").trim() };
    }
    // 兼容：content 直接为字符串
    if (typeof content === "string") {
      return { primaryText: content.trim(), toolBlocks: [], thinkingText: "" };
    }
    // 兜底：常见字段
    const text = typeof source?.text === "string" ? source.text : (typeof source?.message === "string" ? source.message : "");
    return { primaryText: String(text || "").trim(), toolBlocks: [], thinkingText: "" };
  } catch {
    return { primaryText: "", toolBlocks: [], thinkingText: "" };
  }
}

/**
 * 规范化 Claude 角色为 user/assistant/system/tool/meta。
 */
function normalizeClaudeRole(roleRaw: string): string {
  const r = String(roleRaw || "").toLowerCase().trim();
  if (r === "user" || r === "human" || r === "user_input" || r === "input") return "user";
  if (r === "assistant" || r === "model" || r === "response") return "assistant";
  if (r === "system") return "system";
  if (r === "tool" || r === "tool_result") return "tool";
  return r || "assistant";
}

/**
 * Claude 的本地命令 transcript 会混入用户消息中，预览/标题需做一次降噪。
 */
function cleanClaudeUserPrompt(text?: string): string {
  try {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return "";
    const hasCaveat = lines.some((l) => l.toLowerCase().startsWith("caveat:"));
    if (!hasCaveat) {
      for (const l of lines) {
        if (!l) continue;
        if (isWinOrWslPathLineForPreview(l)) continue;
        const stripped = stripXmlLike(l);
        if (!stripped) continue;
        return collapseSpaces(stripped);
      }
      return "";
    }

    // 取最后一个“看起来像自然语言”的行，跳过 <local-command-*> 片段
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l) continue;
      if (isWinOrWslPathLineForPreview(l)) continue;
      if (l.startsWith("<") && l.endsWith(">")) continue;
      const stripped = stripXmlLike(l);
      if (!stripped) continue;
      if (stripped.toLowerCase().includes("local-command-stdout")) continue;
      return collapseSpaces(stripped);
    }
    for (const l of lines) {
      if (!l) continue;
      if (isWinOrWslPathLineForPreview(l)) continue;
      const stripped = stripXmlLike(l);
      if (!stripped) continue;
      if (stripped.toLowerCase().includes("local-command-stdout")) continue;
      return collapseSpaces(stripped);
    }
    return "";
  } catch {
    return String(text || "").trim();
  }
}

/**
 * 将 JSON stringify 降级为可展示文本（失败时回退为 String）。
 */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

/**
 * 去除简单的 XML/标签包裹，避免预览出现 <command-name> 等噪声。
 */
function stripXmlLike(value: string): string {
  try {
    const s = String(value || "");
    return s.replace(/<[^>]+>/g, "").trim();
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 折叠多空格并去除多余换行。
 */
function collapseSpaces(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
