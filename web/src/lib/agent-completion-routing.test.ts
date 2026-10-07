import { describe, expect, it } from "vitest";
import { resolveAgentCompletionTab } from "./agent-completion-routing";

/** 构造两个独立项目；通知环境变量可来自另一窗口。 */
function createContext() {
  return {
    tabsByProject: {
      work: [{ id: "work-tab", name: "PowerShell", providerId: "codex", historySessionId: "work-session" }],
      other: [{ id: "other-tab", name: "PowerShell", providerId: "codex", historySessionId: "other-session" }],
    },
    projects: [
      { id: "work", winPath: "", wslPath: "/workspace/work" },
      { id: "other", winPath: "", wslPath: "/workspace/other" },
    ],
    sessionIdByTab: {} as Record<string, string>,
    timersByTab: {
      "work-tab": { status: "working", startedAt: 10_000 },
      "other-tab": { status: "working", startedAt: 10_000 },
    } as Record<string, { status: string; startedAt: number }>,
  };
}

const EVENT = { tabId: "foreign-window-tab", providerId: "codex", threadId: "work-session", cwd: "/workspace/work", timestamp: "1970-01-01T00:00:20Z" };

describe("完成通知的会话与项目归属", () => {
  it("标签环境变量属于另一窗口时，用已绑定会话找到当前任务", () => {
    expect(resolveAgentCompletionTab(EVENT, createContext())).toBe("work-tab");
  });

  it("标签编号存在但属于另一项目时，不结束它或改写它的绑定", () => {
    expect(resolveAgentCompletionTab({ ...EVENT, tabId: "other-tab" }, createContext())).toBe("work-tab");
    const context = createContext();
    context.tabsByProject.work = [];
    expect(resolveAgentCompletionTab({ ...EVENT, tabId: "other-tab" }, context)).toBeNull();
  });

  it("此前被错绑的会话编号不能盖过项目冲突", () => {
    const context = createContext();
    context.sessionIdByTab["other-tab"] = "work-session";
    expect(resolveAgentCompletionTab({ ...EVENT, tabId: "other-tab" }, context)).toBe("work-tab");
  });

  it("首轮尚未绑定时，仅接受目标项目唯一工作中的未绑定标签", () => {
    const context = createContext();
    context.tabsByProject.work[0].historySessionId = "";
    expect(resolveAgentCompletionTab(EVENT, context)).toBe("work-tab");
    context.tabsByProject.work.push({ id: "second-tab", name: "PowerShell", providerId: "codex", historySessionId: "" });
    context.timersByTab["second-tab"] = { status: "working", startedAt: 10_000 };
    expect(resolveAgentCompletionTab(EVENT, context)).toBeNull();
  });

  it("同项目已绑定其它会话时，不靠唯一工作状态串会话", () => {
    expect(resolveAgentCompletionTab({ ...EVENT, threadId: "unrelated-session" }, createContext())).toBeNull();
    expect(resolveAgentCompletionTab({ ...EVENT, tabId: "work-tab", threadId: "unrelated-session" }, createContext())).toBeNull();
  });

  it("共享父项目下的子项目优先，不能结束父项目标签", () => {
    const context = createContext();
    context.projects[1].wslPath = "/workspace/work/child";
    expect(resolveAgentCompletionTab({ ...EVENT, cwd: "/workspace/work/child", threadId: "other-session" }, context)).toBe("other-tab");
    expect(resolveAgentCompletionTab({ ...EVENT, cwd: "/workspace/work/child" }, context)).toBeNull();
  });

  it("通知早于当前轮次、未标记应用来源或项目不匹配时拒绝", () => {
    for (const change of [{ timestamp: "1970-01-01T00:00:01Z" }, { tabId: "" }, { cwd: "/workspace/work-other" }])
      expect(resolveAgentCompletionTab({ ...EVENT, ...change }, createContext())).toBeNull();
  });

  it("子代理编号不覆盖主会话；项目正确时仍归到父标签通知入口", () => {
    expect(resolveAgentCompletionTab({ ...EVENT, tabId: "work-tab", threadId: "child-session", completionKind: "subagent" }, createContext())).toBe("work-tab");
  });

  it("缺少会话元数据的旧通知仍按有效标签解析", () => {
    expect(resolveAgentCompletionTab({ tabId: "work-tab" }, createContext())).toBe("work-tab");
    expect(resolveAgentCompletionTab({ tabId: "foreign-window-tab" }, createContext())).toBeNull();
  });

  it("其它引擎保留原有有效标签和唯一名称匹配", () => {
    const context = createContext();
    context.tabsByProject.work[0].providerId = "claude";
    expect(resolveAgentCompletionTab({ providerId: "claude", envLabel: "PowerShell" }, context)).toBe("work-tab");
    expect(resolveAgentCompletionTab({ tabId: "work-tab", providerId: "claude" }, context)).toBe("work-tab");
    expect(resolveAgentCompletionTab({ tabId: "other-tab", providerId: "claude" }, context)).toBeNull();
  });
});
