import { describe, expect, it } from "vitest";
import {
  buildBranchRowPresentation,
  buildCurrentBranchPresentation,
  buildIncomingBranchSyncBadge,
  buildOutgoingBranchSyncBadge,
} from "./presentation";

describe("branch sync presentation", () => {
  it("顶栏当前分支 tooltip 应拼接分支名与同步状态说明", () => {
    const presentation = buildCurrentBranchPresentation({
      branchName: "master",
      detached: false,
      sync: {
        upstream: "origin/master",
        incoming: 2,
        outgoing: 1,
        hasUnfetched: false,
        status: "diverged",
        tooltip: "跟踪分支：origin/master\n落后 2 个提交，领先 1 个提交。",
      },
    });
    expect(presentation.label).toBe("master");
    expect(presentation.tooltip).toContain("当前分支：master");
    expect(presentation.tooltip).toContain("落后 2 个提交，领先 1 个提交");
  });

  it("incoming / outgoing 标签应按 IDEA 规则格式化为 99+ 与空数字 incoming", () => {
    const incoming = buildIncomingBranchSyncBadge({
      upstream: "origin/master",
      incoming: 124,
      outgoing: 0,
      hasUnfetched: false,
      status: "incoming",
      tooltip: "",
    });
    const unfetchedIncoming = buildIncomingBranchSyncBadge({
      upstream: "origin/master",
      incoming: 0,
      outgoing: 0,
      hasUnfetched: true,
      status: "incoming",
      tooltip: "",
    });
    const outgoing = buildOutgoingBranchSyncBadge({
      upstream: "origin/master",
      incoming: 0,
      outgoing: 124,
      hasUnfetched: false,
      status: "outgoing",
      tooltip: "",
    });

    expect(incoming?.text).toBe("99+");
    expect(unfetchedIncoming?.text).toBe("");
    expect(outgoing?.text).toBe("99+");
  });

  it("分支行展示模型应把 tracked branch 收敛到 tooltip 与同步标签", () => {
    const presentation = buildBranchRowPresentation({
      name: "feature/topic",
      upstream: "origin/feature/topic",
      sync: {
        upstream: "origin/feature/topic",
        incoming: 3,
        outgoing: 1,
        hasUnfetched: false,
        status: "diverged",
        tooltip: "跟踪分支：origin/feature/topic\n落后 3 个提交，领先 1 个提交。",
      },
    });

    expect(presentation.tooltip).toContain("origin/feature/topic");
    expect(presentation.incomingBadge?.text).toBe("3");
    expect(presentation.outgoingBadge?.text).toBe("1");
  });

  it("缺少同步说明时仍应通过 tooltip 暴露 tracked branch", () => {
    const presentation = buildBranchRowPresentation({
      name: "feature/topic",
      upstream: "origin/feature/topic",
    });

    expect(presentation.tooltip).toBe("跟踪分支：origin/feature/topic");
  });
});
