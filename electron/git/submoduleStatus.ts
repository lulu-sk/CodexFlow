// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";

type SubmoduleStatusResult = { ok: boolean; stdout?: string };
type GitRunner = (repoRoot: string, argv: string[], timeoutMs: number) => Promise<SubmoduleStatusResult>;

/** 仅在配置确实缺失且索引确认没有子模块时省略递归查询；不确定状态保留原结果。 */
export async function readSubmoduleStatusAsync(repoRoot: string, runGit: GitRunner): Promise<SubmoduleStatusResult> {
  let mayCheckIndex = false;
  try {
    await fsp.lstat(path.join(repoRoot, ".gitmodules"));
  } catch (error) {
    mayCheckIndex = (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
  if (mayCheckIndex) {
    try {
      // 没有工作区标记时直接回退；标记存在仍不代表 Git 认可此工作区。
      await fsp.lstat(path.join(repoRoot, ".git"));
      const index = await runGit(repoRoot, ["ls-files", "--stage", "-z"], 20_000);
      const output = index.stdout;
      if (index.ok && output !== undefined && (
        output === "" || (output.endsWith("\0") && output.slice(0, -1).split("\0").every(
          (entry) => /^(?:100644|100755|120000) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0\t[^\0]+$/.test(entry),
        ))
      )) {
        // core.bare 等配置也会禁用工作区，必须由 Git 确认，不能只看 .git 标记。
        const worktree = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], 20_000);
        if (worktree.ok && worktree.stdout?.trim() === "true") return { ok: true, stdout: "" };
      }
    } catch {
      // 索引探测异常不能代替原查询的成功或失败结果。
    }
  }
  return await runGit(repoRoot, ["submodule", "status", "--recursive"], 20_000);
}
