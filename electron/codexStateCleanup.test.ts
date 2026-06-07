import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

type TestDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
};

const wslMockState = vi.hoisted(() => ({
  roots: {
    windowsCodex: "",
    windowsSessions: "",
    wsl: [] as { distro: string; codexUNC: string; sessionsUNC: string }[],
  },
}));

vi.mock("./wsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wsl")>();
  return {
    ...actual,
    getCodexRootsFastAsync: vi.fn(async () => wslMockState.roots),
  };
});

import { __codexStateCleanupTestHooks, cleanupCodexStateForDeletedHistoryFiles, repairMissingCodexRolloutRows } from "./codexStateCleanup";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3") as new (filename: string) => TestDb;

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalCodexSqliteHome = process.env.CODEX_SQLITE_HOME;

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = originalCodexSqliteHome;
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  wslMockState.roots = { windowsCodex: "", windowsSessions: "", wsl: [] };
  vi.restoreAllMocks();
});

/** 创建临时 Codex home。 */
async function createCodexHome(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-codex-state-"));
  tempDirs.push(root);
  const codexHome = path.join(root, ".codex");
  await fsp.mkdir(codexHome, { recursive: true });
  return codexHome;
}

/** 打开测试 SQLite DB。 */
function openTestDb(filePath: string): TestDb {
  return new Database(filePath);
}

/** 读取表行数。 */
function countRows(db: TestDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count || 0);
}

/** 列出目录中的 CodexFlow sqlite 备份文件。 */
async function listCodexFlowBackupFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir);
  return entries.filter((name) => name.includes(".codexflow-backup-")).sort();
}

/** 创建当前和旧版兼容的 state DB 测试结构。 */
function createStateDb(dbPath: string, rows: { id: string; rolloutPath: string }[]): void {
  const db = openTestDb(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL
      );
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY(thread_id, position)
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    const insertThread = db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)");
    for (const row of rows) insertThread.run(row.id, row.rolloutPath);
  } finally {
    db.close();
  }
}

/** 创建 goals DB 测试结构。 */
function createGoalsDb(dbPath: string, threadId: string): void {
  const db = openTestDb(dbPath);
  try {
    db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL);");
    db.prepare("INSERT INTO thread_goals (thread_id, objective) VALUES (?, ?)").run(threadId, "goal");
  } finally {
    db.close();
  }
}

/** 创建 memories DB 测试结构。 */
function createMemoriesDb(dbPath: string, threadId: string): void {
  const db = openTestDb(dbPath);
  try {
    db.exec(`
      CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, raw_memory TEXT NOT NULL);
      CREATE TABLE jobs (kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(kind, job_key));
    `);
    db.prepare("INSERT INTO stage1_outputs (thread_id, raw_memory) VALUES (?, ?)").run(threadId, "memory");
    db.prepare("INSERT INTO jobs (kind, job_key, status) VALUES (?, ?, ?)").run("memory_stage1", threadId, "pending");
  } finally {
    db.close();
  }
}

describe("codexStateCleanup", () => {
  it("路径 key 保留 WSL UNC 前缀用于正确推导 Codex home", () => {
    const threadId = "00000000-0000-0000-0000-000000000007";
    const uncPath = `\\\\wsl.localhost\\Ubuntu-24.04\\home\\tester\\.codex\\sessions\\2026\\06\\07\\rollout-2026-06-07T01-02-08-${threadId}.jsonl`;

    const key = __codexStateCleanupTestHooks.pathKey(uncPath);

    expect(key).toBe(`//wsl.localhost/ubuntu-24.04/home/tester/.codex/sessions/2026/06/07/rollout-2026-06-07t01-02-08-${threadId}.jsonl`);
    if (process.platform === "win32") {
      expect(__codexStateCleanupTestHooks.accessPathFromKey(key)).toBe(`\\\\wsl.localhost\\ubuntu-24.04\\home\\tester\\.codex\\sessions\\2026\\06\\07\\rollout-2026-06-07t01-02-08-${threadId}.jsonl`);
    }
  });

  it("精准清理已删除 rollout 对应的 state/goals/memories 记录", async () => {
    const codexHome = await createCodexHome();
    const threadId = "00000000-0000-0000-0000-000000000001";
    const rolloutPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "06",
      "07",
      `rollout-2026-06-07T01-02-03-${threadId}.jsonl`,
    );
    createStateDb(path.join(codexHome, "state_5.sqlite"), [{ id: threadId, rolloutPath }]);
    createGoalsDb(path.join(codexHome, "goals_1.sqlite"), threadId);
    createMemoriesDb(path.join(codexHome, "memories_1.sqlite"), threadId);

    const stateDb = openTestDb(path.join(codexHome, "state_5.sqlite"));
    try {
      stateDb.prepare("INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES (?, ?, ?)").run(threadId, 1, "tool");
      stateDb.prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)").run(threadId, "child", "open");
    } finally {
      stateDb.close();
    }

    const result = await cleanupCodexStateForDeletedHistoryFiles([rolloutPath]);

    expect(result.ok).toBe(true);
    expect(result.deletedThreadRows).toBe(1);
    expect(await listCodexFlowBackupFiles(codexHome)).toHaveLength(0);
    const afterState = openTestDb(path.join(codexHome, "state_5.sqlite"));
    const afterGoals = openTestDb(path.join(codexHome, "goals_1.sqlite"));
    const afterMemories = openTestDb(path.join(codexHome, "memories_1.sqlite"));
    try {
      expect(countRows(afterState, "threads")).toBe(0);
      expect(countRows(afterState, "thread_dynamic_tools")).toBe(0);
      expect(countRows(afterState, "thread_spawn_edges")).toBe(0);
      expect(countRows(afterGoals, "thread_goals")).toBe(0);
      expect(countRows(afterMemories, "stage1_outputs")).toBe(0);
      expect(countRows(afterMemories, "jobs")).toBe(0);
    } finally {
      afterState.close();
      afterGoals.close();
      afterMemories.close();
    }
  });

  it("按 CODEX_SQLITE_HOME 相对当前工作目录查找 sqlite home", async () => {
    const codexHome = await createCodexHome();
    const workspace = path.dirname(codexHome);
    const sqliteHome = path.join(workspace, "sqlite-home");
    await fsp.mkdir(sqliteHome, { recursive: true });
    process.chdir(workspace);
    process.env.CODEX_SQLITE_HOME = "sqlite-home";
    const threadId = "00000000-0000-0000-0000-000000000005";
    const rolloutPath = path.join(codexHome, "sessions", "2026", "06", "07", `rollout-2026-06-07T01-02-06-${threadId}.jsonl`);
    createStateDb(path.join(sqliteHome, "state_5.sqlite"), [{ id: threadId, rolloutPath }]);

    const result = await cleanupCodexStateForDeletedHistoryFiles([rolloutPath]);

    expect(result.ok).toBe(true);
    expect(result.deletedThreadRows).toBe(1);
    const after = openTestDb(path.join(sqliteHome, "state_5.sqlite"));
    try {
      expect(countRows(after, "threads")).toBe(0);
    } finally {
      after.close();
    }
  });

  it("解析 config.toml sqlite_home 时保留引号内的井号字符", async () => {
    const codexHome = await createCodexHome();
    const sqliteHome = path.join(path.dirname(codexHome), "sqlite#home");
    await fsp.mkdir(sqliteHome, { recursive: true });
    await fsp.writeFile(path.join(codexHome, "config.toml"), `sqlite_home = '${sqliteHome}' # comment\n`, "utf8");
    const threadId = "00000000-0000-0000-0000-000000000006";
    const rolloutPath = path.join(codexHome, "sessions", "2026", "06", "07", `rollout-2026-06-07T01-02-07-${threadId}.jsonl`);
    createStateDb(path.join(sqliteHome, "state_5.sqlite"), [{ id: threadId, rolloutPath }]);

    const result = await cleanupCodexStateForDeletedHistoryFiles([rolloutPath]);

    expect(result.ok).toBe(true);
    expect(result.deletedThreadRows).toBe(1);
    const after = openTestDb(path.join(sqliteHome, "state_5.sqlite"));
    try {
      expect(countRows(after, "threads")).toBe(0);
    } finally {
      after.close();
    }
  });

  it("自动补救只删除可确认缺失的 rollout，不删除仍存在的文件", async () => {
    const codexHome = await createCodexHome();
    const missingId = "00000000-0000-0000-0000-000000000002";
    const existingId = "00000000-0000-0000-0000-000000000003";
    const sessionDir = path.join(codexHome, "sessions", "2026", "06", "07");
    await fsp.mkdir(sessionDir, { recursive: true });
    const missingPath = path.join(sessionDir, `rollout-2026-06-07T01-02-03-${missingId}.jsonl`);
    const existingPath = path.join(sessionDir, `rollout-2026-06-07T01-02-04-${existingId}.jsonl`);
    await fsp.writeFile(existingPath, "{}\n", "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(path.dirname(codexHome));
    createStateDb(path.join(codexHome, "state_5.sqlite"), [
      { id: missingId, rolloutPath: missingPath },
      { id: existingId, rolloutPath: existingPath },
    ]);
    wslMockState.roots = {
      windowsCodex: codexHome,
      windowsSessions: path.join(codexHome, "sessions"),
      wsl: [],
    };

    const result = await repairMissingCodexRolloutRows();

    expect(result.ok).toBe(true);
    expect(result.repairedStaleRows).toBe(1);
    const db = openTestDb(path.join(codexHome, "state_5.sqlite"));
    try {
      expect(countRows(db, "threads")).toBe(1);
      const row = db.prepare("SELECT id FROM threads").get();
      expect(row?.id).toBe(existingId);
    } finally {
      db.close();
    }
  });

  it("旧版缺少关联表时跳过不存在的表列并继续清理 threads", async () => {
    const codexHome = await createCodexHome();
    const threadId = "00000000-0000-0000-0000-000000000004";
    const rolloutPath = path.join(codexHome, "sessions", "2026", "06", "07", `rollout-2026-06-07T01-02-05-${threadId}.jsonl`);
    const db = openTestDb(path.join(codexHome, "state.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);");
      db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(threadId, rolloutPath);
    } finally {
      db.close();
    }

    const result = await cleanupCodexStateForDeletedHistoryFiles([rolloutPath]);

    expect(result.ok).toBe(true);
    expect(result.deletedThreadRows).toBe(1);
    const after = openTestDb(path.join(codexHome, "state.sqlite"));
    try {
      expect(countRows(after, "threads")).toBe(0);
    } finally {
      after.close();
    }
  });
});
