// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promises as fsp, type Stats } from "node:fs";
import { detectRuntimeShell, type Message, type MessageContent, type RuntimeShell } from "../../history";
import { createHistoryImageContent } from "../shared/historyImage";
import { dirKeyFromCwd } from "../shared/path";
import { filterHistoryPreviewText } from "../shared/preview";

export type GrokParseOptions = {
  /** 索引阶段仅解析摘要和首条用户消息。 */
  summaryOnly?: boolean;
  /** `updates.jsonl` 最大读取字节数。 */
  maxBytes?: number;
  /** 最大解析行数。 */
  maxLines?: number;
  /** 单行最大字符数。 */
  maxLineChars?: number;
};

export type GrokSessionDetails = {
  providerId: "grok";
  id: string;
  title: string;
  date: number;
  filePath: string;
  messages: Message[];
  skippedLines: number;
  rawDate?: string;
  preview?: string;
  cwd?: string;
  dirKey?: string;
  resumeId?: string;
  runtimeShell?: RuntimeShell;
};

type GrokSummary = {
  info?: { id?: unknown; cwd?: unknown };
  session_summary?: unknown;
  generated_title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_active_at?: unknown;
  current_model_id?: unknown;
};

type ParsedGrokUpdate = {
  update: any;
  isXai: boolean;
};

type UserRunTurnTracker = {
  seenMarker: boolean;
  inUser: boolean;
  currentRunPromptIndex?: number;
};

type UserRunTrackingResult = {
  startsRun: boolean;
  startsCountedTurn: boolean;
};

/**
 * 将未知值安全转换为非空字符串。
 */
function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 将时间字段转换为毫秒时间戳。
 */
function parseTimestamp(value: unknown): number {
  const raw = asNonEmptyString(value);
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 将历史列表文案限制为稳定的单行长度。
 */
function clampListText(value: string, maxLength = 120): string {
  const normalized = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * 对结构化值生成有长度保护的 JSON 文本。
 */
function stringifyStructured(value: unknown, maxLength = 100_000): string {
  try {
    const text = JSON.stringify(value, null, 2) || "";
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n…`;
  } catch {
    return String(value ?? "");
  }
}

/**
 * 从现代或旧版 JSONL 封装中提取 Grok 更新。
 */
function parseGrokUpdateEnvelope(envelope: any): ParsedGrokUpdate | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const nestedUpdate = envelope?.params?.update;
  const legacyUpdate = envelope?.update;
  const update = nestedUpdate && typeof nestedUpdate === "object" && !Array.isArray(nestedUpdate)
    ? nestedUpdate
    : legacyUpdate && typeof legacyUpdate === "object" && !Array.isArray(legacyUpdate)
      ? legacyUpdate
      : null;
  if (!update) return null;
  return {
    update,
    isXai: envelope.method === "_x.ai/session/update",
  };
}

/**
 * 创建官方渐进式用户轮次跟踪状态。
 */
function createUserRunTurnTracker(): UserRunTurnTracker {
  return {
    seenMarker: false,
    inUser: false,
    currentRunPromptIndex: undefined,
  };
}

/**
 * 读取非负整数元数据；无效值按缺失处理。
 */
function readNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/**
 * 读取用户消息块的官方 promptIndex 元数据。
 */
function getUserPromptIndex(update: any): number | undefined {
  return readNonNegativeInteger(update?._meta?.promptIndex ?? update?.content?._meta?.promptIndex);
}

/**
 * 判断用户消息块是否属于宿主内部轮次。
 */
function isHostTurnUpdate(update: any): boolean {
  return update?._meta?.hostTurn === true || update?.content?._meta?.hostTurn === true;
}

/**
 * 按官方规则推进用户轮次跟踪器，并返回新连续块与可计数轮次状态。
 */
function trackUserChunk(tracker: UserRunTurnTracker, promptIndex?: number): UserRunTrackingResult {
  const hasPromptIndex = promptIndex !== undefined;
  if (hasPromptIndex) tracker.seenMarker = true;
  const counts = tracker.seenMarker ? hasPromptIndex : true;
  const startsNewRun = !tracker.inUser
    || ((tracker.seenMarker || hasPromptIndex) && promptIndex !== tracker.currentRunPromptIndex);
  if (startsNewRun) {
    tracker.currentRunPromptIndex = promptIndex;
    tracker.inUser = true;
    return { startsRun: true, startsCountedTurn: counts };
  }
  tracker.inUser = true;
  return { startsRun: false, startsCountedTurn: false };
}

/**
 * 结束当前用户消息连续块，同时保留是否见过 promptIndex 的渐进式状态。
 */
function endUserRun(tracker: UserRunTurnTracker): void {
  tracker.inUser = false;
  tracker.currentRunPromptIndex = undefined;
}

/**
 * 判断更新是否不应显示在历史滚动区。
 */
function isHiddenFromScrollback(update: any): boolean {
  return update?._meta?.hideFromScrollback === true || update?.content?._meta?.hideFromScrollback === true;
}

/**
 * 从 Grok ACP 内容块中提取可展示文本。
 */
function extractContentText(content: any): string {
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  return "";
}

/**
 * 从最终有效更新时间线中提取完整的首条可见用户文本。
 */
function extractFirstVisibleUserText(entries: ParsedGrokUpdate[]): string {
  const tracker = createUserRunTurnTracker();
  let collecting = false;
  let text = "";

  for (const entry of entries) {
    const update = entry.update;
    const updateType = asNonEmptyString(update?.sessionUpdate).toLowerCase();
    const isUserChunk = !entry.isXai && updateType === "user_message_chunk" && !isHostTurnUpdate(update);
    if (!isUserChunk) {
      endUserRun(tracker);
      if (collecting) break;
      continue;
    }

    const tracking = trackUserChunk(tracker, getUserPromptIndex(update));
    if (collecting && tracking.startsRun) break;
    if (isHiddenFromScrollback(update)) continue;
    const chunkText = extractContentText(update?.content);
    if (!chunkText) {
      if (collecting) break;
      continue;
    }
    collecting = true;
    text += chunkText;
  }

  return text;
}

/**
 * 将 file URL 或绝对路径转换为历史图片可复用的本地路径。
 */
function resolveLocalImagePath(source: string): string {
  const value = String(source || "").trim();
  if (!value) return "";
  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return "";
    }
  }
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value)) return value;
  return "";
}

/**
 * 将 Grok ACP 图片内容块转换为通用历史图片内容。
 */
function createGrokImageContent(content: any): MessageContent | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const contentType = asNonEmptyString(content.type).toLowerCase();
  if (contentType !== "image" && contentType !== "image_url") return null;

  const url = asNonEmptyString(content.url) || asNonEmptyString(content?.image_url?.url);
  const uri = asNonEmptyString(content.uri);
  const data = asNonEmptyString(content.data);
  const sources = [url, uri].filter(Boolean);
  const dataUrl = [...sources, data].find((candidate) => /^data:image\//i.test(candidate)) || "";
  const localPath = resolveLocalImagePath(sources.find((candidate) => !/^data:|^https?:/i.test(candidate)) || "");
  const mimeType = [content.mimeType, content.mime_type, content.mediaType, content.media_type]
    .map(asNonEmptyString)
    .find(Boolean) || "";
  const imageContent = createHistoryImageContent({
    localPath: localPath || undefined,
    mimeType: mimeType || undefined,
    dataUrl: dataUrl || undefined,
    base64Data: data && !/^data:/i.test(data) ? data : undefined,
    tags: ["grok.user_message", "grok.image"],
    preferDataUrl: true,
  });
  if (imageContent) return imageContent;

  const remoteSource = sources.find((candidate) => /^https?:\/\//i.test(candidate));
  if (!remoteSource) return null;
  return {
    type: "image",
    text: mimeType ? `图片\n类型: ${mimeType}` : "图片",
    src: remoteSource,
    mimeType: mimeType || undefined,
    tags: ["grok.user_message", "grok.image"],
  };
}

/**
 * 向消息列表追加文本；连续同类流式块会合并，避免每个 token 形成一条消息。
 */
function appendTextMessage(
  messages: Message[],
  role: string,
  type: string,
  text: string,
  tags: string[],
  startNewMessage = false,
): void {
  if (!text) return;
  const previous = messages[messages.length - 1];
  const previousContent = previous?.content?.[previous.content.length - 1];
  if (!startNewMessage && previous?.role === role && previousContent?.type === type && (previous.content.length === 1 || role === "user")) {
    previousContent.text += text;
    return;
  }
  if (!startNewMessage && role === "user" && previous?.role === "user") {
    previous.content.push({ type, text, tags });
    return;
  }
  messages.push({ role, content: [{ type, text, tags }] });
}

/**
 * 向用户消息追加图片内容，并按轮次边界决定是否新建消息。
 */
function appendUserImageMessage(messages: Message[], imageContent: MessageContent, startNewMessage: boolean): void {
  const previous = messages[messages.length - 1];
  if (!startNewMessage && previous?.role === "user") {
    previous.content.push(imageContent);
    return;
  }
  messages.push({ role: "user", content: [imageContent] });
}

/**
 * 将单条 Grok `session/update` 转换为通用历史消息，并返回是否追加了用户内容。
 */
function appendUpdateMessage(messages: Message[], update: any, startNewUserMessage = false): boolean {
  const updateType = asNonEmptyString(update?.sessionUpdate).toLowerCase();
  if (!updateType) return false;

  if (updateType === "user_message_chunk") {
    if (isHiddenFromScrollback(update)) return false;
    const imageContent = createGrokImageContent(update?.content);
    if (imageContent) {
      appendUserImageMessage(messages, imageContent, startNewUserMessage);
      return true;
    }
    const contentText = extractContentText(update?.content);
    if (!contentText) return false;
    appendTextMessage(
      messages,
      "user",
      "input_text",
      contentText,
      ["grok.user_message"],
      startNewUserMessage,
    );
    return true;
  }
  if (updateType === "agent_message_chunk") {
    appendTextMessage(messages, "assistant", "output_text", extractContentText(update?.content), ["grok.agent_message"]);
    return false;
  }
  if (updateType === "agent_thought_chunk") {
    appendTextMessage(messages, "assistant", "reasoning", extractContentText(update?.content), ["grok.agent_thought"]);
    return false;
  }
  if (updateType === "tool_call") {
    const payload = {
      id: update.toolCallId,
      title: update.title,
      kind: update.kind,
      status: update.status,
      locations: update.locations,
      rawInput: update.rawInput,
      content: update.content,
    };
    messages.push({ role: "assistant", content: [{ type: "tool_call", text: stringifyStructured(payload), tags: ["grok.tool_call"] }] });
    return false;
  }
  if (updateType === "tool_call_update") {
    const payload = {
      id: update.toolCallId,
      title: update.title,
      kind: update.kind,
      status: update.status,
      content: update.content,
      rawOutput: update.rawOutput,
    };
    messages.push({ role: "tool", content: [{ type: "tool_result", text: stringifyStructured(payload), tags: ["grok.tool_call_update"] }] });
    return false;
  }
  if (updateType === "plan") {
    messages.push({ role: "assistant", content: [{ type: "plan", text: stringifyStructured(update.entries ?? update), tags: ["grok.plan"] }] });
    return false;
  }
  if (updateType === "turn_completed") {
    const payload = { stopReason: update.stopReason ?? update.stop_reason, usage: update.usage };
    messages.push({ role: "state", content: [{ type: "usage", text: stringifyStructured(payload), tags: ["grok.turn_completed", "grok.usage"] }] });
    return false;
  }

  messages.push({ role: "meta", content: [{ type: "meta", text: stringifyStructured(update), tags: [`grok.${updateType}`] }] });
  return false;
}

/**
 * 解析 Grok Build 的 `summary.json + updates.jsonl` 会话。
 */
export async function parseGrokSessionFile(filePath: string, stat: Stats, options?: GrokParseOptions): Promise<GrokSessionDetails> {
  const inputPath = String(filePath || "").trim();
  const sessionDir = path.dirname(inputPath);
  const summaryPath = path.basename(inputPath).toLowerCase() === "summary.json" ? inputPath : path.join(sessionDir, "summary.json");
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  const summaryOnly = options?.summaryOnly === true;
  const maxBytes = Math.max(64 * 1024, Math.min(128 * 1024 * 1024, Number(options?.maxBytes ?? (summaryOnly ? 2 * 1024 * 1024 : 64 * 1024 * 1024))));
  const maxLines = Math.max(1, Math.min(500_000, Number(options?.maxLines ?? (summaryOnly ? 2_000 : 100_000))));
  const maxLineChars = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options?.maxLineChars ?? 2 * 1024 * 1024)));

  let summary: GrokSummary = {};
  let skippedLines = 0;
  try {
    const rawSummary = (await fsp.readFile(summaryPath, "utf8")).replace(/^\uFEFF/, "");
    summary = JSON.parse(rawSummary) as GrokSummary;
  } catch {
    skippedLines += 1;
  }

  const resumeId = asNonEmptyString(summary.info?.id) || path.basename(sessionDir);
  const cwd = asNonEmptyString(summary.info?.cwd);
  const rawDate = asNonEmptyString(summary.last_active_at) || asNonEmptyString(summary.updated_at) || asNonEmptyString(summary.created_at);
  const date = parseTimestamp(rawDate) || Number(stat?.mtimeMs || 0);
  const messages: Message[] = [];
  const liveUpdates: ParsedGrokUpdate[] = [];
  const promptStarts: number[] = [];
  const userRunTracker = createUserRunTurnTracker();

  try {
    const updatesStat = await fsp.stat(updatesPath);
    const readLimit = Math.min(Math.max(0, Number(updatesStat.size || 0)), maxBytes);
    const input = fs.createReadStream(updatesPath, { encoding: "utf8", start: 0, end: Math.max(0, readLimit - 1) });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const rawLine of reader) {
      lineNumber += 1;
      if (lineNumber > maxLines) {
        skippedLines += 1;
        break;
      }
      const line = String(rawLine || "").replace(/^\uFEFF/, "").trim();
      if (!line) continue;
      if (line.length > maxLineChars) {
        skippedLines += 1;
        continue;
      }
      try {
        const envelope = JSON.parse(line);
        const parsedUpdate = parseGrokUpdateEnvelope(envelope);
        if (!parsedUpdate) {
          endUserRun(userRunTracker);
          continue;
        }
        const updateType = asNonEmptyString(parsedUpdate.update?.sessionUpdate).toLowerCase();
        const rewindTarget = readNonNegativeInteger(parsedUpdate.update?.target_prompt_index);
        if (parsedUpdate.isXai && updateType === "rewind_marker" && rewindTarget !== undefined) {
          const truncateAt = promptStarts[rewindTarget] ?? liveUpdates.length;
          liveUpdates.splice(truncateAt);
          promptStarts.splice(Math.min(rewindTarget, promptStarts.length));
          endUserRun(userRunTracker);
          continue;
        }

        const isUserChunk = !parsedUpdate.isXai
          && updateType === "user_message_chunk"
          && !isHostTurnUpdate(parsedUpdate.update);
        if (isUserChunk) {
          if (trackUserChunk(userRunTracker, getUserPromptIndex(parsedUpdate.update)).startsCountedTurn) {
            promptStarts.push(liveUpdates.length);
          }
        } else {
          endUserRun(userRunTracker);
        }
        liveUpdates.push(parsedUpdate);
      } catch {
        endUserRun(userRunTracker);
        skippedLines += 1;
      }
    }
    if (Number(updatesStat.size || 0) > maxBytes) skippedLines += 1;
  } catch {
    skippedLines += 1;
  }

  const firstUserText = extractFirstVisibleUserText(liveUpdates);
  if (!summaryOnly) {
    const renderTracker = createUserRunTurnTracker();
    let pendingUserMessageBoundary = false;
    for (const entry of liveUpdates) {
      const update = entry.update;
      const updateType = asNonEmptyString(update?.sessionUpdate).toLowerCase();
      const isHostTurn = isHostTurnUpdate(update);
      const isUserChunk = !entry.isXai && updateType === "user_message_chunk" && !isHostTurn;
      let startsNewUserMessage = false;
      if (isUserChunk) {
        startsNewUserMessage = trackUserChunk(renderTracker, getUserPromptIndex(update)).startsRun;
        pendingUserMessageBoundary = pendingUserMessageBoundary || startsNewUserMessage;
      } else {
        endUserRun(renderTracker);
        pendingUserMessageBoundary = false;
      }
      if (!isHostTurn && appendUpdateMessage(messages, update, pendingUserMessageBoundary)) {
        pendingUserMessageBoundary = false;
      }
    }
  }

  const summaryTitle = asNonEmptyString(summary.generated_title) || asNonEmptyString(summary.session_summary);
  const preview = clampListText(filterHistoryPreviewText(firstUserText), 120);
  const title = clampListText(summaryTitle || preview || `Grok ${resumeId}`, 120);
  const modelId = asNonEmptyString(summary.current_model_id);
  if (!summaryOnly && (cwd || modelId)) {
    const details = [cwd ? `cwd: ${cwd}` : "", modelId ? `model: ${modelId}` : ""].filter(Boolean).join("\n");
    messages.unshift({ role: "meta", content: [{ type: "session_meta", text: details, tags: ["grok.session_meta"] }] });
  }

  return {
    providerId: "grok",
    id: `grok:${resumeId}`,
    title,
    date,
    filePath: summaryPath,
    messages,
    skippedLines,
    rawDate: rawDate || undefined,
    preview: preview || undefined,
    cwd: cwd || undefined,
    dirKey: cwd ? dirKeyFromCwd(cwd) : undefined,
    resumeId: resumeId || undefined,
    runtimeShell: detectRuntimeShell(summaryPath),
  };
}
