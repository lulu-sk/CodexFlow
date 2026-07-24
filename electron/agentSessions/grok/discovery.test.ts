import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wslMocks = vi.hoisted(() => ({
  execInWslAsync: vi.fn(),
  getDistroHomeSubPathUNCAsync: vi.fn(),
  listDistrosAsync: vi.fn(),
  wslToUNC: vi.fn(),
}));

vi.mock("../../wsl", () => wslMocks);

import { discoverGrokSessionFiles, getGrokRootCandidatesFastAsync } from "./discovery";

const originalGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  delete process.env.GROK_HOME;
  wslMocks.execInWslAsync.mockReset();
  wslMocks.getDistroHomeSubPathUNCAsync.mockReset();
  wslMocks.listDistrosAsync.mockReset();
  wslMocks.wslToUNC.mockReset();
  wslMocks.getDistroHomeSubPathUNCAsync.mockResolvedValue("\\\\wsl.localhost\\TestDistro\\home\\tester\\.grok\\sessions");
  wslMocks.wslToUNC.mockImplementation((posixPath: string, distro: string) => {
    const relativePath = posixPath.replace(/^\/+/, "").replace(/\//g, "\\");
    return `\\\\wsl.localhost\\${distro}\\${relativePath}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
});

describe("discoverGrokSessionFiles", () => {
  it("只发现目录结构正确且按官方规则可见的 summary.json", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-grok-discovery-"));
    const first = path.join(root, "encoded-a", "session-a");
    const second = path.join(root, "encoded-b", "session-b");
    const hidden = path.join(root, "encoded-c", "session-c");
    const subagent = path.join(root, "encoded-d", "session-d");
    const visibleSubagent = path.join(root, "encoded-e", "session-e");
    const invalid = path.join(root, "encoded-f", "session-f");
    await fs.promises.mkdir(first, { recursive: true });
    await fs.promises.mkdir(second, { recursive: true });
    await fs.promises.mkdir(hidden, { recursive: true });
    await fs.promises.mkdir(subagent, { recursive: true });
    await fs.promises.mkdir(visibleSubagent, { recursive: true });
    await fs.promises.mkdir(invalid, { recursive: true });
    await fs.promises.writeFile(path.join(first, "summary.json"), "{}", "utf8");
    await fs.promises.writeFile(path.join(first, "updates.jsonl"), "", "utf8");
    await fs.promises.writeFile(path.join(second, "notes.json"), "{}", "utf8");
    await fs.promises.writeFile(path.join(hidden, "summary.json"), JSON.stringify({ hidden: true }), "utf8");
    await fs.promises.writeFile(path.join(subagent, "summary.json"), JSON.stringify({ session_kind: "subagent_fork" }), "utf8");
    await fs.promises.writeFile(
      path.join(visibleSubagent, "summary.json"),
      JSON.stringify({ hidden: false, session_kind: "subagent_resume" }),
      "utf8",
    );
    await fs.promises.writeFile(path.join(invalid, "summary.json"), "{", "utf8");
    await fs.promises.writeFile(path.join(root, "summary.json"), "{}", "utf8");

    const files = await discoverGrokSessionFiles(root);

    expect(files.map((filePath) => path.relative(root, filePath).replace(/\\/g, "/")).sort()).toEqual([
      "encoded-a/session-a/summary.json",
      "encoded-e/session-e/summary.json",
    ]);
    await fs.promises.rm(root, { recursive: true, force: true });
  });
});

describe("getGrokRootCandidatesFastAsync", () => {
  it("发现每个 WSL 发行版自身配置的 GROK_HOME 会话目录", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    wslMocks.listDistrosAsync.mockResolvedValue([
      { name: "TestDistro", state: "Running", version: 2, isDefault: true },
    ]);
    wslMocks.execInWslAsync.mockResolvedValue("/opt/grok-home");

    const candidates = await getGrokRootCandidatesFastAsync();

    expect(wslMocks.execInWslAsync).toHaveBeenCalledWith(
      "TestDistro",
      "printf '%s' \"${GROK_HOME:-}\"",
      { timeoutMs: 3_000 },
    );
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "\\\\wsl.localhost\\TestDistro\\opt\\grok-home\\sessions",
        source: "wsl",
        kind: "unc",
        distro: "TestDistro",
      }),
    ]));
  });

  it.each([
    ["空值", ""],
    ["相对路径", "relative/grok-home"],
    ["含换行的路径", "/opt/grok-home\n/other"],
    ["含反斜杠的路径", "/opt/grok\\home"],
  ])("忽略%s形式的 WSL GROK_HOME", async (_label, configuredHome) => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    wslMocks.listDistrosAsync.mockResolvedValue([
      { name: "TestDistro", state: "Running", version: 2, isDefault: true },
    ]);
    wslMocks.execInWslAsync.mockResolvedValue(configuredHome);

    await getGrokRootCandidatesFastAsync();

    expect(wslMocks.wslToUNC).not.toHaveBeenCalled();
  });
});
