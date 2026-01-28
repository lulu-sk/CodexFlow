import { describe, expect, it } from "vitest";
import { buildPowerShellCall } from "./shell";

describe("shell 工具：PowerShell 参数安全拼接", () => {
  it("包含换行的参数会被编码为单行表达式（避免 PTY 把多行拆坏）", () => {
    const cmd = buildPowerShellCall(["claude", "--dangerously-skip-permissions", "你\n好\n！"]);
    expect(cmd).not.toMatch(/[\r\n]/);
    expect(cmd).toContain("[System.Text.Encoding]::UTF8.GetString");
    expect(cmd).toContain("5L2gCuWlvQrvvIE=");
  });

  it("普通参数保持单引号字面量（含空格/单引号）", () => {
    const cmd = buildPowerShellCall(["tool", "a b", "x'y"]);
    expect(cmd).toBe("& 'tool' 'a b' 'x''y'");
  });

  it("包含非 ASCII 字符的参数会被编码为 Base64 表达式（提升 Windows PTY 兼容性）", () => {
    const prompt = "请重新设计历史面板的‘显示/隐藏’机制。我希望移除原本独立的‘隐藏历史’按钮。";
    const cmd = buildPowerShellCall(["claude", "--dangerously-skip-permissions", prompt]);
    expect(cmd).toContain("[System.Text.Encoding]::UTF8.GetString");
    expect(cmd).toContain("[System.Convert]::FromBase64String");
    expect(cmd).not.toContain(prompt);
    expect(cmd).not.toMatch(/[^\x20-\x7E]/);

    const m = cmd.match(/FromBase64String\('([^']*)'\)/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m?.[1] || "", "base64").toString("utf8");
    expect(decoded).toBe(prompt);
  });
});

