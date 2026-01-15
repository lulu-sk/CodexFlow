// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { Message } from "../../history";

/**
 * 判断会话 messages 中是否存在“有效输入/输出”的非空文本。
 *
 * 说明：
 * - 主通道：input_text / output_text
 * - 兼容旧格式：user/assistant 的 text 也视为有效（避免把旧日志误判为空历史）
 * - 其他类型一律不计入（例如 instructions/environment_context/meta/tool 等）
 */
export function hasNonEmptyIOFromMessages(messages: Message[] | null | undefined): boolean {
  try {
    for (const m of (messages || [])) {
      const role = String((m as any)?.role || "").toLowerCase();
      const items = Array.isArray((m as any)?.content) ? (m as any).content : [];
      for (const it of items) {
        const ty = String((it as any)?.type || "").toLowerCase();
        const txt = String((it as any)?.text || "").trim();
        if (!txt) continue;
        if (ty === "input_text" || ty === "output_text") return true;
        if (ty === "text" && (role === "user" || role === "assistant")) return true;
      }
    }
  } catch {}
  return false;
}

