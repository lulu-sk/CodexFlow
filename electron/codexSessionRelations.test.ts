// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCodexRelationDeletePlan,
  extractCodexSessionRelationship,
  selectCodexRelationDeleteItems,
  verifyCodexRelationPlanFiles,
  type CodexSessionRecord,
} from "./codexSessionRelations";

/**
 * 构造用于关系树测试的稳定会话记录。
 */
function createRecord(
  id: string,
  filePath: string,
  relationship: CodexSessionRecord["relationship"],
  mtimeMs: number,
): CodexSessionRecord {
  return { id, filePath, relationship, mtimeMs, size: 128 + mtimeMs };
}

describe("electron/codexSessionRelations", () => {
  it("能从现代 thread_spawn 元数据提取父会话、昵称、角色和深度", () => {
    const relationship = extractCodexSessionRelationship({
      timestamp: "2026-01-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        parent_thread_id: "PARENT-SESSION",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "PARENT-SESSION",
              depth: 2,
              agent_nickname: "Atlas",
              agent_role: "researcher",
            },
          },
        },
      },
    });

    expect(relationship).toMatchObject({
      kind: "subagent",
      threadSpawn: true,
      parentThreadId: "parent-session",
      agentNickname: "Atlas",
      agentRole: "researcher",
      agentDepth: 2,
    });
  });

  it("字符串形式且没有 thread_spawn 的内部子代理仍会识别为子代理", () => {
    const relationship = extractCodexSessionRelationship({
      type: "session_meta",
      payload: {
        id: "review-session",
        source: { subagent: "review" },
      },
    });

    expect(relationship.kind).toBe("subagent");
    expect(relationship.threadSpawn).toBe(false);
    expect(relationship.parentThreadId).toBeUndefined();
  });

  it("Codex 内部来源会按非根代理语义识别为子代理", () => {
    const relationship = extractCodexSessionRelationship({
      type: "session_meta",
      payload: {
        id: "memory-session",
        source: { internal: "memory_consolidation" },
      },
    });

    expect(relationship.kind).toBe("subagent");
    expect(relationship.threadSpawn).toBe(false);
  });

  it("从子代理发起时也会生成根会话及全部子孙的关联树", () => {
    const records: CodexSessionRecord[] = [
      createRecord("root", "/fixture/sessions/root.jsonl", { kind: "main" }, 1),
      createRecord("child-a", "/fixture/sessions/child-a.jsonl", { kind: "subagent", parentThreadId: "root", threadSpawn: true }, 2),
      createRecord("child-b", "/fixture/sessions/child-b.jsonl", { kind: "subagent", parentThreadId: "root", threadSpawn: true }, 3),
      createRecord("grandchild", "/fixture/sessions/grandchild.jsonl", { kind: "subagent", parentThreadId: "child-a", threadSpawn: true }, 4),
    ];
    const titles = new Map([
      ["root", "主会话"],
      ["child-a", "调研子会话"],
      ["child-b", "验证子会话"],
      ["grandchild", "下级子会话"],
    ]);

    const plan = buildCodexRelationDeletePlan("/fixture/sessions/child-a.jsonl", records, titles);

    expect(plan.supported).toBe(true);
    expect(plan.rootId).toBe("root");
    expect(plan.targetId).toBe("child-a");
    expect(plan.items.map((item) => [item.id, item.depth])).toEqual([
      ["root", 0],
      ["child-a", 1],
      ["child-b", 1],
      ["grandchild", 2],
    ]);
    expect(plan.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("能识别树外 forked_from_id 与 history_base 引用", () => {
    const records: CodexSessionRecord[] = [
      createRecord("root", "/fixture/sessions/root.jsonl", { kind: "main" }, 1),
      createRecord("child", "/fixture/sessions/child.jsonl", { kind: "subagent", parentThreadId: "root", threadSpawn: true }, 2),
      createRecord("fork", "/fixture/sessions/fork.jsonl", { kind: "main", forkedFromId: "child" }, 3),
      createRecord("history-base", "/fixture/sessions/history-base.jsonl", { kind: "main", historyBaseThreadId: "root" }, 4),
    ];

    const planWithoutExternalReferences = buildCodexRelationDeletePlan(
      "/fixture/sessions/root.jsonl",
      records.slice(0, 2),
      new Map(),
    );
    const plan = buildCodexRelationDeletePlan("/fixture/sessions/root.jsonl", records, new Map());

    expect(plan.externalReferenceIds).toEqual(["fork", "history-base"]);
    expect(plan.version).not.toBe(planWithoutExternalReferences.version);
  });

  it("选择仅删除当前会话时不会包含父、同级或下级会话", () => {
    const records: CodexSessionRecord[] = [
      createRecord("root", "/fixture/sessions/root.jsonl", { kind: "main" }, 1),
      createRecord("child", "/fixture/sessions/child.jsonl", { kind: "subagent", parentThreadId: "root", threadSpawn: true }, 2),
    ];
    const plan = buildCodexRelationDeletePlan("/fixture/sessions/child.jsonl", records, new Map());

    expect(selectCodexRelationDeleteItems(plan, "current").map((item) => item.id)).toEqual(["child"]);
    expect(selectCodexRelationDeleteItems(plan, "tree").map((item) => item.id)).toEqual(["root", "child"]);
  });

  it("仅复核计划内文件签名，变化或缺失时返回失效", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-relation-"));
    const filePath = path.join(tempRoot, "session.jsonl");
    try {
      await fsp.writeFile(filePath, "session", "utf8");
      const stat = await fsp.stat(filePath);
      const plan = {
        supported: true,
        version: "fixture-version",
        items: [{
          id: "session",
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          relationship: { kind: "main" as const },
          title: "session",
          depth: 0,
        }],
        externalReferenceIds: [],
      };

      await expect(verifyCodexRelationPlanFiles(plan)).resolves.toEqual({ ok: true });
      const treePlan = {
        ...plan,
        items: [
          ...plan.items,
          {
            ...plan.items[0],
            id: "child",
            filePath: path.join(tempRoot, "missing-child.jsonl"),
          },
        ],
      };
      await expect(verifyCodexRelationPlanFiles(treePlan, [treePlan.items[0]])).resolves.toEqual({ ok: true });
      await expect(verifyCodexRelationPlanFiles(treePlan)).resolves.toEqual({ ok: false, reason: "changed" });
      await fsp.appendFile(filePath, "-changed", "utf8");
      await expect(verifyCodexRelationPlanFiles(plan)).resolves.toEqual({ ok: false, reason: "changed" });
      await fsp.rm(filePath, { force: true });
      await expect(verifyCodexRelationPlanFiles(plan)).resolves.toEqual({ ok: false, reason: "changed" });
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
