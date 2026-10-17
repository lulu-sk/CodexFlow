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
  it("开启系统筛选后仍跳过自动内容，并保留真实输入和用户图片", () => {
    const keys = buildHistoryUserInputMessageKeys([
      historyView("context", textMessage("user", "图片尺寸说明", "system_context")),
      historyView("summary", textMessage("user", "压缩摘要", "context_summary")),
      historyView("command", textMessage("user", "本地命令", "local_command")),
      historyView("system", textMessage("system", "系统消息")),
      historyView("empty", { role: "user", content: [] }),
      historyView("real", textMessage("user", "真实输入")),
      historyView("image", { role: "user", content: [{ type: "image", text: "图片", src: "data:image/png;base64,aGVsbG8=" }] }),
      historyView("mixed", { role: "user", content: [{ type: "system_context", text: "系统前缀" }, { type: "input_text", text: "真实输入" }] }),
    ]);
    expect(keys).toEqual(["real", "image", "mixed"]);
  });

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
