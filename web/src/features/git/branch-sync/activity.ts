// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const BRANCH_SYNC_AUTO_REFRESH_ACTIONS = new Set<string>([
  "branch.switch",
  "branch.action",
  "flow.fetch",
  "flow.pull",
  "commit.create",
  "log.action",
  "log.details.action",
  "log.rebasePlan.run",
  "operation.continue",
  "operation.abort",
]);

/**
 * 判断某次 Git 活动结束后是否需要刷新分支同步快照。
 * - 仅在动作成功完成后触发，避免失败场景频繁覆盖错误上下文；
 * - 只监听会改变 HEAD、上游状态或本地提交图的动作，避免把普通只读请求放大为额外刷新。
 */
export function shouldAutoRefreshBranchSyncAfterActivity(action: string, ok?: boolean): boolean {
  if (ok !== true) return false;
  return BRANCH_SYNC_AUTO_REFRESH_ACTIONS.has(String(action || "").trim());
}
