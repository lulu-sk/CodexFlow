import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const getDistroHomeSubPathUNCAsyncMock = vi.hoisted(() => vi.fn());
const uncToWslMock = vi.hoisted(() => vi.fn());

vi.mock("../wsl", () => ({
  getDistroHomeSubPathUNCAsync: getDistroHomeSubPathUNCAsyncMock,
  uncToWsl: uncToWslMock,
}));

import {
  GEMINI_WSL_EDITOR_ENV_KEYS,
  prepareGeminiWslEditorEnv,
  readGeminiWslEditorStatus,
  writeGeminiWslEditorSource,
} from "./wslEditor";

/**
 * 中文说明：创建临时测试目录，并确保用例结束后清理。
 * @param prefix 目录前缀
 * @returns 临时目录
 */
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Gemini WSL 外部编辑器桥接", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    try { vi.restoreAllMocks(); } catch {}
    getDistroHomeSubPathUNCAsyncMock.mockReset();
    uncToWslMock.mockReset();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("会为指定 distro 生成专用 env 与会话文件", async () => {
    const rootDir = createTempDir("gemini-wsl-editor-");
    const winRoot = path.join(rootDir, "gemini-wsl-editor");
    tempDirs.push(rootDir);
    getDistroHomeSubPathUNCAsyncMock.mockResolvedValue(winRoot);
    uncToWslMock.mockReturnValue({
      distro: "Ubuntu-24.04-test-a",
      wslPath: "/home/example-user/.codexflow/gemini-wsl-editor",
    });

    const res = await prepareGeminiWslEditorEnv({
      tabId: "tab:gemini/wsl",
      distro: "Ubuntu-24.04-test-a",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.env.EDITOR).toBe("sh /home/example-user/.codexflow/gemini-wsl-editor/gemini-editor-wrapper.sh");
    expect(res.env.VISUAL).toBe(res.env.EDITOR);
    expect(res.env[GEMINI_WSL_EDITOR_ENV_KEYS.helperScript]).toBe("/home/example-user/.codexflow/gemini-wsl-editor/gemini-editor-helper.sh");
    expect(res.env[GEMINI_WSL_EDITOR_ENV_KEYS.source]).toContain("/home/example-user/.codexflow/gemini-wsl-editor/tab_gemini_wsl/source.txt");
    expect(fs.existsSync(res.sourcePath)).toBe(true);
    expect(fs.existsSync(res.statusPath)).toBe(true);

    const helperPath = path.join(winRoot, "gemini-editor-helper.sh");
    const wrapperPath = path.join(winRoot, "gemini-editor-wrapper.sh");
    expect(fs.existsSync(helperPath)).toBe(true);
    expect(fs.existsSync(wrapperPath)).toBe(true);

    const helperContent = await fsp.readFile(helperPath, "utf8");
    const wrapperContent = await fsp.readFile(wrapperPath, "utf8");
    expect(helperContent.startsWith("#!/bin/sh\n")).toBe(true);
    expect(helperContent).toContain("resolve_buffer_path()");
    expect(wrapperContent).toContain('exec sh "${CF_GEMINI_WSL_EDITOR_HELPER}" "$@"');
  });

  it("写入 source/status 后，可读取到当前 requestId 的 pending 状态", async () => {
    const rootDir = createTempDir("gemini-wsl-editor-");
    const winRoot = path.join(rootDir, "gemini-wsl-editor");
    tempDirs.push(rootDir);
    getDistroHomeSubPathUNCAsyncMock.mockResolvedValue(winRoot);
    uncToWslMock.mockReturnValue({
      distro: "Ubuntu-24.04-test-b",
      wslPath: "/home/example-user/.codexflow/gemini-wsl-editor",
    });

    const writeRes = await writeGeminiWslEditorSource({
      tabId: "tab-gemini-wsl",
      distro: "Ubuntu-24.04-test-b",
      content: "第一行\n第二行",
    });

    expect(writeRes.ok).toBe(true);
    if (!writeRes.ok) return;

    const sourceContent = await fsp.readFile(writeRes.sourcePath, "utf8");
    expect(sourceContent).toBe("第一行\n第二行");

    const statusRes = await readGeminiWslEditorStatus({
      tabId: "tab-gemini-wsl",
      distro: "Ubuntu-24.04-test-b",
    });
    expect(statusRes.ok).toBe(true);
    if (!statusRes.ok) return;
    expect(statusRes.status?.state).toBe("pending");
    expect(statusRes.status?.requestId).toBe(writeRes.requestId);
  });
});
