import { describe, expect, it, vi } from "vitest";
import { finalizeGitCommitWorkflowSuccess, prepareGitCommitWorkflowAsync } from "./workflow-handler";

describe("commit workflow handler", () => {
  it("应在 blocking check 命中时直接返回错误", async () => {
    const resolvePayloadAsync = vi.fn();

    const result = await prepareGitCommitWorkflowAsync({
      message: "",
      intent: "commit",
      cleanupMessage: false,
      explicitAuthor: "",
      defaultAuthor: "CodexFlow <codexflow@example.com>",
      authorDate: "",
      resolvePayloadAsync,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockingCheck?.id).toBe("message-empty");
    expect(resolvePayloadAsync).not.toHaveBeenCalled();
  });

  it("应在 checks 通过后解析 payload 并返回统一 workflow", async () => {
    const result = await prepareGitCommitWorkflowAsync({
      message: "feat: bridge",
      intent: "commitAndPush",
      cleanupMessage: false,
      explicitAuthor: "",
      defaultAuthor: "CodexFlow <codexflow@example.com>",
      authorDate: "",
      resolvePayloadAsync: async ({ message, intent }) => ({
        ok: true,
        payload: {
          message,
          intent,
          pushAfter: intent === "commitAndPush",
          selections: [],
          includedItems: [{ path: "a.ts", kind: "change" }],
          files: ["a.ts"],
        },
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.payload.message).toBe("feat: bridge");
    expect(result.workflow.payload.intent).toBe("commitAndPush");
    expect(result.workflow.payload.pushAfter).toBe(true);
  });

  it("提交成功收口应返回 post checks 与最近消息持久化决策", () => {
    const result = finalizeGitCommitWorkflowSuccess({
      message: "feat: bridge",
      cleanupMessage: false,
      amend: false,
      intent: "commitAndPush",
      commitHash: "1234567890",
      postCommitPush: {
        mode: "pushed",
        results: [{
          repoRoot: "/repo",
          commitHash: "1234567890",
        }],
      },
    });

    expect(result.shouldPersistMessage).toBe(true);
    expect(result.postChecks.map((item) => item.id)).toEqual(["commit-created", "push-after-pushed"]);
  });
});
