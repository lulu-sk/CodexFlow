import { describe, expect, it } from "vitest";

import { findVisibleStartIndex } from "@/features/history/virtualized-list";

describe("history virtualized list window calculation", () => {
  it("滚动窗口超过总高度时定位到最后一项而不是首项", () => {
    expect(findVisibleStartIndex([0, 100, 260], [100, 160, 120], 999)).toBe(2);
  });

  it("滚动窗口落在中间内容时定位到第一个进入窗口的项目", () => {
    expect(findVisibleStartIndex([0, 100, 260], [100, 160, 120], 180)).toBe(1);
  });
});
