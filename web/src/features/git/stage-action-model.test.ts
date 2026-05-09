import { describe, expect, it } from "vitest";
import { resolveGitStageGlobalActionAvailability } from "./stage-action-model";

const t = ((_: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "") as any;

describe("stage action model", () => {
  it("toolbar/context menu 应在存在整树未跟踪或未暂存更改时启用 Git.Stage.Add.All", () => {
    const state = resolveGitStageGlobalActionAvailability({
      canStageAll: true,
      canStageAllTracked: false,
    }, t);

    expect(state.stageAll).toEqual({
      label: "暂存所有更改",
      enabled: true,
    });
    expect(state.stageTracked).toEqual({
      label: "暂存所有已跟踪更改",
      enabled: false,
      reason: "当前仓库没有可全局暂存的已跟踪更改",
    });
  });

  it("toolbar/context menu 应在整树无待暂存项时给出禁用原因", () => {
    expect(resolveGitStageGlobalActionAvailability({
      canStageAll: false,
      canStageAllTracked: true,
    }, t).stageAll).toEqual({
      label: "暂存所有更改",
      enabled: false,
      reason: "当前仓库没有可全局暂存的未跟踪或未暂存更改",
    });
  });
});
