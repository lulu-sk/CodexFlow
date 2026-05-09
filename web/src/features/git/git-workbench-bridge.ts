// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export const GIT_WORKBENCH_SHOW_STAGE_ACTION_ID = "Git.Show.Stage";
export const GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID = "Git.Commit.Stage";
export const GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID = "Git.Commit.And.Push.Executor";
export const GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID = "Git.Commit.Options";
export const GIT_WORKBENCH_UPDATE_PROJECT_ACTION_ID = "Git.Update.Project";
export const GIT_WORKBENCH_UPDATE_OPTIONS_ACTION_ID = "Git.Update.Options";
export const GIT_WORKBENCH_PULL_ACTION_ID = "Git.Pull";
export const GIT_WORKBENCH_FETCH_ACTION_ID = "Git.Fetch";
export const GIT_WORKBENCH_PUSH_ACTION_ID = "Git.Push";
export const GIT_WORKBENCH_RESOLVE_CONFLICTS_ACTION_ID = "Git.ResolveConflicts";
export const GIT_WORKBENCH_STASH_ACTION_ID = "Git.Stash";
export const GIT_WORKBENCH_UNSTASH_ACTION_ID = "Git.Unstash";

export const GIT_WORKBENCH_PUBLIC_ACTION_IDS = [
  GIT_WORKBENCH_SHOW_STAGE_ACTION_ID,
  GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID,
  GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID,
  GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID,
  GIT_WORKBENCH_UPDATE_PROJECT_ACTION_ID,
  GIT_WORKBENCH_UPDATE_OPTIONS_ACTION_ID,
  GIT_WORKBENCH_PULL_ACTION_ID,
  GIT_WORKBENCH_FETCH_ACTION_ID,
  GIT_WORKBENCH_PUSH_ACTION_ID,
  GIT_WORKBENCH_RESOLVE_CONFLICTS_ACTION_ID,
  GIT_WORKBENCH_STASH_ACTION_ID,
  GIT_WORKBENCH_UNSTASH_ACTION_ID,
] as const;

export type GitWorkbenchPublicActionId = typeof GIT_WORKBENCH_PUBLIC_ACTION_IDS[number];

export type GitWorkbenchHostRequestKind = "show" | "commit";

export type GitWorkbenchHostRequest = {
  requestId: number;
  kind: GitWorkbenchHostRequestKind;
  actionId: string;
  projectId?: string;
  projectPath?: string;
  prefillCommitMessage?: string;
  focusCommitMessage: boolean;
  selectCommitMessage: boolean;
  receivedAt: number;
};

type GitWorkbenchHostRequestListener = (request: GitWorkbenchHostRequest) => void;

let gitWorkbenchHostRequestSeq = 0;

const gitWorkbenchHostRequestListeners = new Set<GitWorkbenchHostRequestListener>();
const gitWorkbenchHostPendingByProjectPath = new Map<string, GitWorkbenchHostRequest>();

/**
 * 把项目路径规整为稳定 key，供 App 与 GitWorkbench 组件跨层传递宿主请求时复用。
 */
export function normalizeGitWorkbenchProjectPathKey(projectPath: string): string {
  return String(projectPath || "").replace(/\\/g, "/").trim().toLowerCase();
}

/**
 * 把宿主输入规整为 GitWorkbench 可消费的统一请求对象。
 */
export function createGitWorkbenchHostRequest(
  kind: GitWorkbenchHostRequestKind,
  payload?: Partial<GitWorkbenchHostRequest>,
): GitWorkbenchHostRequest {
  gitWorkbenchHostRequestSeq += 1;
  const normalizedActionId = normalizeGitWorkbenchActionId(payload?.actionId, kind);
  const normalizedKind = kind === "commit" || isGitWorkbenchCommitLikeActionId(normalizedActionId) ? "commit" : "show";
  return {
    requestId: Math.max(1, Math.floor(Number(payload?.requestId) || gitWorkbenchHostRequestSeq)),
    kind: normalizedKind,
    actionId: normalizedActionId,
    projectId: String(payload?.projectId || "").trim() || undefined,
    projectPath: String(payload?.projectPath || "").trim() || undefined,
    prefillCommitMessage: typeof payload?.prefillCommitMessage === "string"
      ? payload.prefillCommitMessage.replace(/\r\n?/g, "\n")
      : undefined,
    focusCommitMessage: payload?.focusCommitMessage === true || normalizedKind === "commit",
    selectCommitMessage: payload?.selectCommitMessage === true || normalizedKind === "commit",
    receivedAt: Number(payload?.receivedAt) > 0 ? Number(payload?.receivedAt) : Date.now(),
  };
}

/**
 * 把任意 actionId 规整到当前 GitWorkbench 可识别的公共动作集合，未知值统一回退到默认打开动作。
 */
export function normalizeGitWorkbenchActionId(
  actionId: unknown,
  kind?: GitWorkbenchHostRequestKind,
): GitWorkbenchPublicActionId {
  const normalizedActionId = String(actionId || "").trim();
  if ((GIT_WORKBENCH_PUBLIC_ACTION_IDS as readonly string[]).includes(normalizedActionId))
    return normalizedActionId as GitWorkbenchPublicActionId;
  return kind === "commit" ? GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID : GIT_WORKBENCH_SHOW_STAGE_ACTION_ID;
}

/**
 * 判断某个宿主动作是否应按“提交工作流”语义打开，供 App 与 GitWorkbench 共用同一套 commit-like 判定。
 */
export function isGitWorkbenchCommitLikeActionId(actionId: unknown): boolean {
  const normalizedActionId = normalizeGitWorkbenchActionId(actionId);
  return normalizedActionId === GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID
    || normalizedActionId === GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID
    || normalizedActionId === GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID;
}

/**
 * 广播宿主发来的 GitWorkbench 打开请求，并按项目路径缓存最近一次请求，供延迟挂载的组件补消费。
 */
export function publishGitWorkbenchHostRequest(request: GitWorkbenchHostRequest): void {
  const normalizedPathKey = normalizeGitWorkbenchProjectPathKey(request.projectPath || "");
  if (normalizedPathKey)
    gitWorkbenchHostPendingByProjectPath.set(normalizedPathKey, request);
  for (const listener of gitWorkbenchHostRequestListeners) {
    try {
      listener(request);
    } catch {}
  }
}

/**
 * 按项目路径读取并消费一条待处理宿主请求，避免 GitWorkbench 首次挂载时错过打开意图。
 */
export function consumeGitWorkbenchHostRequest(projectPath: string): GitWorkbenchHostRequest | null {
  const normalizedPathKey = normalizeGitWorkbenchProjectPathKey(projectPath);
  if (!normalizedPathKey) return null;
  const request = gitWorkbenchHostPendingByProjectPath.get(normalizedPathKey) || null;
  if (request)
    gitWorkbenchHostPendingByProjectPath.delete(normalizedPathKey);
  return request;
}

/**
 * 订阅宿主 GitWorkbench 请求总线，供 App 与 GitWorkbench 组件共享同一条入口事件流。
 */
export function subscribeGitWorkbenchHostRequests(listener: GitWorkbenchHostRequestListener): () => void {
  gitWorkbenchHostRequestListeners.add(listener);
  return () => {
    gitWorkbenchHostRequestListeners.delete(listener);
  };
}
