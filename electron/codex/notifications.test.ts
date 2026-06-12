import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./notifications";

describe("electron/codex/notifications（子代理 legacy notify 防重）", () => {
  afterEach(() => {
    __testing.resetCodexNotifyDedupeState();
    __testing.setCodexNotifyStateDecisionReader();
  });

  it("SubagentStop 后紧随的 legacy notify 应被视为重复回放并丢弃", () => {
    const preview = "已完成修复。\n\n验证已通过。";

    const first = __testing.buildCodexNotifyDispatch({
      v: 2,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview,
      hookEventName: "SubagentStop",
      completionKind: "subagent",
      agentType: "worker",
      agentId: "agent-1",
    }, 1_000);

    expect(first.dropReason).toBeUndefined();
    expect(first.payload.completionKind).toBe("subagent");

    const duplicate = __testing.buildCodexNotifyDispatch({
      v: 1,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview: "已完成修复。\\n\\n验证已通过。",
      previewEscapedWhitespace: true,
    }, 2_000);

    expect(duplicate.dropReason).toBe("duplicate-subagent-legacy");
  });

  it("SubagentStop 后紧随的明确 Stop 事件不应被 legacy 去重误吞", () => {
    const preview = "已完成修复。\n\n验证已通过。";

    const subagent = __testing.buildCodexNotifyDispatch({
      v: 2,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview,
      hookEventName: "SubagentStop",
      completionKind: "subagent",
    }, 1_000);

    expect(subagent.dropReason).toBeUndefined();

    const agentStop = __testing.buildCodexNotifyDispatch({
      v: 2,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview,
      hookEventName: "Stop",
      completionKind: "agent",
    }, 2_000);

    expect(agentStop.dropReason).toBeUndefined();
    expect(agentStop.payload.completionKind).toBe("agent");
  });

  it("明显的旧版子代理完成文案应归类为 subagent，交给前端子代理开关处理", () => {
    const result = __testing.buildCodexNotifyDispatch({
      v: 1,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview: "子代理 Arendt 已按上次口径完成排查和修复。",
      previewEscapedWhitespace: true,
    }, 1_000);

    expect(result.dropReason).toBeUndefined();
    expect(result.payload.completionKind).toBe("subagent");
  });

  it("普通 legacy notify 不应被误归类为 subagent", () => {
    const result = __testing.buildCodexNotifyDispatch({
      v: 1,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "PowerShell 7",
      preview: "已完成代码修复，测试通过。",
      previewEscapedWhitespace: true,
    }, 1_000);

    expect(result.dropReason).toBeUndefined();
    expect(result.payload.completionKind).toBeUndefined();
  });

  it("legacy notify 对应 goal 未完成时应丢弃完成通知", () => {
    __testing.setCodexNotifyStateDecisionReader((entry, sourcePath) => {
      expect(entry.threadId).toBe("thread-active");
      expect(entry.cwd).toBe("/work/project");
      expect(entry.sqliteHome).toBe("/tmp/codex-sqlite");
      expect(sourcePath).toBe("/home/test/.codex/codexflow_after_agent_notify.jsonl");
      return { dropReason: "unfinished-goal-active", goalStatus: "active" };
    });

    const result = __testing.buildCodexNotifyDispatch({
      v: 1,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "WSL",
      threadId: "thread-active",
      turnId: "turn-1",
      cwd: "/work/project",
      sqliteHome: "/tmp/codex-sqlite",
      preview: "看起来完成了，但 goal 仍 active。",
      previewEscapedWhitespace: true,
    }, 1_000, "/home/test/.codex/codexflow_after_agent_notify.jsonl");

    expect(result.dropReason).toBe("unfinished-goal-active");
    expect(result.payload.threadId).toBe("thread-active");
    expect(result.payload.turnId).toBe("turn-1");
  });

  it("legacy notify 命中子代理线程时应归类为 subagent", () => {
    __testing.setCodexNotifyStateDecisionReader(() => ({ completionKind: "subagent", agentId: "child-thread" }));

    const result = __testing.buildCodexNotifyDispatch({
      v: 1,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "WSL",
      threadId: "child-thread",
      preview: "子任务已结束。",
      previewEscapedWhitespace: true,
    }, 1_000, "/home/test/.codex/codexflow_after_agent_notify.jsonl");

    expect(result.dropReason).toBeUndefined();
    expect(result.payload.completionKind).toBe("subagent");
    expect(result.payload.agentId).toBe("child-thread");
  });

  it("明确 Stop hook 对应 goal 未完成时也应丢弃完成通知", () => {
    __testing.setCodexNotifyStateDecisionReader((entry) => {
      expect(entry.threadId).toBe("thread-active");
      return { dropReason: "unfinished-goal-active", goalStatus: "active" };
    });

    const result = __testing.buildCodexNotifyDispatch({
      v: 2,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "WSL",
      threadId: "thread-active",
      preview: "Stop hook 完成。",
      hookEventName: "Stop",
      completionKind: "agent",
    }, 1_000, "/home/test/.codex/codexflow_after_agent_notify.jsonl");

    expect(result.dropReason).toBe("unfinished-goal-active");
    expect(result.payload.completionKind).toBe("agent");
  });

  it("明确 Stop hook 没有 threadId 时保持旧行为", () => {
    __testing.setCodexNotifyStateDecisionReader(() => {
      throw new Error("没有 threadId 时不应读取 Codex 状态");
    });

    const result = __testing.buildCodexNotifyDispatch({
      v: 2,
      providerId: "codex",
      tabId: "tab-1",
      envLabel: "WSL",
      preview: "Stop hook 完成。",
      hookEventName: "Stop",
      completionKind: "agent",
    }, 1_000, "/home/test/.codex/codexflow_after_agent_notify.jsonl");

    expect(result.dropReason).toBeUndefined();
    expect(result.payload.completionKind).toBe("agent");
  });
});
