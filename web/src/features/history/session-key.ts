// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/** Codex 回退会更换文件但保留会话编号，列表合并必须使用与选中状态一致的编号。 */
export function historySessionKey(session: { providerId: string; id: string; filePath?: string }): string {
  const id = String(session.id || "").trim().toLowerCase();
  return session.providerId === "codex" && id
    ? `codex:${id}`
    : `${session.providerId}:${session.filePath || session.id}`;
}
