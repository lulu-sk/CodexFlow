// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/** 终端程序状态协议的主任务记录；子任务由 id 区分。 */
export type TerminalProgramStatus = {
  state: "idle" | "working" | "done" | "blocked" | "error" | "clear";
  app: string;
  id: string;
  message: string;
  receivedAt: number;
};

export const PROGRAM_STATUS_CAPABILITY_REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

/** 解析 OSC 7501 的字段；未知状态、重复字段和无效消息不能伪造完成。 */
export function parseTerminalProgramStatus(payload: string, now = Date.now()): TerminalProgramStatus | null {
  if (payload.length > 8192) return null;
  const fields = new Map<string, string>();
  for (const pair of payload.split(":")) {
    const separator = pair.indexOf("=");
    if (separator < 1) return null;
    const key = pair.slice(0, separator);
    if (fields.has(key)) return null;
    fields.set(key, pair.slice(separator + 1));
  }
  const state = fields.get("state");
  if (!state || !["idle", "working", "done", "blocked", "error", "clear"].includes(state)) return null;
  let message = "";
  const encoded = fields.get("msg");
  if (encoded) {
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      if (bytes.length > 2048) return null;
      message = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(message)) return null;
    } catch { return null; }
  }
  return {
    state: state as TerminalProgramStatus["state"],
    app: fields.get("app") || "",
    id: fields.get("id") || "",
    message,
    receivedAt: now,
  };
}
