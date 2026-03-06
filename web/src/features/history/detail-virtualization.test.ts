import { describe, expect, it } from "vitest";

import {
  resolveHistoryDetailSearchMode,
  shouldEnableHistoryDetailDomHighlights,
  shouldUseVirtualizedHistoryDetail,
} from "@/features/history/detail-virtualization";

describe("history detail search strategy", () => {
  it("大会话单字符搜索退化为按消息匹配", () => {
    expect(resolveHistoryDetailSearchMode({
      queryLength: 1,
      messageCount: 120,
      totalTextSize: 160_000,
    })).toBe("message");
  });

  it("双字符及以上保持精确搜索", () => {
    expect(resolveHistoryDetailSearchMode({
      queryLength: 2,
      messageCount: 120,
      totalTextSize: 160_000,
    })).toBe("precise");
  });

  it("仅精确搜索启用 DOM 高亮", () => {
    expect(shouldEnableHistoryDetailDomHighlights({
      searchActive: true,
      searchMode: "message",
    })).toBe(false);
    expect(shouldEnableHistoryDetailDomHighlights({
      searchActive: true,
      searchMode: "precise",
    })).toBe(true);
  });
});

describe("history detail virtualization", () => {
  it("DOM 高亮搜索态即使超过阈值也保持完整 DOM", () => {
    expect(shouldUseVirtualizedHistoryDetail({
      messageCount: 120,
      totalTextSize: 160_000,
      searchActive: true,
      domHighlightEnabled: true,
    })).toBe(false);
  });

  it("按消息匹配搜索态可继续启用虚拟列表", () => {
    expect(shouldUseVirtualizedHistoryDetail({
      messageCount: 120,
      totalTextSize: 160_000,
      searchActive: true,
      domHighlightEnabled: false,
    })).toBe(true);
  });

  it("非搜索态在消息数量超过阈值时启用虚拟列表", () => {
    expect(shouldUseVirtualizedHistoryDetail({
      messageCount: 120,
      totalTextSize: 20_000,
      searchActive: false,
    })).toBe(true);
  });

  it("非搜索态在文本体量超过阈值时启用虚拟列表", () => {
    expect(shouldUseVirtualizedHistoryDetail({
      messageCount: 12,
      totalTextSize: 160_000,
      searchActive: false,
    })).toBe(true);
  });

  it("未达到阈值时保持普通渲染", () => {
    expect(shouldUseVirtualizedHistoryDetail({
      messageCount: 12,
      totalTextSize: 20_000,
      searchActive: false,
    })).toBe(false);
  });
});

