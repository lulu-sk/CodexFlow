import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agentSessions/claude/discovery", () => ({
  getClaudeRootCandidatesFastAsync: vi.fn(),
}));

vi.mock("../wsl", () => ({
  uncToWsl: vi.fn(() => null),
}));

/**
 * 中文说明：创建临时目录，供 Claude 通知脚本生成测试使用。
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 中文说明：加载 Claude 通知模块，并预置本次测试需要的根目录列表。
 */
async function loadClaudeNotificationsModule(rootPath: string): Promise<typeof import("./notifications")> {
  vi.resetModules();
  const discovery = await import("../agentSessions/claude/discovery");
  vi.mocked(discovery.getClaudeRootCandidatesFastAsync).mockResolvedValue([
    { path: rootPath, exists: true, source: "windows", kind: "local" },
  ]);
  return await import("./notifications");
}

describe("electron/claude/notifications（多行预览保真）", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    try { vi.restoreAllMocks(); } catch {}
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("生成的 Claude hook 脚本：保留 JSONL 预览中的真实换行，仅在 OSC 兜底时折叠为空单行", async () => {
    const root = createTempDir("claude-notify-root-");
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "settings.json"), "{}\n", "utf8");

    const mod = await loadClaudeNotificationsModule(root);
    await mod.ensureAllClaudeNotifications();

    const script = fs.readFileSync(path.join(root, "hooks", "codexflow_stop_notify.js"), "utf8");
    expect(script).toContain("function collapsePreviewForOsc(input)");
    expect(script).toContain("function extractPreviewFromTranscriptWithRetry(transcriptPath)");
    expect(script).toContain("const deadline = Date.now() + 1600;");
    expect(script).toContain("sleepSync(160);");
    expect(script).toContain('const payload = collapsePreviewForOsc(preview) || "agent-turn-complete";');
    expect(script).toContain('return s.replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]/g, " ");');
    expect(script).not.toContain("function collapseWs(input)");
    expect(script).not.toContain("const s = collapseWs(input);");
    expect(script).not.toContain('"CONOUT$"');
  });

  it("读取 settings.json 失败时不应覆盖现有配置", async () => {
    const root = createTempDir("claude-notify-read-error-");
    tempDirs.push(root);
    const settingsPath = path.join(root, "settings.json");
    const original = "{\n  \"model\": \"test-model\"\n}\n";
    fs.writeFileSync(settingsPath, original, "utf8");

    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(settingsPath))
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return await (readFile as any)(...args);
    });

    const mod = await loadClaudeNotificationsModule(root);
    await mod.ensureAllClaudeNotifications();

    expect(fs.readFileSync(settingsPath, "utf8")).toBe(original);
  });

  it("读取已有 hook 脚本失败时不应改写 settings.json", async () => {
    const root = createTempDir("claude-notify-script-read-error-");
    tempDirs.push(root);
    const settingsPath = path.join(root, "settings.json");
    const scriptPath = path.join(root, "hooks", "codexflow_stop_notify.js");
    const originalSettings = "{\n  \"model\": \"test-model\"\n}\n";
    fs.writeFileSync(settingsPath, originalSettings, "utf8");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "user-owned-hook\n", "utf8");

    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(scriptPath))
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return await (readFile as any)(...args);
    });

    const mod = await loadClaudeNotificationsModule(root);
    await mod.ensureAllClaudeNotifications();

    expect(fs.readFileSync(settingsPath, "utf8")).toBe(originalSettings);
    expect(fs.readFileSync(scriptPath, "utf8")).toBe("user-owned-hook\n");
  });
});
