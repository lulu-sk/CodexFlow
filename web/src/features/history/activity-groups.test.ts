import { describe, expect, it } from "vitest";
import type { HistoryMessage } from "@/types/host";
import { buildHistoryActivityGroups, formatHistoryActivityDuration, resolveHistoryActivityVisibility } from "./activity-groups";

/** 创建不包含本地信息的协议消息，覆盖旧记录与带阶段信息的新记录。 */
function message(role: string, type: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
  return { role, content: [{ type, text: "示例正文" }], ...extra };
}

describe("历史执行过程折叠", () => {
  it("按轮次折叠过程，最终答复、文件变更和压缩摘要保留独立入口", () => {
    const messages = [
      message("user", "input_text", { turnId: "turn-a", timestamp: "2026-01-01T00:00:00Z" }),
      message("assistant", "output_text", { turnId: "turn-a", phase: "commentary" }),
      message("assistant", "function_call", { turnId: "turn-a" }),
      message("tool", "function_output", { turnId: "turn-a" }),
      message("assistant", "context_compaction", { turnId: "turn-a", phase: "final_answer" }),
      message("assistant", "output_text", { turnId: "turn-a", phase: "final_answer", timestamp: "2026-01-01T00:00:51Z" }),
      message("assistant", "turn_diff", { turnId: "turn-a" }),
      message("user", "input_text", { turnId: "turn-b" }),
      message("assistant", "output_text", { turnId: "turn-b", phase: "commentary" }),
    ];
    const groups = buildHistoryActivityGroups(messages);
    expect(groups).toEqual([{ id: "turn-a:5", anchorIndex: 5, messageIndices: [1, 2, 3], durationMs: 51000 }]);
    const views = messages.map((_, originalIndex) => ({ originalIndex }));
    const collapsed = resolveHistoryActivityVisibility(views, groups, new Set(), false);
    expect(collapsed.messages.map((view) => view.originalIndex)).toEqual([0, 4, 5, 6, 7, 8]);
    expect(collapsed.disclosures.get(5)?.expanded).toBe(false);
    const expanded = resolveHistoryActivityVisibility(views, groups, new Set([groups[0].id]), false);
    expect(expanded.messages).toEqual(views);
    expect([...expanded.disclosures.keys()]).toEqual([1]);
    // 首条过程被筛掉后，入口仍放在实际可见的过程之前。
    const filtered = resolveHistoryActivityVisibility(views.filter((view) => view.originalIndex !== 1), groups, new Set([groups[0].id]), false);
    expect([...filtered.disclosures.keys()]).toEqual([2]);
  });

  it("搜索自动展开命中，结束搜索恢复原来的折叠状态", () => {
    const groups = buildHistoryActivityGroups([
      message("user", "input_text"), message("assistant", "output_text", { phase: "commentary" }),
      message("assistant", "output_text", { phase: "final" }),
    ]);
    const views = [{ originalIndex: 1 }, { originalIndex: 2 }];
    expect(resolveHistoryActivityVisibility(views, groups, new Set(), true).messages).toEqual(views);
    expect(resolveHistoryActivityVisibility(views, groups, new Set(), false).messages).toEqual([{ originalIndex: 2 }]);
    // 最终答复不命中时也不能丢掉执行过程中的搜索结果。
    expect(resolveHistoryActivityVisibility([{ originalIndex: 1 }], groups, new Set(), true).messages).toEqual([{ originalIndex: 1 }]);
  });

  it("不折叠正在运行的 commentary，且不跨用户输入合并旧记录", () => {
    const messages = [
      message("user", "input_text"), message("assistant", "output_text"),
      message("user", "input_text"), message("assistant", "output_text", { phase: "commentary" }),
      message("assistant", "function_call"),
    ];
    expect(buildHistoryActivityGroups(messages)).toEqual([]);
  });

  it("旧版多条助手正文可折叠，子代理通知不切断执行过程", () => {
    const groups = buildHistoryActivityGroups([
      message("user", "input_text"), message("assistant", "output_text"),
      message("user", "subagent_notification"), message("assistant", "output_text"),
    ]);
    expect(groups[0]?.messageIndices).toEqual([1]);
    expect(groups[0]?.durationMs).toBeUndefined();
  });

  it("筛选没有可见过程时不显示空按钮，不隐藏与变更混合的消息", () => {
    const messages = [
      message("assistant", "function_call"),
      message("assistant", "output_text", { content: [{ type: "turn_diff", text: "diff" }, { type: "output_text", text: "过程" }], phase: "commentary" }),
      message("assistant", "output_text", { phase: "final", durationMs: 1000 }),
    ];
    const groups = buildHistoryActivityGroups(messages);
    expect(groups[0]?.messageIndices).toEqual([0]);
    expect(groups[0]?.durationMs).toBe(1000);
    expect(resolveHistoryActivityVisibility([{ originalIndex: 2 }], groups, new Set(), false).disclosures.size).toBe(0);
  });

  it("时间倒序时不伪造耗时，并正确显示超过一小时的时间", () => {
    const groups = buildHistoryActivityGroups([
      message("assistant", "function_call", { timestamp: "2026-01-01T01:00:00Z" }),
      message("assistant", "output_text", { timestamp: "2026-01-01T00:00:00Z" }),
    ]);
    expect(groups[0]?.durationMs).toBeUndefined();
    expect(formatHistoryActivityDuration(51000)).toBe("0:51");
    expect(formatHistoryActivityDuration(3661000)).toBe("1:01:01");
  });

  it("启用推理筛选后，reasoning 消息仍归入当前轮次的执行过程", () => {
    const groups = buildHistoryActivityGroups([
      message("user", "input_text"),
      message("reasoning", "summary"),
      message("assistant", "output_text", { phase: "final_answer" }),
    ]);
    expect(groups[0]?.messageIndices).toEqual([1]);
  });
});
