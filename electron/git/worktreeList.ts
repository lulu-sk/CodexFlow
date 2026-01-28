// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type WorktreeListEntry = {
  /** worktree 根目录路径（git 输出原样，后续需自行做路径归一化） */
  worktree: string;
  /** HEAD sha1（完整） */
  head?: string;
  /** 当前分支引用（如 refs/heads/main） */
  branch?: string;
  /** 是否为 detached HEAD */
  detached?: boolean;
  /** 是否被锁定（git worktree lock） */
  locked?: boolean;
  /** 是否标记 prune（不常见） */
  prune?: boolean;
};

/**
 * 解析 `git worktree list --porcelain` 输出为结构化列表。
 */
export function parseWorktreeListPorcelain(stdout: string): WorktreeListEntry[] {
  const lines = String(stdout || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const out: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | null = null;
  const flush = () => {
    if (cur && cur.worktree) out.push(cur);
    cur = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    if (!line.trim()) {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      flush();
      cur = { worktree: value };
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") {
      cur.head = value;
      continue;
    }
    if (key === "branch") {
      cur.branch = value;
      continue;
    }
    if (key === "detached") {
      cur.detached = true;
      continue;
    }
    if (key === "locked") {
      cur.locked = true;
      continue;
    }
    if (key === "prune") {
      cur.prune = true;
      continue;
    }
  }
  flush();
  return out;
}

