// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { MessageContent } from "../../history";

type ClaudeUserMetadata = {
  isMeta?: boolean;
  isCompactSummary?: boolean;
  promptSource?: string;
};

/** 拆分用户消息前缀里的自动上下文，保留真实提问及原始系统文本供筛选查看。 */
export function splitClaudeUserContext(text: string, metadata: ClaudeUserMetadata): MessageContent[] {
  let rest = text.trim();
  if (!rest) return [];
  if (metadata.isCompactSummary === true
    || /^This session is being continued from a previous conversation that ran out of context\.\s+The summary below covers the earlier portion of the conversation\.\s+Summary:/i.test(rest))
    return [{ type: "context_summary", text: rest }];

  const content: MessageContent[] = [];
  const { promptText, transcriptText } = splitClaudeUserTextForLocalCommandTranscript(rest);
  if (transcriptText) content.push({ type: "local_command", text: transcriptText });
  rest = promptText;
  if (metadata.isMeta === true || metadata.promptSource === "system") {
    if (rest) content.push({ type: "system_context", text: rest });
    return content;
  }
  while (rest) {
    const tag = rest.match(/^<(system-reminder|task-notification)\b[^>]*>/i);
    if (tag) {
      const close = `</${tag[1].toLowerCase()}>`;
      const end = rest.toLowerCase().indexOf(close, tag[0].length);
      const length = end < 0 ? rest.length : end + close.length;
      content.push({ type: "system_context", text: rest.slice(0, length) });
      rest = rest.slice(length).trim();
      continue;
    }
    const imageHint = rest.match(/^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\](?:\r?\n|$)/i);
    if (imageHint) {
      content.push({ type: "system_context", text: imageHint[0].trim() });
      rest = rest.slice(imageHint[0].length).trim();
      continue;
    }
    content.push({ type: "input_text", text: rest });
    break;
  }
  return content;
}

/** 判断本地命令记录行，避免将命令回显计入真实用户输入。 */
function isClaudeLocalCommandTranscriptLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return lower.startsWith("caveat:")
    || lower.includes("<command-name>")
    || lower.includes("<command-message>")
    || lower.includes("<command-args>")
    || lower.includes("<local-command-")
    || lower.includes("</local-command-");
}

/** 分离本地命令回显与同条消息中的真实提问，保留既有日志格式兼容性。 */
function splitClaudeUserTextForLocalCommandTranscript(text: string): { promptText: string; transcriptText: string } {
  const trimmed = text.trim();
  if (!isClaudeLocalCommandTranscriptLine(trimmed)) return { promptText: trimmed, transcriptText: "" };
  const transcriptLines: string[] = [];
  const promptLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (isClaudeLocalCommandTranscriptLine(line)) transcriptLines.push(line);
    else promptLines.push(line);
  }
  return {
    promptText: promptLines.join("\n").trim(),
    transcriptText: promptLines.length === 0 ? trimmed : transcriptLines.join("\n").trim(),
  };
}
