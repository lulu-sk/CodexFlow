import { describe, expect, it } from "vitest";

import { resolveHistoryDetailTypeFilter } from "@/features/history/detail-type-filter";

describe("history detail type filter", () => {
  it("切换期间的空筛选状态使用当前会话默认值", () => {
    const fallback = { input_text: true, output_text: true, developer: false };

    expect(resolveHistoryDetailTypeFilter({}, fallback)).toBe(fallback);
  });

  it("保留用户明确设置的筛选状态，包括全部关闭", () => {
    const current = { input_text: false, output_text: false };

    expect(resolveHistoryDetailTypeFilter(current, { input_text: true })).toBe(current);
  });
});
