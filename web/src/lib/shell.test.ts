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
});

