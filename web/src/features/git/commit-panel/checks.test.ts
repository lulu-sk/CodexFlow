import { describe, expect, it } from "vitest";
import {
  buildPostCommitChecks,
  findConfirmationCommitChecks,
  findBlockingCommitCheck,
  normalizeCommitMessageForPolicy,
  runBeforeCommitChecks,
} from "./checks";

describe("commit checks", () => {
  it("cleanup message 启用时应剔除注释行并按策略规整消息", () => {
    expect(normalizeCommitMessageForPolicy("  subject\n# comment\n\nbody\n", true)).toBe("subject\n\nbody");
    expect(normalizeCommitMessageForPolicy("  # only comment\n", true)).toBe("");
  });

  it("缺失消息或默认作者时应返回阻塞检查", () => {
    const checks = runBeforeCommitChecks({
      message: "   ",
      cleanupMessage: false,
      explicitAuthor: "",
      defaultAuthor: "",
      authorDate: "",
    });
    expect(findBlockingCommitCheck(checks)?.id).toBe("message-empty");
    expect(checks.some((item) => item.id === "author-missing")).toBe(true);
  });

  it("存在默认作者时应返回信息提示而非阻塞错误", () => {
    const checks = runBeforeCommitChecks({
      message: "feat: test",
      cleanupMessage: false,
      explicitAuthor: "",
      defaultAuthor: "Alice <alice@example.com>",
      authorDate: "",
    });
    expect(findBlockingCommitCheck(checks)).toBeNull();
    expect(checks).toEqual([
      expect.objectContaining({
        id: "author-default",
        level: "info",
        message: "默认作者：Alice <alice@example.com>",
      }),
    ]);
  });

  it("可按调用场景隐藏空提交信息错误，仅保留其余检查结果", () => {
    const checks = runBeforeCommitChecks({
      message: "   ",
      cleanupMessage: false,
      explicitAuthor: "",
      defaultAuthor: "Alice <alice@example.com>",
      authorDate: "",
      showEmptyMessageError: false,
    });
    expect(findBlockingCommitCheck(checks)).toBeNull();
    expect(checks).toEqual([
      expect.objectContaining({
        id: "author-default",
        level: "info",
        message: "默认作者：Alice <alice@example.com>",
      }),
    ]);
  });

  it("confirmationRequired 检查应能被单独提取，供统一提交流程复用", () => {
    expect(findConfirmationCommitChecks([
      { id: "info", level: "info", blocking: false, message: "info" },
      { id: "warning", level: "warning", blocking: false, confirmationRequired: true, message: "warning" },
    ])).toEqual([
      expect.objectContaining({ id: "warning", confirmationRequired: true }),
    ]);
  });

  it("提交后的后置检查应给出 commit / push-after 摘要", () => {
    expect(buildPostCommitChecks({
      amend: false,
      intent: "commitAndPush",
      commitHash: "1234567890abcdef",
    })).toEqual([
      expect.objectContaining({ id: "commit-created", message: "已创建提交：12345678。" }),
      expect.objectContaining({ id: "push-after", message: "接下来将打开推送对话框。" }),
    ]);
  });

  it("commit-and-push 已直接推送时，应返回直接推送摘要而不是继续打开预览", () => {
    expect(buildPostCommitChecks({
      amend: false,
      intent: "commitAndPush",
      commitHash: "1234567890abcdef",
      postCommitPush: {
        mode: "pushed",
        results: [{
          repoRoot: "/repo",
          commitHash: "1234567890abcdef",
        }],
      },
    })).toEqual([
      expect.objectContaining({ id: "commit-created", message: "已创建提交：12345678。" }),
      expect.objectContaining({ id: "push-after-pushed", message: "提交后已直接推送。" }),
    ]);
  });
});
