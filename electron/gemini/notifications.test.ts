import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agentSessions/gemini/discovery", () => ({
  getGeminiRootCandidatesFastAsync: vi.fn(),
}));

vi.mock("../wsl", () => ({
  uncToWsl: vi.fn(() => null),
}));

/**
 * 中文说明：创建临时目录，供 Gemini 通知脚本生成测试使用。
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 中文说明：加载 Gemini 通知模块，并预置本次测试需要的根目录列表。
 */
async function loadGeminiNotificationsModule(rootPath: string): Promise<typeof import("./notifications")> {
  vi.resetModules();
  const discovery = await import("../agentSessions/gemini/discovery");
  vi.mocked(discovery.getGeminiRootCandidatesFastAsync).mockResolvedValue([
    { path: path.join(rootPath, "tmp"), exists: true, source: "windows", kind: "local" },
  ]);
  return await import("./notifications");
}

describe("electron/gemini/notifications（多行预览保真）", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    try { vi.restoreAllMocks(); } catch {}
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("生成的 Gemini hook 脚本：保留 JSONL 预览中的真实换行，仅在 OSC 兜底时折叠为空单行", async () => {
    const root = createTempDir("gemini-notify-root-");
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(root, "settings.json"), "{}\n", "utf8");

    const mod = await loadGeminiNotificationsModule(root);
    await mod.ensureAllGeminiNotifications();

    const script = fs.readFileSync(path.join(root, "hooks", "codexflow_after_agent_notify.js"), "utf8");
    expect(script).toContain("function collapsePreviewForOsc(input)");
    expect(script).toContain('const payload = collapsePreviewForOsc(preview) || "agent-turn-complete";');
    expect(script).toContain('return s.replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]/g, " ");');
    expect(script).not.toContain("function collapseWs(input)");
    expect(script).not.toContain("const s = collapseWs(input);");
  });
});
