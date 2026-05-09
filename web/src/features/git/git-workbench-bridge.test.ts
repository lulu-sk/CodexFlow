import { describe, expect, it } from "vitest";
import {
  consumeGitWorkbenchHostRequest,
  createGitWorkbenchHostRequest,
  GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID,
  GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID,
  GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID,
  GIT_WORKBENCH_FETCH_ACTION_ID,
  GIT_WORKBENCH_PUBLIC_ACTION_IDS,
  GIT_WORKBENCH_SHOW_STAGE_ACTION_ID,
  isGitWorkbenchCommitLikeActionId,
  normalizeGitWorkbenchActionId,
  normalizeGitWorkbenchProjectPathKey,
  publishGitWorkbenchHostRequest,
  subscribeGitWorkbenchHostRequests,
} from "./git-workbench-bridge";

describe("git workbench bridge", () => {
  it("应按路径缓存最近一次宿主请求并在消费后清空", () => {
    const request = createGitWorkbenchHostRequest("show", {
      actionId: GIT_WORKBENCH_SHOW_STAGE_ACTION_ID,
      projectPath: "C:\\Repo\\App",
    });
    publishGitWorkbenchHostRequest(request);

    expect(consumeGitWorkbenchHostRequest("c:/repo/app")?.requestId).toBe(request.requestId);
    expect(consumeGitWorkbenchHostRequest("c:/repo/app")).toBeNull();
  });

  it("commit 请求应默认打开并全选提交消息编辑器", () => {
    const request = createGitWorkbenchHostRequest("commit", {
      actionId: GIT_WORKBENCH_COMMIT_STAGE_ACTION_ID,
      projectPath: "/repo",
    });

    expect(request.focusCommitMessage).toBe(true);
    expect(request.selectCommitMessage).toBe(true);
  });

  it("应广播发布的宿主请求给订阅者", () => {
    const received: number[] = [];
    const off = subscribeGitWorkbenchHostRequests((request) => {
      received.push(request.requestId);
    });
    const request = createGitWorkbenchHostRequest("show", {
      projectPath: "/tmp/repo-bridge-test",
    });

    publishGitWorkbenchHostRequest(request);
    off();

    expect(received).toEqual([request.requestId]);
    expect(normalizeGitWorkbenchProjectPathKey("C:\\Repo\\App")).toBe("c:/repo/app");
  });

  it("应把新增公共 action 归一化到稳定集合，并正确识别 commit-like 动作", () => {
    expect(GIT_WORKBENCH_PUBLIC_ACTION_IDS).toContain(GIT_WORKBENCH_FETCH_ACTION_ID);
    expect(normalizeGitWorkbenchActionId("Git.Fetch")).toBe(GIT_WORKBENCH_FETCH_ACTION_ID);
    expect(isGitWorkbenchCommitLikeActionId(GIT_WORKBENCH_COMMIT_AND_PUSH_ACTION_ID)).toBe(true);
    expect(isGitWorkbenchCommitLikeActionId(GIT_WORKBENCH_COMMIT_OPTIONS_ACTION_ID)).toBe(true);
    expect(isGitWorkbenchCommitLikeActionId("Git.Fetch")).toBe(false);
  });
});
