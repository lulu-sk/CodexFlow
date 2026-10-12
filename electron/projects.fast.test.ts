// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

let userDataDir = "";
let sessionRoot = "";

vi.mock("electron", () => ({ app: { getPath: () => userDataDir } }));
vi.mock("./wsl", async (importOriginal) => ({
  ...await importOriginal<typeof import("./wsl")>(),
  getCodexRootsFastAsync: vi.fn(async () => ({ windowsSessions: sessionRoot, wsl: [] })),
}));
vi.mock("./agentSessions/claude/discovery", () => ({
  getClaudeRootCandidatesFastAsync: vi.fn(async () => []), discoverClaudeSessionFiles: vi.fn(),
}));
vi.mock("./agentSessions/gemini/discovery", () => ({
  getGeminiRootCandidatesFastAsync: vi.fn(async () => []), discoverGeminiSessionFiles: vi.fn(),
}));
vi.mock("./agentSessions/grok/discovery", () => ({
  getGrokRootCandidatesFastAsync: vi.fn(async () => []), discoverGrokSessionFiles: vi.fn(),
}));
vi.mock("./log", () => ({ perfLogger: {
  /** 直接执行被测扫描步骤，避免写入性能日志。 */
  time: async (_label: string, task: () => Promise<unknown>) => await task(),
} }));
vi.mock("./debugConfig", () => ({ getDebugConfig: () => ({ projects: { debug: false } }) }));
vi.mock("./settings", () => ({ default: { getSettings: () => ({}) } }));

import { addProjectByWinPath, listProjectsFromStore, scanProjectsAsync, type Project } from "./projects.fast";
import { getCodexRootsFastAsync } from "./wsl";

beforeEach(async () => {
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-projects-test-"));
  sessionRoot = path.join(userDataDir, "sessions");
  await fsp.mkdir(sessionRoot);
});

afterEach(async () => {
  await fsp.rm(userDataDir, { recursive: true, force: true });
});

/** 在临时会话目录中写入真实 JSONL 文件，供项目扫描使用。 */
async function createSession(records: unknown[]): Promise<void> {
  const dir = path.join(sessionRoot, "2026", "04", "29");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "rollout-test.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

/** 创建实际存在的目录及缓存条目，模拟旧扫描和用户保留记录。 */
async function createStoredProject(name: string, fields: Partial<Project> = {}): Promise<Project> {
  const winPath = path.join(userDataDir, name);
  await fsp.mkdir(winPath);
  return { id: name, name, winPath, wslPath: "", hasDotCodex: false, createdAt: 1, hasBuiltInSessions: true, ...fields };
}

/** 将项目缓存写入测试数据目录，避免触碰真实用户数据。 */
async function writeStore(projects: Project[]): Promise<void> {
  await fsp.writeFile(path.join(userDataDir, "projects.json"), JSON.stringify(projects), "utf8");
}

describe("项目扫描与目录保留", () => {
  it("元信息中的 new-chat 子目录不会截成没有会话的父目录", async () => {
    const parent = await createStoredProject("daily");
    const cwd = path.join(parent.winPath, "new-chat");
    await createSession([{ type: "session_meta", payload: { id: "session", cwd } }]);
    await writeStore([parent]);

    const projects = await scanProjectsAsync();
    expect(projects).toHaveLength(1);
    expect(projects[0].winPath).toBe(cwd);
    expect(projects[0].name).toBe("new-chat");
    expect(projects[0].hasBuiltInSessions).toBe(true);
    expect(listProjectsFromStore()).toEqual(projects);
  });

  it("旧版 JSON 文本中的 cwd 保留 new-chat 并按实际消息边界截断", async () => {
    const cwd = "C:\\workspace\\daily\\new-chat";
    await createSession([
      { id: "legacy", timestamp: "2026-04-29" },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Current working directory: ${cwd}\n下一行` }] },
    ]);
    expect((await scanProjectsAsync()).map((project) => project.winPath)).toEqual([cwd]);
  });

  it.each([false, true])("没有会话的自动项目会被清理，其他会话存在=%s", async (withSession) => {
    const stale = await createStoredProject("stale");
    const manual = await createStoredProject("manual", { explicitlyAdded: true });
    const custom = await createStoredProject("custom", {
      hasBuiltInSessions: false, dirRecord: { kind: "custom_provider", providerId: "custom", recordedAt: 1 },
    });
    const legacyManual = await createStoredProject("legacy-manual", { hasBuiltInSessions: false });
    await writeStore([stale, manual, custom, legacyManual]);
    if (withSession) await createSession([{ type: "session_meta", payload: { id: "session", cwd: "C:\\workspace\\project" } }]);

    const projects = await scanProjectsAsync();
    expect(projects.some((project) => project.id === stale.id)).toBe(false);
    expect(projects.map((project) => project.id)).toEqual(expect.arrayContaining([manual.id, custom.id, legacyManual.id]));
    expect(projects.find((project) => project.id === manual.id)?.hasBuiltInSessions).toBe(false);
    expect(listProjectsFromStore()).toEqual(projects);
  });

  it("主动添加的空目录在扫描与重新读取后仍保留", async () => {
    const dir = path.join(userDataDir, "chosen");
    await fsp.mkdir(dir);
    const added = addProjectByWinPath(dir);
    expect(added?.explicitlyAdded).toBe(true);
    expect((await scanProjectsAsync()).map((project) => project.id)).toEqual([added!.id]);
    expect(listProjectsFromStore()[0].explicitlyAdded).toBe(true);
  });

  it("主动选择已有自动项目后，即使历史被移除仍保留项目和设置", async () => {
    const project = await createStoredProject("chosen", {
      worktreePostSetup: { items: [{ relativePath: ".env", label: ".env" }], command: "", applyAfterReset: true },
    });
    await writeStore([project]);
    expect(addProjectByWinPath(project.winPath)?.id).toBe(project.id);
    const projects = await scanProjectsAsync();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: project.id, explicitlyAdded: true, hasBuiltInSessions: false, worktreePostSetup: project.worktreePostSetup });
  });

  it("目录不存在时仍保留真实会话推导的项目", async () => {
    const cwd = "C:\\workspace\\missing-project";
    await createSession([{ type: "session_meta", payload: { id: "session", cwd } }]);
    expect((await scanProjectsAsync()).map((project) => project.winPath)).toEqual([cwd]);
  });

  it("扫描期间主动添加目录不会被扫描的旧缓存覆盖", async () => {
    const dir = path.join(userDataDir, "chosen-during-scan");
    await fsp.mkdir(dir);
    let release!: () => void;
    vi.mocked(getCodexRootsFastAsync).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { windowsCodex: userDataDir, windowsSessions: sessionRoot, wsl: [] };
    });
    const scanning = scanProjectsAsync();
    const added = addProjectByWinPath(dir);
    release();
    expect((await scanning).map((project) => project.id)).toEqual([added!.id]);
    expect(listProjectsFromStore()[0].explicitlyAdded).toBe(true);
  });
});
