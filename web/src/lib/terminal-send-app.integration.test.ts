// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPasteError } from "./terminal-send";

/** 提取应用真实发送入口，避免用测试中的重写逻辑代替失败处理。 */
function readSendCommand(): string {
  const source = readFileSync("web/src/App.tsx", "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result = "";
  /** 仅定位目标函数，保留完整生产函数体。 */
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "sendCommand") {
      result = source.slice(node.getStart(file), node.getEnd());
      return;
    }
    if (!result)
      ts.forEachChild(node, visit);
  }
  visit(file);
  if (!result)
    throw new Error("应用发送入口不存在");
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
  const sendCommand = new Function(...Object.keys(deps), `${sendSource}\nreturn sendCommand;`)(...Object.values(deps)) as () => Promise<void>;
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
