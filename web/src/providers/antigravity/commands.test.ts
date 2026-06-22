import { describe, expect, it } from "vitest";
import { buildAntigravityResumeStartupCmd, resolveAntigravityStartupCmd } from "./commands";

describe("Antigravity commands", () => {
  it("空命令回退为 agy", () => {
    expect(resolveAntigravityStartupCmd("")).toBe("agy");
    expect(resolveAntigravityStartupCmd("  agy --flag  ")).toBe("agy --flag");
  });

  it("按终端构造 --conversation 启动命令", () => {
    expect(buildAntigravityResumeStartupCmd({ cmd: "agy", terminalMode: "wsl", conversationId: "conv-1" })).toBe("agy --conversation 'conv-1'");
    expect(buildAntigravityResumeStartupCmd({ cmd: "agy", terminalMode: "pwsh", conversationId: "conv-1" })).toBe("& 'agy' '--conversation' 'conv-1'");
    expect(buildAntigravityResumeStartupCmd({ cmd: "agy", terminalMode: "cmd", conversationId: "conv-1" })).toBe("agy --conversation conv-1");
  });
});
