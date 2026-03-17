// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";
import { detectRuntimeShell } from "../../history";
import type { Message, RuntimeShell } from "../../history";
import { sha256Hex } from "../shared/crypto";
import { createHistoryImageContent } from "../shared/historyImage";
import { dirKeyFromCwd, dirKeyOfFilePath, tidyPathCandidate } from "../shared/path";
import { isWinOrWslPathLineForPreview } from "../shared/preview";

export type ClaudeParseOptions = {
  /** 索引阶段仅提取 cwd/preview 等轻量信息，避免完整解析。 */
  summaryOnly?: boolean;
  /** 最大解析行数（防止超大文件导致内存/CPU 激增）。 */
  maxLines?: number;
  /** 单行最大字符数（防止某一行异常巨大导致内存爆炸）。 */
  maxLineChars?: number;
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
  const maxLineChars = Math.max(8 * 1024, Math.min(2_000_000, Number(opts?.maxLineChars ?? 1_000_000)));

  const id = `claude:${sha256Hex(filePath)}`;
  const date = Number(stat?.mtimeMs || 0);
  let rawDate: string | undefined = undefined;
  let cwd: string | undefined = undefined;
  let preview: string | undefined = undefined;
  let resumeId: string | undefined = undefined;
  let runtimeShell: RuntimeShell = "unknown";
  const messages: Message[] = [];
  const readToolPathById = new Map<string, string>();

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
      let skippingLongLine = false;

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
        if (lineCount >= maxLines) { skippedLines++; finish(); return; }
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
        const structuredToolMessages = extractClaudeStructuredToolMessages(messageObj ?? obj, readToolPathById);

        if (role === "user" && primaryText) {
          const { promptText, transcriptText } = splitClaudeUserTextForLocalCommandTranscript(primaryText);
          if (promptText) updatePreviewFromUserText(promptText);
          const content: Message["content"] = [];
          if (transcriptText) content.push({ type: "local_command", text: transcriptText });
          if (promptText) content.push({ type: "input_text", text: promptText });
          if (content.length > 0) pushMessage({ role, content });
        } else if (primaryText) {
          const type = role === "assistant" ? "output_text" : "text";
          pushMessage({ role, content: [{ type, text: primaryText }] });
        }
        if (thinkingText) {
          pushMessage({ role: "assistant", content: [{ type: "meta", text: thinkingText }] });
        }
        if (structuredToolMessages.length > 0) {
          for (const toolMessage of structuredToolMessages) pushMessage(toolMessage);
        } else {
          for (const tb of toolBlocks) {
            if (tb.kind === "tool_call") pushMessage({ role: "assistant", content: [{ type: "tool_call", text: tb.text }] });
            else if (tb.kind === "tool_result") pushMessage({ role: "tool", content: [{ type: "tool_result", text: tb.text }] });
          }
        }

        if (summaryOnly && preview && cwd) {
          finish();
        }
      };

      rs.on("data", (chunk: string | Buffer) => {
        if (done) return;
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        // 跳过异常超长行：避免 buf 在“无换行”场景下无限增长导致内存暴涨。
        if (skippingLongLine) {
          const nl = text.indexOf("\n");
          if (nl < 0) return; // 仍在长行内，继续丢弃
          skippingLongLine = false;
          buf = text.slice(nl + 1);
        } else {
          buf += text;
        }

        // 若当前缓冲区仍未出现换行且已超过阈值，则视为“超长行”，丢弃到下一次换行。
        if (!skippingLongLine && buf.length > maxLineChars && buf.indexOf("\n") < 0) {
          lineCount++;
          skippedLines++;
          if (lineCount >= maxLines) { finish(); return; }
          buf = "";
          skippingLongLine = true;
          return;
        }
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
          if (done) return;
        }

        // 处理完已有换行后，若剩余尾部仍是“无换行超长行”，继续进入丢弃模式。
        if (!done && !skippingLongLine && buf.length > maxLineChars && buf.indexOf("\n") < 0) {
          lineCount++;
          skippedLines++;
          if (lineCount >= maxLines) { finish(); return; }
          buf = "";
          skippingLongLine = true;
        }
      });
      rs.on("end", () => {
        if (done) return;
        if (buf && !skippingLongLine) handleLine(buf);
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
type ClaudeStructuredToolMessage = { role: "assistant" | "tool"; content: Message["content"] };

/**
 * 中文说明：从 Claude 内容块中提取结构化的工具消息，并为 `Read -> tool_result.image` 建立路径关联。
 */
function extractClaudeStructuredToolMessages(source: any, readToolPathById: Map<string, string>): ClaudeStructuredToolMessage[] {
  try {
    const content = source?.content;
    if (!Array.isArray(content)) return [];

    const out: ClaudeStructuredToolMessage[] = [];
    for (const block of content) {
      const type = String(block?.type || "").toLowerCase();
      if (type === "tool_use" || type === "tool-use" || type === "tool_call" || type === "tool-call") {
        const toolCallText = buildClaudeToolUseText(block);
        const toolUseId = typeof block?.id === "string" ? block.id.trim() : "";
        const filePath = typeof block?.input?.file_path === "string" ? tidyPathCandidate(block.input.file_path) : "";
        if (toolUseId && filePath) readToolPathById.set(toolUseId, filePath);
        if (toolCallText) out.push({ role: "assistant", content: [{ type: "tool_call", text: toolCallText }] });
        continue;
      }
      if (type === "tool_result" || type === "tool-result") {
        const toolResultContent = buildClaudeToolResultContents(block, readToolPathById);
        if (toolResultContent.length > 0) out.push({ role: "tool", content: toolResultContent });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 中文说明：格式化 Claude 的工具调用文本，并保留 `Read.input.file_path` 等关键信息。
 */
function buildClaudeToolUseText(block: any): string {
  try {
    const name = typeof block?.name === "string" ? block.name : (typeof block?.tool === "string" ? block.tool : "");
    const input = block && Object.prototype.hasOwnProperty.call(block, "input") ? safeJsonStringify(block.input) : "";
    return name ? `${name}${input ? `\n${input}` : ""}`.trim() : input.trim();
  } catch {
    return "";
  }
}

/**
 * 中文说明：构造 Claude `tool_result` 的统一内容项。
 * - 文本结果仍保留为 `tool_result`；
 * - 图片结果优先尝试本地路径，不存在时回退到会话内 Base64。
 */
function buildClaudeToolResultContents(block: any, readToolPathById: Map<string, string>): Message["content"] {
  try {
    const rawContent = Array.isArray(block?.content)
      ? block.content
      : (typeof block?.content === "string"
        ? [block.content]
        : (Object.prototype.hasOwnProperty.call(block ?? {}, "output") ? [block.output] : []));
    if (!Array.isArray(rawContent) || rawContent.length === 0) return [];

    const localPath = resolveClaudeToolResultPath(block, readToolPathById);
    const textParts: string[] = [];
    const out: Message["content"] = [];

    for (const part of rawContent) {
      if (typeof part === "string") {
        const text = part.trim();
        if (text) textParts.push(text);
        continue;
      }
      if (!part || typeof part !== "object") continue;

      const type = String(part?.type || "").toLowerCase();
      if (type === "text") {
        const text = typeof part?.text === "string" ? part.text.trim() : "";
        if (text) textParts.push(text);
        continue;
      }
      if (type === "image") {
        const source = part?.source;
        const imageItem = createHistoryImageContent({
          localPath,
          mimeType: resolveClaudeImageMimeType(part),
          dataUrl: typeof source?.data === "string" && /^data:image\//i.test(source.data) ? source.data : undefined,
          base64Data: typeof source?.data === "string" && !/^data:image\//i.test(source.data) ? source.data : undefined,
        });
        if (imageItem) out.push(imageItem);
        continue;
      }

      const text = safeJsonStringify(part).trim();
      if (text) textParts.push(text);
    }

    if (textParts.length > 0) out.unshift({ type: "tool_result", text: textParts.join("\n\n") });
    return out;
  } catch {
    return [];
  }
}

/**
 * 中文说明：按 `tool_use_id -> file_path` 映射解析 Claude 图片对应的原始路径。
 */
function resolveClaudeToolResultPath(block: any, readToolPathById: Map<string, string>): string | undefined {
  try {
    const toolUseId = typeof block?.tool_use_id === "string"
      ? block.tool_use_id.trim()
      : (typeof block?.toolUseId === "string" ? block.toolUseId.trim() : "");
    if (toolUseId && readToolPathById.has(toolUseId)) return readToolPathById.get(toolUseId);
    const direct = typeof block?.file_path === "string" ? block.file_path : (typeof block?.path === "string" ? block.path : "");
    const normalized = tidyPathCandidate(direct);
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 中文说明：从 Claude 图片块中尽力提取 MIME。
 */
function resolveClaudeImageMimeType(part: any): string | undefined {
  try {
    const candidates = [
      part?.mimeType,
      part?.mime_type,
      part?.mediaType,
      part?.media_type,
      part?.source?.mimeType,
      part?.source?.mime_type,
      part?.source?.mediaType,
      part?.source?.media_type,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().toLowerCase().startsWith("image/")) {
        return candidate.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 判断一行文本是否属于 Claude Code 的“本地命令 transcript”噪声片段。
 * 这些内容通常来自 `/model` 等本地命令与其 stdout/stderr，并不代表用户真实输入。
 */
function isClaudeLocalCommandTranscriptLine(line: string): boolean {
  try {
    const s = String(line || "").trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    if (lower.startsWith("caveat:")) return true;
    if (lower.includes("<command-name>")) return true;
    if (lower.includes("<command-message>")) return true;
    if (lower.includes("<command-args>")) return true;
    if (lower.includes("<local-command-")) return true;
    if (lower.includes("</local-command-")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 将 Claude user 文本拆分为：真实 prompt 与本地命令 transcript（默认应隐藏）。
 * - promptText：用于 preview/title 与默认展示（input_text）
 * - transcriptText：归类为 local_command，默认筛选不勾选
 */
function splitClaudeUserTextForLocalCommandTranscript(text?: string): { promptText: string; transcriptText: string } {
  try {
    const raw = String(text ?? "");
    const trimmed = raw.trim();
    if (!trimmed) return { promptText: "", transcriptText: "" };

    const lower = trimmed.toLowerCase();
    const hasMarkers =
      lower.startsWith("caveat:") ||
      lower.includes("<command-name>") ||
      lower.includes("<command-message>") ||
      lower.includes("<command-args>") ||
      lower.includes("<local-command-");
    if (!hasMarkers) return { promptText: trimmed, transcriptText: "" };

    const lines = trimmed.split(/\r?\n/);
    const transcriptLines: string[] = [];
    const promptLines: string[] = [];
    for (const line of lines) {
      if (!line || /^\s*$/.test(line)) continue;
      if (isClaudeLocalCommandTranscriptLine(line)) transcriptLines.push(line);
      else promptLines.push(line);
    }
    if (transcriptLines.length === 0) return { promptText: trimmed, transcriptText: "" };
    if (promptLines.length === 0) return { promptText: "", transcriptText: trimmed };
    return {
      promptText: promptLines.join("\n").trim(),
      transcriptText: transcriptLines.join("\n").trim(),
    };
  } catch {
    const fallback = String(text ?? "").trim();
    return { promptText: fallback, transcriptText: "" };
  }
}

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
    const pathFallback = extractClaudePathPreviewFallback(lines);
    const hasCaveat = lines.some((l) => l.toLowerCase().startsWith("caveat:"));
    if (!hasCaveat) {
      for (const l of lines) {
        if (!l) continue;
        if (isWinOrWslPathLineForPreview(l)) continue;
        const stripped = stripXmlLike(l);
        if (!stripped) continue;
        return collapseSpaces(stripped);
      }
      return pathFallback;
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
    return pathFallback;
  } catch {
    return String(text || "").trim();
  }
}

/**
 * 当用户输入只有路径/附件引用时，提取一个简短可读的历史预览，避免该会话被误判为“仅助手输出”。
 */
function extractClaudePathPreviewFallback(lines: string[]): string {
  try {
    for (const rawLine of lines) {
      const line = unwrapClaudePreviewLine(rawLine);
      if (!line) continue;
      if (!isWinOrWslPathLineForPreview(line)) continue;
      const normalized = line.replace(/\\/g, "/");
      const base = normalized.split("/").filter(Boolean).pop() || line;
      const name = collapseSpaces(base);
      if (!name) continue;
      if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(name)) return `图片：${name}`;
      return `文件：${name}`;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 去掉预览候选行首尾的成对包裹符，兼容 ``path`` / "path" / 'path' 这类纯路径输入。
 */
function unwrapClaudePreviewLine(value: string): string {
  try {
    let text = String(value || "").trim();
    const stripPairs = (ch: string) => {
      if (text.startsWith(ch) && text.endsWith(ch) && text.length >= 2) text = text.slice(1, -1).trim();
    };
    stripPairs("`");
    stripPairs("\"");
    stripPairs("'");
    return text;
  } catch {
    return String(value || "").trim();
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
