// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";

export type GitCommitAndPushPolicy = {
  previewOnCommitAndPush: boolean;
  previewProtectedOnly: boolean;
  protectedBranchPatterns: string[];
};

export type GitCommitHooksPolicy = {
  disableRunCommitHooks: boolean;
};

export type GitCommitPanelPreferences = {
  version: 1;
  commitAndPush: GitCommitAndPushPolicy;
  hooks: GitCommitHooksPolicy;
};

const GIT_COMMIT_PANEL_PREFERENCES_VERSION = 1;

export const DEFAULT_GIT_COMMIT_AND_PUSH_POLICY: GitCommitAndPushPolicy = {
  previewOnCommitAndPush: true,
  previewProtectedOnly: false,
  protectedBranchPatterns: ["master", "main"],
};

export const DEFAULT_GIT_COMMIT_HOOKS_POLICY: GitCommitHooksPolicy = {
  disableRunCommitHooks: false,
};

/**
 * 返回 commit panel 偏好的持久化路径，供提交与状态读取统一复用。
 */
export function getGitCommitPanelPreferencesPath(userDataPath: string): string {
  return path.join(userDataPath, "git", "commit-panel-preferences.json");
}

/**
 * 把任意输入规整为稳定字符串数组，并过滤空白项与重复项。
 */
function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));
}

/**
 * 把任意输入规整为稳定的 commit-and-push 策略对象。
 */
export function normalizeGitCommitAndPushPolicy(raw: unknown): GitCommitAndPushPolicy {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const protectedBranchPatterns = normalizeStringList(input.protectedBranchPatterns);
  return {
    previewOnCommitAndPush: input.previewOnCommitAndPush !== false,
    previewProtectedOnly: input.previewProtectedOnly === true,
    protectedBranchPatterns: protectedBranchPatterns.length > 0
      ? protectedBranchPatterns
      : [...DEFAULT_GIT_COMMIT_AND_PUSH_POLICY.protectedBranchPatterns],
  };
}

/**
 * 把任意输入规整为稳定的 commit hooks 策略对象。
 */
export function normalizeGitCommitHooksPolicy(raw: unknown): GitCommitHooksPolicy {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    disableRunCommitHooks: input.disableRunCommitHooks === true,
  };
}

/**
 * 把任意输入规整为稳定的 commit panel 偏好对象。
 */
export function normalizeGitCommitPanelPreferences(raw: unknown): GitCommitPanelPreferences {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    version: GIT_COMMIT_PANEL_PREFERENCES_VERSION,
    commitAndPush: normalizeGitCommitAndPushPolicy(input.commitAndPush),
    hooks: normalizeGitCommitHooksPolicy(input.hooks),
  };
}

/**
 * 读取磁盘中的 commit panel 偏好；文件缺失或损坏时统一回退默认值。
 */
export async function readGitCommitPanelPreferencesAsync(userDataPath: string): Promise<GitCommitPanelPreferences> {
  const storePath = getGitCommitPanelPreferencesPath(userDataPath);
  try {
    const raw = await fs.promises.readFile(storePath, "utf8");
    return normalizeGitCommitPanelPreferences(JSON.parse(raw));
  } catch {
    return normalizeGitCommitPanelPreferences(null);
  }
}

/**
 * 把最新 commit panel 偏好写回磁盘，确保 hooks 与 commit-and-push 使用同一份持久化配置。
 */
async function writeGitCommitPanelPreferencesAsync(
  userDataPath: string,
  preferences: GitCommitPanelPreferences,
): Promise<GitCommitPanelPreferences> {
  const normalized = normalizeGitCommitPanelPreferences(preferences);
  const storePath = getGitCommitPanelPreferencesPath(userDataPath);
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await fs.promises.writeFile(storePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

/**
 * 按增量补丁更新 commit panel 偏好，并返回保存后的稳定结果。
 */
export async function updateGitCommitPanelPreferencesAsync(
  userDataPath: string,
  patch: {
    commitAndPush?: Partial<GitCommitAndPushPolicy>;
    hooks?: Partial<GitCommitHooksPolicy>;
  },
): Promise<GitCommitPanelPreferences> {
  const previous = await readGitCommitPanelPreferencesAsync(userDataPath);
  return await writeGitCommitPanelPreferencesAsync(userDataPath, {
    version: GIT_COMMIT_PANEL_PREFERENCES_VERSION,
    commitAndPush: normalizeGitCommitAndPushPolicy({
      ...previous.commitAndPush,
      ...(patch.commitAndPush || {}),
    }),
    hooks: normalizeGitCommitHooksPolicy({
      ...previous.hooks,
      ...(patch.hooks || {}),
    }),
  });
}

/**
 * 按 JetBrains 的保护分支规则执行安全匹配；pattern 视为完整正则并自动补上首尾锚点。
 */
export function isGitProtectedBranch(branchName: string, patterns: string[]): boolean {
  const normalizedBranchName = String(branchName || "").trim();
  if (!normalizedBranchName) return false;
  for (const patternText of patterns) {
    const pattern = String(patternText || "").trim();
    if (!pattern) continue;
    try {
      if (new RegExp(`^${pattern}$`).test(normalizedBranchName))
        return true;
    } catch {}
  }
  return false;
}

/**
 * 统一探测仓库是否存在 commit hooks，兼容 worktree 下 `.git/hooks` 路径解析。
 */
export async function detectCommitHooksAvailableAsync<GitCtx, GitExecResult extends { ok: boolean; stdout?: string; error?: string }>(
  ctx: GitCtx,
  repoRoot: string,
  runGitExecAsync: (
    ctx: GitCtx,
    repoRoot: string,
    argv: string[],
    timeoutMs?: number,
  ) => Promise<GitExecResult>,
): Promise<boolean> {
  const hooksPathRes = await runGitExecAsync(ctx, repoRoot, ["rev-parse", "--git-path", "hooks"], 8_000);
  if (!hooksPathRes.ok) return false;
  const hooksPathText = String(hooksPathRes.stdout || "").trim();
  if (!hooksPathText) return false;
  const hooksPath = path.isAbsolute(hooksPathText) ? hooksPathText : path.resolve(repoRoot, hooksPathText);
  const hookNames = ["pre-commit", "commit-msg", "prepare-commit-msg"];
  for (const hookName of hookNames) {
    const hookPath = path.join(hooksPath, hookName);
    try {
      const stat = await fs.promises.stat(hookPath);
      if (stat.isFile()) return true;
    } catch {}
  }
  return false;
}
