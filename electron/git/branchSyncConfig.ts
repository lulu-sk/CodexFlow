// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";

export type GitBranchSyncSettings = {
  version: 1;
  enabled: boolean;
  showOnlyMy: boolean;
};

const DEFAULT_GIT_BRANCH_SYNC_SETTINGS: GitBranchSyncSettings = {
  version: 1,
  enabled: true,
  showOnlyMy: false,
};

/**
 * 返回分支同步设置文件路径；该开关按项目级别持久化，不跟随具体仓库根切分。
 */
function getGitBranchSyncSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, "git", "branch-sync.json");
}

/**
 * 把任意输入规整为稳定设置对象，兼容旧值或损坏值。
 */
function normalizeGitBranchSyncSettings(value: any): GitBranchSyncSettings {
  return {
    version: 1,
    enabled: value?.enabled !== false,
    showOnlyMy: value?.showOnlyMy === true,
  };
}

/**
 * 读取项目级分支同步设置；文件缺失或损坏时统一回退到默认启用。
 */
export function readGitBranchSyncSettings(userDataPath: string): GitBranchSyncSettings {
  const settingsPath = getGitBranchSyncSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    return normalizeGitBranchSyncSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GIT_BRANCH_SYNC_SETTINGS };
  }
}

/**
 * 写回项目级分支同步设置，写入前确保父目录存在。
 */
export function writeGitBranchSyncSettings(
  userDataPath: string,
  patch: Partial<Pick<GitBranchSyncSettings, "enabled" | "showOnlyMy">>,
): GitBranchSyncSettings {
  const next = normalizeGitBranchSyncSettings({
    ...readGitBranchSyncSettings(userDataPath),
    ...patch,
  });
  const settingsPath = getGitBranchSyncSettingsPath(userDataPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
