import { describe, expect, it } from "vitest";
import { buildGrokResumeStartupCmd, resolveGrokStartupCmd } from "./commands";

describe("Grok commands", () => {
  it("空命令回退为 grok", () => {
    expect(resolveGrokStartupCmd("")).toBe("grok");
    expect(resolveGrokStartupCmd("  grok --yolo  ")).toBe("grok --yolo");
  });

  it("按终端安全构造指定会话恢复命令", () => {
    expect(buildGrokResumeStartupCmd({ cmd: "grok", terminalMode: "wsl", sessionId: "session-1" })).toBe("grok --resume 'session-1'");
    expect(buildGrokResumeStartupCmd({ cmd: "grok --yolo", terminalMode: "pwsh", sessionId: "session-1" })).toBe("& 'grok' '--yolo' '--resume' 'session-1'");
    expect(buildGrokResumeStartupCmd({ cmd: "grok", terminalMode: "cmd", sessionId: "session-1" })).toBe("grok --resume session-1");
  });

  it("缺少会话 ID 时恢复当前目录最近会话", () => {
    expect(buildGrokResumeStartupCmd({ cmd: "grok", terminalMode: "wsl", sessionId: "" })).toBe("grok --continue");
    expect(buildGrokResumeStartupCmd({ cmd: "grok", terminalMode: "pwsh", sessionId: null })).toBe("& 'grok' '--continue'");
  });
});
