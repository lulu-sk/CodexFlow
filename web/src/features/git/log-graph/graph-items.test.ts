import { describe, expect, it } from "vitest";
import type { GitLogItem } from "../types";
import { mergePagedGitLogGraphItems } from "./graph-items";

/**
 * 构造最小日志项，避免测试重复填写无关字段。
 */
function createLogItem(hash: string): GitLogItem {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: [],
    authorName: "CodexFlow",
    authorEmail: "codexflow@example.com",
    authorDate: "2026-04-01T00:00:00.000Z",
    subject: hash,
    decorations: "",
  };
}

describe("graph-items pagination merge", () => {
  it("分页 graphItems 重叠时应按首次出现顺序去重", () => {
    const previousItems = [
      createLogItem("a0"),
      createLogItem("a1"),
      createLogItem("a2"),
      createLogItem("a3"),
    ];
    const nextItems = [
      createLogItem("a2"),
      createLogItem("a3"),
      createLogItem("a4"),
      createLogItem("a5"),
    ];

    expect(mergePagedGitLogGraphItems(previousItems, nextItems).map((item) => item.hash)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("真实分页边界场景下不应把 200..799 这一段上下文重复追加两次", () => {
    const previousItems = Array.from({ length: 800 }, (_, index) => createLogItem(`commit-${index}`));
    const nextItems = Array.from({ length: 800 }, (_, index) => createLogItem(`commit-${index + 200}`));

    const merged = mergePagedGitLogGraphItems(previousItems, nextItems);

    expect(merged).toHaveLength(1000);
    expect(merged[199]?.hash).toBe("commit-199");
    expect(merged[200]?.hash).toBe("commit-200");
    expect(merged[799]?.hash).toBe("commit-799");
    expect(merged[800]?.hash).toBe("commit-800");
    expect(merged[999]?.hash).toBe("commit-999");
  });
});
