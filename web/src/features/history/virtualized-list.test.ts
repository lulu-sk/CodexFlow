import { describe, expect, it } from "vitest";

import { buildVirtualizedLayout, findVisibleStartIndex } from "@/features/history/virtualized-list";

describe("history virtualized list window calculation", () => {
  it("滚动窗口超过总高度时定位到最后一项而不是首项", () => {
    expect(findVisibleStartIndex([0, 100, 260], [100, 160, 120], 999)).toBe(2);
  });

  it("滚动窗口落在中间内容时定位到第一个进入窗口的项目", () => {
    expect(findVisibleStartIndex([0, 100, 260], [100, 160, 120], 180)).toBe(1);
  });

  it("未测量项目使用逐项估算高度构建位移表", () => {
    const layout = buildVirtualizedLayout(
      [{ id: "a", height: 80 }, { id: "b", height: 180 }, { id: "c", height: 60 }],
      (item) => item.id,
      {},
      240,
      (item) => item.height,
    );

    expect(layout).toEqual({
      tops: [0, 80, 260],
      heights: [80, 180, 60],
      totalHeight: 320,
    });
  });

  it("真实测量高度优先覆盖逐项估算高度", () => {
    const layout = buildVirtualizedLayout(
      [{ id: "a", height: 80 }, { id: "b", height: 180 }],
      (item) => item.id,
      { b: 220 },
      240,
      (item) => item.height,
    );

    expect(layout).toEqual({
      tops: [0, 80],
      heights: [80, 220],
      totalHeight: 300,
    });
  });
});
