// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as classifier from "./codex-cli-error-classifier";
import * as replay from "./codex-error-replay-guard";
import * as settings from "./codex-error-handling-settings";
import * as completion from "./codex-turn-completion";
import { inspectClaudeProgramStatus, inspectClaudeTurnState } from "./claude-turn-state";
import type { TerminalProgramStatus } from "./terminal-program-status";
import { resolveAgentCompletionTab } from "./agent-completion-routing";
import { isCodexHistoryBrowsingScreen } from "./codex-tui-screen";
import { shouldDedupeRepeatedExternalCompletion, shouldDedupeCrossSourceCompletion } from "../app/app-shared";

const ERROR = "unexpected status 502 Bad Gateway: upstream unavailable";
const FINAL_SCREEN = `› continue\n■ ${ERROR}\n\n› Ask Codex to do anything`;
const RUNTIME_NAMES = new Set([
  "createCodexErrorScanState", "appendCodexTurnOutput", "clearCodexPendingFinalErrorState", "buildCodexCliErrorKey",
  "CODEX_ERROR_SCAN_MAX_BUFFER_LENGTH", "CODEX_TURN_OUTPUT_MAX_LENGTH", "CODEX_FINAL_ERROR_SCREEN_CONFIRM_RETRY_MS",
  "CODEX_FINAL_ERROR_SCREEN_CONFIRM_MAX_CHECKS", "CODEX_FINAL_ERROR_SCREEN_CONFIRM_STABLE_CHECKS",
  "CODEX_RECONNECT_AFTER_ERROR_GRACE_MS",
  "clearCodexErrorAutoContinueTimer", "resetCodexErrorScanForTab", "startAgentTurnTimer", "markAgentTurnReconnecting",
  "clearAgentTurnReconnecting", "resumeAgentTurnTimer", "restoreFailedAgentTurnToReconnecting", "restoreFailedAgentTurnToWorking",
  "interruptAgentTurnTimer", "failAgentTurnTimer", "acknowledgeAgentTurnFailure",
  "rememberHandledCodexError", "resolveCodexReplayDecision", "settleCodexIdleWithoutFinalError",
  "shouldTrustCodexIdleScreenForCurrentTurn", "scheduleCodexPendingFinalIdleScreenCheck", "shouldTrustCodexRuntimeStatus",
  "scheduleCodexRuntimeScreenCheck",
  "handleCodexCliErrorDetected", "handleCodexCliReconnectDetected", "confirmCodexPendingFinalErrorFromIdleScreen",
  "flushCodexPendingFinalError", "processCodexPtyErrorFrame", "processCodexPtyErrorChunk",
  "sendCodexAutoContinue", "sendCodexManualContinue", "scheduleCodexAutoContinue",
  "checkCodexTurnCompletions", "completeAgentTurnTimer", "handleAgentCompletion", "isDuplicateCompletion", "recordCompletionSnapshot",
  "resolveExternalTabId", "handleExternalAgentCompletion",
  "checkClaudeTurnState", "processClaudePtyActivity", "cancelAgentTurnTimer",
]);

/** 从实际应用抽取报错闭包，替换宿主边界，不在测试中重写状态机。 */
function readRuntimeSource(): string {
  const text = readFileSync(resolve("web/src/App.tsx"), "utf8");
  const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations: string[] = [];
  const found = new Set<string>();
  /** 仅提取指定声明；函数体由应用原文编译执行。 */
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && RUNTIME_NAMES.has(node.name.text)) {
      found.add(node.name.text);
      declarations.push(node.getText(source));
      return;
    }
    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name) && RUNTIME_NAMES.has(declaration.name.text)) {
        found.add(declaration.name.text);
        declarations.push(node.getText(source));
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...RUNTIME_NAMES].filter((name) => !found.has(name))).toEqual([]);
  return ts.transpileModule(`${declarations.join("\n")}\nreturn { ${[...found].join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const runtimeSource = readRuntimeSource();

describe("Claude 完成与 goal 续跑实际调用链", () => {
  const idle = "任务完成。\n────────────────\n❯ \n────────────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
  const busy = `${idle} · esc to interrupt`;

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("官方完成状态不依赖 Stop、结束耗时行或输入框；迟到通知不重复完成", async () => {
    const ctx = createRuntime("claude");
    ctx.setScreen("");
    ctx.setProgramStatus("done", "最终回复");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    ctx.runtime.checkClaudeTurnState();
    ctx.runtime.handleAgentCompletion("tab", "最终回复", "external");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.chime).toHaveBeenCalledTimes(1);
    expect(ctx.autoCommit).toHaveBeenCalledTimes(1);
  });

  it.each(["working", "blocked", "idle", "error"] as const)("官方 %s 状态阻止旧 Stop 和空闲画面提前报完成", async (state) => {
    const ctx = createRuntime("claude");
    ctx.setScreen(idle);
    ctx.runtime.handleAgentCompletion("tab", "停止检查", "external");
    ctx.setProgramStatus(state);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("done 后恢复执行会重启计时，旧 done 不能结束新发送的一轮", async () => {
    const ctx = createRuntime("claude");
    ctx.setProgramStatus("done");
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.runtime.startAgentTurnTimer("tab");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setProgramStatus("done");
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    await vi.advanceTimersByTimeAsync(1000);
    ctx.setProgramStatus("working");
    ctx.runtime.processClaudePtyActivity("pty", "新状态");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setProgramStatus("done");
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(3);
  });

  it("完成状态遇到未解析输出及窗口回放会等待，后续 working 会撤销完成", async () => {
    const ctx = createRuntime("claude");
    ctx.setProgramStatus("done");
    ctx.setPendingOutput(true);
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setPendingOutput(false);
    ctx.setResizing(true);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setResizing(false);
    ctx.setProgramStatus("working");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("Stop 后继续执行不提前结束、响铃或自动提交；最终空闲后只完成一次", async () => {
    const ctx = createRuntime("claude");
    const startedAt = ctx.timers.current.tab.startedAt;
    ctx.setScreen(busy);
    ctx.runtime.handleExternalAgentCompletion({ providerId: "claude", tabId: "tab", threadId: "work-session", preview: "继续检查" });
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab).toMatchObject({ status: "working", startedAt });
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(ctx.chime).not.toHaveBeenCalled();
    expect(ctx.autoCommit).not.toHaveBeenCalled();

    ctx.runtime.handleExternalAgentCompletion({ providerId: "claude", tabId: "tab", preview: "最终完成" });
    ctx.setScreen(idle);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab).toMatchObject({ status: "done", startedAt, elapsedMs: 14_000 });
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify).toHaveBeenCalledWith("tab", "最终完成");
    expect(ctx.chime).toHaveBeenCalledTimes(1);
    expect(ctx.autoCommit).toHaveBeenCalledTimes(1);
  });

  it("goal 在已完成后自动续跑，无需发送消息即可开启新计时，并能再次结束", async () => {
    const ctx = createRuntime("claude");
    ctx.setScreen(idle);
    ctx.runtime.handleAgentCompletion("tab", "第一轮", "external");
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    const finishedAt = ctx.timers.current.tab.finishedAt;
    expect(ctx.timers.current.tab.status).toBe("done");

    await vi.advanceTimersByTimeAsync(20_000);
    ctx.setScreen(`Goal not yet met… continuing\n${busy}`);
    ctx.runtime.processClaudePtyActivity("pty", "Goal not yet met… continuing");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab).toMatchObject({ status: "working", startedAt: finishedAt + 20_000 });
    expect(ctx.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    ctx.runtime.handleAgentCompletion("tab", "第二轮", "external");
    ctx.setScreen(idle);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab).toMatchObject({ status: "done", elapsedMs: 8000 });
    expect(ctx.histories.current.tab).toHaveLength(2);
    expect(ctx.histories.current.tab.reduce((total: number, turn: { elapsedMs: number }) => total + turn.elapsedMs, 0)).toBe(12_000);
    expect(ctx.notify).toHaveBeenCalledTimes(2);
  });

  it("新输入清理上一轮停止候选，迟到的旧 Stop 不得结束新轮次", async () => {
    const ctx = createRuntime("claude");
    ctx.runtime.handleAgentCompletion("tab", "旧回复", "external");
    ctx.timers.current.tab.status = "done";
    const oldTimestamp = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(10_000);
    ctx.runtime.startAgentTurnTimer("tab");
    expect(ctx.claudeCandidates.current.tab).toBeUndefined();
    ctx.runtime.handleExternalAgentCompletion({ providerId: "claude", tabId: "tab", preview: "旧回复", timestamp: oldTimestamp });
    ctx.setScreen(idle);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("新轮 Stop 先于终端空闲画面到达，自动启动后仍能确认完成", async () => {
    const ctx = createRuntime("claude");
    ctx.timers.current.tab.status = "done";
    ctx.setScreen(busy);
    ctx.runtime.processClaudePtyActivity("pty", "继续执行");
    ctx.runtime.handleAgentCompletion("tab", "新轮最终回复", "external");
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setScreen(idle);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledWith("tab", "新轮最终回复");
  });

  it("双通道的迟到完成事件经屏幕确认后仍去重，不重复响铃或提交", async () => {
    const ctx = createRuntime("claude");
    ctx.setScreen(idle);
    ctx.runtime.handleAgentCompletion("tab", "已完成", "external");
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    ctx.runtime.handleAgentCompletion("tab", "已完成", "osc");
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.chime).toHaveBeenCalledTimes(1);
    expect(ctx.autoCommit).toHaveBeenCalledTimes(1);
  });

  it("手动中断或取消后清理旧候选，旧画面不触发通知或重启", async () => {
    for (const action of ["interruptAgentTurnTimer", "cancelAgentTurnTimer"]) {
      const ctx = createRuntime("claude");
      ctx.runtime.handleAgentCompletion("tab", "旧候选", "external");
      ctx.runtime[action]("tab", "manual");
      ctx.setScreen(idle);
      ctx.runtime.checkClaudeTurnState();
      await vi.advanceTimersByTimeAsync(3000);
      ctx.runtime.checkClaudeTurnState();
      ctx.setScreen(busy);
      ctx.runtime.processClaudePtyActivity("pty", "旧画面重绘");
      ctx.runtime.checkClaudeTurnState();
      expect(ctx.timers.current.tab?.status).not.toBe("working");
      expect(ctx.notify).not.toHaveBeenCalled();
    }
  });

  it("输出待解析及窗口回放不确认完成；没有新输出的旧运行画面也不重启计时", async () => {
    const ctx = createRuntime("claude");
    ctx.setScreen(idle);
    ctx.runtime.handleAgentCompletion("tab", "已完成", "osc");
    ctx.setPendingOutput(true);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(5000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setPendingOutput(false);
    ctx.setResizing(true);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.setResizing(false);
    ctx.runtime.checkClaudeTurnState();
    await vi.advanceTimersByTimeAsync(3000);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
    ctx.setScreen(busy);
    ctx.runtime.checkClaudeTurnState();
    expect(ctx.timers.current.tab.status).toBe("done");
  });
});

/** 为真实应用闭包提供终端、通知、设置及 React 状态边界。 */
function createRuntime(providerId = "codex") {
  let screen = FINAL_SCREEN;
  let programStatus: TerminalProgramStatus | null = null;
  let pendingOutput = false;
  let resizing = false;
  const timers = { current: { tab: { status: "working", startedAt: Date.now() - 1000, elapsedMs: 0 } } as Record<string, any> };
  const histories = { current: {} as Record<string, any[]> };
  const scans = { current: {} as Record<string, any> };
  const handled = { current: {} as Record<string, any[]> };
  const prefs = { current: { ...settings.DEFAULT_CODEX_ERROR_HANDLING_PREFS, autoContinueDelaySeconds: 5 } };
  const notify = vi.fn();
  const send = vi.fn(async () => true);
  const probes = { current: {} as Record<string, any> };
  const snapshots = { current: {} as Record<string, any> };
  const chime = vi.fn();
  const autoCommit = vi.fn();
  const claudeProbes = { current: {} as Record<string, any> };
  const claudeCandidates = { current: {} as Record<string, any> };
  const claudeFreshOutput = { current: {} as Record<string, boolean> };
  const tabs = { current: {
    project: [{ id: "tab", providerId, name: "PowerShell", historySessionId: "work-session" }],
    other: [{ id: "other-tab", providerId: "codex", name: "PowerShell", historySessionId: "other-session" }],
  } };
  const sessions = { current: {} as Record<string, string> };
  const bindSession = vi.fn((tabId: string, sessionId: string) => { sessions.current[tabId] = sessionId; return true; });
  let nextTimerId = 0;
  const timerHandles = new Map<number, ReturnType<typeof setTimeout>>();
  const browserTimers = {
    /** 浏览器计时器返回数字，避免 Node 假时钟的对象句柄改变生产分支。 */
    setTimeout(callback: () => void, delay: number): number {
      const id = ++nextTimerId;
      timerHandles.set(id, setTimeout(() => { timerHandles.delete(id); callback(); }, delay));
      return id;
    },
    /** 将浏览器数字句柄映射回假时钟句柄，保持取消语义一致。 */
    clearTimeout(id: number): void {
      clearTimeout(timerHandles.get(id));
      timerHandles.delete(id);
    },
  };
  const bindings = {
    ...classifier, ...replay, ...settings, ...completion, isCodexHistoryBrowsingScreen, resolveAgentCompletionTab, inspectClaudeTurnState, inspectClaudeProgramStatus,
    claudeTurnProbeByTabRef: claudeProbes, claudeCompletionCandidateByTabRef: claudeCandidates,
    claudeFreshOutputByTabRef: claudeFreshOutput,
    window: browserTimers, useCallback: (fn: unknown) => fn, MAX_AGENT_TURN_HISTORY: 30,
    codexErrorScanByTabRef: scans, codexHandledErrorKeysByPtyRef: handled,
    codexErrorHandlingPrefsRef: prefs, agentTurnTimerByTabRef: timers,
    agentTurnHistoryByTabRef: histories, codexTurnCompletionProbeByTabRef: probes,
    completionSnapshotRef: snapshots, hasWorkingAgentTimer: true,
    tabsByProjectRef: tabs, agentSessionIdByTabRef: sessions,
    projectsRef: { current: [
      { id: "project", winPath: "", wslPath: "/workspace/work" },
      { id: "other", winPath: "", wslPath: "/workspace/other" },
    ] },
    bindHistorySessionIdToTab: bindSession, handleSubagentCompletion: vi.fn(),
    COMPLETION_DEDUPE_WINDOW_MS: 1600, COMPLETION_CROSS_SOURCE_WINDOW_MS: 5000,
    normalizeCompletionPreview: (value: string) => value.trim(),
    isEquivalentCompletionPreview: (a: string, b: string) => a === b,
    shouldDedupeRepeatedExternalCompletion, shouldDedupeCrossSourceCompletion,
    clearPendingOscCompletion: vi.fn(), consumeResumeCompletionGuardIfNeeded: () => false,
    shouldEnableAgentTimerForProvider: () => true, notificationPrefsRef: { current: { sound: true } },
    playCompletionChime: chime, enqueueAutoCommit: autoCommit, tabProjectRef: { current: { tab: "project" } },
    emitCodexRateRefresh: vi.fn(), emitClaudeUsageRefresh: vi.fn(), emitGeminiUsageRefresh: vi.fn(),
    emitAntigravityUsageRefresh: vi.fn(), emitGrokUsageRefresh: vi.fn(),
    historyActiveTurnStartedAtByTabRef: { current: {} }, historyMatchByTabRef: { current: {} },
    ptyByTabRef: { current: { tab: "pty" } }, ptyToTabRef: { current: { pty: "tab" } },
    activeTabIdRef: { current: "tab" }, pendingCompletionsRef: { current: {} },
    resolveTabProviderId: () => providerId, resolveCodexErrorKindLabel: classifier.getCodexCliErrorKindLabel,
    getTabExecEnv: () => ({ terminal: "powershell", distro: "" }),
    resolveAgentTurnElapsedMs: () => 1000, formatElapsedClock: () => "1s",
    setAgentTurnTimerByTab: vi.fn(), setAgentTurnHistoryByTab: vi.fn(),
    notifyLog: vi.fn(), prefetchHistoryForTabSilently: vi.fn(), scheduleHistoryBindingRetry: vi.fn(),
    clearPendingForTab: vi.fn(), isAppForeground: () => false, autoClearActiveTabIfForeground: vi.fn(),
    applyPending: vi.fn(), showCompletionNotification: notify, t: (key: string) => key,
    tm: {
      readTerminalProgramStatus: () => programStatus,
      readTerminalCursorTextSnapshot: () => ({ text: screen }),
      hasPendingTerminalOutput: () => pendingOutput,
      isPtyResizeReplayWindowActive: () => resizing,
      sendTextAndEnter: send,
    },
  };
  const runtime = new Function(...Object.keys(bindings), runtimeSource)(...Object.values(bindings));
  scans.current.tab = runtime.createCodexErrorScanState({ turn: 1, currentPrompt: "continue" });
  return {
    runtime, timers, histories, scans, handled, prefs, notify, send, probes, snapshots, chime, autoCommit, tabs, sessions, bindSession,
    claudeProbes, claudeCandidates, claudeFreshOutput,
    setScreen: (value: string) => { screen = value; },
    setProgramStatus: (state: TerminalProgramStatus["state"], message = "") => {
      programStatus = { state, app: "claude-code", id: "", message, receivedAt: Date.now() };
    },
    setPendingOutput: (value: boolean) => { pendingOutput = value; },
    setResizing: (value: boolean) => { resizing = value; },
  };
}

describe("Codex 报错处理实际调用链", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("发送长日志后，完成轮询、终端回显和旧错误过滤仍能闭环", async () => {
    const ctx = createRuntime();
    const prompt = "请检查日志：\nEngine.Debug:Log (object)\nLoader:OpenScene (string,int) (at Assets/Scripts/Loader.cs:123)\n".repeat(100);
    ctx.setScreen("› Ask Codex to do anything");
    ctx.runtime.resetCodexErrorScanForTab("tab", "user-send", { advanceTurn: true, prompt, clearFrameState: true });
    expect(ctx.scans.current.tab.currentPrompt).toBe(prompt.trim().slice(0, 4096));
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();

    ctx.runtime.processCodexPtyErrorChunk("pty", `\u001b[?2026h■ ${ERROR}\n› ${prompt}\n• Working (1s • esc to interrupt)\n\u001b[?2026l`);
    expect(ctx.probes.current.tab.probe.boundaryPrompt).toBe(ctx.scans.current.tab.currentPrompt);
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();

    ctx.setScreen("• 已完成。\nWorked for 12s\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    await vi.advanceTimersByTimeAsync(1000);
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.chime).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign-window-tab", "other-tab"])("真实完成通知携带错标签 %s 时，仍完成正确任务并只通知一次", (tabId) => {
    const ctx = createRuntime();
    ctx.timers.current["other-tab"] = { ...ctx.timers.current.tab };
    const event = {
      tabId, providerId: "codex", threadId: "work-session", cwd: "/workspace/work",
      timestamp: new Date().toISOString(), hookEventName: "Stop", completionKind: "agent", preview: "已完成。",
    };
    ctx.runtime.handleExternalAgentCompletion(event);
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.timers.current["other-tab"].status).toBe("working");
    expect(ctx.bindSession).toHaveBeenCalledWith("tab", "work-session", true);
    expect(ctx.notify).toHaveBeenCalledWith("tab", "已完成。");
    expect(ctx.chime).toHaveBeenCalledTimes(1);
    expect(ctx.autoCommit).toHaveBeenCalledWith("project", "agent", "已完成。");
    ctx.runtime.handleExternalAgentCompletion({ ...event, hookEventName: undefined, completionKind: undefined });
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("另一项目的错误标签通知不能绑定当前会话或结束当前任务", () => {
    const ctx = createRuntime();
    ctx.tabs.current.project = [];
    ctx.runtime.handleExternalAgentCompletion({ tabId: "other-tab", providerId: "codex", threadId: "work-session", cwd: "/workspace/work", completionKind: "agent" });
    expect(ctx.bindSession).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(ctx.timers.current.tab.status).toBe("working");
  });

  it("提示词不可见且通知缺失时，真实活动到完成画面仍补齐通知和计时", async () => {
    const ctx = createRuntime();
    ctx.probes.current.tab = { startedAt: ctx.timers.current.tab.startedAt, probe: completion.createCodexTurnCompletionProbe("") };
    ctx.setScreen("› [Pasted Content 2048 chars]\n• Working (1s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    ctx.setScreen("• 已完成。\nWorked for 17m 19s • 02:58\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    await vi.advanceTimersByTimeAsync(1000);
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.chime).toHaveBeenCalledTimes(1);
  });

  it("关闭报错识别也必须保留完成检测的本轮边界证据", async () => {
    const ctx = createRuntime();
    ctx.prefs.current.detectionEnabled = false;
    ctx.probes.current.tab = { startedAt: ctx.timers.current.tab.startedAt, probe: completion.createCodexTurnCompletionProbe("") };
    ctx.runtime.processCodexPtyErrorChunk("pty", "› continue\n• Working (1s • esc to interrupt)\n");
    expect(ctx.probes.current.tab.probe.boundaryPrompt).toBe("continue");
    ctx.setScreen("• 已完成。\nWorked for 12s\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    await vi.advanceTimersByTimeAsync(1000);
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("长任务完成画面补齐计时、通知和自动提交，迟到 hook 不重复，新轮次仍可通知", async () => {
    const ctx = createRuntime();
    ctx.probes.current.tab = { startedAt: ctx.timers.current.tab.startedAt, probe: completion.createCodexTurnCompletionProbe("") };
    ctx.runtime.processCodexPtyErrorChunk("pty", "› continue\n• Working (1s • esc to interrupt)\n");
    expect(ctx.probes.current.tab.probe.boundaryPrompt).toBe("continue");
    ctx.setScreen("• 已完成。\nWorked for 35m 31s • 23:48\n› Ask Codex to do anything\nGPT-6 · Context 37% left · Fast off\n⚠ 1 warning · f2 to view");
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("working");
    await vi.advanceTimersByTimeAsync(1000);
    ctx.runtime.checkCodexTurnCompletions();
    expect(ctx.timers.current.tab.status).toBe("done");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.chime).toHaveBeenCalledTimes(1);
    expect(ctx.autoCommit).toHaveBeenCalledTimes(1);
    ctx.runtime.handleAgentCompletion("tab", "完整回复。", "external");
    ctx.runtime.handleAgentCompletion("tab", "完成", "osc");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    ctx.runtime.startAgentTurnTimer("tab");
    ctx.runtime.handleAgentCompletion("tab", "完整回复。", "external");
    expect(ctx.notify).toHaveBeenCalledTimes(2);
    expect(ctx.timers.current.tab.status).toBe("done");
  });

  it("屏幕来源去重有时间边界，后续直接在终端输入的完成通知仍可接收", async () => {
    const ctx = createRuntime();
    ctx.runtime.handleAgentCompletion("tab", "", "screen");
    await vi.advanceTimersByTimeAsync(6000);
    ctx.runtime.handleAgentCompletion("tab", "下一次回复。", "external");
    expect(ctx.notify).toHaveBeenCalledTimes(2);
  });

  it("同类重连应更新次数，重复通知去重不应冻结状态", async () => {
    const ctx = createRuntime();
    ctx.setScreen(`› continue\nReconnecting... 1/5 (1s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}`);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(1);
    ctx.setScreen(`› continue\nReconnecting... 2/5 (2s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `\nReconnecting... 2/5\n${ERROR}`);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("重连后仅局部输出最终错误正文，也必须确认屏幕上的最终失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}\n`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(11000);
    expect(ctx.timers.current.tab.status).toBe("failed");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("关闭报错识别后，已排队的屏幕检查不能再落失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    ctx.prefs.current.detectionEnabled = false;
    await vi.advanceTimersByTimeAsync(11000);
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("写入队列超过检查期限后，后续相同候选应重新启动检查", async () => {
    const ctx = createRuntime();
    ctx.setPendingOutput(true);
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(11000);
    ctx.setPendingOutput(false);
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("关闭识别期间到期的重连等待不能阻止重新启用后的相同错误", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `${ERROR}\n`);
    ctx.prefs.current.detectionEnabled = false;
    await vi.advanceTimersByTimeAsync(11000);
    ctx.prefs.current.detectionEnabled = true;
    ctx.runtime.processCodexPtyErrorChunk("pty", `${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(11000);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("旧轮次重连等待回调不能推进新轮次的相同候选", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(5000);
    ctx.scans.current.tab = ctx.runtime.createCodexErrorScanState({ turn: 2, currentPrompt: "continue" });
    ctx.runtime.processCodexPtyErrorChunk("pty", `${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(5200);
    expect(ctx.timers.current.tab.status).toBe("working");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("自动继续发送前，恢复工作应取消旧计划", async () => {
    const ctx = createRuntime();
    ctx.prefs.current.autoContinueEnabled = true;
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.timers.current.tab.status).toBe("failed");
    ctx.timers.current.tab.status = "working";
    const key = ctx.scans.current.tab.pendingErrorKey;
    await ctx.runtime.sendCodexAutoContinue("tab", key);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("阻断错误的正文包含可恢复错误时也不能安排自动继续", async () => {
    const ctx = createRuntime();
    ctx.prefs.current.autoContinueEnabled = true;
    const error = "Your workspace is out of credits. Last response: 429 Too Many Requests";
    ctx.setScreen(`› continue\n■ ${error}\n\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${error}\n`);
    await vi.advanceTimersByTimeAsync(11000);
    expect(ctx.timers.current.tab.status).toBe("failed");
    expect(ctx.timers.current.tab.errorKind).toBe("usageLimit");
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("自动继续返回未发送时不能留下工作中状态", async () => {
    const ctx = createRuntime();
    ctx.prefs.current.autoContinueEnabled = true;
    ctx.send.mockResolvedValueOnce(false);
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(5500);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.timers.current.tab.status).toBe("interrupted");
  });

  it("手动继续未发送也不能留下工作中状态", async () => {
    const ctx = createRuntime();
    ctx.send.mockResolvedValueOnce(false);
    await ctx.runtime.sendCodexManualContinue("tab");
    expect(ctx.timers.current.tab.status).toBe("interrupted");
  });

  it("新一轮相同错误不能被旧屏幕回调提前确认", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(80);
    ctx.scans.current.tab = ctx.runtime.createCodexErrorScanState({ turn: 2, currentPrompt: "continue" });
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(40);
    expect(ctx.timers.current.tab.status).toBe("working");
    await vi.advanceTimersByTimeAsync(80);
    expect(ctx.timers.current.tab.status).toBe("failed");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("检查期限最后一刻才出现输入框时，稳定次数不足不能确认", async () => {
    const ctx = createRuntime();
    ctx.setScreen("正在输出");
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(10000);
    ctx.setScreen(FINAL_SCREEN);
    await vi.advanceTimersByTimeAsync(40);
    expect(ctx.timers.current.tab.status).toBe("working");
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(120);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("跨字节块同步更新只通知一次，历史重建不能恢复失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026h■ unexpected\nsta");
    ctx.runtime.processCodexPtyErrorChunk("pty", "tus 502 Bad Gateway: upstream unavailable\n\n› Ask Codex to do anything\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.status).toBe("failed");
    ctx.runtime.processCodexPtyErrorChunk("pty", `\u001b[?2026h\u001b[3J■ ${ERROR}\nWorking (1s)\u001b[?2026l`);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.status).toBe("failed");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("相同重连详情重绘时不重复通知，进度仍更新", async () => {
    const ctx = createRuntime();
    ctx.prefs.current.notifyReconnectErrors = true;
    ctx.setScreen(`› continue\nReconnecting... 1/5 (1s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen(`› continue\nReconnecting... 2/5 (2s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 2/5\n${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("只重绘重连标题时也应更新次数", async () => {
    const ctx = createRuntime();
    ctx.setScreen(`› continue\nReconnecting... 1/5 (1s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen("› continue\nReconnecting... 2/5 (2s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "Reconnecting... 2/5\n");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
  });

  it("同步局部重绘的 Working 应清掉当前重连展示", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `› continue\nReconnecting... 1/5\n${ERROR}\n`);
    ctx.setScreen("› continue\n• Processing\nWorking (2s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
  });

  it.each([false, true])("压缩上下文应自动清除重连，保持本轮起始时间：同步=%s", async (synchronized) => {
    const ctx = createRuntime();
    const startedAt = ctx.timers.current.tab.startedAt;
    ctx.timers.current.tab.reconnectAttempt = 1;
    ctx.timers.current.tab.reconnectErrorKind = "networkStream";
    ctx.timers.current.tab.reconnectErrorMessage = "stream disconnected before completion";
    ctx.setScreen("› continue\n• Compacting context (45s • esc to interrupt)\n  Making room to continue.\n› Ask Codex to do anything");
    const chunk = "• Compacting context (45s • esc to interrupt)";
    ctx.runtime.processCodexPtyErrorChunk("pty", synchronized ? `\u001b[?2026h${chunk}\u001b[?2026l` : chunk);
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.timers.current.tab.startedAt).toBe(startedAt);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("旧重连标题的局部重画不能覆盖实际正在压缩的屏幕", async () => {
    const ctx = createRuntime();
    ctx.setScreen("› continue\n• Compacting context (45s • esc to interrupt)\n  Making room to continue.\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", `\u001b[?2026hReconnecting... 1/5\n${ERROR}\u001b[?2026l`);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("没有换行的重连局部绘制应核对实际屏幕，恢复后也不能残留", async () => {
    const ctx = createRuntime();
    const chunk = `\u001b[?2026h\u001b[3;1H• 正在检查代码\u001b[20;1H◦ Reconnecting... 2/5 (45s • esc to interrupt)\u001b[21;1H${ERROR}\u001b[?2026l`;
    ctx.setScreen(`› continue\n◦ Reconnecting... 2/5 (45s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", chunk);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
    ctx.setScreen("› continue\n◦ Compacting context (45s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", chunk);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("已经误显示重连时，没有新的状态文字也应由屏幕自动纠正", async () => {
    const ctx = createRuntime();
    ctx.timers.current.tab.reconnectAttempt = 1;
    ctx.timers.current.tab.reconnectErrorKind = "networkStream";
    ctx.setScreen("› continue\n• 正在检查代码。\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it.each(["continue", ""])("输入已滚出屏幕或由终端直接提交时，真实重连仍能确认：%s", async (prompt) => {
    const ctx = createRuntime();
    ctx.scans.current.tab.currentPrompt = prompt;
    ctx.setScreen(`• Reconnecting... 3/5 (1m 03s • esc to interrupt)\n  ${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 3/5\n${ERROR}`);
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(3);
    ctx.setScreen("• Compacting context (45s • esc to interrupt)\n  Making room to continue.\n› Ask Codex to do anything");
    ctx.runtime.checkCodexTurnCompletions();
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.timers.current.tab.status).toBe("working");
  });

  it("手动继续清理重连和待确认错误，保留本轮时间且不发送消息", async () => {
    const ctx = createRuntime();
    const startedAt = ctx.timers.current.tab.startedAt;
    ctx.timers.current.tab.reconnectAttempt = 1;
    ctx.timers.current.tab.reconnectErrorKind = "networkStream";
    ctx.scans.current.tab.autoContinueAttempts = 2;
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    ctx.runtime.resumeAgentTurnTimer("tab");
    await vi.advanceTimersByTimeAsync(11000);
    expect(ctx.timers.current.tab.status).toBe("working");
    expect(ctx.timers.current.tab.startedAt).toBe(startedAt);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
    expect(ctx.scans.current.tab.pendingFinalError).toBeUndefined();
    expect(ctx.scans.current.tab.currentPrompt).toBe("continue");
    expect(ctx.scans.current.tab.turn).toBe(1);
    expect(ctx.scans.current.tab.autoContinueAttempts).toBe(2);
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it.each(["resize", "history", "new-turn"])("恢复检查不能越过保护边界：%s", async (mode) => {
    const ctx = createRuntime();
    ctx.timers.current.tab.reconnectAttempt = 1;
    ctx.setScreen("› continue\n• Compacting context (45s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.scheduleCodexRuntimeScreenCheck("tab");
    if (mode === "resize") ctx.setResizing(true);
    if (mode === "history") ctx.setScreen("› continue\n• Compacting context (45s • esc to interrupt)\n↓ Back to bottom\n› Ask Codex to do anything\nenter/esc latest");
    if (mode === "new-turn") ctx.scans.current.tab = ctx.runtime.createCodexErrorScanState({ turn: 2, currentPrompt: "new task" });
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(1);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("同步局部重绘的重连标题也应从稳定屏幕更新进度", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `› continue\nReconnecting... 1/5\n${ERROR}\n`);
    ctx.setScreen(`› continue\nReconnecting... 2/5 (2s • esc to interrupt)\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hReconnecting... 2/5\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
  });

  it("当前输入之前的旧 Working 不能被局部同步帧恢复为工作中", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen("Working (2s • esc to interrupt)\n› continue\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("局部同步帧排队检查后关闭识别不能恢复失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen("› continue\nWorking (2s • esc to interrupt)\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    ctx.prefs.current.detectionEnabled = false;
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("局部状态重绘后的稳定屏幕已是最终错误时，应确认本轮失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.timers.current.tab.status).toBe("failed");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("恢复 Working 后才结束的旧发送异常不能中断新轮次", async () => {
    const ctx = createRuntime();
    let rejectSend!: (error: Error) => void;
    ctx.send.mockImplementationOnce(() => new Promise<boolean>((_resolveSend, reject) => { rejectSend = reject; }));
    const pending = ctx.runtime.sendCodexManualContinue("tab");
    ctx.scans.current.tab = ctx.runtime.createCodexErrorScanState({ turn: 3, currentPrompt: "new task" });
    rejectSend(new Error("closed terminal"));
    await pending;
    expect(ctx.timers.current.tab.status).toBe("working");
  });

  it("发送完成前开始新轮次，旧发送失败不能中断新轮次", async () => {
    const ctx = createRuntime();
    let finishSend!: (value: boolean) => void;
    ctx.send.mockImplementationOnce(() => new Promise<boolean>((resolveSend) => { finishSend = resolveSend; }));
    const pending = ctx.runtime.sendCodexManualContinue("tab");
    ctx.scans.current.tab = ctx.runtime.createCodexErrorScanState({ turn: 3, currentPrompt: "new task" });
    finishSend(false);
    await pending;
    expect(ctx.timers.current.tab.status).toBe("working");
  });
});
