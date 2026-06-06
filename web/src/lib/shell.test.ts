import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCmdCall, buildPowerShellCall } from "./shell";

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

  it("CMD 参数会按 cmd.exe 规则转义", () => {
    const cmd = buildCmdCall(["tool", "a b", "x\"y", "100%", "a&b"]);
    expect(cmd).toBe("tool \"a b\" \"x\"\"y\" \"100\"^% \"a&b\"");
  });

  it("CMD 引号参数不会污染普通元字符", () => {
    const cmd = buildCmdCall(["tool", "a<b", "a|b", "caret^", "bang!"]);
    expect(cmd).toBe("tool \"a<b\" \"a|b\" \"caret^\" \"bang!\"");
  });

  it("CMD 不应保留换行参数", () => {
    const cmd = buildCmdCall(["tool", "a\nb"]);
    expect(cmd).toBe("tool \"a b\"");
  });

  it.runIf(process.platform === "win32")("CMD 参数会按真实 cmd.exe 语义传给子进程", () => {
    const args = ["a b", "x\"y", "%PATH%", "100%", "a&b", "a|b", "caret^", "bang!"];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-cmd-argv-"));
    const scriptPath = path.join(tempDir, "argv.js");
    try {
      fs.writeFileSync(scriptPath, "console.log('ARGV_JSON:' + JSON.stringify(process.argv.slice(2)));\n", "utf8");
      const command = buildCmdCall([process.execPath, scriptPath, ...args]);
      const result = spawnSync("cmd.exe", ["/q", "/d", "/v:off"], {
        input: `${command}\r\nexit\r\n`,
        encoding: "utf8",
        timeout: 2_000,
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(0);
      const stdout = String(result.stdout || "").trim();
      const marker = "ARGV_JSON:";
      const markerIndex = stdout.indexOf(marker);
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      const payload = stdout.slice(markerIndex + marker.length).split(/\r?\n/)[0] || "";
      expect(JSON.parse(payload)).toEqual(args);
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });
});

