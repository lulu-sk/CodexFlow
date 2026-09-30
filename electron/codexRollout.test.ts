import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCodexHistoryStream, parseCodexRolloutFileName, selectCurrentHistorySummaries } from "./codexRollout";

const THREAD = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const FORK = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

/** 构造带有记录编号的会话头。 */
function header(id = THREAD, historyBase?: unknown): object {
  return { ordinal: 0, type: "session_meta", payload: { id, cwd: "/workspace/project", history_base: historyBase } };
}

/** 将测试记录编码为 UTF-8 JSONL，并返回准确的前缀字节长度。 */
function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/** 创建隔离的 Codex 数据目录与符合真实格式的记录文件。 */
async function createRollouts(): Promise<{ original: string; revision: string; fork: string }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-rollouts-"));
  tempDirs.push(home);
  const active = path.join(home, "sessions", "2026", "01", "02");
  const archived = path.join(home, "archived_sessions");
  await fsp.mkdir(active, { recursive: true });
  await fsp.mkdir(archived);
  return {
    original: path.join(archived, `rollout-2026-01-02T01-00-00-${THREAD}.jsonl`),
    revision: path.join(active, `rollout-2026-01-02T02-00-00-${THREAD}_${REVISION}.jsonl`),
    fork: path.join(active, `rollout-2026-01-02T03-00-00-${FORK}.jsonl`),
  };
}

/** 消费逻辑历史流，便于检查拼接顺序与回退边界。 */
async function readRecords(filePath: string): Promise<any[]> {
  const stream = await openCodexHistoryStream(filePath, 32);
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("Codex 物理记录与逻辑会话", () => {
  it("区分稳定会话编号与回退后的物理记录编号", () => {
    expect(parseCodexRolloutFileName(`rollout-2026-01-02T02-00-00-${THREAD}_${REVISION}.jsonl`))
      .toEqual({ timestamp: "2026-01-02T02-00-00", rolloutId: REVISION });
  });

  it("优先选择新文件版本，保留真实分叉和其它提供方的同名会话", () => {
    const original = { providerId: "codex", id: THREAD, date: 90, filePath: `rollout-2026-01-02T01-00-00-${THREAD}.jsonl` };
    const revision = { ...original, date: 20, filePath: `rollout-2026-01-02T02-00-00-${THREAD}_${REVISION}.jsonl` };
    const fork = { ...original, id: FORK, date: 30, filePath: `rollout-2026-01-02T03-00-00-${FORK}.jsonl` };
    const claude = { ...original, providerId: "claude", filePath: "session.jsonl" };
    expect(selectCurrentHistorySummaries([original, fork, revision, claude])).toEqual([claude, fork, revision]);
    expect(selectCurrentHistorySummaries([revision, original])).toEqual([revision]);
  });

  it("按物理记录编号拼接多层归档前缀，排除回退之后的旧消息", async () => {
    const files = await createRollouts();
    const prefix = jsonl([header(), { ordinal: 1, type: "test", text: "保留中文前缀" }]);
    await fsp.writeFile(files.original, prefix + jsonl([{ ordinal: 2, type: "test", text: "旧分支" }]), "utf8");
    const revisionHeader = header(THREAD, { thread_id: THREAD, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(prefix) });
    const revisionPrefix = jsonl([revisionHeader, { ordinal: 2, type: "test", text: "修改后的消息" }]);
    await fsp.writeFile(files.revision, revisionPrefix + jsonl([{ ordinal: 3, type: "test", text: "分叉之后" }]), "utf8");
    await fsp.writeFile(files.fork, jsonl([
      header(FORK, { thread_id: REVISION, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(revisionPrefix) }),
      { ordinal: 3, type: "test", text: "分叉新消息" },
    ]), "utf8");
    const records = await readRecords(files.fork);
    expect(records[0].payload.id).toBe(FORK);
    expect(records.slice(1).map((record) => record.text)).toEqual(["保留中文前缀", "修改后的消息", "分叉新消息"]);
  });

  it("引用缺失、截断或循环时明确失败，避免缓存不完整历史", async () => {
    const files = await createRollouts();
    const base = { thread_id: THREAD, end_ordinal_exclusive: 2, end_byte_offset: 1000 };
    await fsp.writeFile(files.revision, jsonl([header(THREAD, base)]), "utf8");
    await expect(openCodexHistoryStream(files.revision, 32)).rejects.toThrow("缺失");
    await fsp.writeFile(files.original, jsonl([header()]), "utf8");
    await expect(openCodexHistoryStream(files.revision, 32)).rejects.toThrow("截断");
    await fsp.writeFile(files.original, jsonl([header(THREAD, { ...base, end_byte_offset: 1 })]), "utf8");
    await fsp.writeFile(files.revision, jsonl([header(THREAD, { ...base, end_byte_offset: 1 })]), "utf8");
    await expect(openCodexHistoryStream(files.revision, 32)).rejects.toThrow("循环");
  });
});
