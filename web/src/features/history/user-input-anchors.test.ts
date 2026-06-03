import { describe, expect, it } from "vitest";

import { buildHistoryUserInputMessageKeys } from "@/features/history/user-input-anchors";
import type { HistoryMessage } from "@/types/host";

/**
 * 构造历史消息测试项。
 */
function historyView(messageKey: string, message: HistoryMessage) {
  return { messageKey, message };
}

/**
 * 构造文本消息。
 */
function textMessage(role: string, text: string, type = "input_text"): HistoryMessage {
  return { role, content: [{ type, text }] };
}

describe("history user input anchors", () => {
  it("首个 goal context 计入 USER Input，后续重复 goal context 不计入", () => {
    const keys = buildHistoryUserInputMessageKeys([
      historyView("goal-1", textMessage("user", "<codex_internal_context source=\"goal\">\n<objective>目标</objective>\n</codex_internal_context>")),
      historyView("turn-aborted", textMessage("user", "<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>")),
      historyView("real-user", textMessage("user", "继续处理真实用户输入")),
      historyView("goal-2", textMessage("user", "<codex_internal_context source = \"goal\">\n<objective>目标</objective>\n</codex_internal_context>")),
      historyView("subagent", { role: "user", content: [{ type: "subagent_notification", text: "completed" }] }),
      historyView("assistant", textMessage("assistant", "助手回复", "output_text")),
    ]);

    expect(keys).toEqual(["goal-1", "real-user"]);
  });
});
