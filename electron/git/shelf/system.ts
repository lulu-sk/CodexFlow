// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitSavedLocalChanges } from "../update/types";
import { ShelveChangesManager } from "./manager";
import type { GitShelfManagerRuntime, GitShelvedChangeListItem } from "./types";
import { VcsShelveChangesSaver } from "./vcsShelveChangesSaver";

/**
 * 列出当前仓库可见的 system shelf 记录，底层直接复用统一 shelf 平台存储。
 */
export async function listSystemShelvesAsync(
  runtime: Pick<GitShelfManagerRuntime, "repoRoot" | "userDataPath">,
  payload?: { includeHidden?: boolean },
): Promise<GitShelvedChangeListItem[]> {
  const shelfManager = new ShelveChangesManager(runtime as GitShelfManagerRuntime);
  return await shelfManager.listShelvedChangeListsAsync({
    includeHidden: payload?.includeHidden,
    source: "system",
  });
}

/**
 * 删除指定 system shelf 记录，统一走平台层管理器。
 */
export async function deleteSystemShelveAsync(
  runtime: Pick<GitShelfManagerRuntime, "repoRoot" | "userDataPath">,
  ref: string,
): Promise<void> {
  const shelfManager = new ShelveChangesManager(runtime as GitShelfManagerRuntime);
  await shelfManager.deleteChangeListAsync(ref);
}

/**
 * 保存 update/preserving 产生的 system shelf 记录，并回填统一保存条目。
 */
export async function saveSystemShelveAsync(
  runtime: GitShelfManagerRuntime,
  reason: string,
): Promise<{ ok: true; saved: GitSavedLocalChanges | null } | { ok: false; error: string }> {
  const normalizedReason = String(reason || "").trim();
  const message = normalizedReason.toLowerCase().startsWith("codexflow update:")
    ? normalizedReason
    : `codexflow update: ${normalizedReason || "preserve"} @ ${new Date().toISOString()}`;
  const saver = new VcsShelveChangesSaver(runtime, message, "system");
  try {
    await saver.save([runtime.repoRoot]);
    const saved = saver.getShelvedLists()[0] || null;
    if (!saved) return { ok: true, saved: null };
    return {
      ok: true,
      saved: {
        repoRoot: saved.repoRoot,
        ref: saved.ref,
        message: saved.message,
        saveChangesPolicy: "shelve",
        displayName: saved.displayName,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error as Error)?.message || "保存搁置记录失败"),
    };
  }
}

/**
 * 恢复指定 system shelf 记录，统一复用平台层 unshelve 流程。
 */
export async function restoreSystemShelveAsync(
  runtime: GitShelfManagerRuntime,
  ref: string,
): Promise<{ ok: true } | { ok: false; error: string; conflictRepoRoots?: string[] }> {
  const shelfManager = new ShelveChangesManager(runtime);
  return await shelfManager.unshelveChangeListAsync(ref);
}
