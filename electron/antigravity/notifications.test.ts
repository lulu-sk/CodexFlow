import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agentSessions/antigravity/discovery", () => ({
  getAntigravityRootCandidatesFastAsync: vi.fn(),
}));

vi.mock("../agentSessions/antigravity/parser", () => ({
  parseAntigravitySessionFile: vi.fn(),
}));

/**
 * 创建临时目录，供 Antigravity 通知 hook 配置测试使用。
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 加载 Antigravity 通知模块，并注入测试根目录。
 */
async function loadAntigravityNotificationsModule(rootPath: string): Promise<typeof import("./notifications")> {
  vi.resetModules();
  const discovery = await import("../agentSessions/antigravity/discovery");
  vi.mocked(discovery.getAntigravityRootCandidatesFastAsync).mockResolvedValue([
    { path: path.join(rootPath, "conversations"), exists: true, source: "windows", kind: "local" },
  ]);
  return await import("./notifications");
}

describe("electron/antigravity/notifications", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    try { vi.restoreAllMocks(); } catch {}
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("ensureAllAntigravityNotifications：写入 Antigravity Stop hook 和通知脚本", async () => {
    const geminiRoot = createTempDir("antigravity-notify-root-");
    tempDirs.push(geminiRoot);
    const root = path.join(geminiRoot, "antigravity-cli");
    fs.mkdirSync(path.join(root, "conversations"), { recursive: true });

    const mod = await loadAntigravityNotificationsModule(root);
    await mod.ensureAllAntigravityNotifications();

    const scriptPath = path.join(root, "hooks", "codexflow_stop_notify.js");
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain("ANTIGRAVITY_CODEXFLOW_TAB_ID");
    expect(script).toContain("codexflow_after_agent_notify.jsonl");
    expect(script).toContain("JSON.stringify({ decision: \"\" })");
    expect(script).not.toContain("suppressOutput");

    const hooksJsonPath = path.join(geminiRoot, "config", "hooks.json");
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
    const stopHook = hooksJson["codexflow-notify"]?.Stop?.[0];
    expect(hooksJson["codexflow-notify"]?.enabled).toBe(true);
    expect(stopHook?.type).toBe("command");
    expect(stopHook?.command).toBe("node ../antigravity-cli/hooks/codexflow_stop_notify.js");
    expect(stopHook?.command).not.toContain("\"");
    expect(stopHook?.timeout).toBe(8);
  });

  it("ensureAllAntigravityNotifications：清理旧 AfterAgent/重复 Stop hook", async () => {
    const geminiRoot = createTempDir("antigravity-notify-root-");
    tempDirs.push(geminiRoot);
    const root = path.join(geminiRoot, "antigravity-cli");
    fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
    const hooksJsonPath = path.join(geminiRoot, "config", "hooks.json");
    fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      "codexflow-notify": {
        enabled: true,
        Stop: [
          { type: "command", command: `node \"${path.join(root, "hooks", "codexflow_stop_notify.js")}\"`, timeout: 8 },
          { type: "command", command: "node ../old/hooks/codexflow_after_agent_notify.js", timeout: 8 },
        ],
        AfterAgent: [
          { type: "command", command: "node ../old/hooks/codexflow_after_agent_notify.js", timeout: 8 },
        ],
      },
    }, null, 2), "utf8");

    const mod = await loadAntigravityNotificationsModule(root);
    await mod.ensureAllAntigravityNotifications();

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
    const entry = hooksJson["codexflow-notify"];
    expect(entry.AfterAgent).toBeUndefined();
    expect(entry.Stop).toHaveLength(1);
    expect(entry.Stop[0].command).toBe("node ../antigravity-cli/hooks/codexflow_stop_notify.js");
    expect(entry.Stop[0].command).not.toContain("\"");
  });

  it("读取已有 hook 脚本失败时不应改写 hooks.json", async () => {
    const geminiRoot = createTempDir("antigravity-notify-script-read-error-");
    tempDirs.push(geminiRoot);
    const root = path.join(geminiRoot, "antigravity-cli");
    const scriptPath = path.join(root, "hooks", "codexflow_stop_notify.js");
    const hooksJsonPath = path.join(geminiRoot, "config", "hooks.json");
    const originalHooks = JSON.stringify({ "user-hook": { enabled: true } }, null, 2) + "\n";
    fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    fs.writeFileSync(scriptPath, "user-owned-hook\n", "utf8");
    fs.writeFileSync(hooksJsonPath, originalHooks, "utf8");

    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(scriptPath))
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return await (readFile as any)(...args);
    });

    const mod = await loadAntigravityNotificationsModule(root);
    await mod.ensureAllAntigravityNotifications();

    expect(fs.readFileSync(hooksJsonPath, "utf8")).toBe(originalHooks);
    expect(fs.readFileSync(scriptPath, "utf8")).toBe("user-owned-hook\n");
  });

  it("hydrateAntigravityNotifyPreview：hook 正文为空时从会话 DB 补最后一条助手回复", async () => {
    const geminiRoot = createTempDir("antigravity-notify-root-");
    tempDirs.push(geminiRoot);
    const root = path.join(geminiRoot, "antigravity-cli");
    const sessionId = "session-123";
    const dbPath = path.join(root, "conversations", `${sessionId}.db`);
    const notifyPath = path.join(root, "hooks", "codexflow_after_agent_notify.jsonl");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(notifyPath), { recursive: true });
    fs.writeFileSync(dbPath, "", "utf8");

    const mod = await loadAntigravityNotificationsModule(root);
    const parser = await import("../agentSessions/antigravity/parser");
    vi.mocked(parser.parseAntigravitySessionFile).mockResolvedValue({
      providerId: "antigravity",
      id: `antigravity:${sessionId}`,
      title: sessionId,
      date: 1,
      filePath: dbPath,
      messages: [
        { role: "assistant", content: [{ type: "tool_call", text: "GREP_SEARCH", tags: ["antigravity.grep_search"] }] },
        { role: "assistant", content: [{ type: "output_text", text: "这是最后一条助手回复正文。" }] },
      ],
      skippedLines: 0,
      dirKey: "",
    });

    const result = await mod.__testing.hydrateAntigravityNotifyPreview({
      providerId: "antigravity",
      preview: "",
      sessionId,
      transcriptPath: path.join(root, "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl"),
    }, notifyPath);

    expect(result.preview).toBe("这是最后一条助手回复正文。");
    expect(result.previewEscapedWhitespace).toBe(false);
    expect(parser.parseAntigravitySessionFile).toHaveBeenCalledWith(dbPath, expect.any(Object), { summaryOnly: false });
  });

  it("hydrateAntigravityNotifyPreview：NO_TOOL_CALL 结束状态不作为通知正文", async () => {
    const geminiRoot = createTempDir("antigravity-notify-root-");
    tempDirs.push(geminiRoot);
    const root = path.join(geminiRoot, "antigravity-cli");
    const sessionId = "session-456";
    const dbPath = path.join(root, "conversations", `${sessionId}.db`);
    const notifyPath = path.join(root, "hooks", "codexflow_after_agent_notify.jsonl");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(notifyPath), { recursive: true });
    fs.writeFileSync(dbPath, "", "utf8");

    const mod = await loadAntigravityNotificationsModule(root);
    const parser = await import("../agentSessions/antigravity/parser");
    vi.mocked(parser.parseAntigravitySessionFile).mockResolvedValue({
      providerId: "antigravity",
      id: `antigravity:${sessionId}`,
      title: sessionId,
      date: 1,
      filePath: dbPath,
      messages: [
        { role: "assistant", content: [{ type: "output_text", text: "这是从会话库补出的正文。" }] },
      ],
      skippedLines: 0,
      dirKey: "",
    });

    const result = await mod.__testing.hydrateAntigravityNotifyPreview({
      providerId: "antigravity",
      preview: "NO_TOOL_CALL",
      sessionId,
    }, notifyPath);

    expect(result.preview).toBe("这是从会话库补出的正文。");
  });
});
