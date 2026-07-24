import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agentSessions/grok/discovery", () => ({
  getGrokRootCandidatesFastAsync: vi.fn(),
}));

vi.mock("../wsl", () => ({
  uncToWsl: vi.fn(() => null),
}));

const tempDirs: string[] = [];

/**
 * 构造 Hook 写入的通知行。
 */
function createNotifyLine(rawEvent: string): string {
  return [
    "v1",
    Buffer.from("tab-1", "utf8").toString("base64"),
    Buffer.from("PowerShell", "utf8").toString("base64"),
    Buffer.from("grok", "utf8").toString("base64"),
    Buffer.from(rawEvent, "utf8").toString("base64"),
  ].join("\t");
}

/**
 * 加载 Grok 通知模块，并把候选会话根指向临时目录。
 */
async function loadGrokNotificationsModule(grokHome: string): Promise<typeof import("./notifications")> {
  vi.resetModules();
  const discovery = await import("../agentSessions/grok/discovery");
  vi.mocked(discovery.getGrokRootCandidatesFastAsync).mockResolvedValue([
    { path: path.join(grokHome, "sessions"), exists: true, source: "windows", kind: "local" },
  ]);
  return await import("./notifications");
}

afterEach(() => {
  try { vi.restoreAllMocks(); } catch {}
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("electron/grok/notifications", () => {
  it("生成 Stop/SubagentStop Hook 配置与无 BOM PowerShell 通知脚本", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);

    await mod.ensureAllGrokNotifications();

    const config = JSON.parse(fs.readFileSync(path.join(grokHome, "hooks", "codexflow-notifications.json"), "utf8"));
    const stopHandler = config.hooks.Stop[0].hooks[0];
    const subagentHandler = config.hooks.SubagentStop[0].hooks[0];
    expect(stopHandler).toEqual(subagentHandler);
    expect(stopHandler).toMatchObject({ type: "command", timeout: 5 });
    expect(stopHandler.command).toContain("codexflow-notify.ps1");

    const scriptBuffer = fs.readFileSync(path.join(grokHome, "hooks", "codexflow-notify.ps1"));
    expect([...scriptBuffer.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    const script = scriptBuffer.toString("utf8");
    expect(script).toContain("GROK_CODEXFLOW_TAB_ID");
    expect(script).toContain("IsNullOrWhiteSpace($tabId)");
    expect(script).toContain("GROK_CODEXFLOW_ENV_LABEL");
    expect(script).toContain("GROK_CODEXFLOW_PROVIDER_ID");
    expect(script).toContain("[Console]::OpenStandardInput()");
    expect(script).toContain("$utf8.GetString($inputBuffer.ToArray())");
    expect(script).not.toContain("[Console]::In.ReadToEnd()");

    expect(mod.__testing.resolveGrokAgentType({ subagentType: "explore", agentType: "legacy" })).toBe("explore");
    expect(mod.__testing.resolveGrokAgentType({ agentType: "legacy" })).toBe("legacy");
    expect(mod.__testing.shouldUsePosixHook({ path: "/tmp/.grok/sessions", exists: true, source: "windows", kind: "local" }, "linux")).toBe(true);
    expect(mod.__testing.shouldUsePosixHook({ path: "C:\\fixture\\.grok\\sessions", exists: true, source: "windows", kind: "local" }, "win32")).toBe(false);
    expect(mod.__testing.shouldUsePosixHook({ path: "\\\\wsl.localhost\\TestDistro\\home\\user\\.grok\\sessions", exists: true, source: "wsl", kind: "unc" }, "win32")).toBe(true);
  });

  it("缺少 CodexFlow 标签页标记的 Grok 通知不会进入转发链路", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);
    const rawEvent = JSON.stringify({
      hookEventName: "stop",
      sessionId: "external-session",
      reason: "end_turn",
    });
    const line = [
      "v1",
      "",
      "",
      Buffer.from("grok", "utf8").toString("base64"),
      Buffer.from(rawEvent, "utf8").toString("base64"),
    ].join("\t");

    const record = mod.__testing.parseNotifyLine(line);

    expect(record?.tabId).toBe("");
    expect(mod.__testing.hasGrokCodexFlowTabId(record)).toBe(false);
  });

  it("可解析有效的 Base64 通知事件", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);

    const record = mod.__testing.parseNotifyLine(createNotifyLine(JSON.stringify({
      hookEventName: "stop",
      sessionId: "session-1",
      cwd: "/workspace/project",
      timestamp: "2026-07-24T11:40:38.000Z",
      reason: "end_turn",
      lastAssistantMessage: "Task completed",
    })));

    expect(record).toMatchObject({
      tabId: "tab-1",
      envLabel: "PowerShell",
      providerId: "grok",
      event: {
        hookEventName: "stop",
        reason: "end_turn",
        lastAssistantMessage: "Task completed",
      },
    });
  });

  it.skipIf(process.platform !== "win32")("PowerShell Hook 应保留 UTF-8 回复正文", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);
    await mod.ensureAllGrokNotifications();
    const scriptPath = path.join(grokHome, "hooks", "codexflow-notify.ps1");
    const payload = JSON.stringify({
      hookEventName: "stop",
      sessionId: "session-1",
      cwd: "/workspace/project",
      reason: "end_turn",
      lastAssistantMessage: "你好，Grok 已完成。",
    });

    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ], {
      cwd: grokHome,
      env: {
        ...process.env,
        GROK_CODEXFLOW_TAB_ID: "tab-1",
        GROK_CODEXFLOW_ENV_LABEL: "PowerShell",
        GROK_CODEXFLOW_PROVIDER_ID: "grok",
      },
      input: Buffer.from(payload, "utf8"),
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const notifyPath = path.join(grokHome, "codexflow", "after-agent-notify.jsonl");
    const parts = fs.readFileSync(notifyPath, "utf8").trim().split("\t");
    expect(parts[0]).toBe("v1");
    const event = JSON.parse(Buffer.from(parts.slice(4).join("\t"), "base64").toString("utf8"));
    expect(event.lastAssistantMessage).toBe("你好，Grok 已完成。");
  });

  it("回复正文损坏时仍恢复主代理完成元数据", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);
    const rawEvent = '{"hookEventName":"stop","sessionId":"session-1","cwd":"/workspace/project","timestamp":"2026-07-24T11:40:38.000Z","reason":"end_turn","lastAssistantMessage":"message with an unescaped " quote"}';

    const record = mod.__testing.parseNotifyLine(createNotifyLine(rawEvent));

    expect(record).toMatchObject({
      tabId: "tab-1",
      providerId: "grok",
      event: {
        hookEventName: "stop",
        sessionId: "session-1",
        reason: "end_turn",
      },
    });
    expect(record?.event.lastAssistantMessage).toBeUndefined();
    expect(mod.__testing.resolveGrokCompletionKind(record?.event || {})).toBe("agent");
  });

  it("正文损坏且并非完成事件时拒绝通知记录", async () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-grok-notify-"));
    tempDirs.push(grokHome);
    const mod = await loadGrokNotificationsModule(grokHome);
    const rawEvent = '{"hookEventName":"stop","sessionId":"session-1","reason":"tool_use","lastAssistantMessage":"message with an unescaped " quote"}';

    expect(mod.__testing.parseNotifyLine(createNotifyLine(rawEvent))).toBeNull();
  });
});
