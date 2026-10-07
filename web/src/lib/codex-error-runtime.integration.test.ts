// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as classifier from "./codex-cli-error-classifier";
import * as replay from "./codex-error-replay-guard";
import * as settings from "./codex-error-handling-settings";
import * as completion from "./codex-turn-completion";
import { resolveAgentCompletionTab } from "./agent-completion-routing";
import { isCodexHistoryBrowsingScreen } from "./codex-tui-screen";

const ERROR = "unexpected status 502 Bad Gateway: upstream unavailable";
const FINAL_SCREEN = `› continue\n■ ${ERROR}\n\n› Ask Codex to do anything`;
const RUNTIME_NAMES = new Set([
  "createCodexErrorScanState", "appendCodexTurnOutput", "clearCodexPendingFinalErrorState", "buildCodexCliErrorKey",
  "CODEX_ERROR_SCAN_MAX_BUFFER_LENGTH", "CODEX_TURN_OUTPUT_MAX_LENGTH", "CODEX_FINAL_ERROR_SCREEN_CONFIRM_RETRY_MS",
  "CODEX_FINAL_ERROR_SCREEN_CONFIRM_MAX_CHECKS", "CODEX_FINAL_ERROR_SCREEN_CONFIRM_STABLE_CHECKS",
  "CODEX_RECONNECT_AFTER_ERROR_GRACE_MS",
  "clearCodexErrorAutoContinueTimer", "resetCodexErrorScanForTab", "startAgentTurnTimer", "markAgentTurnReconnecting",
  "clearAgentTurnReconnecting", "restoreFailedAgentTurnToReconnecting", "restoreFailedAgentTurnToWorking",
  "interruptAgentTurnTimer", "failAgentTurnTimer", "acknowledgeAgentTurnFailure",
  "rememberHandledCodexError", "resolveCodexReplayDecision", "settleCodexIdleWithoutFinalError",
  "shouldTrustCodexIdleScreenForCurrentTurn", "scheduleCodexPendingFinalIdleScreenCheck", "shouldTrustCodexRuntimeStatus",
  "scheduleCodexRuntimeScreenCheck",
  "handleCodexCliErrorDetected", "handleCodexCliReconnectDetected", "confirmCodexPendingFinalErrorFromIdleScreen",
  "flushCodexPendingFinalError", "processCodexPtyErrorFrame", "processCodexPtyErrorChunk",
  "sendCodexAutoContinue", "sendCodexManualContinue", "scheduleCodexAutoContinue",
  "checkCodexTurnCompletions", "completeAgentTurnTimer", "handleAgentCompletion", "isDuplicateCompletion", "recordCompletionSnapshot",
  "resolveExternalTabId", "handleExternalAgentCompletion",
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

/** 为真实应用闭包提供终端、通知、设置及 React 状态边界。 */
function createRuntime() {
  let screen = FINAL_SCREEN;
  let pendingOutput = false;
  let resizing = false;
  const timers = { current: { tab: { status: "working", startedAt: Date.now() - 1000, elapsedMs: 0 } } as Record<string, any> };
  const scans = { current: {} as Record<string, any> };
  const handled = { current: {} as Record<string, any[]> };
  const prefs = { current: { ...settings.DEFAULT_CODEX_ERROR_HANDLING_PREFS, autoContinueDelaySeconds: 5 } };
  const notify = vi.fn();
  const send = vi.fn(async () => true);
  const probes = { current: {} as Record<string, any> };
  const snapshots = { current: {} as Record<string, any> };
  const chime = vi.fn();
  const autoCommit = vi.fn();
  const tabs = { current: {
    project: [{ id: "tab", providerId: "codex", name: "PowerShell", historySessionId: "work-session" }],
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
    ...classifier, ...replay, ...settings, ...completion, isCodexHistoryBrowsingScreen, resolveAgentCompletionTab,
    window: browserTimers, useCallback: (fn: unknown) => fn, MAX_AGENT_TURN_HISTORY: 30,
    codexErrorScanByTabRef: scans, codexHandledErrorKeysByPtyRef: handled,
    codexErrorHandlingPrefsRef: prefs, agentTurnTimerByTabRef: timers,
    agentTurnHistoryByTabRef: { current: {} }, codexTurnCompletionProbeByTabRef: probes,
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
    shouldDedupeRepeatedExternalCompletion: () => false, shouldDedupeCrossSourceCompletion: () => false,
    clearPendingOscCompletion: vi.fn(), consumeResumeCompletionGuardIfNeeded: () => false,
    shouldEnableAgentTimerForProvider: () => true, notificationPrefsRef: { current: { sound: true } },
    playCompletionChime: chime, enqueueAutoCommit: autoCommit, tabProjectRef: { current: { tab: "project" } },
    emitCodexRateRefresh: vi.fn(), emitClaudeUsageRefresh: vi.fn(), emitGeminiUsageRefresh: vi.fn(),
    emitAntigravityUsageRefresh: vi.fn(), emitGrokUsageRefresh: vi.fn(),
    historyActiveTurnStartedAtByTabRef: { current: {} }, historyMatchByTabRef: { current: {} },
    ptyByTabRef: { current: { tab: "pty" } }, ptyToTabRef: { current: { pty: "tab" } },
    activeTabIdRef: { current: "tab" }, pendingCompletionsRef: { current: {} },
    resolveTabProviderId: () => "codex", resolveCodexErrorKindLabel: classifier.getCodexCliErrorKindLabel,
    getTabExecEnv: () => ({ terminal: "powershell", distro: "" }),
    resolveAgentTurnElapsedMs: () => 1000, formatElapsedClock: () => "1s",
    setAgentTurnTimerByTab: vi.fn(), setAgentTurnHistoryByTab: vi.fn(),
    notifyLog: vi.fn(), prefetchHistoryForTabSilently: vi.fn(), scheduleHistoryBindingRetry: vi.fn(),
    clearPendingForTab: vi.fn(), isAppForeground: () => false, autoClearActiveTabIfForeground: vi.fn(),
    applyPending: vi.fn(), showCompletionNotification: notify, t: (key: string) => key,
    tm: {
      readTerminalCursorTextSnapshot: () => ({ text: screen }),
      hasPendingTerminalOutput: () => pendingOutput,
      isPtyResizeReplayWindowActive: () => resizing,
      sendTextAndEnter: send,
    },
  };
  const runtime = new Function(...Object.keys(bindings), runtimeSource)(...Object.values(bindings));
  scans.current.tab = runtime.createCodexErrorScanState({ turn: 1, currentPrompt: "continue" });
  return {
    runtime, timers, scans, handled, prefs, notify, send, probes, snapshots, chime, autoCommit, tabs, sessions, bindSession,
    setScreen: (value: string) => { screen = value; },
    setPendingOutput: (value: boolean) => { pendingOutput = value; },
    setResizing: (value: boolean) => { resizing = value; },
  };
}

describe("Codex 报错处理实际调用链", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

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

  it("同类重连应更新次数，重复通知去重不应冻结状态", () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `\nReconnecting... 2/5\n${ERROR}`);
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

  it("相同重连详情重绘时不重复通知，进度仍更新", () => {
    const ctx = createRuntime();
    ctx.prefs.current.notifyReconnectErrors = true;
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}\n`);
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 2/5\n${ERROR}\n`);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
  });

  it("只重绘重连标题时也应更新次数", () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `Reconnecting... 1/5\n${ERROR}\n`);
    ctx.runtime.processCodexPtyErrorChunk("pty", "Reconnecting... 2/5\n");
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
  });

  it("同步局部重绘的 Working 应清掉当前重连展示", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `› continue\nReconnecting... 1/5\n${ERROR}\n`);
    ctx.setScreen("› continue\n• Processing\nWorking (2s)\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBeUndefined();
  });

  it("同步局部重绘的重连标题也应从稳定屏幕更新进度", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `› continue\nReconnecting... 1/5\n${ERROR}\n`);
    ctx.setScreen(`› continue\nReconnecting... 2/5\n${ERROR}\n› Ask Codex to do anything`);
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hReconnecting... 2/5\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.reconnectAttempt).toBe(2);
  });

  it("当前输入之前的旧 Working 不能被局部同步帧恢复为工作中", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen("Working (2s)\n› continue\n› Ask Codex to do anything");
    ctx.runtime.processCodexPtyErrorChunk("pty", "\u001b[?2026hWorking (2s)\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(160);
    expect(ctx.timers.current.tab.status).toBe("failed");
  });

  it("局部同步帧排队检查后关闭识别不能恢复失败", async () => {
    const ctx = createRuntime();
    ctx.runtime.processCodexPtyErrorChunk("pty", `■ ${ERROR}\n`);
    await vi.advanceTimersByTimeAsync(160);
    ctx.setScreen("› continue\nWorking (2s)\n› Ask Codex to do anything");
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
