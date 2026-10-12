// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexStateSnapshot as readStateSnapshot } from "./codexStateSnapshot";

let fixtureRows: Array<Record<string, unknown>> = [];
let fixtureColumns = ["id", "rollout_path", "cwd", "title", "first_user_message"];
let readOnly = false;
/** 用可控数据库端口验证筛选；真实驱动另由独立进程集成验证。 */
class Database {
  /** 核对读取端只使用只读打开方式。 */
  constructor(_filePath: string, options?: { readonly?: boolean }) { readOnly = options?.readonly === true; }
  /** 返回当前夹具的数据库结构。 */
  pragma() { return fixtureColumns.map((name) => ({ name })); }
  /** 提供摘要查询和夹具写入端口。 */
  prepare(_sql: string) {
    return {
      /** 返回预置摘要行。 */
      all: () => fixtureRows,
      /** 添加摘要夹具，不加载原生驱动。 */
      run: (id: string, rollout_path: string, cwd: string, title: string, first_user_message: string) => { fixtureRows.push({ id, rollout_path, cwd, title, first_user_message }); },
    };
  }
  /** 模拟不兼容的旧数据库结构。 */
  exec(_sql: string) { fixtureColumns = ["id"]; fs.writeFileSync(path.join(home, "state_5.sqlite"), "fixture", "utf8"); }
  /** 关闭夹具端口。 */
  close() {}
}
/** 在同一测试环境复用原生构造器，避免重复初始化原生驱动。 */
function readCodexStateSnapshot(roots: readonly string[]) {
  return readStateSnapshot(roots, Database);
}
let home = "";
let root = "";

beforeEach(async () => {
  fixtureRows = [];
  fixtureColumns = ["id", "rollout_path", "cwd", "title", "first_user_message"];
  readOnly = false;
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-state-snapshot-"));
  root = path.join(home, "sessions");
  await fsp.mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(home, { recursive: true, force: true });
});

/** 建立摘要库文件夹具，兼容旧版没有 name 字段的结构。 */
function createDb(): any {
  const db = new Database(path.join(home, "state_5.sqlite"));
  fs.writeFileSync(path.join(home, "state_5.sqlite"), "fixture", "utf8");
  return db;
}

/** 建立真实会话文件；大正文只用于验证摘要读取量。 */
async function createRollout(id: string, payload: Record<string, unknown> = {}, body = ""): Promise<string> {
  const filePath = path.join(root, `${id}.jsonl`);
  await fsp.writeFile(filePath, JSON.stringify({ type: "session_meta", timestamp: "2026-04-29T00:00:00Z", payload: { id, cwd: "C:\\workspace\\daily\\new-chat", source: "cli", ...payload } }) + "\n" + body, "utf8");
  return filePath;
}

describe("官方 Codex 摘要快照", () => {
  it("目录联接的逻辑入口能恢复数据库里记录的物理路径", async () => {
    const filePath = await createRollout("junction");
    const alias = path.join(home, "linked-sessions");
    await fsp.symlink(root, alias, "junction");
    const db = createDb();
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("junction", filePath, "", "已有标题", "真实请求");
    db.close();
    expect(readCodexStateSnapshot([alias])[0].summary.filePath).toBe(path.join(alias, path.basename(filePath)));
  });

  it.skipIf(process.platform !== "win32")("Windows 长路径前缀不会被误判成网络目录而漏收", async () => {
    const filePath = await createRollout("extended");
    const db = createDb();
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("extended", `\\\\?\\${filePath}`, "", "已有标题", "真实请求");
    db.close();
    expect(readCodexStateSnapshot([root])[0].summary.filePath).toBe(filePath);
  });

  it("旧版顶层会话头同样能直接恢复摘要", async () => {
    const filePath = path.join(root, "legacy.jsonl");
    await fsp.writeFile(filePath, JSON.stringify({ id: "legacy", timestamp: "2026-04-29T00:00:00Z" }) + "\n", "utf8");
    const db = createDb();
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("legacy", filePath, "C:\\workspace\\legacy", "旧会话", "真实请求");
    db.close();
    expect(readCodexStateSnapshot([root])[0].summary).toMatchObject({ id: "legacy", resumeMode: "legacy", dirKey: "/mnt/c/workspace/legacy" });
  });

  it("只读恢复项目、摘要和关系，读取量与聊天正文大小无关", async () => {
    const filePath = await createRollout("main", {}, "x".repeat(2 * 1024 * 1024));
    const db = createDb();
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("main", filePath, "C:\\workspace\\wrong", "真实标题", "真实请求");
    db.close();
    const before = await fsp.readFile(path.join(home, "state_5.sqlite"));
    const readSpy = vi.spyOn(fs, "readSync");

    const entries = readCodexStateSnapshot([root]);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toMatchObject({ id: "main", title: "真实标题", dirKey: "/mnt/c/workspace/daily/new-chat", codexRelationship: { kind: "main" } });
    expect(readSpy.mock.calls).toHaveLength(1);
    expect(readOnly).toBe(true);
    expect(await fsp.readFile(path.join(home, "state_5.sqlite"))).toEqual(before);
  });

  it("跳过空上下文、已删除文件、错误会话身份和继承历史", async () => {
    const empty = await createRollout("empty");
    const mismatched = await createRollout("actual");
    const inherited = await createRollout("inherited", { history_base: { thread_id: "parent" } });
    const db = createDb();
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
    insert.run("empty", empty, "", "空会话", "<environment_context>环境</environment_context>");
    insert.run("missing", path.join(root, "missing.jsonl"), "", "已删除", "请求");
    insert.run("wrong", mismatched, "", "错配", "请求");
    insert.run("inherited", inherited, "", "继承", "请求");
    db.close();
    expect(readCodexStateSnapshot([root])).toEqual([]);
  });

  it("保留子代理关系并拒绝数据库中的根目录外文件", async () => {
    const subagent = await createRollout("child", { source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "researcher" } } } });
    const outside = path.join(home, "outside.jsonl");
    await fsp.copyFile(subagent, outside);
    const db = createDb();
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
    insert.run("child", subagent, "", "研究", "研究请求");
    insert.run("child", outside, "", "外部", "请求");
    db.close();
    const entries = readCodexStateSnapshot([root]);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary.codexRelationship).toMatchObject({ kind: "subagent", parentThreadId: "parent", agentNickname: "researcher" });
  });

  it("数据库缺失或结构不兼容时回退为空快照", () => {
    expect(readCodexStateSnapshot([root])).toEqual([]);
    const db = new Database(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT)");
    db.close();
    expect(readCodexStateSnapshot([root])).toEqual([]);
  });
});
