import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("./agentSessions/claude/discovery", () => ({ getClaudeRootCandidatesFastAsync: vi.fn() }));
vi.mock("./agentSessions/gemini/discovery", () => ({ getGeminiRootCandidatesFastAsync: vi.fn() }));
vi.mock("./agentSessions/grok/discovery", () => ({ getGrokRootCandidatesFastAsync: vi.fn() }));
vi.mock("./agentSessions/antigravity/discovery", () => ({ getAntigravityRootCandidatesFastAsync: vi.fn() }));
vi.mock("./historyReconciler", () => ({ requestHistoryFastRefresh: vi.fn() }));
vi.mock("./log", () => ({ perfLogger: { log: vi.fn() } }));

describe("通知文件到界面的会话编号", () => {
  it.each(["claude", "gemini", "grok", "antigravity"] as const)("%s 完整转发会话编号供终端精确绑定", async (providerId) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-notification-"));
    const candidate = { exists: true, source: "windows" as const, kind: "local" as const };
    const send = vi.fn();
    const win = { webContents: { send }, isDestroyed: () => false } as unknown as BrowserWindow;
    let stop: (() => void) | undefined;
    try {
      let notifyPath = path.join(root, "hooks", "codexflow_after_agent_notify.jsonl");
      if (providerId === "claude") {
        const discovery = await import("./agentSessions/claude/discovery");
        vi.mocked(discovery.getClaudeRootCandidatesFastAsync).mockResolvedValue([{ ...candidate, path: root }]);
        const mod = await import("./claude/notifications");
        stop = mod.stopClaudeNotificationBridge;
        await mod.startClaudeNotificationBridge(() => win);
      } else if (providerId === "gemini") {
        const discovery = await import("./agentSessions/gemini/discovery");
        vi.mocked(discovery.getGeminiRootCandidatesFastAsync).mockResolvedValue([{ ...candidate, path: path.join(root, "tmp") }]);
        const mod = await import("./gemini/notifications");
        stop = mod.stopGeminiNotificationBridge;
        await mod.startGeminiNotificationBridge(() => win);
      } else if (providerId === "grok") {
        const discovery = await import("./agentSessions/grok/discovery");
        vi.mocked(discovery.getGrokRootCandidatesFastAsync).mockResolvedValue([{ ...candidate, path: path.join(root, "sessions") }]);
        const mod = await import("./grok/notifications");
        stop = mod.stopGrokNotificationBridge;
        await mod.startGrokNotificationBridge(() => win);
        notifyPath = path.join(root, "codexflow", "after-agent-notify.jsonl");
      } else {
        const discovery = await import("./agentSessions/antigravity/discovery");
        vi.mocked(discovery.getAntigravityRootCandidatesFastAsync).mockResolvedValue([{ ...candidate, path: path.join(root, "conversations") }]);
        const mod = await import("./antigravity/notifications");
        stop = mod.stopAntigravityNotificationBridge;
        await mod.startAntigravityNotificationBridge(() => win);
      }
      const event = { providerId, tabId: "tab-1", sessionId: "session-1", cwd: "/workspace/project", preview: "任务完成", hookEventName: "stop", reason: "end_turn", lastAssistantMessage: "任务完成" };
      const line = providerId === "grok"
        ? ["v1", ...[event.tabId, "PowerShell", providerId, JSON.stringify(event)].map((text) => Buffer.from(text, "utf8").toString("base64"))].join("\t")
        : JSON.stringify(event);
      fs.mkdirSync(path.dirname(notifyPath), { recursive: true });
      fs.appendFileSync(notifyPath, `${line}\n`, "utf8");

      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("notifications:externalAgentComplete", expect.objectContaining({
        providerId, tabId: "tab-1", threadId: "session-1",
      })), { timeout: 4_000, interval: 50 });
    } finally {
      stop?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);
});
