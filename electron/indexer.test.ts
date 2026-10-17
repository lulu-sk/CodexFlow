import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCodexStateSnapshot, type CodexStateSnapshotEntry } from "./codexStateSnapshot";

vi.mock("./codexStateSnapshot", () => ({ loadCodexStateSnapshot: vi.fn(async () => []) }));

let userDataDir = "";
const wslMockState = vi.hoisted(() => ({ sessionRoots: [] as string[] }));

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

vi.mock("./wsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wsl")>();
  return {
    ...actual,
    getSessionsRootCandidatesFastAsync: vi.fn(async () => wslMockState.sessionRoots.map((root) => ({
      path: root,
      exists: true,
      source: "windows",
      kind: "local",
    }))),
  };
});

vi.mock("./agentSessions/claude/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentSessions/claude/discovery")>();
  return {
    ...actual,
    getClaudeRootCandidatesFastAsync: vi.fn(async () => []),
  };
});

vi.mock("./agentSessions/gemini/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentSessions/gemini/discovery")>();
  return {
    ...actual,
    getGeminiRootCandidatesFastAsync: vi.fn(async () => []),
  };
});

vi.mock("./agentSessions/grok/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentSessions/grok/discovery")>();
  return {
    ...actual,
    getGrokRootCandidatesFastAsync: vi.fn(async () => []),
  };
});

vi.mock("./agentSessions/antigravity/discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentSessions/antigravity/discovery")>();
  return {
    ...actual,
    getAntigravityRootCandidatesFastAsync: vi.fn(async () => []),
  };
});

import { commitIndexedHistoryFilesRemovedAfterSweep, ensureHistoryIndexLoaded, getIndexedCodexSessionRecords, getIndexedSummaries, getLastIndexerRoots, isCodexRelationIndexReady, listIndexedHistoryFilesForRemovalAfterSweep, requestHistoryFastRefresh, startHistoryIndexer, stopHistoryIndexer } from "./indexer";
import { stopHistoryReconciler } from "./historyReconciler";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

beforeEach(async () => {
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-indexer-user-data-"));
  tempDirs.push(userDataDir);
  vi.spyOn(os, "homedir").mockReturnValue(userDataDir);
  for (const name of ["CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "GEMINI_HOME", "ANTIGRAVITY_HOME", "GROK_HOME"]) {
    vi.stubEnv(name, "");
  }
  process.chdir(userDataDir);
  wslMockState.sessionRoots = [];
  vi.mocked(loadCodexStateSnapshot).mockReset().mockResolvedValue([]);
  (global as any).__indexer = {
    retries: new Map(),
    index: { version: "v12", files: {}, savedAt: 0 },
    details: { version: "v12", files: {}, savedAt: 0 },
  };
});

afterEach(async () => {
  try { await stopHistoryIndexer(); } catch {}
  try {
    await stopHistoryReconciler();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    (global as any).__indexer = {
      retries: new Map(),
      index: { version: "v12", files: {}, savedAt: 0 },
      details: { version: "v12", files: {}, savedAt: 0 },
    };
    wslMockState.sessionRoots = [];
    userDataDir = "";
    process.chdir(originalCwd);
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch {}
    }));
  }
});

/**
 * 创建符合 Codex sessions 年/月/日目录结构的索引器测试文件。
 */
async function createCodexSessionFile(lines: unknown[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-indexer-root-"));
  tempDirs.push(root);
  const dir = path.join(root, "2026", "04", "29");
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "rollout-2026-04-29T03-35-01-test.jsonl");
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  await fsp.writeFile(filePath, `${body}\n`, "utf8");
  wslMockState.sessionRoots = [root];
  return filePath;
}

/**
 * 启动轻量索引器并通过协调器精确刷新一个 Codex 会话文件。
 */
async function startAndRefreshCodexFile(filePath: string): Promise<void> {
  await startHistoryIndexer(() => null);
  requestHistoryFastRefresh({ providerId: "codex", filePath });
  await vi.waitFor(() => {
    expect(getIndexedSummaries().some((item) => item.filePath === filePath)).toBe(true);
  }, { timeout: 2_000 });
}

/** 建立已有持久化摘要与后台快照，关闭目录发现以单独验证快速恢复入口。 */
async function createPersistedCodexSnapshotFixture({ mtimeDelta = -1_000, sizeDelta = -1, resolved = true } = {}) {
  const filePath = await createCodexSessionFile([{ type: "session_meta", payload: { id: "resumed", cwd: "/workspace/project", source: "cli" } }]);
  wslMockState.sessionRoots = [];
  const stat = await fsp.stat(filePath);
  const key = filePath.replace(/\\/g, "/").toLowerCase();
  const entry: CodexStateSnapshotEntry = {
    sig: { mtimeMs: stat.mtimeMs, size: stat.size }, cwd: "/workspace/project",
    summary: { providerId: "codex", id: "resumed", title: "最新摘要", preview: "真实请求", filePath, date: stat.mtimeMs, rawDate: "2026-04-20T00:00:00Z", dirKey: "/workspace/project", codexRelationship: { kind: "main" } },
  };
  const cached = {
    sig: { mtimeMs: stat.mtimeMs + mtimeDelta, size: stat.size + sizeDelta },
    summary: { ...entry.summary, title: "已解析摘要", date: stat.mtimeMs + mtimeDelta, codexHistoryResolved: resolved },
  };
  await fsp.writeFile(path.join(userDataDir, "history.index.v20.json"), JSON.stringify({ version: "v20", files: { [key]: cached }, savedAt: 1 }), "utf8");
  vi.mocked(loadCodexStateSnapshot).mockResolvedValue([entry]);
  return { key, entry, cached };
}

describe("electron/indexer Codex preview", () => {
  it("不再加载旧解析版本中由系统指令生成的 Claude 标题", async () => {
    await fsp.writeFile(path.join(userDataDir, "history.index.v19.json"), JSON.stringify({
      version: "v19", savedAt: 1, files: {
        "old-claude-session": { sig: { mtimeMs: 1, size: 1 }, summary: {
          providerId: "claude", id: "old-claude-session", title: "Codebase and user instructions",
          filePath: "/workspace/sessions/claude.jsonl", date: 1, dirKey: "/workspace/project",
        } },
      },
    }), "utf8");
    await ensureHistoryIndexLoaded();
    expect(getIndexedSummaries()).toEqual([]);
  });

  it("启动批量摘要恢复后立刻可按项目查询，并只发送一次列表刷新", async () => {
    const filePath = await createCodexSessionFile([{ type: "session_meta", payload: { id: "snapshot", cwd: "C:\\workspace\\project", source: "cli" } }]);
    const stat = await fsp.stat(filePath);
    vi.mocked(loadCodexStateSnapshot).mockResolvedValue([{
      sig: { mtimeMs: stat.mtimeMs, size: stat.size }, cwd: "C:\\workspace\\project",
      summary: { providerId: "codex", id: "snapshot", title: "已有摘要", preview: "已有请求", filePath, date: stat.mtimeMs, dirKey: "/mnt/c/workspace/project", codexRelationship: { kind: "main" } },
    }]);
    const send = vi.fn();
    await startHistoryIndexer(() => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: { send } } } as any));
    await vi.waitFor(() => expect(getIndexedSummaries().find((item) => item.id === "snapshot")?.title).toBe("已有摘要"));
    await vi.waitFor(() => expect(send.mock.calls.filter((call) => call[0] === "history:index:invalidate")).toHaveLength(1));
    expect(getIndexedCodexSessionRecords().find((item) => item.id === "snapshot")?.relationship.kind).toBe("main");
  });

  it("启动快照直接刷新已缓存旧会话，不必等待旧日期目录全量扫描", async () => {
    const { key, entry } = await createPersistedCodexSnapshotFixture();
    await ensureHistoryIndexLoaded();
    const oldList = getIndexedSummaries();
    expect(oldList[0].title).toBe("已解析摘要");
    const send = vi.fn();
    await startHistoryIndexer(() => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: { send } } } as any));
    await vi.waitFor(() => expect(getIndexedSummaries()[0]?.date).toBe(entry.summary.date));
    expect(getIndexedSummaries()).not.toBe(oldList);
    expect((global as any).__indexer.index.files[key].sig).toEqual(entry.sig);
    expect(getIndexedSummaries()[0]).toMatchObject({ title: "最新摘要", rawDate: entry.summary.rawDate, dirKey: "/workspace/project", codexHistoryResolved: true });
    expect(send.mock.calls.filter((call) => call[0] === "history:index:invalidate")).toHaveLength(1);
    await stopHistoryIndexer();
    const persisted = JSON.parse(await fsp.readFile(path.join(userDataDir, "history.index.v20.json"), "utf8"));
    expect(persisted.files[key].summary.date).toBe(entry.summary.date);
  });

  it.each([
    { mtimeDelta: 0, sizeDelta: 0 },
    { mtimeDelta: 1_000, sizeDelta: 0 },
    { mtimeDelta: 0, sizeDelta: 1 },
  ])("迟到快照保留签名为 %j 的完整或更新解析结果", async (deltas) => {
    const { key, cached } = await createPersistedCodexSnapshotFixture(deltas);
    await startHistoryIndexer(() => null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((global as any).__indexer.index.files[key]).toEqual(cached);
  });

  it("签名未变化但缓存尚未解析时，可信快照仍可补齐摘要", async () => {
    const { entry } = await createPersistedCodexSnapshotFixture({ mtimeDelta: 0, sizeDelta: 0, resolved: false });
    await startHistoryIndexer(() => null);
    await vi.waitFor(() => expect(getIndexedSummaries()[0]?.title).toBe(entry.summary.title));
    expect(getIndexedSummaries()[0]?.codexHistoryResolved).toBe(true);
  });

  it("停止后的迟到官方摘要不能回写新代次", async () => {
    let complete!: (entries: any[]) => void;
    vi.mocked(loadCodexStateSnapshot).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await startHistoryIndexer(() => null);
    await stopHistoryIndexer();
    complete([{ summary: { providerId: "codex", id: "late", filePath: path.join(userDataDir, "late.jsonl"), dirKey: "/workspace/project" }, sig: { mtimeMs: 1, size: 1 }, cwd: "/workspace/project" }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getIndexedSummaries()).toEqual([]);
  });

  it("索引 Windows 的 new-chat 目录时保留完整项目归属", async () => {
    const filePath = await createCodexSessionFile([
      { type: "session_meta", payload: { id: "windows-new-chat", cwd: "C:\\workspace\\daily\\new-chat" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "测试请求" }] } },
    ]);
    await startAndRefreshCodexFile(filePath);
    expect(getIndexedSummaries().find((item) => item.filePath === filePath)?.dirKey)
      .toBe("/mnt/c/workspace/daily/new-chat");
  });

  it("首次加载不复用旧版错误项目归属缓存", async () => {
    await fsp.writeFile(path.join(userDataDir, "history.index.v18.json"), JSON.stringify({
      version: "v18", savedAt: Date.now(), files: {
        stale: { sig: { mtimeMs: 1, size: 1 }, summary: { providerId: "codex", id: "stale", dirKey: "/mnt/c/workspace/dailyew-chat" } },
      },
    }), "utf8");
    await ensureHistoryIndexLoaded();
    expect(getIndexedSummaries()).toEqual([]);
  });

  it("索引和增量刷新选择当前回退版本，摘要使用继承的首条用户输入", async () => {
    const thread = "11111111-1111-4111-8111-111111111111";
    const revision = "22222222-2222-4222-8222-222222222222";
    const prefixRecords = [
      { ordinal: 0, type: "session_meta", payload: { id: thread, cwd: "/workspace/project", source: "cli" } },
      { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继承的首条请求" }] } },
    ];
    const initialPath = await createCodexSessionFile(prefixRecords);
    const originalPath = path.join(path.dirname(initialPath), `rollout-2026-04-29T03-35-01-${thread}.jsonl`);
    await fsp.rename(initialPath, originalPath);
    const revisionPath = path.join(path.dirname(originalPath), `rollout-2026-04-29T03-36-01-${thread}_${revision}.jsonl`);
    const prefix = prefixRecords.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await fsp.writeFile(revisionPath, JSON.stringify({
      ordinal: 2, type: "session_meta",
      payload: { id: thread, cwd: "/workspace/project", source: "cli", history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix) } },
    }) + "\n", "utf8");
    await startAndRefreshCodexFile(revisionPath);
    expect(getIndexedSummaries().filter((item) => item.id === thread)).toMatchObject([
      { filePath: revisionPath, preview: "继承的首条请求" },
    ]);
    await fsp.appendFile(originalPath, JSON.stringify({ type: "event_msg", payload: { type: "thread_name_updated", thread_name: "旧版本的更新" } }) + "\n", "utf8");
    requestHistoryFastRefresh({ providerId: "codex", filePath: originalPath });
    await vi.waitFor(() => expect(isCodexRelationIndexReady()).toBe(true), { timeout: 2_000 });
    expect(getIndexedSummaries().filter((item) => item.id === thread).map((item) => item.filePath)).toEqual([revisionPath]);
    expect(getIndexedCodexSessionRecords().filter((item) => item.id === thread)).toHaveLength(2);
  });

  it("仅在首轮索引完成后允许使用关系快照", async () => {
    expect(isCodexRelationIndexReady()).toBe(false);

    await startHistoryIndexer(() => null);
    expect(isCodexRelationIndexReady()).toBe(true);

    await stopHistoryIndexer();
    expect(isCodexRelationIndexReady()).toBe(false);
  });

  it("Codex 增量刷新完成前会暂时阻止使用旧关系快照", async () => {
    const filePath = await createCodexSessionFile([{
      type: "session_meta",
      payload: { id: "relation-refresh-session", cwd: "/workspace/project", source: "cli" },
    }]);
    await startHistoryIndexer(() => null);
    expect(isCodexRelationIndexReady()).toBe(true);

    requestHistoryFastRefresh({ providerId: "codex", filePath });
    expect(isCodexRelationIndexReady()).toBe(false);
    await vi.waitFor(() => expect(isCodexRelationIndexReady()).toBe(true), { timeout: 2_000 });
  });

  it("稳定扫描删除端口只返回候选并提交协调器确认的缺失项", async () => {
    const parentDir = path.join(os.tmpdir(), "codexflow-indexed-history");
    const filePath = path.join(parentDir, "session.jsonl");
    const key = filePath.replace(/\\/g, "/").toLowerCase();
    (global as any).__indexer.index = {
      version: "v20",
      files: {
        [key]: {
          sig: { mtimeMs: 1, size: 1 },
          summary: { providerId: "codex", id: "session", filePath },
        },
      },
      savedAt: 0,
    };
    (global as any).__indexer.details = {
      version: "v20",
      files: {
        [key]: { sig: { mtimeMs: 1, size: 1 }, details: { providerId: "codex", id: "session", filePath, messages: [] } },
      },
      savedAt: 0,
    };
    const candidates = listIndexedHistoryFilesForRemovalAfterSweep("codex", parentDir, new Set());
    expect(candidates).toEqual([filePath]);
    expect(commitIndexedHistoryFilesRemovedAfterSweep("codex", [], () => true)).toBe(0);
    expect((global as any).__indexer.index.files[key]).toBeTruthy();

    expect(commitIndexedHistoryFilesRemovedAfterSweep("codex", candidates, () => true)).toBe(1);
    expect((global as any).__indexer.index.files[key]).toBeUndefined();
  });

  it("首次列表请求可直接加载持久化摘要索引", async () => {
    const cachedFilePath = path.join(os.tmpdir(), "codexflow-cached-session.jsonl");
    const cacheKey = cachedFilePath.replace(/\\/g, "/").toLowerCase();
    await fsp.writeFile(path.join(userDataDir, "history.index.v20.json"), JSON.stringify({
      version: "v20",
      savedAt: Date.now(),
      files: {
        [cacheKey]: {
          sig: { mtimeMs: 2, size: 1 },
          summary: {
            providerId: "codex",
            id: "cached-session",
            title: "缓存会话",
            date: 2,
            filePath: cachedFilePath,
            dirKey: "/workspace/project",
          },
        },
      },
    }), "utf8");

    await ensureHistoryIndexLoaded();

    const first = getIndexedSummaries();
    const second = getIndexedSummaries();
    expect(first.map((item) => item.id)).toEqual(["cached-session"]);
    expect(second).toBe(first);
  });

  it("索引内容更新后会使摘要缓存失效", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: { id: "summary-cache-session", cwd: "/workspace/project" },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "初始摘要" }],
        },
      },
    ]);
    await startAndRefreshCodexFile(filePath);
    const first = getIndexedSummaries();

    await fsp.appendFile(filePath, `${JSON.stringify({
      timestamp: "2026-04-29T03:35:03.000Z",
      type: "event_msg",
      payload: { type: "thread_name_updated", thread_name: "更新后的摘要" },
    })}\n`, "utf8");
    requestHistoryFastRefresh({ providerId: "codex", filePath });

    await vi.waitFor(() => {
      expect(getIndexedSummaries().find((item) => item.filePath === filePath)?.title).toBe("更新后的摘要");
    }, { timeout: 2_000 });
    expect(getIndexedSummaries()).not.toBe(first);
  });

  it("停止索引器前会完成异步缓存刷盘且不持久化消息正文", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-persist",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "验证索引缓存异步刷盘" }],
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    await stopHistoryIndexer();

    const index = JSON.parse(await fsp.readFile(path.join(userDataDir, "history.index.v20.json"), "utf8"));
    const details = JSON.parse(await fsp.readFile(path.join(userDataDir, "history.details.v20.json"), "utf8"));
    const detailEntry = Object.values(details.files as Record<string, any>)
      .find((entry: any) => entry?.details?.filePath === filePath) as any;

    expect(Number.isFinite(index.savedAt)).toBe(true);
    expect(Number.isFinite(details.savedAt)).toBe(true);
    expect(detailEntry?.details?.messages).toEqual([]);
  });

  it("连续索引更新会延迟合并写盘，并在停止时强制刷完", async () => {
    const filePath = await createCodexSessionFile([{
      timestamp: "2026-04-29T03:35:01.000Z",
      type: "session_meta",
      payload: { id: "session-index-debounce", cwd: "/workspace/project" },
    }]);
    const writeFileSpy = vi.spyOn(fsp, "writeFile");

    await startAndRefreshCodexFile(filePath);
    writeFileSpy.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const cacheWritesBeforeStop = writeFileSpy.mock.calls.filter(([filePath]) => {
      const name = String(filePath || "");
      return name.endsWith("history.index.v20.json") || name.endsWith("history.details.v20.json");
    });
    expect(cacheWritesBeforeStop).toHaveLength(0);

    await stopHistoryIndexer();
    const cacheWritesAfterStop = writeFileSpy.mock.calls.filter(([filePath]) => {
      const name = String(filePath || "");
      return name.endsWith("history.index.v20.json") || name.endsWith("history.details.v20.json");
    });
    expect(cacheWritesAfterStop).toHaveLength(2);
  });

  it("索引摘要优先使用 thread_name_updated 并跳过 Files mentioned 模板标题", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-thread-name",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "# Files mentioned by the user:",
                "",
                "## workflows/alp-auto-current-ops.json",
                "",
                "## My request for Codex:",
                "工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:08.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_id: "session-index-thread-name",
          thread_name: "优化 alp-auto-current-ops 节点布局",
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    const summaries = getIndexedSummaries().filter((item) => item.filePath === filePath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("优化 alp-auto-current-ops 节点布局");
    expect(summaries[0].preview).toBe("优化 alp-auto-current-ops 节点布局");
  });

  it("没有线程名时索引摘要从 Files mentioned 模板提取真实请求", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-clean-request",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "# Files mentioned by the user:",
                "",
                "## workflows/alp-auto-current-ops.json",
                "",
                "## My request for Codex:",
                "工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距",
              ].join("\n"),
            },
          ],
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    const summaries = getIndexedSummaries().filter((item) => item.filePath === filePath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距");
    expect(summaries[0].preview).toBe("工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距");
    expect(summaries[0].preview || "").not.toContain("# Files mentioned by the user");
  });

  it("索引摘要会跳过 goal 内部上下文和前置路径行生成标题", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-goal-context",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<codex_internal_context source=\"goal\">",
                "内部目标上下文不应作为标题",
                "</codex_internal_context>",
                "src/features/history/detail.ts",
                "修复历史详情标题提取",
              ].join("\n"),
            },
          ],
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    const summaries = getIndexedSummaries().filter((item) => item.filePath === filePath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("修复历史详情标题提取");
    expect(summaries[0].preview).toBe("修复历史详情标题提取");
  });

  it("索引摘要会使用首条 goal objective 且忽略 turn_aborted", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-goal-objective",
          cwd: "/workspace/project",
        },
      },
      {
        timestamp: "2026-04-29T03:35:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<codex_internal_context source=\"goal\">",
                "Continue working toward the active thread goal.",
                "<objective>",
                "你作为调度者，最终目标是完整推进测试与验收工作",
                "`alp-auto-v3-lan-three-task-test.zh-CN.md`",
                "</objective>",
                "</codex_internal_context>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<turn_aborted>",
                "The user interrupted the previous turn on purpose.",
                "</turn_aborted>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-04-29T03:35:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "预检我不是提醒你了吗，只执行一个任务就行" }],
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    const summaries = getIndexedSummaries().filter((item) => item.filePath === filePath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("你作为调度者，最终目标是完整推进测试与验收工作");
    expect(summaries[0].preview).toBe("你作为调度者，最终目标是完整推进测试与验收工作");
  });

  it("会从内存索引返回包含签名和父子关系的 Codex 会话快照", async () => {
    const filePath = await createCodexSessionFile([
      {
        timestamp: "2026-04-29T03:35:01.000Z",
        type: "session_meta",
        payload: {
          id: "session-index-subagent",
          cwd: "/workspace/project",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "session-index-parent",
                agent_nickname: "researcher",
                agent_role: "research",
                depth: 1,
              },
            },
          },
        },
      },
    ]);

    await startAndRefreshCodexFile(filePath);
    const record = getIndexedCodexSessionRecords().find((item) => item.id === "session-index-subagent");

    expect(record).toMatchObject({
      id: "session-index-subagent",
      filePath,
      relationship: {
        kind: "subagent",
        parentThreadId: "session-index-parent",
        agentNickname: "researcher",
        agentRole: "research",
        agentDepth: 1,
      },
    });
    expect(record?.mtimeMs).toBeGreaterThan(0);
    expect(record?.size).toBeGreaterThan(0);
  });

  it("根目录发现迟迟不返回时初始化仍可用，stop 后迟到结果不能回写", async () => {
    const wsl = await import("./wsl");
    let resolveCandidates: ((value: Awaited<ReturnType<typeof wsl.getSessionsRootCandidatesFastAsync>>) => void) | null = null;
    vi.mocked(wsl.getSessionsRootCandidatesFastAsync).mockImplementationOnce(async () => {
      return await new Promise((resolve) => { resolveCandidates = resolve; });
    });

    await startHistoryIndexer(() => null);
    expect(isCodexRelationIndexReady()).toBe(true);
    await stopHistoryIndexer();
    const completeDiscovery = resolveCandidates as ((value: Awaited<ReturnType<typeof wsl.getSessionsRootCandidatesFastAsync>>) => void) | null;
    if (completeDiscovery) completeDiscovery([{
      path: path.join(os.tmpdir(), "late-history-root"),
      exists: true,
      source: "windows",
      kind: "local",
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(isCodexRelationIndexReady()).toBe(false);
    expect(getLastIndexerRoots()).toEqual([]);
  });
});
