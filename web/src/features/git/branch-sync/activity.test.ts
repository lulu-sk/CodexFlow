import { describe, expect, it } from "vitest";
import { shouldAutoRefreshBranchSyncAfterActivity } from "./activity";

describe("branch sync activity", () => {
  it("成功完成的 refs/history 改写动作应触发分支同步刷新", () => {
    expect(shouldAutoRefreshBranchSyncAfterActivity("flow.fetch", true)).toBe(true);
    expect(shouldAutoRefreshBranchSyncAfterActivity("branch.switch", true)).toBe(true);
    expect(shouldAutoRefreshBranchSyncAfterActivity("commit.create", true)).toBe(true);
  });

  it("失败动作与只读动作不应触发分支同步刷新", () => {
    expect(shouldAutoRefreshBranchSyncAfterActivity("flow.fetch", false)).toBe(false);
    expect(shouldAutoRefreshBranchSyncAfterActivity("status.get", true)).toBe(false);
    expect(shouldAutoRefreshBranchSyncAfterActivity("log.details", true)).toBe(false);
  });
});
