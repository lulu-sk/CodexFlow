import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing, getCodexNotifyStateDecision } from "./notifyState";

type TestDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3") as new (filename: string) => TestDb;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

/** 创建临时 Codex home。 */
function createCodexHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-notify-state-"));
  tempDirs.push(root);
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  return codexHome;
}

/** 创建临时 sqlite home。 */
function createSqliteHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-notify-sqlite-"));
  tempDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 创建 Codex goals DB 测试结构。 */
function createGoalsDb(sqliteHome: string, threadId: string, status: string, fileName = "goals_1.sqlite"): void {
  const db = new Database(path.join(sqliteHome, fileName));
  try {
    db.exec(`
      CREATE TABLE thread_goals (
        thread_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO thread_goals (
        thread_id,
        goal_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        created_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(threadId, "goal-1", "objective", status, null, 0, 0, 1, 1);
  } finally {
    db.close();
  }
}

/** 创建 Codex state DB 测试结构。 */
function createStateDb(sqliteHome: string, parentThreadId: string, childThreadId: string, fileName = "state_5.sqlite"): void {
  const db = new Database(path.join(sqliteHome, fileName));
  try {
    db.exec(`
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL,
        child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)")
      .run(parentThreadId, childThreadId, "closed");
  } finally {
    db.close();
  }
}

describe("electron/codex/notifyState", () => {
  it("goal 状态为 active 时丢弃 legacy 完成通知", () => {
    const codexHome = createCodexHome();
    const threadId = "thread-active";
    createGoalsDb(codexHome, threadId, "active");

    const decision = getCodexNotifyStateDecision(
      { threadId },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.dropReason).toBe("unfinished-goal-active");
    expect(decision.goalStatus).toBe("active");
  });

  it("goal 状态为 budget_limited 时丢弃 legacy 完成通知", () => {
    const codexHome = createCodexHome();
    const threadId = "thread-budget";
    createGoalsDb(codexHome, threadId, "budget_limited");

    const decision = getCodexNotifyStateDecision(
      { threadId },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.dropReason).toBe("unfinished-goal-budget_limited");
    expect(decision.goalStatus).toBe("budget_limited");
  });

  it("goal 状态为 complete 时保持旧行为", () => {
    const codexHome = createCodexHome();
    const threadId = "thread-complete";
    createGoalsDb(codexHome, threadId, "complete");

    const decision = getCodexNotifyStateDecision(
      { threadId },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision).toEqual({});
  });

  it("thread_spawn_edges 命中 child_thread_id 时归类为 subagent", () => {
    const codexHome = createCodexHome();
    createStateDb(codexHome, "parent-thread", "child-thread");

    const decision = getCodexNotifyStateDecision(
      { threadId: "child-thread" },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.completionKind).toBe("subagent");
    expect(decision.agentId).toBe("child-thread");
  });

  it("子代理线程仍有未完成 goal 时优先丢弃 legacy 完成通知", () => {
    const codexHome = createCodexHome();
    createStateDb(codexHome, "parent-thread", "child-with-goal");
    createGoalsDb(codexHome, "child-with-goal", "active");

    const decision = getCodexNotifyStateDecision(
      { threadId: "child-with-goal" },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.dropReason).toBe("unfinished-goal-active");
    expect(decision.completionKind).toBeUndefined();
  });

  it("优先读取 config.toml 中的 sqlite_home", () => {
    const codexHome = createCodexHome();
    const sqliteHome = createSqliteHome();
    fs.writeFileSync(path.join(codexHome, "config.toml"), `sqlite_home = '${sqliteHome}' # comment\n`, "utf8");
    createGoalsDb(sqliteHome, "thread-config", "active");

    const decision = getCodexNotifyStateDecision(
      { threadId: "thread-config" },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.dropReason).toBe("unfinished-goal-active");
  });

  it("支持 sqlite runtime DB 文件名序号升级", () => {
    const codexHome = createCodexHome();
    createGoalsDb(codexHome, "thread-next-db", "active", "goals_2.sqlite");

    const decision = getCodexNotifyStateDecision(
      { threadId: "thread-next-db" },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision.dropReason).toBe("unfinished-goal-active");
    expect(__testing.listRuntimeDbPaths(codexHome, "goals").some((item) => item.endsWith("goals_2.sqlite"))).toBe(true);
  });

  it("多版本 goals DB 中优先使用较新 DB 的线程状态", () => {
    const codexHome = createCodexHome();
    createGoalsDb(codexHome, "thread-migrated", "active", "goals_1.sqlite");
    createGoalsDb(codexHome, "thread-migrated", "complete", "goals_2.sqlite");

    const decision = getCodexNotifyStateDecision(
      { threadId: "thread-migrated" },
      path.join(codexHome, "codexflow_after_agent_notify.jsonl"),
    );

    expect(decision).toEqual({});
  });

  it("解析 WSL UNC 来源时可把 sqliteHome 里的绝对 Linux 路径映射成 UNC", () => {
    const sourcePath = "\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex\\codexflow_after_agent_notify.jsonl";

    expect(__testing.distroFromWslUncPath(sourcePath)).toBe("Ubuntu");
    expect(__testing.mapWslAbsolutePathFromSource(sourcePath, "/home/user/.codex"))
      .toBe("\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex");
  });
});
