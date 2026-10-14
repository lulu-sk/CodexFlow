import { describe, expect, it } from "vitest";
import { parseTerminalProgramStatus } from "./terminal-program-status";

describe("终端程序状态协议", () => {
  it.each(["idle", "working", "done", "blocked", "error", "clear"])("解析 %s 和未知扩展字段", (state) => {
    expect(parseTerminalProgramStatus(`state=${state}:app=claude-code:extension=value`, 123)).toMatchObject({
      state, app: "claude-code", id: "", message: "", receivedAt: 123,
    });
  });

  it.each(["?", "state=unknown", "state=done:state=working", "state=done:msg=%%%", "state=done:msg=Gw==",
    "state=done:msg=/w=="])("拒绝无效记录 %s", (payload) => {
    expect(parseTerminalProgramStatus(payload)).toBeNull();
  });

  it("限制记录长度", () => {
    expect(parseTerminalProgramStatus("state=done:msg=" + "YQ==".repeat(3000))).toBeNull();
  });
});
