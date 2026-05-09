// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { parseStatusPorcelainV2Z } from "../commitPanel/statusModel";
import type { GitShelfManagerRuntime } from "./types";

export type GitScannedWorkingTreeChange = {
  repoRoot: string;
  path: string;
  untracked: boolean;
  ignored: boolean;
};

/**
 * 扫描指定仓库当前工作区变更，统一复用 `status --porcelain=v2 -z` 作为平台层事实来源。
 */
export async function scanWorkingTreeChangesAsync(
  runtime: Pick<GitShelfManagerRuntime, "runGitExecAsync" | "toGitErrorMessage">,
  repoRoot: string,
): Promise<{ ok: true; changes: GitScannedWorkingTreeChange[] } | { ok: false; error: string }> {
  const res = await runtime.runGitExecAsync(repoRoot, ["status", "--porcelain=v2", "-z"], 20_000);
  if (!res.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(res, "读取工作区改动失败"),
    };
  }
  return {
    ok: true,
    changes: parseStatusPorcelainV2Z(String(res.stdout || ""))
      .map((entry) => ({
        repoRoot,
        path: String(entry.path || "").trim().replace(/\\/g, "/"),
        untracked: entry.untracked === true,
        ignored: entry.ignored === true,
      }))
      .filter((entry) => !!entry.path),
  };
}
