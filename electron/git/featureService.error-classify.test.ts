import { describe, expect, it } from "vitest";
import { toGitErrorMessage } from "./featureService";

describe("featureService error classify", () => {
  it("maxBuffer 等基础设施错误应优先返回真实错误，而不是误判为冲突", () => {
    const message = toGitErrorMessage({
      ok: false,
      stdout: "ignored/conflict-cache.txt\0ignored/fix conflicts and then run.log",
      stderr: "warning: in the working copy of 'ProjectSettings.asset', LF will be replaced by CRLF the next time Git touches it",
      exitCode: -1,
      error: "stdout maxBuffer length exceeded",
    }, "读取已忽略文件失败");
    expect(message).toBe("stdout maxBuffer length exceeded");
    expect(message).not.toContain("检测到冲突");
  });

  it("仅文件路径里包含 conflict 文样时，不应误判为 Git 冲突", () => {
    const message = toGitErrorMessage({
      ok: false,
      stdout: "ignored/conflict-preview.txt",
      stderr: "",
      exitCode: 1,
      error: "",
    }, "读取已忽略文件失败");
    expect(message).toBe("ignored/conflict-preview.txt");
  });

  it("机器协议 stdout 不应把 %x1e/%x00 直接泄露到 UI", () => {
    const message = toGitErrorMessage({
      ok: false,
      stdout: "hash%x1epath%x00subject",
      stderr: "",
      exitCode: 1,
      error: "",
    }, "拉取失败");
    expect(message).toBe("拉取失败");
  });
});
