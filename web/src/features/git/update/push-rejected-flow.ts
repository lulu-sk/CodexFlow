import type { GitPushRejectedAction, GitUpdateOptionMethod } from "../types";
import { resolveGitText } from "../git-i18n";

/**
 * 从 Push Rejected 决策动作中提取用户显式选择的更新方式，供持久化设置与后续提示复用。
 */
export function resolvePushRejectedUpdateMethod(action: GitPushRejectedAction): GitUpdateOptionMethod | null {
  const value = String(action?.payloadPatch?.updateMethod || "").trim().toLowerCase();
  if (value === "merge" || value === "rebase") return value;
  return null;
}

/**
 * 生成“先更新再推送”成功后的聚合提示文案，统一覆盖 Merge / Rebase 两类入口。
 */
export function buildPushRejectedRetrySuccessMessage(updateMethod: GitUpdateOptionMethod | null): string {
  if (updateMethod === "rebase") {
    return resolveGitText("flow.pushRejected.retrySuccessWithMethod", "已完成更新（{{method}}）并自动重试推送", {
      method: resolveGitText("dialogs.updateOptions.methods.rebase.title", "变基"),
    });
  }
  if (updateMethod === "merge") {
    return resolveGitText("flow.pushRejected.retrySuccessWithMethod", "已完成更新（{{method}}）并自动重试推送", {
      method: resolveGitText("dialogs.updateOptions.methods.merge.title", "合并"),
    });
  }
  return resolveGitText("flow.pushRejected.retrySuccess", "已完成更新并自动重试推送");
}
