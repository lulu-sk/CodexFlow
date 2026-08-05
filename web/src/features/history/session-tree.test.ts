// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { buildHistorySessionTree, flattenHistorySessionDescendants, historySessionTreeSome } from "./session-tree";

type FixtureSession = {
  providerId: string;
  id: string;
  title: string;
  codexRelationship?: { kind: "main" | "subagent" | "unknown"; parentThreadId?: string };
};

/**
 * 构造用于历史树测试的简化会话。
 */
function session(id: string, title: string, parentThreadId?: string): FixtureSession {
  return {
    providerId: "codex",
    id,
    title,
    codexRelationship: parentThreadId
      ? { kind: "subagent", parentThreadId }
      : { kind: "main" },
  };
}

describe("history session tree", () => {
  it("会把子代理和下级子代理折叠到主会话下", () => {
    const tree = buildHistorySessionTree([
      session("root", "主会话"),
      session("child-a", "子会话 A", "root"),
      session("child-b", "子会话 B", "root"),
      session("grandchild", "下级会话", "child-a"),
    ]);

    expect(tree.roots.map((item) => item.session.id)).toEqual(["root"]);
    expect(tree.roots[0].descendantCount).toBe(3);
    expect(flattenHistorySessionDescendants(tree.roots[0]).map(({ node, depth }) => [node.session.id, depth])).toEqual([
      ["child-a", 1],
      ["grandchild", 2],
      ["child-b", 1],
    ]);
  });

  it("父会话尚未加载时会保留子代理为独立会话", () => {
    const tree = buildHistorySessionTree([session("child", "孤立显示", "missing-parent")]);

    expect(tree.roots.map((item) => item.session.id)).toEqual(["child"]);
  });

  it("搜索条件可以命中折叠层级内的子代理", () => {
    const tree = buildHistorySessionTree([session("root", "主会话"), session("child", "调研结果", "root")]);

    expect(historySessionTreeSome(tree.roots[0], (item) => item.title.includes("调研"))).toBe(true);
  });

  it("循环父子关系不会造成递归死循环", () => {
    const tree = buildHistorySessionTree([session("a", "A", "b"), session("b", "B", "a")]);

    expect(tree.roots).toHaveLength(2);
  });
});
