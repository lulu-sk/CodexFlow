import { describe, expect, it } from "vitest";
import type { GitPushRejectedAction } from "../types";
import {
  buildPushRejectedRetrySuccessMessage,
  resolvePushRejectedUpdateMethod,
} from "./push-rejected-flow";

/**
 * 构造最小 Push Rejected 动作，避免测试重复拼装无关字段。
 */
function createAction(payloadPatch: Record<string, any>): GitPushRejectedAction {
  return {
    kind: "update-with-merge",
    label: "更新后重试",
    payloadPatch,
    variant: "primary",
  };
}

describe("push-rejected-flow", () => {
  it("应只提取 Merge/Rebase 两类更新方式，并忽略其他 payload patch", () => {
    expect(resolvePushRejectedUpdateMethod(createAction({ updateMethod: "merge" }))).toBe("merge");
    expect(resolvePushRejectedUpdateMethod(createAction({ updateMethod: "rebase" }))).toBe("rebase");
    expect(resolvePushRejectedUpdateMethod(createAction({ forceWithLease: true }))).toBeNull();
    expect(resolvePushRejectedUpdateMethod(createAction({ forcePush: true }))).toBeNull();
    expect(resolvePushRejectedUpdateMethod(createAction({ updateMethod: "reset" }))).toBeNull();
  });

  it("应为更新后重试推送生成稳定的聚合提示文案", () => {
    expect(buildPushRejectedRetrySuccessMessage("merge")).toBe("已完成更新（合并）并自动重试推送");
    expect(buildPushRejectedRetrySuccessMessage("rebase")).toBe("已完成更新（变基）并自动重试推送");
    expect(buildPushRejectedRetrySuccessMessage(null)).toBe("已完成更新并自动重试推送");
  });
});
