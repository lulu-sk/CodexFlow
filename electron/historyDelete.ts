// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const ANTIGRAVITY_CONVERSATIONS_SEGMENT = "/.gemini/antigravity-cli/conversations/";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * 判断路径是否指向 Antigravity conversation SQLite 主库。
 */
export function isAntigravityConversationDbPath(filePath: string): boolean {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes(ANTIGRAVITY_CONVERSATIONS_SEGMENT)) return false;
  const baseName = normalized.split("/").pop() || "";
  return baseName.endsWith(".db")
    && !baseName.endsWith(".db-wal")
    && !baseName.endsWith(".db-shm")
    && !baseName.endsWith(".db-journal");
}

/**
 * 扩展历史删除候选；Antigravity SQLite 会话需要连同 WAL/SHM/JOURNAL 辅助文件一起清理。
 */
export function expandAntigravityConversationDeleteCandidates(candidates: readonly string[]): string[] {
  const out: string[] = [];
  const push = (value?: string) => {
    const next = String(value || "").trim();
    if (next && !out.includes(next)) out.push(next);
  };

  for (const item of candidates || []) {
    const candidate = String(item || "").trim();
    if (!candidate) continue;
    push(candidate);
    if (!isAntigravityConversationDbPath(candidate)) continue;
    for (const suffix of SQLITE_SIDECAR_SUFFIXES)
      push(`${candidate}${suffix}`);
  }

  return out;
}
