// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import readline from "node:readline";
import { openCodexHistoryStream } from "./codexRollout";
import { filterCodexHistoryPreviewText } from "./agentSessions/shared/preview";

/** 判断一条记录是否含真实对话，排除初始化上下文，同时保留纯图片请求。 */
function hasConversationRecord(line: string): boolean {
  try {
    const record = JSON.parse(line.replace(/^\uFEFF/, ""));
    const message = record.type === "response_item" ? record.payload : record;
    if (message?.type !== "message" && message?.record_type !== "message") return false;
    if (!["user", "assistant"].includes(String(message.role || message.actor || ""))) return false;
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    return content.some((item: any) => {
      const type = String(item?.type || "");
      if (["input_image", "image", "image_url"].includes(type)) return true;
      if (["instructions", "environment_context"].includes(type)) return false;
      return !!filterCodexHistoryPreviewText(String(item?.text || ""));
    });
  } catch { return false; }
}

/** 优先复用已读取的前缀；未确定时沿逻辑历史流查找，读到真实对话立即停止。 */
export async function hasCodexConversation(filePath: string, prefix: string): Promise<boolean> {
  if (prefix.split(/\r?\n/).some(hasConversationRecord)) return true;
  const input = await openCodexHistoryStream(filePath, 64 * 1024);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines)
      if (hasConversationRecord(line)) return true;
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}
