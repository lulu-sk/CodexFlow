import { describe, expect, it } from "vitest";
import { createUpdateExecutionSession, markUpdateSessionCancelled, recordUpdateSessionPhase } from "./session";

describe("update session cancel phase", () => {
  it("取消会话时应保留调用侧传入的真实阶段，而不是统一改写为 root-update", () => {
    const session = createUpdateExecutionSession("/repo", [
      {
        repoRoot: "/repo",
        rootName: "repo",
        kind: "repository",
      },
    ]);

    recordUpdateSessionPhase(session, "fetch", "running", "正在获取远端", "/repo");
    markUpdateSessionCancelled(session, "fetch", "用户取消", "/repo");

    expect(session.cancelled).toBe(true);
    expect(session.currentPhase).toBe("fetch");
    expect(session.phaseHistory.at(-1)?.phase).toBe("fetch");
    expect(session.phaseHistory.at(-1)?.status).toBe("cancelled");
  });
});
