// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPasteError } from "./terminal-send";
import type { ScheduledMessage } from "@/types/host";

/** 提取应用真实发送入口，避免用测试中的重写逻辑代替失败处理。 */
function readSendCommand(name = "sendCommand"): string {
  const source = readFileSync("web/src/App.tsx", "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = "";
  /** 仅定位目标函数，保留完整生产函数体。 */
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = source.slice(node.getStart(file), node.getEnd());
      return;
    }
    if (!result)
      ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result)
    throw new Error(`应用函数不存在：${name}`);
  return ts.transpileModule(result, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const sendSource = readSendCommand();

/** 为真实发送入口提供独立状态与宿主桩，观察草稿、计时和兜底写入。 */
function createSendHarness(send: () => Promise<boolean>) {
  const draftByTab = { example: "待发送正文" };
  const chipsByTab = { example: [] as string[] };
  let drafts = draftByTab;
  let chips = chipsByTab;
  const pendingCommandSendByTabRef = { current: new Set<string>() };
  const write = vi.fn();
  (window as any).host = { pty: { write } };
  const deps = {
    activeTab: { id: "example", providerId: "codex" },
    tabsByProjectRef: { current: { project: [{ id: "example", providerId: "codex", windowId: "main" }] } },
    currentWindowId: "main",
    isTabOwnedByWindow: (tab: { windowId: string }, windowId: string) => tab.windowId === windowId,
    pendingCommandSendByTabRef,
    compileTextFromChipsAndDraft: () => draftByTab.example,
    collectGrokAttachmentPaths: () => [],
    ptyByTabRef: { current: { example: "pty-example" } },
    tabExecEnvByTabRef: { current: { example: { terminal: "pwsh" } } },
    getProviderEnv: () => ({ terminal: "pwsh" }),
    isTerminalFrontendDebugEnabled: () => false,
    resumeCompletionGuardByTabRef: { current: {} },
    resetCodexErrorScanForTab: vi.fn(),
    shouldEnableAgentTimerForProvider: () => true,
    startAgentTurnTimer: vi.fn(),
    cancelAgentTurnTimer: vi.fn(),
    selectedProject: undefined,
    geminiWindowsEditorReadyByTabRef: { current: {} },
    geminiWslEditorReadyByTabRef: { current: {} },
    geminiExternalEditorShortcutByTabRef: { current: {} },
    sendMode: "write_and_enter",
    tm: { sendTextAndEnter: vi.fn(send) },
    TerminalPasteError,
    setNoticeDialog: vi.fn(),
    t: (key: string) => key,
    chipsByTab,
    draftByTab,
    setChipsByTab: vi.fn((update) => { chips = update(chips); }),
    setDraftByTab: vi.fn((update) => { drafts = update(drafts); }),
    setInputFullscreenState: vi.fn(),
    userInputCountByTabIdRef: { current: {} },
    enqueueAutoCommit: vi.fn(),
  };
  const sendCommand = new Function(...Object.keys(deps), `${sendSource}\nreturn sendCommand;`)(...Object.values(deps)) as (task?: ScheduledMessage) => Promise<boolean>;
  return { deps, write, sendCommand, readDraft: () => drafts.example, editDraft: (text: string) => { drafts = { example: text }; } };
}

describe("应用发送入口的失败与并发处理", () => {
  afterEach(() => { delete (window as any).host; });

  it("原生粘贴失败保留草稿、停止计时，不触发危险兜底或自动提交", async () => {
    const harness = createSendHarness(async () => { throw new TerminalPasteError("native-paste-timeout"); });
    await harness.sendCommand();
    expect(harness.readDraft()).toBe("待发送正文");
    expect(harness.deps.cancelAgentTurnTimer).toHaveBeenCalledWith("example", "paste-failed");
    expect(harness.deps.setNoticeDialog).toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.deps.enqueueAutoCommit).not.toHaveBeenCalled();
    expect(harness.deps.pendingCommandSendByTabRef.current.size).toBe(0);
  });

  it("终端消失时保留输入，明确结束等待", async () => {
    const harness = createSendHarness(async () => false);
    await harness.sendCommand();
    expect(harness.readDraft()).toBe("待发送正文");
    expect(harness.deps.cancelAgentTurnTimer).toHaveBeenCalledWith("example", "paste-failed");
    expect(harness.write).not.toHaveBeenCalled();
  });

  it("等待粘贴期间连续点击只发送一次，完成后保留新输入", async () => {
    let resolve!: (value: boolean) => void;
    const harness = createSendHarness(() => new Promise<boolean>((done) => { resolve = done; }));
    const first = harness.sendCommand();
    await harness.sendCommand();
    expect(harness.deps.tm.sendTextAndEnter).toHaveBeenCalledTimes(1);
    harness.editDraft("粘贴期间的新输入");
    resolve(true);
    await first;
    expect(harness.readDraft()).toBe("粘贴期间的新输入");
    expect(harness.deps.pendingCommandSendByTabRef.current.size).toBe(0);
  });
});

/** 生成预约时已保存的内容和目标，不依赖当前选中的对话。 */
function scheduledTask(): ScheduledMessage {
  return { id: "scheduled-example", tabId: "example", tabName: "Example", providerId: "codex", projectId: "project", projectName: "Example", projectWinRoot: "", projectWslRoot: "/repo/example", ptyId: "pty-example", text: "预约时的正文", attachmentPaths: ["/attachments/example.png"], imagePaths: [], scheduledAt: 1, status: "sending" };
}

describe("真实发送入口的预约行为", () => {
  afterEach(() => { delete (window as any).host; });

  it("切换对话和更改发送设置后，仍发送原始快照且自动确认", async () => {
    const h = createSendHarness(async () => true);
    h.deps.activeTab.id = "other";
    h.deps.sendMode = "write_only";
    const task = scheduledTask();
    expect(await h.sendCommand(task)).toBe(true);
    expect(h.deps.tm.sendTextAndEnter).toHaveBeenCalledWith("example", "预约时的正文", expect.objectContaining({ projectWslRoot: "/repo/example", attachmentPaths: task.attachmentPaths }));
    expect(h.deps.setDraftByTab).not.toHaveBeenCalled();
    expect(h.deps.setChipsByTab).not.toHaveBeenCalled();
    expect(h.deps.setInputFullscreenState).not.toHaveBeenCalled();
  });

  it("目标终端已被替换或标签移到另一个窗口时拒绝发送", async () => {
    const h = createSendHarness(async () => true);
    expect(await h.sendCommand({ ...scheduledTask(), ptyId: "replaced" })).toBe(false);
    h.deps.tabsByProjectRef.current.project[0].windowId = "detached";
    expect(await h.sendCommand(scheduledTask())).toBe(false);
    expect(h.deps.tm.sendTextAndEnter).not.toHaveBeenCalled();
  });

  it("未知粘贴失败不执行第二次兜底写入，保留新输入", async () => {
    const h = createSendHarness(async () => { throw new Error("paste failed"); });
    expect(await h.sendCommand(scheduledTask())).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.readDraft()).toBe("待发送正文");
    expect(h.deps.cancelAgentTurnTimer).toHaveBeenCalledWith("example", "paste-failed");
    expect(h.deps.pendingCommandSendByTabRef.current.size).toBe(0);
  });

  it("普通发送占用同一对话时，不并发写入预约正文", async () => {
    let resolve!: (value: boolean) => void;
    const h = createSendHarness(() => new Promise<boolean>((done) => { resolve = done; }));
    const first = h.sendCommand();
    expect(await h.sendCommand(scheduledTask())).toBe(false);
    resolve(true);
    await first;
    expect(h.deps.tm.sendTextAndEnter).toHaveBeenCalledTimes(1);
  });
});

describe("取消预约后的草稿恢复", () => {
  afterEach(() => { delete (window as any).host; });

  /** 为实际取消入口提供可观察的草稿和附件状态。 */
  function createCancelHarness(ok: boolean) {
    let drafts: Record<string, string> = { example: "正在编辑的新草稿" };
    let chips: Record<string, string[]> = { example: ["已有附件"] };
    const inputValuesByTabRef = { current: { draftByTab: drafts, chipsByTab: chips } };
    const history = { busy: false };
    const record = vi.fn();
    (window as any).host = { scheduledMessages: { cancel: vi.fn(async () => ({ ok, historyToken: ok ? "history-example" : undefined })) } };
    const deps = {
      scheduledMessageTasks: [scheduledTask()],
      getInputHistory: () => history,
      recordPathChipsHistoryChange: record,
      inputValuesByTabRef,
      setNoticeDialog: vi.fn(),
      t: (key: string) => key,
      setDraftByTab: (update: (current: typeof drafts) => typeof drafts) => { drafts = update(drafts); inputValuesByTabRef.current.draftByTab = drafts; },
      setChipsByTab: (update: (current: typeof chips) => typeof chips) => { chips = update(chips); inputValuesByTabRef.current.chipsByTab = chips; },
      tabExecEnvByTabRef: { current: { example: { terminal: "wsl" } } },
      getProviderEnv: () => ({ terminal: "wsl" }),
      buildPathChipFromPath: (options: { rawPath: string }) => options.rawPath,
      mergePathChips: (current: string[], next: string[]) => [...current, ...next],
    };
    const source = readSendCommand("recordScheduledMessageChange") + readSendCommand("cancelScheduledMessage");
    const cancel = new Function(...Object.keys(deps), `${source}\nreturn cancelScheduledMessage;`)(...Object.values(deps)) as (id: string) => Promise<{ ok: boolean }>;
    return { cancel, record, history, drafts: () => drafts.example, chips: () => chips.example };
  }

  it("取消后追加原正文和图片附件，保留已有输入", async () => {
    const h = createCancelHarness(true);
    expect((await h.cancel("scheduled-example")).ok).toBe(true);
    expect(h.drafts()).toBe("正在编辑的新草稿\n\n预约时的正文");
    expect(h.chips()).toEqual(["已有附件", "/attachments/example.png"]);
    expect(h.record).toHaveBeenCalledWith(h.history, { draft: "正在编辑的新草稿", chips: ["已有附件"] }, { draft: h.drafts(), chips: h.chips() }, expect.objectContaining({ restore: expect.any(Function) }));
    expect(h.history.busy).toBe(false);
  });

  it("任务已开始发送导致取消失败时，不重复恢复正文", async () => {
    const h = createCancelHarness(false);
    expect((await h.cancel("scheduled-example")).ok).toBe(false);
    expect(h.drafts()).toBe("正在编辑的新草稿");
    expect(h.chips()).toEqual(["已有附件"]);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.history.busy).toBe(false);
  });
});
