// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { normalizeRepoPaths } from "./pathUtils";
import { ChangeListPlatformService } from "../changelists";

type PathEntryState = {
  untracked?: boolean;
  ignored?: boolean;
};

type MoveFilesDependencies = {
  addUntrackedPathsAsync?: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
  forceAddIgnoredPathsAsync?: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
};

/**
 * 创建 changelist 平台门面，统一承接能力判断与持久化写操作。
 */
function createChangeListPlatformService(userDataPath: string, repoRoot: string): ChangeListPlatformService {
  return new ChangeListPlatformService({ userDataPath, repoRoot });
}

/**
 * 创建新 changelist，并按显式参数决定是否切换为活动列表。
 */
export function createChangeList(
  userDataPath: string,
  repoRoot: string,
  name: string,
  setActive: boolean = false,
): { ok: boolean; data?: any; error?: string } {
  try {
    return {
      ok: true,
      data: createChangeListPlatformService(userDataPath, repoRoot).createChangeList(name, { setActive }),
    };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "创建变更列表失败") };
  }
}

/**
 * 重命名 changelist，并执行重名校验。
 */
export function renameChangeList(userDataPath: string, repoRoot: string, id: string, name: string): { ok: boolean; data?: any; error?: string } {
  try {
    return { ok: true, data: createChangeListPlatformService(userDataPath, repoRoot).renameChangeList(id, name) };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "重命名变更列表失败") };
  }
}

/**
 * 设置活动 changelist，新产生的文件映射会默认归入该列表。
 */
export function setActiveChangeList(userDataPath: string, repoRoot: string, id: string): { ok: boolean; data?: any; error?: string } {
  try {
    return { ok: true, data: createChangeListPlatformService(userDataPath, repoRoot).setActiveChangeList(id) };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "设置活动更改列表失败") };
  }
}

/**
 * 更新 changelist 的 comment/data 元数据，供提交草稿与作者信息按列表持久化复用。
 */
export function updateChangeListData(
  userDataPath: string,
  repoRoot: string,
  id: string,
  patch: { comment?: string | null; data?: Record<string, any> | null },
): { ok: boolean; data?: any; error?: string } {
  try {
    return { ok: true, data: createChangeListPlatformService(userDataPath, repoRoot).updateChangeListMetadata(id, patch) };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "更新更改列表元数据失败") };
  }
}

/**
 * 删除 changelist；若删除活动列表，则必须先确定新的活动列表，再迁移文件并删除。
 */
export function deleteChangeList(
  userDataPath: string,
  repoRoot: string,
  id: string,
  targetListIdInput?: string,
): { ok: boolean; data?: any; error?: string } {
  try {
    return { ok: true, data: createChangeListPlatformService(userDataPath, repoRoot).deleteChangeList(id, targetListIdInput) };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "删除变更列表失败") };
  }
}

/**
 * 移动文件到目标 changelist；对 ignored/unversioned 文件自动补走 add-to-vcs 语义。
 */
export async function moveFilesToChangeListAsync(
  userDataPath: string,
  repoRoot: string,
  pathsInput: any,
  targetListIdInput: string,
  entryStateByPath: Record<string, PathEntryState>,
  dependencies?: MoveFilesDependencies,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const paths = normalizeRepoPaths(repoRoot, pathsInput);
  const ignoredPaths = paths.filter((one) => entryStateByPath[one]?.ignored);
  const untrackedPaths = paths.filter((one) => entryStateByPath[one]?.untracked && !entryStateByPath[one]?.ignored);

  if (ignoredPaths.length > 0 && dependencies?.forceAddIgnoredPathsAsync) {
    const res = await dependencies.forceAddIgnoredPathsAsync(ignoredPaths);
    if (!res.ok) return { ok: false, error: res.error || "添加已忽略文件到 VCS 失败" };
  }
  if (untrackedPaths.length > 0 && dependencies?.addUntrackedPathsAsync) {
    const res = await dependencies.addUntrackedPathsAsync(untrackedPaths);
    if (!res.ok) return { ok: false, error: res.error || "添加未跟踪文件到 VCS 失败" };
  }
  try {
    const result = createChangeListPlatformService(userDataPath, repoRoot).moveFilesToChangeList(paths, targetListIdInput);
    return {
      ok: true,
      data: {
        moved: result.moved,
        targetListId: result.targetListId,
        addedToVcsCount: ignoredPaths.length + untrackedPaths.length,
      },
    };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || "移动变更列表失败") };
  }
}
