import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const getPathMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getPath: getPathMock,
  },
}));

import {
  GEMINI_WINDOWS_EDITOR_ENV_KEYS,
  prepareGeminiWindowsEditorEnv,
  readGeminiWindowsEditorStatus,
  writeGeminiWindowsEditorSource,
} from "./windowsEditor";

/**
 * 中文说明：创建临时测试目录，并确保用例结束后清理。
 * @param prefix 目录前缀
 * @returns 临时目录
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Gemini Windows 外部编辑器桥接", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    try { vi.restoreAllMocks(); } catch {}
    getPathMock.mockReset();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("会为指定 tab 生成专用 env 与会话文件", async () => {
    const userDataDir = createTempDir("gemini-win-editor-");
    tempDirs.push(userDataDir);
    getPathMock.mockReturnValue(userDataDir);

    const res = await prepareGeminiWindowsEditorEnv({ tabId: "tab:gemini/win" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.EDITOR).toBe(`%${GEMINI_WINDOWS_EDITOR_ENV_KEYS.wrapperScript}%`);
    expect(res.env.VISUAL).toBe(res.env.EDITOR);
    expect(String(res.env.EDITOR || "").toLowerCase().includes("code")).toBe(false);
    expect(fs.existsSync(res.sourcePath)).toBe(true);
    expect(fs.existsSync(res.statusPath)).toBe(true);
    const helperPath = path.join(userDataDir, "gemini-windows-editor", "gemini-editor-helper.ps1");
    const wrapperPath = path.join(userDataDir, "gemini-windows-editor", "gemini-editor-wrapper.cmd");
    expect(fs.existsSync(helperPath)).toBe(true);
    expect(fs.existsSync(wrapperPath)).toBe(true);
    const helperContent = await fsp.readFile(helperPath, "utf8");
    const wrapperContent = await fsp.readFile(wrapperPath, "utf8");
    expect(helperContent.startsWith("param([Parameter(ValueFromRemainingArguments = $true)][string[]]$EditorArgs)\n")).toBe(true);
    expect(helperContent).toContain("function Resolve-CodexFlowBufferPath {");
    expect(helperContent).not.toContain("Select-Object -Reverse");
    expect(wrapperContent).toContain("powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File");
    expect(wrapperContent).toContain("%*");
  });

  it("写入 source/status 后，可读取到当前 requestId 的 pending 状态", async () => {
    const userDataDir = createTempDir("gemini-win-editor-");
    tempDirs.push(userDataDir);
    getPathMock.mockReturnValue(userDataDir);

    const writeRes = await writeGeminiWindowsEditorSource({
      tabId: "tab-gemini-win",
      content: "第一行\n第二行",
    });

    expect(writeRes.ok).toBe(true);
    if (!writeRes.ok) return;

    const sourceContent = await fsp.readFile(writeRes.sourcePath, "utf8");
    expect(sourceContent).toBe("第一行\n第二行");

    const statusRes = await readGeminiWindowsEditorStatus({ tabId: "tab-gemini-win" });
    expect(statusRes.ok).toBe(true);
    if (!statusRes.ok) return;
    expect(statusRes.status?.state).toBe("pending");
    expect(statusRes.status?.requestId).toBe(writeRes.requestId);
  });
});
