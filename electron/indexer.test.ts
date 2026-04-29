import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

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

import { getIndexedSummaries, startHistoryIndexer, stopHistoryIndexer } from "./indexer";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

beforeEach(async () => {
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-indexer-user-data-"));
  tempDirs.push(userDataDir);
  process.chdir(userDataDir);
  wslMockState.sessionRoots = [];
  (global as any).__indexer = {
    retries: new Map(),
    index: { version: "v12", files: {}, savedAt: 0 },
    details: { version: "v12", files: {}, savedAt: 0 },
  };
});

afterEach(async () => {
  try { await stopHistoryIndexer(); } catch {}
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

describe("electron/indexer Codex preview", () => {
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

    await startHistoryIndexer(() => null);
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

    await startHistoryIndexer(() => null);
    const summaries = getIndexedSummaries().filter((item) => item.filePath === filePath);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].preview).toBe("工作流包 alp-auto-current-ops 节点的位置调整优化，重叠的地方调整间距");
    expect(summaries[0].preview || "").not.toContain("# Files mentioned by the user");
  });
});
