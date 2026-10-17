import { describe, expect, it } from "vitest";

import { isHistoryDetailTypeVisibleByDefault, resolveHistoryDetailTypeFilter } from "@/features/history/detail-type-filter";

describe("history detail type filter", () => {
  it("压缩摘要默认关闭，普通助手输出保持可见", () => {
    expect(isHistoryDetailTypeVisibleByDefault("context_compaction")).toBe(false);
    expect(isHistoryDetailTypeVisibleByDefault("compaction_output")).toBe(false);
    expect(isHistoryDetailTypeVisibleByDefault("output_text")).toBe(true);
    expect(isHistoryDetailTypeVisibleByDefault("turn_diff")).toBe(true);
  });

  it("切换期间的空筛选状态使用当前会话默认值", () => {
    const fallback = { input_text: true, output_text: true, developer: false };

    expect(resolveHistoryDetailTypeFilter({}, fallback)).toBe(fallback);
  });

  it("保留用户明确设置的筛选状态，包括全部关闭", () => {
    const current = { input_text: false, output_text: false };

    expect(resolveHistoryDetailTypeFilter(current, { input_text: true })).toBe(current);
  });
});
