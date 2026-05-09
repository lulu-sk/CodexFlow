import { describe, expect, it } from "vitest";
import { sanitizeGitErrorText, toErrorText } from "./error-text";

describe("error-text", () => {
  it("应移除机器协议分隔符与控制字符", () => {
    const result = sanitizeGitErrorText("fatal:%x00bad\x1eoutput\u0007\nnext line");
    expect(result).toBe("fatal: bad\noutput\nnext line");
  });

  it("清洗后为空时应回退到兜底文案", () => {
    expect(toErrorText("%x00\x1e", "读取失败")).toBe("读取失败");
  });

  it("应把已知后端原始错误映射为本地化兜底文案", () => {
    expect(toErrorText("缺少仓库路径", "unused")).toBe("缺少仓库路径");
    expect(toErrorText("摘取提交失败", "unused")).toBe("优选提交失败");
  });

  it("应支持带参数的后端原始错误映射", () => {
    expect(toErrorText("文件移动已单独提交，但主提交失败：提交失败", "unused")).toBe("文件移动已单独提交，但主提交失败：提交失败");
  });
});
