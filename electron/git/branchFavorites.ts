// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { toFsPathKey } from "./pathKey";

export type GitBranchFavoriteKind = "local" | "remote";

type GitBranchFavoritesStore = {
  version: 1;
  repos: Record<string, {
    local: string[];
    remote: string[];
  }>;
};

const EMPTY_GIT_BRANCH_FAVORITES_STORE: GitBranchFavoritesStore = {
  version: 1,
  repos: {},
};

/**
 * 返回分支 favorites 持久化文件路径，统一放在用户数据目录下，避免把 UI 偏好混入仓库内容。
 */
function getGitBranchFavoritesStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "branch-favorites.json");
}

/**
 * 把收藏仓库根路径规整为稳定 key，兼容大小写与分隔符差异。
 */
function toBranchFavoritesRepoKey(repoRoot: string): string {
  return toFsPathKey(repoRoot);
}

/**
 * 把任意值安全规整为非空字符串数组，用于兼容旧数据与脏数据。
 */
function normalizeFavoriteNameList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

/**
 * 读取分支 favorites 存储；文件缺失或损坏时回退到空配置，避免影响主流程。
 */
function loadGitBranchFavoritesStore(userDataPath: string): GitBranchFavoritesStore {
  const storePath = getGitBranchFavoritesStorePath(userDataPath);
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    const reposInput = parsed?.repos && typeof parsed.repos === "object" ? parsed.repos : {};
    const repos: GitBranchFavoritesStore["repos"] = {};
    for (const [repoKey, value] of Object.entries(reposInput)) {
      const normalizedRepoKey = String(repoKey || "").trim();
      if (!normalizedRepoKey) continue;
      repos[normalizedRepoKey] = {
        local: normalizeFavoriteNameList((value as any)?.local),
        remote: normalizeFavoriteNameList((value as any)?.remote),
      };
    }
    return {
      version: 1,
      repos,
    };
  } catch {
    return {
      version: 1,
      repos: {},
    };
  }
}

/**
 * 持久化分支 favorites 存储，写入前确保父目录存在。
 */
function saveGitBranchFavoritesStore(userDataPath: string, store: GitBranchFavoritesStore): void {
  const storePath = getGitBranchFavoritesStorePath(userDataPath);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/**
 * 返回指定仓库下某类分支的 favorites 集合，供 popup/tree 排序与星标展示复用。
 */
export function listGitBranchFavorites(
  userDataPath: string,
  repoRoot: string,
  kind: GitBranchFavoriteKind,
): Set<string> {
  const repoKey = toBranchFavoritesRepoKey(repoRoot);
  if (!repoKey) return new Set();
  const store = loadGitBranchFavoritesStore(userDataPath);
  const repo = store.repos[repoKey];
  if (!repo) return new Set();
  return new Set(kind === "remote" ? repo.remote : repo.local);
}

/**
 * 判断指定分支当前是否已被收藏。
 */
export function isGitBranchFavorite(
  userDataPath: string,
  repoRoot: string,
  kind: GitBranchFavoriteKind,
  name: string,
): boolean {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return false;
  return listGitBranchFavorites(userDataPath, repoRoot, kind).has(normalizedName);
}

/**
 * 显式设置分支收藏状态，并返回更新后的收藏结果。
 */
export function setGitBranchFavorite(
  userDataPath: string,
  repoRoot: string,
  kind: GitBranchFavoriteKind,
  name: string,
  favorite: boolean,
): boolean {
  const repoKey = toBranchFavoritesRepoKey(repoRoot);
  const normalizedName = String(name || "").trim();
  if (!repoKey || !normalizedName) return false;

  const store = loadGitBranchFavoritesStore(userDataPath);
  const repo = store.repos[repoKey] || {
    local: [],
    remote: [],
  };
  const target = new Set(kind === "remote" ? repo.remote : repo.local);
  if (favorite) target.add(normalizedName);
  else target.delete(normalizedName);

  const nextRepo = {
    ...repo,
    [kind]: Array.from(target).sort((left, right) => left.localeCompare(right)),
  };
  if (nextRepo.local.length <= 0 && nextRepo.remote.length <= 0) delete store.repos[repoKey];
  else store.repos[repoKey] = nextRepo;
  saveGitBranchFavoritesStore(userDataPath, store);
  return favorite;
}

/**
 * 切换分支收藏状态，并返回切换后的目标状态，供 UI 无需再次推导。
 */
export function toggleGitBranchFavorite(
  userDataPath: string,
  repoRoot: string,
  kind: GitBranchFavoriteKind,
  name: string,
): boolean {
  const nextFavorite = !isGitBranchFavorite(userDataPath, repoRoot, kind, name);
  return setGitBranchFavorite(userDataPath, repoRoot, kind, name, nextFavorite);
}

/**
 * 供测试重置分支 favorites 持久化状态，避免跨用例串味。
 */
export function clearGitBranchFavoritesStore(userDataPath: string): void {
  saveGitBranchFavoritesStore(userDataPath, EMPTY_GIT_BRANCH_FAVORITES_STORE);
}
